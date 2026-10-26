// The plan and body-weight write tools: the pure halves (plan-tools.js applyWeighIn,
// applyPlanChanges, revertPlan, scheduleWeek) against small hand-built profiles, then the tools
// end to end against a stand-in for the api (the same shape as write-tools.test.js), for what
// the PUT carries and how a conflict is retried.
import { describe, test, expect, afterEach } from 'vitest'
import http from 'node:http'
import { applyWeighIn, applyPlanChanges, revertPlan, scheduleWeek, logBodyweight, applyPlanChangesTool, scheduleWeekTool, revertLastPlanChange } from '../src/plan-tools.js'
import { _seedStateForTests } from '../src/state.js'
import { queueOf, queueRemaining } from '../../frontend/src/lib/queue.js'

const TODAY = '2026-10-26'                      // a Monday
const NOW = new Date(TODAY + 'T09:00:00').getTime()
const opts = { now: NOW, today: TODAY }

const profile = () => ({
  unit: 'kg',
  targetW: 78,
  bodyweight: [{ d: '2026-10-20', w: 80, t: 1 }],
  routines: [
    { id: 'push', name: 'Push', ex: [{ id: '0025', sets: 4, reps: 8, mode: 'reps' }, { id: '0334', sets: 3, reps: 12, mode: 'reps' }] },
    { id: 'pull', name: 'Pull', ex: [{ id: '0027', sets: 4, reps: 8, mode: 'reps' }] },
  ],
  week: { 1: ['push'], 4: ['pull'] },
  dayPlan: {},
  workouts: [],
  customEx: [],
})

describe('applyWeighIn', () => {
  test('logs today in the profile\'s unit, converting what was said in the other one', () => {
    const S = profile()
    const r = applyWeighIn(S, { weight: 176, unit: 'lb' }, opts)
    expect(r.changed).toBe(true)
    expect(r.result).toMatchObject({ logged: true, status: 'added', date: TODAY, weight: 79.8, unit: 'kg', goal: 78 })
    expect(S.bodyweight.at(-1)).toEqual({ d: TODAY, w: 79.8, t: NOW })
  })

  test('a second weigh-in that day replaces it; the same weight again changes nothing', () => {
    const S = profile()
    expect(applyWeighIn(S, { weight: 79.4, date: '2026-10-20' }, opts).result).toMatchObject({ status: 'replaced', replaced: 80 })
    expect(applyWeighIn(S, { weight: 79.4, date: '2026-10-20' }, opts)).toMatchObject({ changed: false, result: { logged: false, status: 'same' } })
  })

  test('refuses a date in the future', () => {
    expect(() => applyWeighIn(profile(), { weight: 80, date: '2026-10-27' }, opts)).toThrow(/future/)
  })
})

