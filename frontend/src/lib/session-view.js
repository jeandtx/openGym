/* One saved workout read back for the Visualize page: the tiles at the top, the timeline of
 * every ticked set on the session's own clock with the rest between them, one lane per exercise
 * and every set in order. Pure, so the page and the tests read the same numbers.
 *
 * Every ticked set carries the time it was ticked (`at`, Workout.jsx, the same stamp
 * finish-workout.js ends a session on). That is all the timeline needs: nothing new is logged.
 * A workout without those times (imported, logged after the fact, or from a build that did not
 * stamp sets) has no clock: `clock` is false, and only the cards and the table are shown.
 *
 * How the time on an exercise is counted follows the rule the "time per exercise" proposal
 * upstream (#812) uses, so both read the same: the time up to each tick goes to that set's
 * exercise — from the start to the first tick, then from tick to tick — a timed row counts at
 * least its own length, and a pause longer than FORGOTTEN_GAP_MS is a break that counts for none.
 *
 * Rest is measured between ROUNDS: a plain exercise's round is one set, a superset's round is the
 * n-th set of each of its members, and it ends on the last of them, which is when the rest timer
 * starts. Two rounds of the same block in a row are a rest, measured against the timer the
 * workout itself would have run (restSecFor); a round of another block is a change of exercise,
 * which has no timer to be held against. A rest after a warm-up round is shown but kept out of
 * the averages, since warm-up rests are meant to be short.
 *
 * Warm-up rows are never counted as work sets, in volume or in effort, as everywhere else. */
import { isWarmupRow, hasCompletedWork, completedVolumeOf, modeForSet, isSideSet, dropsOf } from './workout-model.js'
import { supersetUnits, workoutVolume, workoutDuration } from './history.js'
import { restSecFor } from './supersetFlow.js'
import { FORGOTTEN_GAP_MS } from './finish-workout.js'
import { volumeFactor } from './dumbbells.js'
import { rirOf } from './effort.js'

// A rest past this reads as a long one in the tiles (the "Rest > 2:00" count).
export const LONG_REST_SEC = 120

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const stamp = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

// How long a ticked row itself took: a hold its seconds (both sides of a per-side hold), cardio
// its minutes. The same reach finish-workout.js gives a row.
function rowLengthMs(set) {
  const n = v => (Number(v) > 0 ? Number(v) : 0)
  if (isSideSet(set)) return (n(set.sides.L?.sec) + n(set.sides.R?.sec)) * 1000
  return n(set.min) * 60000 + n(set.sec) * 1000
}

export const median = values => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

// What a lane's bars measure: kilos for loaded rep work, reps for rep work never loaded (a
// pull-up), seconds for a hold, minutes for cardio. Decided from the work sets, so a loaded
// warm-up on a bodyweight move does not turn the whole card into kilos.
function laneMetric(sets) {
  const pool = sets.some(s => !s.warm) ? sets.filter(s => !s.warm) : sets
  if (pool.some(s => s.mode === 'cardio')) return 'min'
  if (pool.some(s => s.mode === 'time')) return 'sec'
  return pool.some(s => s.w > 0) ? 'w' : 'r'
}

/** The value a set's bar is drawn at, in its lane's metric. */
export const barValue = (set, metric) =>
  metric === 'min' ? set.min : metric === 'sec' ? set.sec : metric === 'r' ? set.r : set.w

/**
 * @param w  a saved workout ({ start, end, entries: [{ id, target, sg, sets }] })
 * @param opts.defaultRestSec  the profile's rest timer (S.restSec), for exercises without their own
 * @returns {{
 *   clock: boolean, t0: number|null, t1: number|null, durationMs: number,
 *   blocks: [{ b, idxs, superset, restSec }],
 *   lanes: [{ idx, id, entry, block, metric, sets, volume, reps, sec, min, timeMs, spanFrom, spanTo, avgGapSec }],
 *   intervals: [{ from, to, sec, kind: 'rest'|'switch'|'break', block, afterWarm, planSec, overSec, round }],
 *   rows: [{ lane, set, gapSec }],
 *   totals: { workSets, warmSets, volume, supersets, restMedianSec, restAvgSec, restCount, longRests, planSec, effortRir, effortN }
 * }}
 * A lane's set: { i, n, warm, mode, at, w, r, sec, min, drops: [{ w, r }], rir, volume, row }.
 * `n` is the set's number among the exercise's working sets (null on a warm-up); a work row left
 * unticked keeps its number, so set 4 never reads as set 3.
 */
