/* The review tools: what a coach needs on the table to look back at a block of training and plan
   the next week, computed here rather than left to the model to add up from forty get_workout
   calls.

   - training_review: one period (the last four weeks by default) against the period before it —
     sessions, volume, effort, per-muscle work, per-exercise estimated 1RM and what moved, PRs,
     body weight.
   - recovery_status: the Stats screen's per-muscle fatigue and retained strength, today.
   - find_exercise: an exercise name to the library id the write tools take.

   Every number comes from the lib functions the app uses (history.js, onerm.js, muscles.js,
   recovery.js), so a review agrees with what the Stats screen shows. */
import { z } from 'zod'
import { getState } from './state.js'
import { isoDate, noState, exerciseOf, muscleLoadOf, withCustomsIndexed } from './tools.js'
import { muscleName, friendlyDuration } from './labels.js'
import { workoutVolume, workoutAt, doneUnits } from '../../frontend/src/lib/history.js'
import { bestSetOf, DEFAULT_FORMULA } from '../../frontend/src/lib/onerm.js'
import { rankOf } from '../../frontend/src/lib/muscles.js'
import { isWarmupRow, isFailureSet, isSideSet } from '../../frontend/src/lib/workout-model.js'
import { fatigueOf, strengthOf, LB_TO_KG } from '../../frontend/src/lib/recovery.js'
import { fatigueStateOf } from '../../frontend/src/lib/recovery-view.js'
import { weekKey, weekStartOf } from '../../frontend/src/lib/format.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'
import { EXIDX } from '../../frontend/src/lib/exercises.js'

const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localIso(d) }
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000)
const r1 = n => Math.round(n * 10) / 10
const pct = (now, before) => (before > 0 ? r1(((now - before) / before) * 100) : null)

// The rows of an entry that are work done: a warm-up is left out as everywhere else, a
// unilateral row counts when either side was done.
const workRows = e => (e.sets || []).filter(s => !isWarmupRow(s) && (s.done || (isSideSet(s) && (s.sides.L.done || s.sides.R.done))))
// Work sets done, a unilateral row counting once per side done (history.js doneUnits) — the
// app's setsDone counts warm-ups too, which is a session's tick count, not its training.
const workSets = entries => entries.reduce((n, e) => n + workRows(e).reduce((m, s) => m + doneUnits(s), 0), 0)

/** Sessions, volume and effort over a list of workouts. */
function totalsOf(workouts) {
  let volume = 0, sets = 0, minutes = 0, timed = 0, failure = 0, rows = 0
  const rir = [], rpe = []
  for (const w of workouts) {
    volume += workoutVolume(w)
    sets += workSets(w.entries || [])
    if (w.end > w.start) { minutes += (w.end - w.start) / 60000; timed++ }
    for (const e of w.entries || []) {
      for (const s of workRows(e)) {
        rows++
        if (isFailureSet(s)) failure++
        if (Number.isFinite(s.rir)) rir.push(s.rir)
        if (Number.isFinite(s.rpe)) rpe.push(s.rpe)
      }
    }
  }
  const avg = a => (a.length ? r1(a.reduce((x, y) => x + y, 0) / a.length) : null)
  return {
    sessions: workouts.length,
    days_trained: new Set(workouts.map(w => w.d)).size,
    volume: Math.round(volume),
    sets_done: sets,
    avg_duration: timed ? friendlyDuration((minutes / timed) * 60000) : null,
    avg_duration_min: timed ? Math.round(minutes / timed) : null,
    effort: { work_sets: rows, to_failure_pct: rows ? Math.round((failure / rows) * 100) : null, avg_rir: avg(rir), avg_rpe: avg(rpe), rated_sets: rir.length + rpe.length },
  }
}

/** Per exercise over a list of workouts (oldest first): sessions, sets and the e1RM of each session. */
function exercisesOf(S, workouts, formula) {
  const by = new Map()
  for (const w of workouts) {
    for (const e of w.entries || []) {
      const rows = workRows(e)
      if (!rows.length) continue
      const x = by.get(e.id) || { id: e.id, sessions: 0, sets: 0, points: [], last: null }
      x.sessions++
      x.sets += workSets([e])
      const best = bestSetOf(e, formula)
      if (best) x.points.push({ date: w.d, est: best.est, w: best.w, r: best.r })
      x.last = { date: w.d, top: rows.reduce((top, s) => (Number(s.w) > Number(top.w) || (Number(s.w) === Number(top.w) && Number(s.r) > Number(top.r)) ? s : top), rows[0]) }
      by.set(e.id, x)
    }
  }
  return by
}

