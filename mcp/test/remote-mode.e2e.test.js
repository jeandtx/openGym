// The server mode end to end: the real api/server.js in a child process on a temp data
// directory, and the real MCP server (src/index.js) spawned by an MCP client over stdio with
// OPENGYM_URL + OPENGYM_TOKEN and no data directory, the way Claude Code runs it against an
// instance whose data is not on this machine (Vercel + Supabase). Reads come through the api,
// writes go back through it, and what the server stores is read back off its disk.
// Needs api/'s dependencies, like log-workout.e2e.test.js: skipped without them, failed in CI.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const API = path.join(HERE, '..', '..', 'api')
const HAVE_API = fs.existsSync(path.join(API, 'node_modules', '@simplewebauthn', 'server'))
if (!HAVE_API && process.env.CI) throw new Error('api/node_modules is missing: run `npm ci` in api/ before the MCP tests in CI')

const SECRET = crypto.randomBytes(32).toString('hex')
const UID = 'u_remote_1'
const payload = `${UID}:${Date.now() + 86400000}:0`
const TOKEN = payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return localIso(d) }
const at = (d, hh) => new Date(`${d}T${hh}:00`).getTime()
const session = (d, w) => ({ id: 'w-' + d, d, start: at(d, '18:00'), end: at(d, '19:00'), routineIds: ['r1'], routineId: 'r1', name: 'Push', prs: [], entries: [{ id: '0025', sets: [{ w, r: 5, done: true }, { w, r: 5, done: true }], target: null }] })
const DOC = {
  unit: 'kg', targetW: 80,
  routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps' }], _ts: 1000 }],
  week: { 1: ['r1'] }, dayPlan: {},
  workouts: [session(daysAgo(20), 95), session(daysAgo(10), 100), session(daysAgo(3), 102.5)],
  exWeights: {}, customEx: [], bodyweight: [{ d: daysAgo(10), w: 81, t: 1000 }],
  deleted: {}, edited: {},
  _rev: 5, _wid: 'w-seed', _ts: 1000,
}

let api, dataDir, base, client, log = ''
const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, `state-${UID}.json`), 'utf8'))
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content[0].text
  if (r.isError) throw new Error(text)
  return JSON.parse(text)
}

describe.skipIf(!HAVE_API)('server mode: the MCP reads and writes through the real api', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-remote-'))
    fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 })
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: UID, name: 'Jean', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dataDir, `state-${UID}.json`), JSON.stringify(DOC))
    api = spawn(process.execPath, ['server.js'], {
      cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' },
    })
    api.stderr.on('data', d => { log += d })
    const port = await new Promise((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('server never announced a port:\n' + log)), 20000)
      api.stdout.on('data', d => {
        log += d
        const m = /gym-api on :(\d+)/.exec(log)
        if (m) { clearTimeout(give); resolve(+m[1]) }
      })
      api.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${log}`)) })
    })
    base = `http://127.0.0.1:${port}`
    // No OPENGYM_DATA, and a working directory with no ./data: nothing to read but the server.
    const { OPENGYM_DATA, OPENGYM_UID, ...env } = process.env
    client = new Client({ name: 'test', version: '0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(HERE, '..', 'src', 'index.js')],
      cwd: os.tmpdir(), env: { ...env, OPENGYM_URL: base, OPENGYM_TOKEN: TOKEN }, stderr: 'pipe',
    }))
  }, 30000)
  afterAll(async () => {
    await client?.close().catch(() => {})
    api?.kill('SIGKILL')
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('every tool is listed', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining([
      'list_routines', 'list_workouts', 'training_review', 'recovery_status', 'find_exercise',
      'log_workout', 'log_bodyweight', 'apply_plan_changes', 'revert_last_plan_change', 'schedule_week',
    ]))
  })

  test('the read tools answer from the server\'s copy', async () => {
    expect((await call('list_routines')).routines.map(r => r.name)).toEqual(['Push'])
    const review = await call('training_review')
    expect(review.training.sessions).toBe(3)
    expect(review.exercises[0]).toMatchObject({ id: '0025', sessions: 3 })
  })

  test('a write lands on the server, and the next read sees it', async () => {
    const w = await call('log_bodyweight', { weight: 80.2 })
    expect(w).toMatchObject({ logged: true, weight: 80.2, revision: 6 })
    expect(stored().bodyweight.at(-1)).toMatchObject({ d: localIso(new Date()), w: 80.2 })
    expect((await call('get_bodyweight')).latest).toMatchObject({ weight: 80.2 })
  })

  test('a plan for next week: a new routine, then the week, then undo the routine', async () => {
    const p = await call('apply_plan_changes', { summary: 'monthly review', changes: [{ type: 'add-routine', after: { name: 'Pull', ex: [{ id: 'barbell bent over row', sets: 4, reps: 8 }] } }] })
    const pull = p.new_routines[0].id
    expect(stored().routines.map(r => r.name)).toEqual(['Push', 'Pull'])
    const wk = await call('schedule_week', { sessions: ['r1', pull], label: 'Next week' })
    expect(wk.sessions.map(s => s.routine_name)).toEqual(['Push', 'Pull'])
    expect(stored().queue).toMatchObject({ ids: ['r1', pull], label: 'Next week' })
    expect((await call('get_week_plan')).coach_week.sessions.map(s => s.routine_name)).toEqual(['Push', 'Pull'])
    await call('revert_last_plan_change')
    expect(stored().routines.map(r => r.name)).toEqual(['Push'])
  })

  test('a change made on another device meanwhile is read before the next answer', async () => {
    const S = stored()
    const res = await fetch(base + '/api/data', {
      method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ state: { ...S, routines: [...S.routines, { id: 'r9', name: 'Legs', ex: [{ id: '0043', sets: 5, reps: 5, mode: 'reps' }] }] }, baseRev: S._rev, baseWid: S._wid }),
    })
    expect(res.status).toBe(200)
    expect((await call('list_routines')).routines.map(r => r.name)).toEqual(['Push', 'Legs'])
  })
})
