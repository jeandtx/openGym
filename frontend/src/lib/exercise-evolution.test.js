import { describe, it, expect } from 'vitest'
import { exerciseEvolution, exerciseIndex, trendOf, slopeOf } from './exercise-evolution.js'
import { estimate1RM } from './onerm.js'

const DAY = 86400000
const T = Date.UTC(2026, 8, 1, 10)
const wk = (i, sets, extra = {}) => ({
  id: 'w' + i, d: new Date(T + i * 7 * DAY).toISOString().slice(0, 10), start: T + i * 7 * DAY, name: 'Legs',
  entries: [{ id: 'squat', target: {}, sets: sets.map(([w, r, more]) => ({ w, r, done: true, ...more })), ...extra }],
})

const S = workouts => ({ unit: 'kg', workouts })

describe('trendOf', () => {
  it('reads a rising, falling and flat series', () => {
    expect(trendOf([{ t: 0, y: 100 }, { t: 1, y: 105 }, { t: 2, y: 110 }]).dir).toBe('up')
    expect(trendOf([{ t: 0, y: 100 }, { t: 1, y: 95 }, { t: 2, y: 90 }]).dir).toBe('down')
    expect(trendOf([{ t: 0, y: 100 }, { t: 1, y: 101 }, { t: 2, y: 100 }]).dir).toBe('flat')
  })
  it('fits a line, so one bad last day does not flip a rising period', () => {
    const tr = trendOf([{ t: 0, y: 80 }, { t: 1, y: 84 }, { t: 2, y: 88 }, { t: 3, y: 92 }, { t: 4, y: 85 }])
    expect(tr.dir).toBe('up')
    expect(tr.change).toBeGreaterThan(0)
  })
  it('needs two points', () => {
    expect(trendOf([{ t: 0, y: 1 }])).toBe(null)
    expect(slopeOf([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBe(null)
  })
})

describe('exerciseEvolution', () => {
  it('tracks the estimated 1RM, session by session, with the change from the one before', () => {
    const s = S([wk(0, [[60, 8], [60, 8]]), wk(1, [[65, 8], [65, 7]]), wk(2, [[70, 6]])])
    const ev = exerciseEvolution(s, 'squat', { formula: 'epley' })
    expect(ev.key).toBe('e1rm')
    expect(ev.sessions.map(x => x.id)).toEqual(['w0', 'w1', 'w2'])
    expect(ev.sessions[1].e1rm).toBeCloseTo(estimate1RM(65, 8, 'epley'))
    expect(ev.sessions[1].e1rmFrom).toEqual({ w: 65, r: 8 })
    expect(ev.sessions[0].delta).toBe(null)
    expect(ev.sessions[2].delta.key).toBeCloseTo(estimate1RM(70, 6, 'epley') - estimate1RM(65, 8, 'epley'))
    expect(ev.sessions[1].delta.volume).toBe(65 * 15 - 60 * 16)
    expect(ev.sessions[1].reps).toBe(15)
    expect(ev.trend.dir).toBe('up')
    expect(ev.best.id).toBe('w2')
    expect(ev.sessions.filter(x => x.pr).map(x => x.id)).toEqual(['w2'])
  })

  it('leaves warm-ups out and averages the rated effort', () => {
    const s = S([wk(0, [[20, 10, { phase: 'warmup' }], [60, 8, { rpe: 8 }], [60, 8, { rir: 1 }]])])
    const [one] = exerciseEvolution(s, 'squat').sessions
    expect(one.reps).toBe(16)
    expect(one.effortRir).toBe(1.5)
    expect(one.volume).toBe(960)
  })

  it('lists a session kept out of progression but leaves it out of the deltas, the best and the trend', () => {
    const s = S([wk(0, [[60, 8]]), wk(1, [[30, 10]], { noProg: true }), wk(2, [[62.5, 8]])])
    const ev = exerciseEvolution(s, 'squat')
    expect(ev.sessions.map(x => x.excluded)).toEqual([false, true, false])
    expect(ev.sessions[1].delta).toBe(null)
    expect(ev.sessions[2].prev.id).toBe('w0')
    expect(ev.trend.dir).toBe('up')
  })

  it('cuts the list at `since` but still compares the first session shown with the one before', () => {
    const s = S([wk(0, [[60, 8]]), wk(1, [[62.5, 8]]), wk(2, [[65, 8]])])
    const ev = exerciseEvolution(s, 'squat', { since: T + 7 * DAY })
    expect(ev.sessions.map(x => x.id)).toEqual(['w1', 'w2'])
    expect(ev.sessions[0].prev.id).toBe('w0')
    expect(ev.total).toBe(3)
    const two = exerciseEvolution(s, 'squat', { last: 2 })
    expect(two.sessions.map(x => x.id)).toEqual(['w1', 'w2'])
  })

  it('follows the most reps on a bodyweight move and the longest hold on a timed one', () => {
    const pull = S([
      { id: 'a', d: '2026-09-01', start: T, entries: [{ id: 'pullup', target: {}, sets: [{ w: 0, r: 8, done: true }] }] },
      { id: 'b', d: '2026-09-08', start: T + 7 * DAY, entries: [{ id: 'pullup', target: {}, sets: [{ w: 0, r: 10, done: true }] }] },
    ])
    const ev = exerciseEvolution(pull, 'pullup')
    expect(ev.key).toBe('reps')
    expect(ev.sessions[1].delta.key).toBe(2)
    const plank = S([
      { id: 'a', d: '2026-09-01', start: T, entries: [{ id: 'plank', target: { mode: 'time' }, sets: [{ sec: 45, done: true }] }] },
      { id: 'b', d: '2026-09-08', start: T + 7 * DAY, entries: [{ id: 'plank', target: { mode: 'time' }, sets: [{ sec: 60, done: true }] }] },
    ])
    const hold = exerciseEvolution(plank, 'plank')
    expect(hold.key).toBe('sec')
    expect(hold.sessions[1].e1rm).toBe(null)
    expect(hold.sessions[1].delta.key).toBe(15)
  })

  it('is empty for an exercise never logged', () => {
    const ev = exerciseEvolution(S([]), 'squat')
    expect(ev.sessions).toEqual([])
    expect(ev.trend).toBe(null)
    expect(ev.best).toBe(null)
  })
})

describe('exerciseIndex', () => {
  it('lists every trained exercise once per workout, most recent first', () => {
    const s = S([
      { id: 'a', d: '2026-09-01', start: T, entries: [{ id: 'squat', sets: [{ w: 60, r: 5, done: true }] }, { id: 'squat', sets: [{ w: 50, r: 5, done: true }] }] },
      { id: 'b', d: '2026-09-08', start: T + 7 * DAY, entries: [{ id: 'bench', sets: [{ w: 60, r: 5, done: true }] }, { id: 'row', sets: [{ w: 20, r: 5, phase: 'warmup', done: true }] }] },
    ])
    expect(exerciseIndex(s)).toEqual([
      { id: 'bench', sessions: 1, lastT: T + 7 * DAY, lastD: '2026-09-08' },
      { id: 'squat', sessions: 1, lastT: T, lastD: '2026-09-01' },
    ])
  })
})
