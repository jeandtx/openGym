import { describe, it, expect } from 'vitest'
import { sessionView, barValue, median, LONG_REST_SEC } from './session-view.js'

const T0 = Date.UTC(2026, 10, 2, 11, 0, 0)
const at = sec => T0 + sec * 1000

// A small legs day: a squat with a warm-up, a superset of two, a drop-set calf raise and a plank.
const legs = () => ({
  id: 'w1', d: '2026-11-02', start: T0, end: at(40 * 60),
  entries: [
    { id: 'squat', target: { restSec: 90 }, sets: [
      { phase: 'warmup', w: 20, r: 10, done: true, at: at(300) },
      { w: 60, r: 8, done: true, at: at(330), rpe: 8 },
      { w: 60, r: 8, done: true, at: at(430), rir: 1 },     // 100 s after the last: 10 s over a 90 s timer
      { w: 60, r: 6, done: true, at: at(600) },             // 170 s: a long rest
    ] },
    { id: 'rdl', sg: 'A', target: { restSec: 60 }, sets: [
      { w: 40, r: 10, done: true, at: at(800) },
      { w: 40, r: 10, done: true, at: at(950) },
    ] },
    { id: 'curl', sg: 'A', target: { restSec: 90 }, sets: [
      { w: 15, r: 12, done: true, at: at(830) },
      { w: 15, r: 12, done: true, at: at(980) },
      { w: 15, r: 12, done: false },
    ] },
    { id: 'calf', target: {}, sets: [
      { type: 'dropset', w: 35, r: 9, drops: [{ w: 10, r: 10 }], done: true, at: at(1200) },
    ] },
    { id: 'plank', target: { mode: 'time' }, sets: [
      { sec: 45, w: 0, done: true, at: at(1400) },
      { sec: 45, w: 0, done: true, at: at(1500) },
    ] },
  ],
})