/**
 * The review of [from, to] against the same number of days just before it. Pure over `S`;
 * `today` only bounds the default window. Exported for the tests.
 */
export function reviewOf(S, { from, to, formula = DEFAULT_FORMULA, top = 15 } = {}, { today = localIso(new Date()) } = {}) {
  const end = to || today
  const start = from || addDays(end, -27)
  if (start > end) { const err = new Error('`from` is after `to`'); err.code = 'EINVAL'; throw err }
  const days = daysBetween(start, end) + 1
  const prevEnd = addDays(start, -1)
  const prevStart = addDays(prevEnd, -(days - 1))
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  const sorted = (S.workouts || []).filter(w => w && typeof w.d === 'string').slice().sort((a, b) => workoutAt(a) - workoutAt(b))
  const inRange = (a, b) => sorted.filter(w => w.d >= a && w.d <= b)
  const now = inRange(start, end)
  const prev = inRange(prevStart, prevEnd)
  const before = sorted.filter(w => w.d < start)

  return withCustomsIndexed(S, () => {
    const cur = totalsOf(now)
    const old = totalsOf(prev)
    const ws = weekStartOf(S)
    const weeks = new Map()
    for (const w of now) {
      const k = weekKey(w.d, ws)
      const x = weeks.get(k) || { week_start: k, sessions: 0, volume: 0, sets_done: 0 }
      x.sessions++; x.volume += Math.round(workoutVolume(w)); x.sets_done += workSets(w.entries || [])
      weeks.set(k, x)
    }
    const weeklyPlan = [0, 1, 2, 3, 4, 5, 6].reduce((n, d) => n + [].concat(S.week?.[d] || []).filter(id => (S.routines || []).some(r => r.id === id)).length, 0)

    // Exercises: this period's sessions, with the previous period's best and the best ever
    // before this period for scale.
    const exNow = exercisesOf(S, now, formula)
    const exPrev = exercisesOf(S, prev, formula)
    const exBefore = exercisesOf(S, before, formula)
    const bestOf = x => (x && x.points.length ? x.points.reduce((a, b) => (b.est > a.est ? b : a)) : null)
    const exercises = [...exNow.values()].map(x => {
      const ex = exerciseOf(x.id, S)
      const first = x.points[0] || null, last = x.points.at(-1) || null
      const best = bestOf(x), prevBest = bestOf(exPrev.get(x.id)), everBefore = bestOf(exBefore.get(x.id))
      let trend = 'new'
      if (!best) trend = 'no_estimate'
      else if (everBefore || x.points.length >= 2) {
        const ref = prevBest?.est ?? first.est
        const change = (best.est - ref) / ref
        trend = change > 0.01 ? 'up' : change < -0.01 ? 'down' : 'flat'
        if (!prevBest && x.points.length < 2) trend = 'new'
      }
      return {
        id: x.id,
        name: ex.n,
        body_part: ex.bp || null,
        sessions: x.sessions,
        sets: x.sets,
        e1rm: best ? {
          best: best.est, best_set: `${best.w} ${unit} × ${best.r}`, best_date: best.date,
          first_in_period: first.est, last_in_period: last.est,
          previous_period_best: prevBest?.est ?? null,
          change_vs_previous_pct: prevBest ? pct(best.est, prevBest.est) : null,
          change_in_period_pct: x.points.length >= 2 ? pct(last.est, first.est) : null,
          all_time_best_before: everBefore?.est ?? null,
          new_all_time_best: !!everBefore && best.est > everBefore.est,
        } : null,
        trend,
        last_session: { date: x.last.date, top_set: `${Number(x.last.top.w) || 0} ${unit} × ${Number(x.last.top.r) || Number(x.last.top.sec) || 0}${x.last.top.sec ? ' s' : ''}` },
      }
    }).sort((a, b) => b.sets - a.sets)

    // A lift trained three times or more without beating its previous period: the first place
    // to look when progress stops (a deload, a rep-range change, a swap).
    const stalled = exercises.filter(e => e.sessions >= 3 && e.e1rm && (e.trend === 'flat' || e.trend === 'down'))
      .map(e => ({ id: e.id, name: e.name, sessions: e.sessions, trend: e.trend, best: e.e1rm.best, previous_period_best: e.e1rm.previous_period_best }))
    const dropped = [...exPrev.values()].filter(x => !exNow.has(x.id) && x.sessions >= 2)
      .map(x => ({ id: x.id, name: exerciseOf(x.id, S).n, sessions_previous_period: x.sessions }))

    // Muscles, in effective sets (muscle_balance's measure), this period against the last.
    const loadNow = muscleLoadOf(S, now), loadPrev = muscleLoadOf(S, prev)
    const slugs = new Set([...Object.keys(loadNow), ...Object.keys(loadPrev)].filter(k => (loadNow[k] || 0) > 0 || (loadPrev[k] || 0) > 0))
    const weeksIn = days / 7
    const muscles = [...slugs].map(slug => ({
      slug, name: muscleName(slug),
      effective_sets: r1(loadNow[slug] || 0),
      per_week: r1((loadNow[slug] || 0) / weeksIn),
      previous_period: r1(loadPrev[slug] || 0),
      change_pct: pct(loadNow[slug] || 0, loadPrev[slug] || 0),
    })).sort((a, b) => b.effective_sets - a.effective_sets)
    const { missed } = rankOf(loadNow)

    const prs = []
    for (const w of now) for (const id of w.prs || []) prs.push({ date: w.d, exercise_id: id, exercise: exerciseOf(id, S).n })

    const bw = (S.bodyweight || []).filter(b => b && b.d >= start && b.d <= end && Number(b.w) > 0).sort((a, b) => (a.d < b.d ? -1 : 1))
    const bwPrev = (S.bodyweight || []).filter(b => b && b.d >= prevStart && b.d <= prevEnd && Number(b.w) > 0)
    const mean = a => (a.length ? r1(a.reduce((x, b) => x + Number(b.w), 0) / a.length) : null)

    return {
      period: { from: start, to: end, days },
      previous_period: { from: prevStart, to: prevEnd },
      unit,
      formula,
      training: {
        ...cur,
        sessions_per_week: r1(cur.sessions / weeksIn),
        previous_period: { sessions: old.sessions, volume: old.volume, sets_done: old.sets_done, avg_duration_min: old.avg_duration_min, effort: old.effort },
        volume_change_pct: pct(cur.volume, old.volume),
        sets_change_pct: pct(cur.sets_done, old.sets_done),
        // The weekly plan as it stands today; a plan changed during the period is not replayed.
        planned_sessions_per_week: weeklyPlan || null,
        weeks: [...weeks.values()],
      },
      exercises: exercises.slice(0, top),
      exercises_not_listed: Math.max(0, exercises.length - top),
      stalled,
      dropped_since_previous_period: dropped,
      prs,
      muscles,
      muscles_not_trained: missed.map(slug => ({ slug, name: muscleName(slug) })),
      bodyweight: {
        goal: S.targetW ?? null,
        weigh_ins: bw.length,
        first: bw[0] ? { date: bw[0].d, weight: bw[0].w } : null,
        last: bw.length ? { date: bw.at(-1).d, weight: bw.at(-1).w } : null,
        change: bw.length >= 2 ? r1(bw.at(-1).w - bw[0].w) : null,
        mean: mean(bw),
        previous_period_mean: mean(bwPrev),
      },
    }
  })
}