describe('applyPlanChanges', () => {
  test('applies the whole set, resolving exercise names, and reports the new routine', () => {
    const S = profile()
    const r = applyPlanChanges(S, {
      summary: 'monthly review',
      changes: [
        { type: 'sets', routine_id: 'push', exercise_id: '0025', before: 4, after: 5 },
        { type: 'swap-exercise', routine_id: 'push', exercise_id: '0334', after: { id: 'cable lateral raise' } },
        { type: 'add-routine', after: { name: 'Legs', ex: [{ id: '0043', sets: 5, reps: 5 }] } },
      ],
    }, opts)
    expect(r.changed).toBe(true)
    expect(r.result.applied).toBe(true)
    expect(r.result.changes.map(c => c.type)).toEqual(['sets', 'swap-exercise', 'add-routine'])
    expect(S.routines[0].ex[0].sets).toBe(5)
    expect(S.routines[0].ex[1].id).not.toBe('0334')
    expect(S.routines[0].ex[1]).toMatchObject({ sets: 3, reps: 12 })      // the swap keeps the prescription
    const legs = S.routines.find(x => x.name === 'Legs')
    expect(r.result.new_routines).toEqual([{ id: legs.id, name: 'Legs' }])
    expect(legs.ex[0]).toMatchObject({ id: '0043', sets: 5, reps: 5 })
    // the Coach's log and snapshot: the change is on record, and it can be undone
    expect(S.coach.log.at(-1)).toMatchObject({ kind: 'review', summary: 'monthly review' })
    expect(S.coach.snapshots).toHaveLength(1)
  })

  test('a `before` the plan no longer holds applies nothing at all', () => {
    const S = profile()
    const r = applyPlanChanges(S, {
      summary: 's',
      changes: [
        { type: 'reps', routine_id: 'pull', exercise_id: '0027', before: 8, after: 6 },
        { type: 'sets', routine_id: 'push', exercise_id: '0025', before: 3, after: 5 },
      ],
    }, opts)
    expect(r.changed).toBe(false)
    expect(r.result.applied).toBe(false)
    expect(r.result.stale).toEqual([expect.objectContaining({ change: 1, type: 'sets' })])
    expect(S.routines[1].ex[0].reps).toBe(8)
  })

  test('a name that means several exercises is a question, not a guess', () => {
    const S = profile()
    const r = applyPlanChanges(S, { summary: 's', changes: [{ type: 'add-exercise', routine_id: 'pull', after: { id: 'pull up', sets: 3, reps: 8 } }] }, opts)
    expect(r.changed).toBe(false)
    expect(r.result.problems[0]).toMatchObject({ change: 0, where: 'after.id', exercise: 'pull up' })
    expect(r.result.problems[0].candidates.map(c => c.id)).toContain('0652')
    expect(S.routines[1].ex).toHaveLength(1)
  })

  test('a change naming a routine that is not there fails whole', () => {
    const r = applyPlanChanges(profile(), { summary: 's', changes: [{ type: 'rename-routine', routine_id: 'nope', after: 'X' }] }, opts)
    expect(r).toMatchObject({ changed: false, result: { applied: false } })
    expect(r.result.stale).toHaveLength(1)
  })

  test('dry_run describes the set and asks for no write', () => {
    const S = profile()
    const r = applyPlanChanges(S, { summary: 's', dry_run: true, changes: [{ type: 'week', weekday: 3, after: 'pull' }] }, opts)
    expect(r.changed).toBe(false)
    expect(r.result).toMatchObject({ applied: false, dry_run: true })
    expect(r.result.changes[0]).toMatchObject({ type: 'week', before: 'Rest', after: 'Pull' })
  })

  test('revertPlan puts routines and week back, and says when there is nothing to undo', () => {
    const S = profile()
    const before = structuredClone({ routines: S.routines, week: S.week })
    applyPlanChanges(S, { summary: 's', changes: [{ type: 'week', weekday: 1, after: 'rest' }, { type: 'remove-routine', routine_id: 'pull' }] }, opts)
    expect(S.week[1]).toBeUndefined()
    expect(revertPlan(S)).toMatchObject({ changed: true, result: { reverted: true, left_to_revert: 0 } })
    expect({ routines: S.routines, week: S.week }).toEqual(before)
    expect(revertPlan(S)).toMatchObject({ changed: false, result: { reverted: false } })
  })
})

