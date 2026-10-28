/* The plan and body-weight write tools. Each one goes through commitProfile (profile-write.js):
   the profile is read from the server, changed on a copy and PUT back over the revision it was
   read at, so it lands on every device the way a change made on the phone does.

   - log_bodyweight: a weigh-in for a day.
   - log_sport: a session away from the gym (swimming, climbing, padel…), filed as the app's "Log a
     sport" sheet files it (frontend/src/lib/sports.js), so recovery counts it.
   - apply_plan_changes: edits to the routines and the weekly plan, in the AI Coach's own change
     format and applied by the Coach's own code (frontend/src/lib/coach.js applyChangeSet). That
     buys three things for free: the closed list of change types the app knows how to apply, the
     staleness check against what the plan holds now, and a snapshot taken first, so
     revert_last_plan_change (and the Coach screen's revert) puts the plan back.
   - schedule_week: next week's sessions as a coach week (`S.queue`, frontend/src/lib/queue.js):
     an ordered list of routines the app then offers one by one on whatever days the user trains,
     optionally pinned to dates. The format exists for exactly this, "a planner — any API client
     that PUTs state with a queue". */
import { z } from 'zod'
import { isoDate, withCustomsIndexed as withCustoms } from './tools.js'
import { commitProfile, fail } from './profile-write.js'
import { CHANGE_TYPES, validateProposal, markStale, applyChangeSet, revertLast, canRevert, changeTitle, changeValues } from '../../frontend/src/lib/coach.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'
import { weighInOn } from '../../frontend/src/lib/bodyweight.js'
import { findSport, sportExercise, buildSportWorkout, SPORTS, SPORT_MAX_MIN } from '../../frontend/src/lib/sports.js'
import { appendLoggedWorkout } from '../../frontend/src/lib/log-workout.js'
import { importId } from '../../frontend/src/lib/import-csv.js'
import { musclesOf } from '../../frontend/src/lib/muscles.js'
import { muscleName } from './labels.js'
import { queueOf, queueRemaining, queueView } from '../../frontend/src/lib/queue.js'
import { effectiveRoutineIds } from '../../frontend/src/lib/history.js'

const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localIso(d) }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const LB = 0.45359237

/* ---------- log_bodyweight ---------- */

/** The weigh-in, in the profile's unit. Pure over `S`; returns what log_bodyweight answers. */
export function applyWeighIn(S, { weight, date, unit }, { now = Date.now(), today = localIso(new Date(now)) } = {}) {
  const d = date || today
  if (d > today) throw fail('EINVAL', 'a weigh-in cannot be dated in the future')
  const profileUnit = S.unit === 'lb' ? 'lb' : 'kg'
  const given = unit || profileUnit
  const w = given === profileUnit ? weight : given === 'lb' ? weight * LB : weight / LB
  const prev = (S.bodyweight || []).find(b => b && b.d === d)?.w ?? null
  const status = weighInOn(S, d, w, now)
  if (status === false) throw fail('EINVAL', 'that is not a body weight')
  const saved = S.bodyweight.find(b => b.d === d).w
  return {
    changed: status !== 'same',
    result: { logged: status !== 'same', status, date: d, weight: saved, unit: profileUnit, ...(prev != null && status === 'replaced' ? { replaced: prev } : {}), goal: S.targetW ?? null },
  }
}

export const logBodyweight = {
  name: 'log_bodyweight',
  description: 'Log a body-weight weigh-in for a day (today by default). A second weigh-in on the same day replaces that day\'s, as in the app. The weight is converted when `unit` differs from the profile\'s.',
  schema: {
    weight: z.number().min(20).max(400).describe('The weight, in `unit`.'),
    date: isoDate().optional().describe('YYYY-MM-DD the weigh-in is for; defaults to today. Not in the future.'),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit the user gave; defaults to the profile\'s.'),
  },
  handler: (params, ctx) => {
    const now = Date.now()
    return commitProfile(S => applyWeighIn(S, params, { now }), ctx)
  },
}

/* ---------- log_sport ---------- */

