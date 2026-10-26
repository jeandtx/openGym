// The MCP endpoint over Streamable HTTP (src/http.js), as the Vercel function serves it at
// /api/mcp: an MCP client connects with a Bearer token, and every read and write goes through the
// real api/server.js (a child process on a temp data directory) with that token. Two profiles,
// to show a request only ever sees its own token's. Needs api/'s dependencies, like the other e2e.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHandler } from '../src/http.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const API = path.join(HERE, '..', '..', 'api')
const HAVE_API = fs.existsSync(path.join(API, 'node_modules', '@simplewebauthn', 'server'))
if (!HAVE_API && process.env.CI) throw new Error('api/node_modules is missing: run `npm ci` in api/ before the MCP tests in CI')

const SECRET = crypto.randomBytes(32).toString('hex')
const mint = uid => { const p = `${uid}:${Date.now() + 86400000}:0`; return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url') }
const doc = (name) => ({
  unit: 'kg', routines: [{ id: 'r1', name, ex: [{ id: '0025', sets: 3, reps: 5, mode: 'reps' }] }],
  week: {}, dayPlan: {}, workouts: [], exWeights: {}, customEx: [], bodyweight: [], deleted: {}, edited: {}, _rev: 1, _wid: 'w0',
})

let api, dataDir, mcp, url, log = ''
const stored = uid => JSON.parse(fs.readFileSync(path.join(dataDir, `state-${uid}.json`), 'utf8'))
async function connect(token) {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer ' + token } } }))
  return client
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  if (r.isError) throw new Error(r.content[0].text)
  return JSON.parse(r.content[0].text)
}

describe.skipIf(!HAVE_API)('the MCP endpoint over HTTP', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-http-'))
    fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 })
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'ua', name: 'A', created: new Date().toISOString() }, { id: 'ub', name: 'B', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dataDir, 'state-ua.json'), JSON.stringify(doc('Push of A')))
    fs.writeFileSync(path.join(dataDir, 'state-ub.json'), JSON.stringify(doc('Pull of B')))
    api = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } })
    api.stderr.on('data', d => { log += d })
    const port = await new Promise((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('server never announced a port:\n' + log)), 20000)
      api.stdout.on('data', d => { log += d; const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(give); resolve(+m[1]) } })
      api.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${log}`)) })
    })
    mcp = http.createServer(createHandler({ base: `http://127.0.0.1:${port}` }))
    await new Promise(r => mcp.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${mcp.address().port}/api/mcp`
  }, 30000)
  afterAll(() => {
    mcp?.close()
    api?.kill('SIGKILL')
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('no token, or one the api refuses, is a 401 the client can act on', async () => {
    const none = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/)
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ua:1:0.forged' }, body: '{}' })
    expect(bad.status).toBe(401)
  })

  test('each token reads its own profile, and writes land in it', async () => {
    const a = await connect(mint('ua'))
    const b = await connect(mint('ub'))
    expect((await a.listTools()).tools.length).toBe(17)
    expect((await call(a, 'list_routines')).routines.map(r => r.name)).toEqual(['Push of A'])
    expect((await call(b, 'list_routines')).routines.map(r => r.name)).toEqual(['Pull of B'])
    // two at once: one instance serves them one after the other, never mixed
    const [ra, rb] = await Promise.all([call(a, 'log_bodyweight', { weight: 80 }), call(b, 'log_bodyweight', { weight: 70 })])
    expect(ra).toMatchObject({ logged: true, weight: 80 })
    expect(rb).toMatchObject({ logged: true, weight: 70 })
    expect(stored('ua').bodyweight.map(x => x.w)).toEqual([80])
    expect(stored('ub').bodyweight.map(x => x.w)).toEqual([70])
    const plan = await call(a, 'apply_plan_changes', { summary: 'more sets', changes: [{ type: 'sets', routine_id: 'r1', exercise_id: '0025', before: 3, after: 4 }] })
    expect(plan.applied).toBe(true)
    expect(stored('ua').routines[0].ex[0].sets).toBe(4)
    expect(stored('ub').routines[0].ex[0].sets).toBe(3)
    await a.close(); await b.close()
  })
})
