/* OAuth 2.1 for the MCP endpoint (/api/mcp, mcp/src/http.js), so a client that can only sign in
   the OAuth way — a claude.ai custom connector, which has no field for a static header — connects
   with the instance's address alone. What MCP's authorization spec asks of a server:

     GET  /.well-known/oauth-protected-resource[/api/mcp]   which server issues tokens for /api/mcp
     GET  /.well-known/oauth-authorization-server           that server's endpoints
     POST /api/oauth/register                               dynamic client registration
     GET  /api/oauth/authorize                              the consent page (session cookie)
     POST /api/oauth/authorize                              its Allow / Deny
     POST /api/oauth/token                                  code + PKCE verifier -> tokens; refresh

   The access token is an ordinary paired session (makeSession, the same as Settings → Connect
   Claude mints), so the api checks it like any other and "Sign out everywhere" ends it. Nothing
   new is stored: a client id is the signed registration itself, a refresh token is a signed
   payload carrying the account's session version, and an authorization code lives in the
   pairings store (one-shot, five minutes) — which Postgres mode already persists across requests.

   This module is the parts that need nothing of server.js's state; server.js wires the routes. */
import crypto from 'node:crypto';

export const CODE_TTL_MS = 5 * 60000;
// Codes share the pairings store. pair/redeem upper-cases what it is sent, so it can never look up
// a key with this lower-case prefix.
export const CODE_PREFIX = 'oauth:';
// A refresh token's signed payload starts with this. It is not a user id, so sessionUser() finds no
// account for it and a refresh token is never a session.
export const REFRESH_PREFIX = 'oauth-refresh';

const MAX_URIS = 5;
const MAX_URI = 512;
const MAX_NAME = 80;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

const b64u = s => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url').toString('utf8');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A redirect URI a client may register: https, or http on a loopback address (a CLI's callback). */
export function redirectOk(uri) {
  if (typeof uri !== 'string' || !uri || uri.length > MAX_URI) return false;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
}

export function metadata(origin) {
  return {
    resource: {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      resource_name: 'openGym'
    },
    server: {
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    }
  };
}

/** S256: the verifier hashes to the challenge the authorization request carried. */
export function pkceOk(verifier, challenge) {
  if (typeof verifier !== 'string' || !PKCE.test(verifier) || typeof challenge !== 'string') return false;
  const got = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
  const want = Buffer.from(challenge);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Everything that needs the instance's signing key. `sign`/`verifySig` are server.js's. */
export function createOAuth({ sign, verifySig }) {
  // Registration is stateless: the client id is the registration, signed. Public clients only
  // (PKCE, no secret), so there is nothing else to keep.
  function register(body) {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_URIS || !uris.every(redirectOk)) {
      return { error: 'invalid_redirect_uri', error_description: `1 to ${MAX_URIS} redirect_uris, https or http on a loopback address` };
    }
    const name = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, MAX_NAME) : '';
    const clientId = sign('oc:' + b64u(JSON.stringify({ r: uris, n: name })));
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name || undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }

  function client(clientId) {
    if (typeof clientId !== 'string' || clientId.length > 4096) return null;
    const payload = verifySig(clientId);
    if (!payload?.startsWith('oc:')) return null;
    try {
      const { r, n } = JSON.parse(unb64u(payload.slice(3)));
      return Array.isArray(r) ? { id: clientId, redirectUris: r, name: n || '' } : null;
    } catch { return null; }
  }

  /**
   * An authorization request, checked. `fatal` is an error the user sees on the page (no client,
   * or a redirect URI it did not register: never redirect there). `error` goes back to the
   * client's redirect URI. Otherwise the request, normalised.
   */
  function authorizeRequest(q) {
    const c = client(q.client_id);
    if (!c) return { fatal: 'This app is not registered with openGym (unknown client_id).' };
    const ru = q.redirect_uri || (c.redirectUris.length === 1 ? c.redirectUris[0] : '');
    if (!c.redirectUris.includes(ru)) return { fatal: 'This redirect address was not registered by the app.' };
    const req = { client: c, clientId: c.id, redirectUri: ru, state: typeof q.state === 'string' ? q.state.slice(0, 1024) : '' };
    if (q.response_type !== 'code') return { ...req, error: 'unsupported_response_type' };
    if (!PKCE.test(q.code_challenge || '') || q.code_challenge_method !== 'S256') {
      return { ...req, error: 'invalid_request', description: 'PKCE with S256 is required' };
    }
    return { ...req, codeChallenge: q.code_challenge };
  }

  function refreshToken(user, clientId, days) {
    const exp = Date.now() + days * 86400000;
    const ch = crypto.createHash('sha256').update(clientId).digest('base64url').slice(0, 22);
    return sign(`${REFRESH_PREFIX}:${user.id}:${exp}:${user.sv || 0}:${ch}`);
  }
  /** { uid, clientHash } of a refresh token that verifies and has not expired, or null. */
  function readRefresh(tok, clientId) {
    if (typeof tok !== 'string' || tok.length > 1024) return null;
    const payload = verifySig(tok);
    const [pre, uid, exp, sv, ch] = (payload || '').split(':');
    if (pre !== REFRESH_PREFIX || !uid || !(+exp > Date.now())) return null;
    if (!clientId || ch !== crypto.createHash('sha256').update(clientId).digest('base64url').slice(0, 22)) return null;
    return { uid, sv: Number(sv) };
  }

  return { register, client, authorizeRequest, refreshToken, readRefresh };
}