/**
 * The sport session filed into `S`, as log_sport answers. A ready-made sport the user has not used
 * yet is created first, under `name` when given (the user's language), with an id that a retry
 * of the same call names again. Pure over `S`; throws a coded error when nothing can be filed.
 */
export function applySport(S, { sport, minutes, rpe, date, note, name }, { now = Date.now(), today = localIso(new Date(now)) } = {}) {
  const found = findSport(S, sport)
  if (found.problem) throw fail('ENOTFOUND', `${found.problem}. The user's sports and the ready-made ones: ${found.candidates.join(', ')}. Another sport is created in the app (Log a sport → Other sport) first.`)
  S.customEx = Array.isArray(S.customEx) ? S.customEx : []
  let id = found.id
  let created = null
  if (found.create) {
    id = importId('ms', found.create.key)
    created = { ...sportExercise(found.create.key, id), n: String(name ?? '').trim().slice(0, 80) || found.create.n }
    S.customEx.push(created)
  }
  const built = buildSportWorkout(S, { exerciseId: id, date: date || today, minutes, rpe, note }, { now, today })
  if (built.problems) throw fail('EINVAL', built.problems.map(p => `${p.field} ${p.problem}`).join('; '))
  // Filed as log_workout files one: the profile's own exercises indexed for the PR rebuild.
  const added = withCustoms(S, () => appendLoggedWorkout(S, built, { now }))
  const ex = S.customEx.find(c => c.id === id)
  const result = {
    logged: added.added,
    ...(added.added ? {} : { reason: 'already logged: the same sport, day and minutes is on file' }),
    date: built.workout.d,
    sport: ex.n,
    minutes: built.workout.entries[0].sets[0].min,
    rpe: built.workout.entries[0].sets[0].rpe ?? null,
    ...(created ? { sport_created: true } : {}),
    muscles: Object.keys(musclesOf(ex)).map(muscleName),
  }
  return { changed: added.added, result }
}

export const logSport = {
  name: 'log_sport',
  description: [
    'Log a sport session done away from the gym: swimming, climbing (bouldering), padel, or a cardio sport the user created in the app.',
    'It is filed as one finished workout of minutes and effort, as the app\'s "Log a sport" sheet does, so recovery_status counts it on the muscles that sport works and training_review lists it under other_sports, apart from the gym work.',
    'Today by default; a past day is filed at 18:00. Calling again with the same sport, day and minutes does not log it twice.',
  ].join(' '),
  schema: {
    sport: z.string().min(1).max(80).describe(`The sport as the user said it: ${SPORTS.map(s => s.key).join(', ')} (or their usual words, e.g. "escalade", "natation"), or the name or id of a cardio sport the user created in the app.`),
    minutes: z.number().int().min(1).max(SPORT_MAX_MIN).describe('How long the session lasted, in minutes.'),
    rpe: z.number().min(1).max(10).optional().describe('How hard it felt, 1-10 (10 = all out). Leave out when the user did not say.'),
    date: isoDate().optional().describe('YYYY-MM-DD the session was on; defaults to today. Not in the future.'),
    note: z.string().max(500).optional().describe('A short note the user wants kept with the session.'),
    name: z.string().max(80).optional().describe('Name for a ready-made sport used for the first time, in the user\'s language ("Escalade"). Ignored once it exists.'),
  },
  handler: (params, ctx) => {
    const now = Date.now()
    return commitProfile(S => applySport(S, params, { now }), ctx)
  },
}

/* ---------- apply_plan_changes ---------- */