describe('scheduleWeek', () => {
  test('writes the coach week: sessions in order, counting from the start date, pins on their dates', () => {
    const S = profile()
    const r = scheduleWeek(S, { sessions: ['pull', 'Push'], starts_on: '2026-10-28', label: 'W44', pins: [{ routine_id: 'push', date: '2026-10-30' }] }, opts)
    expect(r.changed).toBe(true)
    expect(S.queue).toEqual({ ids: ['pull', 'push'], since: new Date('2026-10-28T00:00:00').getTime(), startsOn: '2026-10-28', label: 'W44' })
    expect(S.dayPlan).toEqual({ '2026-10-30': 'push' })
    expect(queueOf(S).ids).toEqual(['pull', 'push'])
    expect(r.result.sessions).toEqual([
      { order: 1, routine_id: 'pull', routine_name: 'Pull', pinned_to: null },
      { order: 2, routine_id: 'push', routine_name: 'Push', pinned_to: '2026-10-30' },
    ])
    expect(r.result.waiting).toBe(true)
    // the weekday plan still offers its own routines: said, not silently doubled up
    expect(r.result.weekday_plan_still_active.map(d => d.weekday_name)).toEqual(['Monday', 'Thursday'])
  })

  test('a session trained before the week starts does not count for it', () => {
    const S = profile()
    scheduleWeek(S, { sessions: ['pull'], starts_on: '2026-10-28' }, opts)
    S.workouts.push({ id: 'w1', d: TODAY, name: 'Pull', routineId: 'pull', start: NOW + 3600000, end: NOW + 7200000, entries: [] })
    expect(queueRemaining(S)).toEqual(['pull'])
  })

  test('refuses an unknown or repeated routine, a past start, and a pin outside the week', () => {
    expect(() => scheduleWeek(profile(), { sessions: ['legs'] }, opts)).toThrow(/no routine "legs"/)
    expect(() => scheduleWeek(profile(), { sessions: ['push', 'push'] }, opts)).toThrow(/twice/)
    expect(() => scheduleWeek(profile(), { sessions: ['push'], starts_on: '2026-10-25' }, opts)).toThrow(/past/)
    expect(() => scheduleWeek(profile(), { sessions: ['push'], pins: [{ routine_id: 'pull', date: TODAY }] }, opts)).toThrow(/not one of the week/)
    expect(() => scheduleWeek(profile(), { sessions: ['push'], pins: [{ routine_id: 'push', date: '2026-11-20' }] }, opts)).toThrow(/outside the week/)
  })

  test('a week still running, the in-app rotation, or a date with its own plan is only replaced when asked', () => {
    const S = profile()
    scheduleWeek(S, { sessions: ['push', 'pull'], pins: [{ routine_id: 'pull', date: '2026-10-29' }] }, opts)
    expect(() => scheduleWeek(S, { sessions: ['pull'] }, opts)).toThrow(/still running/)
    scheduleWeek(S, { sessions: ['pull'], replace: true }, opts)
    expect(S.queue.ids).toEqual(['pull'])
    expect(S.dayPlan).toEqual({})                                     // the old week's pin went with it

    const R = profile()
    R.queue = { ids: ['push'], since: 0, startsOn: '2026-10-01', label: 'Loop', rotationId: 'rot1' }
    expect(() => scheduleWeek(R, { sessions: ['pull'] }, opts)).toThrow(/rotation/)
    expect(() => scheduleWeek(R, { clear: true }, opts)).toThrow(/rotation/)

    const D = profile()
    D.dayPlan = { '2026-10-27': 'rest' }
    expect(() => scheduleWeek(D, { sessions: ['push'], pins: [{ routine_id: 'push', date: '2026-10-27' }] }, opts)).toThrow(/its own plan/)
  })

  test('clear ends the coach week and its future pins', () => {
    const S = profile()
    scheduleWeek(S, { sessions: ['push'], pins: [{ routine_id: 'push', date: '2026-10-27' }] }, opts)
    expect(scheduleWeek(S, { clear: true }, opts)).toMatchObject({ changed: true, result: { cleared: true } })
    expect(S.queue).toBeNull()
    expect(S.dayPlan).toEqual({})
    expect(scheduleWeek(S, { clear: true }, opts)).toMatchObject({ changed: false })
  })

  test('dry_run asks for no write', () => {
    expect(scheduleWeek(profile(), { sessions: ['push'], dry_run: true }, opts)).toMatchObject({ changed: false, result: { scheduled: false, dry_run: true } })
  })
})

/* ---------- through the server ---------- */

const TOKEN = 'tok.secret-value'
let api
function stubApi(doc, { conflicts = 0 } = {}) {
  const s = { doc: structuredClone(doc), rev: 3, puts: [], conflicts }
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'not signed in' })
    if (req.url === '/api/me') return send(200, { user: { id: 'test-uid', name: 'Jean' } })
    if (req.url === '/api/data' && req.method === 'GET') return send(200, { state: s.doc, rev: s.rev })
    if (req.url === '/api/data' && req.method === 'PUT') {
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw)
      s.puts.push(body)
      if (s.conflicts > 0) {
        // another device wrote meanwhile: a weigh-in of its own lands first
        s.conflicts--
        s.doc = { ...s.doc, bodyweight: [...s.doc.bodyweight, { d: '2026-10-22', w: 79.9, t: 5 }] }
        s.rev++
        return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      }
      if (body.baseRev !== s.rev) return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      s.doc = body.state
      s.rev++
      return send(200, { ok: true, rev: s.rev })
    }
    send(404, { error: 'not found' })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    s.server = server
    s.env = { OPENGYM_URL: `http://127.0.0.1:${server.address().port}`, OPENGYM_TOKEN: TOKEN }
    resolve(s)
  }))
}
afterEach(() => api?.server.close())