export const trainingReview = {
  name: 'training_review',
  description: [
    'Review a period of training against the period of the same length just before it (default: the last 28 days). One call gives what a monthly check-in needs:',
    '`training` (sessions, sessions per week vs the weekly plan, volume, sets, average duration, effort: share of sets to failure, average RIR/RPE, week by week),',
    '`exercises` (most-trained first: sessions, sets, estimated 1RM best / first / last in the period, change vs the previous period, trend up/flat/down/new, last top set),',
    '`stalled` (trained 3+ times with no gain), `dropped_since_previous_period`, `prs`, `muscles` (effective sets per muscle and per week, change vs the previous period), `muscles_not_trained`, and `bodyweight` (first, last, change, mean vs goal).',
    'For the next week\'s plan, read recovery_status and get_week_plan too.',
  ].join(' '),
  schema: {
    from: isoDate().optional().describe('Inclusive start YYYY-MM-DD. Defaults to 27 days before `to`.'),
    to: isoDate().optional().describe('Inclusive end YYYY-MM-DD. Defaults to today.'),
    formula: z.enum(['epley', 'brzycki', 'lombardi']).optional().describe(`1RM formula. Defaults to ${DEFAULT_FORMULA}.`),
    top: z.number().int().min(1).max(60).optional().describe('How many exercises to list (most sets first). Defaults to 15.'),
  },
  handler: ({ from, to, formula, top }) => {
    const S = getState()
    if (!S) return noState()
    return reviewOf(S, { from, to, formula, top })
  },
}