// The tool's snake_case change as the Coach's change object. Exercise references (an id or a
// name) are resolved here, against the profile, so the plan never holds a name the library
// cannot map back: whatever does not resolve comes back as a problem with candidates.
function coachChangeOf(S, c, i, problems) {
  const resolveId = (ref, where) => {
    const r = resolveExercise(S, ref)
    if (r.problem) { problems.push({ change: i, where, exercise: ref, problem: r.problem, candidates: r.candidates || [] }); return null }
    return r.id
  }
  const after = c.after && typeof c.after === 'object' && !Array.isArray(c.after) ? { ...c.after } : c.after
  if ((c.type === 'add-exercise' || c.type === 'swap-exercise') && after && typeof after === 'object') {
    after.id = resolveId(after.id ?? after.exercise, 'after.id')
    delete after.exercise
  }
  if (c.type === 'add-routine') {
    if (!after || typeof after !== 'object' || !String(after.name || '').trim() || !Array.isArray(after.ex) || !after.ex.length) {
      problems.push({ change: i, problem: 'add-routine needs after: { name, ex: [{ id, sets, reps }] } with at least one exercise' })
    } else {
      after.ex = after.ex.map((e, j) => ({ ...e, id: resolveId(e?.id ?? e?.exercise, `after.ex[${j}].id`) }))
    }
  }
  const target = {}
  if (c.routine_id != null) target.routineId = c.routine_id
  if (c.exercise_id != null) {
    // A target exercise is one already in the routine: matched by id as stored there, or by a
    // name that resolves to one.
    const routine = (S.routines || []).find(r => r.id === c.routine_id)
    const inRoutine = routine && (routine.ex || []).some(e => e.id === c.exercise_id)
    target.exId = inRoutine ? c.exercise_id : (resolveId(c.exercise_id, 'exercise_id') ?? c.exercise_id)
  }
  if (c.weekday != null) target.weekday = c.weekday
  return { id: 'c' + (i + 1), type: c.type, target, ...(c.before !== undefined ? { before: c.before } : {}), ...(after !== undefined ? { after } : {}) }
}

/**
 * The changes applied to `S` in place, as apply_plan_changes reports them. Throws a coded error
 * (and the caller drops the copy) when the set cannot be applied whole: it is all or nothing,
 * like the Coach's review screen.
 */
export function applyPlanChanges(S, { summary, changes, dry_run }, { now = Date.now() } = {}) {
  if (!Array.isArray(S.routines)) S.routines = []
  if (!S.week || typeof S.week !== 'object') S.week = {}
  if (!S.dayPlan || typeof S.dayPlan !== 'object') S.dayPlan = {}
  const problems = []
  const proposal = withCustoms(S, () => ({ id: 'mcp-' + now, summary: summary || '', changes: changes.map((c, i) => coachChangeOf(S, c, i, problems)) }))
  if (problems.length) {
    return { changed: false, result: { applied: false, problems, next: 'Nothing was changed. Settle these (pick a candidate id, fix the change) and call again.' } }
  }
  try { validateProposal(proposal) } catch { throw fail('EINVAL', 'one of the changes has a type the app cannot apply') }
  const marked = markStale(proposal, S)
  const stale = marked.changes.filter(c => c.status === 'stale')
  if (stale.length) {
    // All or nothing: a half-applied plan is a plan nobody asked for.
    return {
      changed: false,
      result: {
        applied: false,
        stale: stale.map(c => ({ change: Number(c.id.slice(1)) - 1, type: c.type, target: c.target, reason: 'the routine or exercise it names is not in the plan, or `before` is not what the plan holds now: read it again (get_routine, get_week_plan)' })),
        next: 'Nothing was changed.',
      },
    }
  }
  const idsBefore = new Set(S.routines.map(r => r.id))
  const described = marked.changes.map(c => ({ type: c.type, title: withCustoms(S, () => changeTitle(c, S)), ...(withCustoms(S, () => changeValues(c, S)) || {}) }))
  try {
    withCustoms(S, () => applyChangeSet(S, marked, marked.changes.map(c => c.id)))
  } catch (e) {
    throw fail('EINVAL', `the changes could not be applied (${e.message}); nothing was changed`)
  }
  const created = S.routines.filter(r => !idsBefore.has(r.id)).map(r => ({ id: r.id, name: r.name }))
  const result = {
    applied: !dry_run,
    ...(dry_run ? { dry_run: true } : {}),
    changes: described,
    ...(created.length ? { new_routines: dry_run ? created.map(r => ({ name: r.name })) : created } : {}),
    ...(dry_run ? {} : { undo: 'revert_last_plan_change puts the routines and the weekly plan back as they were before this call.' }),
  }
  return { changed: !dry_run, result }
}