describe('sessionView', () => {
  it('builds one lane per exercise with a set number that skips warm-ups', () => {
    const v = sessionView(legs(), { defaultRestSec: 90 })
    expect(v.clock).toBe(true)
    expect(v.lanes.map(l => l.id)).toEqual(['squat', 'rdl', 'curl', 'calf', 'plank'])
    expect(v.lanes[0].sets.map(s => s.n)).toEqual([null, 1, 2, 3])
    expect(v.lanes[0].sets[0].warm).toBe(true)
    // the unticked third curl drops out
    expect(v.lanes[2].sets).toHaveLength(2)
  })

  it('groups a superset into one block and counts its rest per round', () => {
    const v = sessionView(legs(), { defaultRestSec: 90 })
    expect(v.blocks.map(b => b.idxs)).toEqual([[0], [1, 2], [3], [4]])
    // the superset rests the longest of its members asked for
    expect(v.blocks[1].restSec).toBe(90)
    expect(v.totals.supersets).toBe(1)
    const ss = v.intervals.filter(iv => iv.block === 1 && iv.kind === 'rest')
    // round 1 ends on the curl at 830, round 2 starts on the rdl at 950: 120 s
    expect(ss).toHaveLength(1)
    expect(ss[0].sec).toBe(120)
    expect(ss[0].overSec).toBe(30)
  })

  it('tells rests from changes of exercise and keeps warm-up rests out of the averages', () => {
    const v = sessionView(legs(), { defaultRestSec: 90 })
    const squat = v.intervals.filter(iv => iv.block === 0)
    expect(squat.map(iv => [iv.kind, iv.sec, iv.afterWarm])).toEqual([
      ['rest', 30, true], ['rest', 100, false], ['rest', 170, false],
    ])
    expect(squat[1].overSec).toBe(10)
    expect(v.intervals.filter(iv => iv.kind === 'switch').length).toBe(3)
    // counted rests: squat 100 and 170, the superset's 120, the plank's 100
    expect(v.totals.restCount).toBe(4)
    expect(v.totals.longRests).toBe(1)
    expect(LONG_REST_SEC).toBe(120)
    expect(v.totals.restMedianSec).toBe(110)
    expect(median([1, 3, 2])).toBe(2)
    expect(v.totals.planSec).toBe(90)
  })

  it('counts volume, sets and effort from work sets only, drops included', () => {
    const v = sessionView(legs(), { defaultRestSec: 90 })
    expect(v.totals.workSets).toBe(10)
    expect(v.totals.warmSets).toBe(1)
    expect(v.lanes[3].volume).toBe(35 * 9 + 10 * 10)
    expect(v.lanes[3].sets[0].drops).toEqual([{ w: 10, r: 10 }])
    // the warm-up's 200 kg is not in the squat's volume
    expect(v.lanes[0].volume).toBe(60 * 8 * 2 + 60 * 6)
    // RPE 8 is RIR 2, plus RIR 1: average 1.5
    expect(v.totals.effortRir).toBe(1.5)
    expect(v.totals.effortN).toBe(2)
  })

  it('picks what a lane measures from its mode', () => {
    const v = sessionView(legs())
    expect(v.lanes.map(l => l.metric)).toEqual(['w', 'w', 'w', 'w', 'sec'])
    expect(barValue(v.lanes[4].sets[0], 'sec')).toBe(45)
    const pullups = sessionView({ start: T0, entries: [{ id: 'pullup', sets: [{ w: 0, r: 8, done: true, at: at(10) }] }] })
    expect(pullups.lanes[0].metric).toBe('r')
    expect(pullups.lanes[0].reps).toBe(8)
  })

  it('shares the session time between exercises tick by tick, a hold counting at least its length', () => {
    const v = sessionView(legs(), { defaultRestSec: 90 })
    const ms = Object.fromEntries(v.lanes.map(l => [l.id, l.timeMs / 1000]))
    expect(ms.squat).toBe(600)            // 0 → 600
    expect(ms.rdl + ms.curl).toBe(380)    // 600 → 980
    expect(ms.calf).toBe(220)
    expect(ms.plank).toBe(300)
    // and the lane's band starts on the tick before its block
    expect(v.lanes[1].spanFrom).toBe(at(600))
    expect(v.lanes[2].spanFrom).toBe(at(600))
    expect(v.lanes[0].avgGapSec).toBe(135)   // (100 + 170) / 2, the warm-up left out
  })

  it('does not give a forgotten pause to the next exercise', () => {
    const w = legs()
    w.entries[4].sets[1].at = at(1400 + 25 * 60)
    const v = sessionView(w)
    expect(v.lanes[4].timeMs / 1000).toBe(200)
    expect(v.intervals.at(-1).kind).toBe('break')
    expect(v.totals.restCount).toBe(3)
  })

  it('has no clock for a workout without tick times, and still lists every set', () => {
    const w = legs()
    w.entries.forEach(e => e.sets.forEach(s => { delete s.at }))
    const v = sessionView(w)
    expect(v.clock).toBe(false)
    expect(v.intervals).toEqual([])
    expect(v.rows).toHaveLength(11)
    expect(v.rows.every(r => r.gapSec == null)).toBe(true)
    expect(v.totals.restMedianSec).toBe(null)
  })

  it('lists the rows in the order they were ticked, with the gap before each', () => {
    const v = sessionView(legs())
    expect(v.rows.slice(0, 3).map(r => [r.lane.id, r.gapSec])).toEqual([['squat', 300], ['squat', 30], ['squat', 100]])
    expect(v.rows.map(r => r.set.at)).toEqual([...v.rows.map(r => r.set.at)].sort((a, b) => a - b))
  })

  it('reads a per-side set as one set, and the same exercise twice as two lanes', () => {
    const w = { start: T0, end: at(500), entries: [
      { id: 'lunge', target: {}, sets: [{ w: 14, r: 16, done: true, at: at(100),
        sides: { L: { w: 14, r: 8, done: true }, R: { w: 12, r: 8, done: true } } }] },
      { id: 'squat', target: {}, sets: [{ w: 60, r: 5, done: true, at: at(200) }] },
      { id: 'lunge', target: {}, sets: [{ w: 10, r: 10, done: true, at: at(300) }] },
    ] }
    const v = sessionView(w)
    expect(v.lanes.map(l => l.id)).toEqual(['lunge', 'squat', 'lunge'])
    expect(v.lanes[0].sets).toHaveLength(1)
    expect(v.lanes[0].volume).toBe(14 * 8 + 12 * 8)
    expect(v.totals.workSets).toBe(3)
  })

  it('survives an empty or broken workout', () => {
    expect(sessionView(null).lanes).toEqual([])
    expect(sessionView({ entries: [{ id: 'x', sets: [null, { done: false }] }] }).totals.workSets).toBe(0)
  })
})
