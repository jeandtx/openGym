/* openGym MCP server — Streamable HTTP transport, for the endpoint the Vercel function serves at
   /api/mcp (scripts/vercel/api-entry.mjs), so a client connects to the app's own address:

     claude mcp add --transport http opengym https://<host>/api/mcp \
       --header "Authorization: Bearer <token>"

   The token is a paired session, the same kind the phone app holds (Settings → Account →
   "Connect Claude" mints one), or one a client got through OAuth (api/oauth.js): a claude.ai
   connector is given only this address, and the 401 below tells it where to sign in. Nothing is checked here beyond its shape: every read and write
   goes through the api with it (state.js server mode, profile-write.js), so the api's own
   session check is the one that decides — an expired token or "Sign out everywhere" answers
   401 on the first call, and a request can only ever see the profile its token signs in to.

   Stateless: a fresh server and transport per request, JSON responses rather than SSE streams
   (a serverless function holds no stream open). The state module holds one profile at a time,
   so the requests one instance serves run one after the other. */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from './server.js'
import { bindEnv, refresh } from './state.js'

// What a session token is made of (api-client.js TOKEN_CHARS).
const TOKEN = /^Bearer\s+([A-Za-z0-9._:~+/=-]+)$/i
const MAX_BODY = 1024 * 1024

let queue = Promise.resolve()
const oneAtATime = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run }

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}
// resource_metadata points an OAuth client (a claude.ai connector) at the api's discovery document,
// from which it registers and signs the user in (api/oauth.js). A client with a token ignores it.
const unauthorized = (res, base, why) => send(res, 401, { error: 'invalid_token', error_description: why },
  { 'www-authenticate': `Bearer realm="openGym", resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"` })

async function readBody(req) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > MAX_BODY) { const e = new Error('request too large'); e.status = 413; throw e }
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

/**
 * A node (req, res) handler for the MCP endpoint. `base` is the app's public address, the api
 * the tools talk to (ORIGIN); `fetchImpl` is for tests.
 */
export function createHandler({ base, fetchImpl } = {}) {
  return async (req, res) => {
    // No standing stream to offer (GET) and no session to end (DELETE): the spec's answer for a
    // server without them is 405, which clients take as "POST only". Answered before the token,
    // and never queued, since a stream opened here would hold the one-at-a-time line forever.
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only: this endpoint keeps no stream or session' }, { allow: 'POST' })
    const m = TOKEN.exec(req.headers.authorization || '')
    if (!m) return unauthorized(res, base, 'send your openGym token as "Authorization: Bearer <token>" (Settings → Account → Connect Claude)')
    let body
    try { body = await readBody(req) } catch (e) { return send(res, e.status || 400, { error: e.message }) }
    const env = { OPENGYM_URL: base, OPENGYM_TOKEN: m[1] }
    return oneAtATime(async () => {
      bindEnv(env)
      try {
        // Whose token this is, before anything else: a refused one is the client's to fix (a
        // 401 it can act on), not a tool error inside a 200.
        try { await refresh({ env, fetchImpl }) } catch (e) {
          if (e.code === 'EAUTH') return unauthorized(res, base, 'the openGym server did not accept this token: it expired or was signed out everywhere. Make a new one in Settings → Account → Connect Claude.')
          return send(res, 502, { error: `${e.code || 'ERROR'}: ${e.message}` })
        }
        const server = buildServer({ env, fetchImpl })
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        await server.connect(transport)
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
        const request = new Request(new URL(req.url, base), { method: req.method, headers, body })
        const response = await transport.handleRequest(request)
        const text = await response.text()
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(text)
        await transport.close()
        await server.close()
      } catch (e) {
        console.error(`[opengym-mcp] ${e.message}`)
        if (!res.headersSent) send(res, 500, { error: 'internal error' })
      } finally {
        bindEnv(null)
      }
    })
  }
}