const changeSchema = z.object({
  type: z.enum(CHANGE_TYPES).describe('What the change does; see the tool description for what each type needs.'),
  routine_id: z.string().min(1).optional().describe('The routine it is about (list_routines). Not for add-routine or week.'),
  exercise_id: z.string().min(1).optional().describe('The exercise in that routine it is about (get_routine), for the per-exercise types.'),
  weekday: z.number().int().min(0).max(6).optional().describe('For type week: the weekday, JS getDay() (Sunday=0 … Saturday=6).'),
  before: z.any().optional().describe('The value the plan holds now, as you read it. When given and the plan holds something else (edited since), nothing is applied.'),
  after: z.any().optional().describe('The new value; its shape depends on the type.'),
})

export const applyPlanChangesTool = {
  name: 'apply_plan_changes',
  description: [
    'Change the user\'s routines and weekly plan — only after the user agreed to the changes. All the changes apply together or none do, and the plan is snapshotted first: revert_last_plan_change undoes the whole call.',
    'Read the routine first (get_routine) and pass `before` for scalar changes, so an edit made on the phone meanwhile is not overwritten.',
    'Types and their `after`:',
    'sets / reps / repsMin / repsMax / sec / inc: a number (routine_id + exercise_id);',
    'exercise-prog (exercise) and routine-prog (routine_id): a progression policy: "off", "linear", "greyskull", "double", "triple" or "time";',
    'add-exercise: { id (exercise id or name), sets, reps | sec, weight?, mode?: "reps"|"time", repsMin?, repsMax?, position? } (routine_id);',
    'swap-exercise: { id (the new exercise), sets?, reps?, weight? } (routine_id + exercise_id; keeps the old prescription otherwise);',
    'remove-exercise (routine_id + exercise_id); reorder: the routine\'s exercise ids in the new order, all of them;',
    'superset: { link: true, with: <exercise id in the routine> } or { link: false } (routine_id + exercise_id);',
    'add-routine: { name, emoji?, prog?, ex: [{ id, sets, reps | sec, mode?, repsMax? }] } — the new routine\'s id comes back in new_routines;',
    'remove-routine / rename-routine (after: the new name) (routine_id);',
    'week: a routine id, or "rest" (weekday) — the weekly plan, every week.',
    'Exercise names are resolved against the library; one that matches several or none comes back in `problems` with candidates and nothing is applied.',
    'Use dry_run: true to check the set before showing it to the user.',
  ].join(' '),
  schema: {
    summary: z.string().min(1).max(300).describe('One line on why, kept in the plan\'s change log ("Monthly review: more back volume, bench stalled").'),
    changes: z.array(changeSchema).min(1).max(40),
    dry_run: z.boolean().optional().describe('Check and describe the changes without saving anything.'),
  },
  handler: (params, ctx) => {
    const now = Date.now()
    return commitProfile(S => applyPlanChanges(S, params, { now }), ctx)
  },
}

/* ---------- revert_last_plan_change ---------- */

export function revertPlan(S) {
  if (!canRevert(S)) return { changed: false, result: { reverted: false, message: 'There is no earlier plan to go back to: no change made through apply_plan_changes or the Coach is on record.' } }
  const snap = S.coach.snapshots[S.coach.snapshots.length - 1]
  revertLast(S)
  return { changed: true, result: { reverted: true, label: snap.label || null, taken_at: new Date(snap.at).toISOString(), left_to_revert: (S.coach.snapshots || []).length } }
}

export const revertLastPlanChange = {
  name: 'revert_last_plan_change',
  description: 'Undo the last apply_plan_changes call (or the last change the in-app Coach applied): the routines and the weekly plan go back to the snapshot taken before it. Workouts already logged are never touched. Up to three changes can be undone, one call each.',
  schema: {},
  handler: (_params, ctx) => commitProfile(S => revertPlan(S), ctx),
}