export const newCode = () => CODE_PREFIX + crypto.randomBytes(32).toString('base64url');

/** `redirectUri` with the response parameters added (and `iss`, RFC 9207). */
export function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

/* ---------- the consent page ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The page's headers: nothing loads, nothing frames it, and its form may only post here and
 *  follow the redirect to the client (form-action covers the redirect after the submit). */
export function pageHeaders(redirectUri) {
  const to = redirectUri ? ' ' + new URL(redirectUri).origin : '';
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${to}; frame-ancestors 'none'; base-uri 'none'`
  };
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · openGym</title><style>
:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#111;--dim:#6b6b70;--accent:#0a84ff}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f2f2f7;--dim:#98989f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:var(--card);border-radius:16px;padding:24px;margin:16px;max-width:420px;width:100%;box-sizing:border-box}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.dim{color:var(--dim);font-size:14px}
.row{display:flex;gap:10px;margin-top:20px}button,a.btn{flex:1;font:inherit;padding:12px;border-radius:12px;border:0;cursor:pointer;text-align:center;text-decoration:none;background:var(--bg);color:var(--fg)}
button.go,a.go{background:var(--accent);color:#fff}code{word-break:break-all}
</style></head><body><main>${body}</main></body></html>`;
}

export function consentPage(req, user) {
  const host = new URL(req.redirectUri).host;
  const hidden = { client_id: req.clientId, redirect_uri: req.redirectUri, state: req.state, response_type: 'code', code_challenge: req.codeChallenge, code_challenge_method: 'S256' };
  const inputs = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
  return page('Connect', `<h1>Connect ${esc(req.client.name || 'an app')} to openGym?</h1>
<p>It will be able to read your training and, when you ask it to, log workouts and change your plan — as <b>${esc(user.name || 'you')}</b>.</p>
<p class="dim">You will be sent back to <code>${esc(host)}</code>. “Sign out everywhere” in Settings revokes this access.</p>
<form method="post" action="/api/oauth/authorize">${inputs}<div class="row">
<button name="decision" value="deny">Cancel</button><button class="go" name="decision" value="allow">Allow</button></div></form>`);
}

export function signInPage(authorizeUrl) {
  return page('Sign in', `<h1>Sign in to openGym first</h1>
<p>An app is asking to connect to your openGym account, but you are not signed in in this browser.</p>
<p class="dim">Open openGym, sign in, then come back to this tab and continue.</p>
<div class="row"><a class="btn" href="/" target="_blank" rel="noopener">Open openGym</a><a class="btn go" href="${esc(authorizeUrl)}">Continue</a></div>`);
}

export function errorPage(message) {
  return page('Error', `<h1>Can’t connect</h1><p>${esc(message)}</p>`);
}
