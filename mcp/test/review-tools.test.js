// training_review, recovery_status and find_exercise against a small hand-built history, so
// every number in the review can be checked by hand, plus the demo profile for shape.
import { describe, test, expect, beforeEach } from 'vitest'
import { reviewOf, recoveryOf, REVIEW_TOOLS } from '../src/review-tools.js'
import { _seedStateForTests } from '../src/state.js'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { estimate1RM } from '../../frontend/src/lib/onerm.js'

const at = (d, h = 18) => new Date(d + 'T' + String(h).padStart(2, '0') + ':00:00').getTime()
const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra })
const session = (d, entries, extra = {}) => ({ id: 'w-' + d, d, name: 'Session', start: at(d), end: at(d) + 3600000, entries, ...extra })
const bench = sets => ({ id: '0025', sets, target: { sets: sets.length, reps: 8 } })
const row = sets => ({ id: '0027', sets, target: { sets: sets.length, reps: 8 } })

// Previous period: 2026-09-01 … 09-28. This period: 2026-09-29 … 10-26.
const history = () => ({
  unit: 'kg',
  targetW: 78,
  week: { 1: ['r1'], 4: ['r2'] },
  routines: [{ id: 'r1', name: 'A', ex: [] }, { id: 'r2', name: 'B', ex: [] }],
  bodyweight: [{ d: '2026-09-10', w: 81 }, { d: '2026-10-01', w: 80.4 }, { d: '2026-10-25', w: 79.6 }],
  customEx: [],
  workouts: [
    session('2026-09-08', [bench([set(80, 8), set(80, 8)]), row([set(60, 8)])]),
    session('2026-09-22', [bench([set(80, 8), set(80, 7)]), row([set(60, 8)])]),
    session('2026-10-01', [bench([set(40, 10, { phase: 'warmup' }), set(80, 8), set(80, 8, { rir: 2 })])]),
    session('2026-10-08', [bench([set(82.5, 8, { rir: 1 }), set(82.5, 7, { failure: true })])], { prs: ['0025'] }),
    session('2026-10-15', [bench([set(85, 6, { rir: 3 })])]),
  ],
})

describe('reviewOf', () => {
  const r = reviewOf(history(), { to: '2026-10-26' })

  test('the period and the one just before it', () => {
    expect(r.period).toEqual({ from: '2026-09-29', to: '2026-10-26', days: 28 })
    expect(r.previous_period).toEqual({ from: '2026-09-01', to: '2026-09-28' })
  })

  test('sessions, sets and effort, warm-ups left out', () => {
    expect(r.training).toMatchObject({ sessions: 3, days_trained: 3, sets_done: 5, sessions_per_week: 0.8, planned_sessions_per_week: 2, avg_duration_min: 60 })
    expect(r.training.effort).toEqual({ work_sets: 5, to_failure_pct: 20, avg_rir: 2, avg_rpe: null, rated_sets: 3 })
    expect(r.training.previous_period.sessions).toBe(2)
    expect(r.training.weeks.map(w => [w.week_start, w.sessions])).toEqual([['2026-09-28', 1], ['2026-10-05', 1], ['2026-10-12', 1]])
  })

  test('bench: best estimate against the previous period; row: dropped', () => {
    const b = r.exercises.find(e => e.id === '0025')
    const best = estimate1RM(82.5, 8)
    expect(b.sessions).toBe(3)
    expect(b.e1rm).toMatchObject({ best, best_set: '82.5 kg × 8', best_date: '2026-10-08', previous_period_best: estimate1RM(80, 8), new_all_time_best: true })
    expect(b.e1rm.change_vs_previous_pct).toBeCloseTo(((best - estimate1RM(80, 8)) / estimate1RM(80, 8)) * 100, 0)
    expect(b.trend).toBe('up')
    expect(b.last_session).toEqual({ date: '2026-10-15', top_set: '85 kg × 6' })
    expect(r.dropped_since_previous_period).toEqual([{ id: '0027', name: expect.any(String), sessions_previous_period: 2 }])
    expect(r.prs).toEqual([{ date: '2026-10-08', exercise_id: '0025', exercise: expect.any(String) }])
  })

  test('a lift trained three times without beating the previous period is stalled', () => {
    const S = history()
    S.workouts.splice(2, 3,
      session('2026-10-01', [bench([set(80, 8)])]),
      session('2026-10-08', [bench([set(80, 8)])]),
      session('2026-10-15', [bench([set(80, 7)])]))
    const x = reviewOf(S, { to: '2026-10-26' })
    expect(x.stalled).toEqual([expect.objectContaining({ id: '0025', sessions: 3, trend: 'flat' })])
  })

  test('muscles against the previous period, and body weight over the period', () => {
    const chest = r.muscles.find(m => m.slug === 'chest')
    expect(chest.effective_sets).toBeGreaterThan(0)
    expect(chest.previous_period).toBeGreaterThan(0)
    expect(r.muscles_not_trained.length).toBeGreaterThan(0)
    expect(r.bodyweight).toEqual({ goal: 78, weigh_ins: 2, first: { date: '2026-10-01', weight: 80.4 }, last: { date: '2026-10-25', weight: 79.6 }, change: -0.8, mean: 80, previous_period_mean: 81 })
  })

  test('a window given by hand, and one that runs backwards', () => {
    expect(reviewOf(history(), { from: '2026-10-01', to: '2026-10-07' }).training.sessions).toBe(1)
    expect(() => reviewOf(history(), { from: '2026-10-10', to: '2026-10-01' })).toThrow(/after/)
  })
})

describe('recoveryOf', () => {
  test('a muscle trained hard yesterday is not ready; one never trained is detraining', () => {
    const S = history()
    S.workouts.push(session('2026-10-25', [bench([set(80, 8), set(80, 8), set(80, 8), set(80, 8), set(80, 8), set(80, 8)])]))
    const r = recoveryOf(S, at('2026-10-26', 9))
    const chest = r.muscles.find(m => m.slug === 'chest')
    expect(chest.state).not.toBe('ready')
    expect(chest.retained_strength).toBe(1)
    expect(r.detraining.length).toBeGreaterThan(0)
    expect(r.muscles[0].fatigue).toBeGreaterThanOrEqual(r.muscles.at(-1).fatigue)
  })
})

describe('the tools', () => {
  const tool = name => REVIEW_TOOLS.find(t => t.name === name)
  beforeEach(() => _seedStateForTests(buildDemoState()))

  test('training_review answers on the demo profile', () => {
    const r = tool('training_review').handler({})
    expect(r.training.sessions).toBeGreaterThan(0)
    expect(r.exercises.length).toBeGreaterThan(0)
    expect(r.exercises.length).toBeLessThanOrEqual(15)
  })

  test('find_exercise: one match, or candidates', () => {
    expect(tool('find_exercise').handler({ name: 'barbell bench press' })).toMatchObject({ found: true, id: '0025' })
    const many = tool('find_exercise').handler({ name: 'pull up' })
    expect(many.found).toBe(false)
    expect(many.candidates.map(c => c.id)).toContain('0652')
  })

  test('recovery_status lists every muscle', () => {
    const r = tool('recovery_status').handler({})
    expect(r.muscles.length).toBeGreaterThan(10)
    expect(['ready', 'recovering', 'fatigued']).toContain(r.muscles[0].state)
  })
})