/* ---------- schedule_week ---------- */

/**
 * Next week's sessions as a coach week on `S`, in place. Returns what schedule_week answers.
 * `today` and `now` are passed in so the tests and the clock agree.
 */
export function scheduleWeek(S, params, { now = Date.now(), today = localIso(new Date(now)) } = {}) {
  const routines = Array.isArray(S.routines) ? S.routines : []
  if (!S.dayPlan || typeof S.dayPlan !== 'object') S.dayPlan = {}
  const current = queueOf(S)
  const rotation = !!current && !!current.rotationId
  const left = current ? queueRemaining(S) : []

  if (params.clear) {
    if (!current) return { changed: false, result: { cleared: false, message: 'No coach week is running.' } }
    if (rotation && !params.replace) throw fail('ECONFIRM', 'the running week is the in-app rotation (Plan → Rotation), not a planned week: pass replace: true only if the user wants it stopped')
    for (const iso of Object.keys(S.dayPlan)) if (iso >= today && current.ids.includes(S.dayPlan[iso])) delete S.dayPlan[iso]
    S.queue = null
    return { changed: true, result: { cleared: true, was: current.label || null } }
  }

  const sessions = params.sessions || []
  if (!sessions.length) throw fail('EINVAL', 'name the week\'s sessions (routine ids, in the order to do them), or pass clear: true')
  const byName = n => routines.filter(r => String(r.name || '').trim().toLowerCase() === String(n).trim().toLowerCase())
  const ids = []
  for (const ref of sessions) {
    let r = routines.find(x => x.id === ref)
    if (!r) {
      const named = byName(ref)
      if (named.length > 1) throw fail('EINVAL', `several routines are named "${ref}": pass its id (list_routines)`)
      r = named[0]
    }
    if (!r) throw fail('EINVAL', `no routine "${ref}" in the plan: create it first (apply_plan_changes, add-routine) and pass the id it returns`)
    if (ids.includes(r.id)) throw fail('EINVAL', `"${r.name}" is in the week twice: a coach week does each routine once (make a copy under another name to do it twice)`)
    ids.push(r.id)
  }
  const startsOn = params.starts_on || today
  if (startsOn < today) throw fail('EINVAL', 'starts_on is in the past')
  if (startsOn > addDays(today, 14)) throw fail('EINVAL', 'starts_on is more than two weeks ahead')
  if (current && !params.replace && (rotation || left.length)) {
    throw fail('ECONFIRM', rotation
      ? 'the in-app rotation is running (Plan → Rotation): pass replace: true only if the user wants this week to take its place'
      : `a coach week is still running ("${current.label || 'planned week'}", ${left.length} session(s) left): pass replace: true once the user agreed to drop it`)
  }
  const label = (params.label || '').trim() || 'Week of ' + startsOn
  const pins = []
  for (const p of params.pins || []) {
    const r = routines.find(x => x.id === p.routine_id) || byName(p.routine_id)[0]
    if (!r || !ids.includes(r.id)) throw fail('EINVAL', `a pin names "${p.routine_id}", which is not one of the week's sessions`)
    if (p.date < startsOn || p.date > addDays(startsOn, 13)) throw fail('EINVAL', `the pin on ${p.date} is outside the week (from ${startsOn})`)
    const there = S.dayPlan[p.date]
    if (there != null && there !== r.id && !params.replace && !(current && current.ids.includes(there))) {
      throw fail('ECONFIRM', `${p.date} already has its own plan in the app (${there === 'rest' ? 'a rest day' : 'another routine'}): pass replace: true once the user agreed`)
    }
    pins.push({ date: p.date, id: r.id })
  }

  // The old week's future pins go with it, or they would read as plain routine overrides.
  if (current) for (const iso of Object.keys(S.dayPlan)) if (iso >= today && current.ids.includes(S.dayPlan[iso])) delete S.dayPlan[iso]
  // `since` is when sessions start counting: never before the week starts, or a routine trained
  // before then would tick its session off already.
  const startMs = new Date(startsOn + 'T00:00:00').getTime()
  S.queue = { ids, since: Math.max(now, startMs), startsOn, label }
  for (const p of pins) S.dayPlan[p.date] = p.id

  const nameOf = id => routines.find(r => r.id === id)?.name || null
  const view = queueView(S, today)
  const weekdayPlan = [0, 1, 2, 3, 4, 5, 6]
    .map(d => ({ weekday: d, weekday_name: DAY_NAMES[d], routine_names: [].concat(S.week?.[d] || []).map(nameOf).filter(Boolean) }))
    .filter(d => d.routine_names.length)
  const days = Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(startsOn, i)
    const dayIds = effectiveRoutineIds(S, iso, today)
    return { date: iso, weekday_name: DAY_NAMES[new Date(iso + 'T12:00:00').getDay()], routine_names: dayIds.map(nameOf) }
  })
  return {
    changed: !params.dry_run,
    result: {
      scheduled: !params.dry_run,
      ...(params.dry_run ? { dry_run: true } : {}),
      label,
      starts_on: startsOn,
      sessions: ids.map((id, i) => ({ order: i + 1, routine_id: id, routine_name: nameOf(id), pinned_to: pins.find(p => p.id === id)?.date || null })),
      ...(current ? { replaced: current.label || 'the previous week' } : {}),
      // How the app shows it: the first session not done yet is offered on the next day the user
      // trains (or on its pinned day), so `days` names only the dates already decided.
      days,
      waiting: !!view?.waiting,
      // The weekday plan is not paused by a coach week: its routines are offered beside the
      // week's session on their days. Said, so a week meant to replace them can rest them
      // (apply_plan_changes, type week) instead of doubling a day up.
      ...(weekdayPlan.length ? { weekday_plan_still_active: weekdayPlan, weekday_plan_note: 'These weekday routines still show on their days, beside the week\'s next session. If this week should replace them, set those weekdays to "rest" with apply_plan_changes (type week) once the user agrees.' } : {}),
      how_it_works: 'The app offers these sessions in order on whatever day the user next trains; a pinned one is offered on its date. The weekday plan\'s own routines still show beside them.',
    },
  }
}

