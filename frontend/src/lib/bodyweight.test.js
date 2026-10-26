import { describe, expect, it } from 'vitest'
import { weeklyWeights, weighInAt, weighInOn } from './bodyweight.js'

// Discord 'Weight': every weigh-in, week by week, with the week's mean.
describe('weeklyWeights', () => {
  // 2026-09-07 is a Monday, 2026-09-13 the Sunday after it.
  const log = [
    { d: '2026-09-01', w: 81 },
    { d: '2026-09-03', w: 80 },
    { d: '2026-09-07', w: 80.5 },
    { d: '2026-09-09', w: 79.5 },
    { d: '2026-09-13', w: 79 },
  ]

  it('groups by the profile\'s week, newest week and newest weigh-in first, with means and changes', () => {
    const weeks = weeklyWeights(log, 1)
    expect(weeks.map(w => w.key)).toEqual(['2026-09-07', '2026-08-31'])
    expect(weeks[0]).toMatchObject({ n: 3, avg: 79.66666666666667 })
    expect(weeks[0].entries.map(b => b.d)).toEqual(['2026-09-13', '2026-09-09', '2026-09-07'])
    expect(weeks[1]).toMatchObject({ n: 2, avg: 80.5, delta: null })
    expect(weeks[0].delta).toBeCloseTo(-0.8333, 3)
  })

  it('moves the boundary with a Sunday week start', () => {
    const weeks = weeklyWeights(log, 0)
    expect(weeks.map(w => [w.key, w.n])).toEqual([['2026-09-13', 1], ['2026-09-06', 2], ['2026-08-30', 2]])
  })

  it('compares with the last week that has weigh-ins, not the calendar week before', () => {
    const weeks = weeklyWeights([{ d: '2026-08-03', w: 82 }, { d: '2026-09-07', w: 80 }], 1)
    expect(weeks[0].delta).toBe(-2)
  })

  it('does not rely on the stored order and skips entries it cannot place', () => {
    const weeks = weeklyWeights([{ d: '2026-09-09', w: 79 }, { d: '2026-09-07', w: 81 }, { w: 70 }, { d: '2026-09-08', w: 0 }, null], 1)
    expect(weeks).toHaveLength(1)
    expect(weeks[0]).toMatchObject({ n: 2, avg: 80 })
    expect(weeks[0].entries.map(b => b.d)).toEqual(['2026-09-09', '2026-09-07'])
    expect(weeklyWeights(undefined, 1)).toEqual([])
  })
})

// A weigh-in logged for an earlier day is typed today, so its `t` is not on its day.
describe('weighInAt', () => {
  const at = iso => new Date(iso).getTime()

  it('keeps the time a weigh-in was typed on its own day', () => {
    expect(weighInAt({ d: '2026-09-09', w: 80, t: at('2026-09-09T07:30:00') })).toBe(at('2026-09-09T07:30:00'))
  })

  it('puts a weigh-in typed on a later day at noon of the day it is for', () => {
    expect(weighInAt({ d: '2026-03-02', w: 84, t: at('2026-09-09T07:30:00') })).toBe(at('2026-03-02T12:00:00'))
  })

  it('puts one with no time at noon of its day', () => {
    expect(weighInAt({ d: '2026-03-02', w: 84 })).toBe(at('2026-03-02T12:00:00'))
  })
})

// The MCP's log_bodyweight: a weigh-in told for a given day, not the day it is typed on.
describe('weighInOn', () => {
  const at = new Date('2026-10-26T09:00:00').getTime()

  it('adds the day in order, replaces a correction, and leaves the same weight alone', () => {
    const s = { bodyweight: [{ d: '2026-10-20', w: 80, t: 1 }, { d: '2026-10-24', w: 79.4, t: 2 }] }
    expect(weighInOn(s, '2026-10-22', 79.84, at)).toBe('added')
    expect(s.bodyweight.map(b => b.d)).toEqual(['2026-10-20', '2026-10-22', '2026-10-24'])
    expect(s.bodyweight[1]).toEqual({ d: '2026-10-22', w: 79.8, t: at })
    expect(weighInOn(s, '2026-10-24', 79.2, at)).toBe('replaced')
    expect(s.bodyweight[2]).toEqual({ d: '2026-10-24', w: 79.2, t: at })
    expect(weighInOn(s, '2026-10-20', 80, at)).toBe('same')
    expect(s.bodyweight[0].t).toBe(1)
  })

  it('refuses a weight or a day that is not one, and starts a missing list', () => {
    const s = {}
    expect(weighInOn(s, '2026-10-22', 0, at)).toBe(false)
    expect(weighInOn(s, '22/10/2026', 80, at)).toBe(false)
    expect(weighInOn(s, '2026-10-22', 80, at)).toBe('added')
    expect(s.bodyweight).toEqual([{ d: '2026-10-22', w: 80, t: at }])
  })
})