/** Per-muscle fatigue and retained strength at `now`, as the Stats screen computes them. */
export function recoveryOf(S, now = Date.now()) {
  const last = (S.bodyweight || []).filter(b => Number(b?.w) > 0).sort((a, b) => String(a.d).localeCompare(String(b.d))).at(-1)
  const bodyweightKg = last ? (S.unit === 'lb' ? last.w * LB_TO_KG : last.w) : null
  const opts = { bodyweightKg, unit: S.unit }
  return withCustomsIndexed(S, () => {
    const workouts = (S.workouts || []).map(w => ({
      ...w,
      entries: (w.entries || []).map(e => {
        const c = (S.customEx || []).find(x => x.id === e.id)
        return c && !e.exercise ? { ...e, exercise: c } : e
      }),
    }))
    const fatigue = fatigueOf(workouts, now, opts)
    const strength = strengthOf(workouts, now, opts)
    const muscles = Object.keys(fatigue).map(slug => ({
      slug, name: muscleName(slug),
      fatigue: Math.round(fatigue[slug] * 100) / 100,
      state: fatigueStateOf(fatigue[slug]),
      retained_strength: Math.round((strength[slug] ?? 0) * 100) / 100,
    }))
    const order = { fatigued: 0, recovering: 1, ready: 2 }
    return {
      as_of: new Date(now).toISOString(),
      legend: 'fatigue: 0 = fresh; under 0.25 ready, up to 0.5 recovering, above fatigued. retained_strength: 1 = trained recently enough to keep it all, falling towards 0.5 the longer a muscle goes untrained.',
      fatigued: muscles.filter(m => m.state === 'fatigued').map(m => m.name),
      recovering: muscles.filter(m => m.state === 'recovering').map(m => m.name),
      detraining: muscles.filter(m => m.retained_strength < 1).map(m => m.name),
      muscles: muscles.sort((a, b) => order[a.state] - order[b.state] || b.fatigue - a.fatigue),
    }
  })
}

export const recoveryStatus = {
  name: 'recovery_status',
  description: 'Per-muscle recovery right now, as the Stats screen shows it: fatigue from recent sets (ready / recovering / fatigued) and retained strength (how long since a muscle was trained). Use it to decide what the next sessions can load and what needs rest.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return noState()
    return recoveryOf(S)
  },
}

export const findExercise = {
  name: 'find_exercise',
  description: 'Find an exercise in the user\'s library (1,300+ built-ins plus their own) by name, and get the id the plan tools take. Returns the exercise when the name means exactly one, else candidates to choose from.',
  schema: {
    name: z.string().min(1).max(120).describe('The exercise as the user says it, e.g. "incline dumbbell press".'),
  },
  handler: ({ name }) => {
    const S = getState() || {}
    return withCustomsIndexed(S, () => {
      const r = resolveExercise(S, name)
      if (r.problem) return { found: false, problem: r.problem, candidates: r.candidates || [] }
      const ex = r.custom ? (S.customEx || []).find(c => c.id === r.id) : EXIDX[r.id]
      return { found: true, id: r.id, name: r.name, custom: !!r.custom, equipment: ex?.eq || null, body_part: ex?.bp || null, target: ex?.t || null }
    })
  },
}

export const REVIEW_TOOLS = [trainingReview, recoveryStatus, findExercise]