export const scheduleWeekTool = {
  name: 'schedule_week',
  description: [
    'Set next week\'s training as a coach week: the routines to do, in order. The app then offers the first one not done yet as the session of whatever day the user next trains (Home shows the week\'s progress), so missing a day shifts the week instead of skipping a session. Pin a session to a date when the day matters.',
    'The routines must exist: create new ones first with apply_plan_changes (add-routine) and pass the ids it returns. The weekly plan (week) is left alone.',
    'Only after the user agreed to the week. A week still running, or the in-app rotation, is only replaced with replace: true. clear: true ends the coach week.',
  ].join(' '),
  schema: {
    sessions: z.array(z.string().min(1)).max(14).optional().describe('Routine ids (or exact routine names), in the order to do them.'),
    starts_on: isoDate().optional().describe('YYYY-MM-DD the week starts; defaults to today. Sessions done before then do not count.'),
    label: z.string().max(40).optional().describe('Shown on Home, e.g. "Week 44" or "Deload". Defaults to "Week of <starts_on>".'),
    pins: z.array(z.object({ routine_id: z.string().min(1), date: isoDate() })).max(14).optional().describe('Sessions given a date.'),
    replace: z.boolean().optional().describe('Replace a coach week still running, the in-app rotation, or a date\'s own plan. Only once the user agreed.'),
    clear: z.boolean().optional().describe('End the coach week instead (the weekly plan takes over again).'),
    dry_run: z.boolean().optional().describe('Check and describe the week without saving it.'),
  },
  handler: (params, ctx) => {
    const now = Date.now()
    return commitProfile(S => scheduleWeek(S, params, { now }), ctx)
  },
}

export const PLAN_TOOLS = [logBodyweight, logSport, applyPlanChangesTool, revertLastPlanChange, scheduleWeekTool]
