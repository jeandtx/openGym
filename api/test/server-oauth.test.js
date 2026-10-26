/* OAuth for the MCP endpoint (oauth.js): discovery, registration, the consent page, the code
   exchange with PKCE and the refresh — the way a claude.ai connector walks it. Real server.js in
   a child, as in server-pairing.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = uid => ({ Cookie: `gymsid=${mintSession(uid)}` });

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-oauth-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_test_1', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost' }
  });
  const h = { log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  return h;
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const form = o => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });

test('a connector registers, the user allows it, and the code buys a working, revocable token', async t => {
  const h = await startServer(t);

  // Discovery, from the resource to its authorization server.
  const prm = await (await fetch(`${h.api}/.well-known/oauth-protected-resource/api/mcp`)).json();
  assert.equal(prm.resource, `${ORIGIN}/api/mcp`);
  assert.deepEqual(prm.authorization_servers, [ORIGIN]);
  const as = await (await fetch(`${h.api}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.token_endpoint, `${ORIGIN}/api/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);

  // Registration: a non-https, non-loopback callback is refused; claude.ai's is not.
  const bad = await fetch(`${h.api}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(bad.status, 400);
  const reg = await fetch(`${h.api}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'Claude <b>' }) });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();

  const { verifier, challenge } = pkce();
  const params = { client_id, redirect_uri: CALLBACK, response_type: 'code', state: 'st8', code_challenge: challenge, code_challenge_method: 'S256' };
  const authorize = `${h.api}/api/oauth/authorize?${new URLSearchParams(params)}`;

  // Signed out: a page asking to sign in, no redirect.
  const out = await fetch(authorize, { redirect: 'manual' });
  assert.equal(out.status, 200);
  assert.match(await out.text(), /Sign in to openGym first/);

  // Signed in: the consent page, with the client's name escaped and framing refused.
  const consent = await fetch(authorize, { headers: cookie('u_test_1'), redirect: 'manual' });
  assert.equal(consent.status, 200);
  assert.equal(consent.headers.get('x-frame-options'), 'DENY');
  const page = await consent.text();
  assert.match(page, /Claude &lt;b&gt;/);
  assert.match(page, /claude\.ai/);

  // A redirect the client never registered is never redirected to.
  const wrong = await fetch(`${h.api}/api/oauth/authorize?${new URLSearchParams({ ...params, redirect_uri: 'https://evil.example/cb' })}`, { headers: cookie('u_test_1'), redirect: 'manual' });
  assert.equal(wrong.status, 400);

  // The Allow acts on the cookie, so another site cannot post it.
  const forged = await fetch(`${h.api}/api/oauth/authorize`, { ...form({ ...params, decision: 'allow' }), headers: { ...form({}).headers, ...cookie('u_test_1'), 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(forged.status, 403);

  const allow = async () => {
    const r = await fetch(`${h.api}/api/oauth/authorize`, { ...form({ ...params, decision: 'allow' }), headers: { ...form({}).headers, ...cookie('u_test_1'), 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 302);
    const to = new URL(r.headers.get('location'));
    assert.equal(to.origin + to.pathname, CALLBACK);
    assert.equal(to.searchParams.get('state'), 'st8');
    return to.searchParams.get('code');
  };

  // A wrong verifier is refused, and the code is spent by the attempt.
  const code1 = await allow();
  const token = (code, v) => fetch(`${h.api}/api/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id, code_verifier: v }));
  assert.equal((await token(code1, pkce().verifier)).status, 400);
  assert.equal((await token(code1, verifier)).status, 400);

  // The right one, once.
  const code2 = await allow();
  const ok = await token(code2, verifier);
  assert.equal(ok.status, 200);
  const tok = await ok.json();
  assert.equal(tok.token_type, 'Bearer');
  assert.equal((await token(code2, verifier)).status, 400, 'a code is one-shot');

  const me = await fetch(`${h.api}/api/me`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  assert.equal(me.status, 200);
  // A refresh token is not a session.
  assert.equal((await fetch(`${h.api}/api/me`, { headers: { Authorization: `Bearer ${tok.refresh_token}` } })).status, 401);

  // Refresh: needs the client it was issued to, and gives a working token.
  const refresh = (rt, cid = client_id) => fetch(`${h.api}/api/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: rt, client_id: cid }));
  assert.equal((await refresh(tok.refresh_token, 'someone-else')).status, 400);
  const r2 = await refresh(tok.refresh_token);
  assert.equal(r2.status, 200);
  const tok2 = await r2.json();
  assert.equal((await fetch(`${h.api}/api/me`, { headers: { Authorization: `Bearer ${tok2.access_token}` } })).status, 200);

  // "Sign out everywhere" ends the access token and the refresh token alike.
  const lo = await fetch(`${h.api}/api/logout/all`, { method: 'POST', headers: { Authorization: `Bearer ${tok2.access_token}` } });
  assert.equal(lo.status, 200);
  assert.equal((await fetch(`${h.api}/api/me`, { headers: { Authorization: `Bearer ${tok2.access_token}` } })).status, 401);
  assert.equal((await refresh(tok2.refresh_token)).status, 400);
});

test('deny goes back to the client with access_denied', async t => {
  const h = await startServer(t);
  const { client_id } = await (await fetch(`${h.api}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK] }) })).json();
  const { challenge } = pkce();
  const r = await fetch(`${h.api}/api/oauth/authorize`, {
    ...form({ client_id, redirect_uri: CALLBACK, response_type: 'code', state: 's', code_challenge: challenge, code_challenge_method: 'S256', decision: 'deny' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie('u_test_1'), 'Sec-Fetch-Site': 'same-origin' }
  });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'access_denied');
});