describe('the write tools through the server', () => {
  test('log_bodyweight PUTs the document as sent plus the weigh-in, unstamped, over the revision read', async () => {
    _seedStateForTests(profile())
    api = await stubApi(profile())
    const r = await logBodyweight.handler({ weight: 79.5, date: '2026-10-25' }, { env: api.env })
    expect(r).toMatchObject({ logged: true, date: '2026-10-25', weight: 79.5, revision: 4 })
    expect(api.puts).toHaveLength(1)
    expect(api.puts[0].baseRev).toBe(3)
    expect(api.puts[0].stamped).toBeUndefined()
    const { bodyweight, ...rest } = api.puts[0].state
    const { bodyweight: b0, ...rest0 } = profile()
    expect(rest).toEqual(rest0)
    expect(bodyweight.map(b => b.d)).toEqual(['2026-10-20', '2026-10-25'])
  })

  test('a conflict is built again on the document the server sent back', async () => {
    _seedStateForTests(profile())
    api = await stubApi(profile(), { conflicts: 1 })
    const r = await logBodyweight.handler({ weight: 79.5, date: '2026-10-25' }, { env: api.env })
    expect(r.logged).toBe(true)
    expect(api.puts).toHaveLength(2)
    expect(api.puts[1].baseRev).toBe(4)
    expect(api.doc.bodyweight.map(b => b.d)).toEqual(['2026-10-20', '2026-10-22', '2026-10-25'])
  })

  test('nothing to change, a dry run or a refused change writes nothing', async () => {
    _seedStateForTests(profile())
    api = await stubApi(profile())
    expect(await logBodyweight.handler({ weight: 80, date: '2026-10-20' }, { env: api.env })).toMatchObject({ logged: false, status: 'same' })
    expect(await applyPlanChangesTool.handler({ summary: 's', dry_run: true, changes: [{ type: 'sets', routine_id: 'push', exercise_id: '0025', after: 5 }] }, { env: api.env })).toMatchObject({ dry_run: true })
    await expect(scheduleWeekTool.handler({ sessions: ['nope'] }, { env: api.env })).rejects.toMatchObject({ code: 'EINVAL' })
    expect(await revertLastPlanChange.handler({}, { env: api.env })).toMatchObject({ reverted: false })
    expect(api.puts).toHaveLength(0)
  })

  test('a plan change and its revert are two writes, and the second puts the plan back', async () => {
    _seedStateForTests(profile())
    api = await stubApi(profile())
    const r = await applyPlanChangesTool.handler({ summary: 'more back', changes: [{ type: 'sets', routine_id: 'pull', exercise_id: '0027', before: 4, after: 5 }] }, { env: api.env })
    expect(r).toMatchObject({ applied: true, revision: 4 })
    expect(api.doc.routines[1].ex[0].sets).toBe(5)
    expect(await revertLastPlanChange.handler({}, { env: api.env })).toMatchObject({ reverted: true, revision: 5 })
    expect(api.doc.routines[1].ex[0].sets).toBe(4)
  })

  test('a token for another profile is refused before anything is read or written', async () => {
    _seedStateForTests(profile())
    api = await stubApi(profile())
    const other = { ...api.env, OPENGYM_UID: undefined }
    // The seeded state serves 'test-uid'; the stand-in answers for the same id, so swap the id it answers.
    api.server.removeAllListeners('request')
    api.server.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 'someone-else' } })) })
    await expect(logBodyweight.handler({ weight: 79 }, { env: other })).rejects.toMatchObject({ code: 'EPROFILE' })
  })
})
