/* One exercise across its sessions, for the Visualize page: what each session reached, how it
 * compares with the one before, and which way the period is heading. Built on exerciseHistory
 * (the history sheet's own read of the log), so the two never disagree on what a session was.
 *
 * The number that tracks progress is the estimated 1RM when the exercise has one: the heaviest
 * single repetition the best set of the session suggests (lib/onerm.js, the profile's formula).
 * It puts load and reps on one scale, so "70 kg × 6" after "65 kg × 8" reads as the step up it
 * is. Holds, cardio, bodyweight reps and assistance machines have no estimate, and fall back on
 * the history's own number: longest hold, minutes, most reps, or the heaviest set.
 *
 * A session kept out of progression (an injury day, a technique session: entryExcluded) is
 * still listed, flagged, but takes no part in the deltas, the trend or the best — the way the
 * upstream proposal #813 keeps it out of Stats.
 *
 * Warm-up rows are excluded from every number, as everywhere else. */
import { exerciseHistory } from './exercise-history.js'
import { bestSetOf, formulaOf } from './onerm.js'
import { completedRepsOf, entriesForExercise, entryExcluded, workoutAt } from './history.js'
import { hasCompletedWork, isWarmupRow } from './workout-model.js'
import { rirOf } from './effort.js'

// Below this much change over the period (as a share of where it started), a trend reads as flat.
export const FLAT_BAND = 0.02

const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

/** Least-squares slope of y over x; null with fewer than two distinct x. */
export function slopeOf(points) {
  if (points.length < 2) return null
  const mx = mean(points.map(p => p.x)), my = mean(points.map(p => p.y))
  let num = 0, den = 0
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2 }
  return den ? num / den : null
}

/**
 * Which way a series of { t, y } points is heading: the fitted line from the first to the last
 * point, as { dir: 'up'|'down'|'flat', from, to, change, pct }. Null below two points. A fit
 * rather than last-minus-first, so one bad day at either end does not decide the verdict.
 */
export function trendOf(points, band = FLAT_BAND) {
  const pts = points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.y))
  const slope = slopeOf(pts.map(p => ({ x: p.t, y: p.y })))
  if (slope == null) return null
  const mx = mean(pts.map(p => p.t)), my = mean(pts.map(p => p.y))
  const at = t => my + slope * (t - mx)
  const from = at(pts[0].t), to = at(pts.at(-1).t)
  const change = to - from
  const pct = from > 0 ? change / from : 0
  return { dir: pct > band ? 'up' : pct < -band ? 'down' : 'flat', from, to, change, pct }
}

/**
 * @param opts.since   epoch ms; sessions before it are left out of the list and the trend
 *                     (the deltas still compare with the session before, even if older)
 * @param opts.last    keep only the last N sessions of that (0 = all)
 * @param opts.formula 1RM formula, the profile's by default
 * @returns {{ mode, metric, key: 'e1rm'|'weight'|'reps'|'sec'|'min', sessions, trend, best, total }}
 *   sessions: oldest first, [{ id, d, t, name, sets, value, e1rm, e1rmFrom, volume, reps,
 *   effortRir, excluded, pr, prev, delta: { key, value, e1rm, volume } }], `delta` null on the first
 *   counted session and on an excluded one.
 */
export function exerciseEvolution(S, exId, { since = 0, last = 0, formula = formulaOf(S) } = {}) {
  const h = exerciseHistory(S, exId, { limit: Infinity })
  const byId = new Map((S?.workouts || []).map(w => [w.id, w]))
  const all = [...h.sessions].reverse().map(s => {
    const w = byId.get(s.id)
    const entries = w ? entriesForExercise(w, exId) : []
    const excluded = entries.length > 0 && entries.every(en => entryExcluded(w, en))
    const work = (s.sets || []).filter(x => hasCompletedWork(x) && !isWarmupRow(x))
    const best = s.mode === 'reps' ? bestSetOf({ id: exId, sets: s.sets, target: s.target }, formula) : null
    const rirs = work.map(rirOf).filter(v => v != null)
    return {
      id: s.id, d: s.d, t: Number.isFinite(s.t) ? s.t : workoutAt(w), name: w?.name || '',
      mode: s.mode, target: s.target, sets: s.sets, value: s.value,
      e1rm: best ? best.est : null, e1rmFrom: best ? { w: best.w, r: best.r } : null,
      volume: s.volume, reps: work.reduce((a, x) => a + completedRepsOf(x), 0),
      effortRir: mean(rirs), excluded, pr: false, prev: null, delta: null,
    }
  })
  const counted = all.filter(s => !s.excluded)
  // The tracking number: the estimate when the exercise has one in at least two sessions.
  const key = h.mode === 'reps' && counted.filter(s => s.e1rm != null).length >= 2 ? 'e1rm' : h.metric
  const keyOf = s => (key === 'e1rm' ? s.e1rm : s.value)

  let best = null, prev = null
  for (const s of counted) {
    const y = keyOf(s)
    if (y != null && y > 0 && (!best || y > best.y)) { best = { y, id: s.id, d: s.d }; s.pr = true }
    if (prev) {
      s.prev = { id: prev.id, d: prev.d }
      const diff = (a, b) => (a != null && b != null ? a - b : null)
      s.delta = { key: diff(keyOf(s), keyOf(prev)), value: diff(s.value, prev.value), e1rm: diff(s.e1rm, prev.e1rm), volume: diff(s.volume, prev.volume) }
    }
    prev = s
  }
  // Only the session that set each new best keeps its mark until a later one beats it: the
  // last-standing record is the one shown.
  all.forEach(s => { s.pr = !!best && s.id === best.id })

  const inRange = all.filter(s => !(s.t < since))
  const sessions = last > 0 ? inRange.slice(-last) : inRange
  const trend = trendOf(sessions.filter(s => !s.excluded && keyOf(s) != null && keyOf(s) > 0).map(s => ({ t: s.t, y: keyOf(s) })))
  return { mode: h.mode, metric: h.metric, key, sessions, trend, best, total: all.length }
}

/**
 * Every exercise in the log, the most recently trained first: [{ id, sessions, lastT, lastD }].
 * An entry counts once per workout, and only with a ticked work set.
 */
export function exerciseIndex(S) {
  const map = new Map()
  for (const w of S?.workouts || []) {
    const t = workoutAt(w)
    const ids = new Set((w?.entries || []).filter(en => (en?.sets || []).some(s => hasCompletedWork(s) && !isWarmupRow(s))).map(en => en.id))
    for (const id of ids) {
      const cur = map.get(id) || { id, sessions: 0, lastT: -Infinity, lastD: null }
      cur.sessions++
      if (t > cur.lastT) { cur.lastT = t; cur.lastD = w.d }
      map.set(id, cur)
    }
  }
  return [...map.values()].sort((a, b) => b.lastT - a.lastT || a.id.localeCompare(b.id))
}