export function sessionView(w, { defaultRestSec = 0 } = {}) {
  const entries = Array.isArray(w?.entries) ? w.entries : []
  const units = supersetUnits(entries)
  const blocks = units.map((idxs, b) => ({ b, idxs, superset: idxs.length > 1, restSec: restSecFor(entries, idxs, num(defaultRestSec)) || 0 }))
  const blockOf = []
  blocks.forEach(B => B.idxs.forEach(i => { blockOf[i] = B.b }))

  const lanes = entries.map((entry, idx) => {
    const target = entry?.target || {}
    const factor = volumeFactor(entry)
    const sets = []
    let n = 0
    ;(Array.isArray(entry?.sets) ? entry.sets : []).forEach((row, i) => {
      const warm = isWarmupRow(row)
      if (!warm) n++
      if (!hasCompletedWork(row)) return
      const mode = modeForSet(row, target)
      // A per-side row carries its headline on the row itself (max weight, reps of both sides).
      const drops = (isSideSet(row) ? [] : dropsOf(row))
        .map(d => ({ w: num(d?.w), r: num(d?.r) })).filter(d => d.r > 0)
      sets.push({
        i, n: warm ? null : n, warm, mode, at: stamp(row.at),
        w: num(row.w), r: num(row.r), sec: num(row.sec), min: num(row.min), drops,
        rir: rirOf(row), volume: mode === 'reps' ? completedVolumeOf(row) * factor : 0, row,
      })
    })
    const work = sets.filter(s => !s.warm)
    return {
      idx, id: entry?.id, entry, block: blockOf[idx], metric: laneMetric(sets), sets,
      volume: sets.reduce((a, s) => a + (s.warm ? 0 : s.volume), 0),
      reps: work.reduce((a, s) => a + s.r + s.drops.reduce((x, d) => x + d.r, 0), 0),
      sec: work.reduce((a, s) => a + s.sec, 0),
      min: work.reduce((a, s) => a + s.min, 0),
      timeMs: 0, spanFrom: null, spanTo: null, avgGapSec: null,
    }
  }).filter(l => l.sets.length)

  // ---- the clock: every ticked set, oldest first
  const ticks = lanes.flatMap(l => l.sets.filter(s => s.at != null).map(s => ({ lane: l, set: s, at: s.at })))
    .sort((a, b) => a.at - b.at)
  const start = stamp(w?.start)
  const clock = ticks.length > 0 && start != null
  const t0 = clock ? Math.min(start, ticks[0].at) : null
  const end = stamp(w?.end)
  const t1 = clock ? Math.max(end != null && end - ticks.at(-1).at <= FORGOTTEN_GAP_MS ? end : 0, ticks.at(-1).at) : null

  const intervals = []
  if (clock) {
    // Time on each exercise (#812's rule).
    let prev = t0
    for (const { lane, set, at } of ticks) {
      const dt = at - prev
      if (dt >= 0 && dt <= FORGOTTEN_GAP_MS) lane.timeMs += Math.max(dt, rowLengthMs(set.row))
      prev = Math.max(prev, at)
    }
    // The band behind a lane: from the tick before its block began (or the start) to its last set.
    lanes.forEach(l => {
      const own = l.sets.filter(s => s.at != null)
      if (!own.length) return
      const blockTicks = ticks.filter(x => x.lane.block === l.block).map(x => x.at)
      const first = Math.min(...blockTicks)
      const before = ticks.filter(x => x.at < first).map(x => x.at)
      l.spanFrom = before.length ? Math.max(t0, before.at(-1)) : t0
      l.spanTo = own.at(-1).at
      const workAt = own.filter(s => !s.warm).map(s => s.at)
      const gaps = workAt.slice(1).map((at, j) => (at - workAt[j]) / 1000)
      l.avgGapSec = mean(gaps)
    })
    // Rounds: the k-th ticked set of each member of a block.
    const rounds = []
    blocks.forEach(B => {
      const members = lanes.filter(l => l.block === B.b).map(l => l.sets.filter(s => s.at != null))
      const most = Math.max(0, ...members.map(m => m.length))
      for (let k = 0; k < most; k++) {
        const sets = members.map(m => m[k]).filter(Boolean)
        rounds.push({ block: B.b, k, start: Math.min(...sets.map(s => s.at)), end: Math.max(...sets.map(s => s.at)), warm: sets.every(s => s.warm) })
      }
    })
    rounds.sort((a, b) => a.start - b.start)
    rounds.forEach((r, j) => {
      if (!j) return
      const p = rounds[j - 1]
      const from = p.end, to = Math.max(p.end, r.start)
      const sec = (to - from) / 1000
      const kind = to - from > FORGOTTEN_GAP_MS ? 'break' : p.block === r.block ? 'rest' : 'switch'
      const planSec = kind === 'rest' ? blocks[r.block].restSec : 0
      intervals.push({
        from, to, sec, kind, block: r.block, round: r.k, afterWarm: p.warm,
        planSec, overSec: planSec > 0 ? Math.max(0, sec - planSec) : 0,
      })
    })
  }

  // ---- every set, in the order it was ticked (unticked times last, in log order)
  const all = lanes.flatMap(l => l.sets.map(s => ({ lane: l, set: s })))
  const stamped = all.filter(x => x.set.at != null).sort((a, b) => a.set.at - b.set.at)
  let prevAt = t0
  const rows = [...stamped, ...all.filter(x => x.set.at == null)].map(x => {
    const gapSec = x.set.at != null && prevAt != null ? Math.max(0, (x.set.at - prevAt) / 1000) : null
    if (x.set.at != null) prevAt = x.set.at
    return { ...x, gapSec }
  })

  // ---- tiles
  const workSets = all.filter(x => !x.set.warm)
  const rests = intervals.filter(iv => iv.kind === 'rest' && !iv.afterWarm)
  const restSecs = rests.map(iv => iv.sec)
  const plans = rests.map(iv => iv.planSec).filter(v => v > 0)
  const rirs = workSets.map(x => x.set.rir).filter(v => v != null)
  const durationMs = workoutDuration(w) || (clock ? t1 - t0 : 0)

  return {
    clock, t0, t1, durationMs, blocks, lanes, intervals, rows,
    totals: {
      workSets: workSets.length,
      warmSets: all.length - workSets.length,
      volume: workoutVolume(w),
      supersets: blocks.filter(B => B.superset && lanes.filter(l => l.block === B.b).length > 1).length,
      restMedianSec: median(restSecs),
      restAvgSec: mean(restSecs),
      restCount: restSecs.length,
      longRests: restSecs.filter(s => s > LONG_REST_SEC).length,
      // The timer most rests were held against; one number for the tile.
      planSec: plans.length ? median(plans) : null,
      effortRir: mean(rirs),
      effortN: rirs.length,
    },
  }
}
