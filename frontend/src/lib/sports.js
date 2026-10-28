import { buildCompletedWorkout } from './finish-workout.js'
import { backfillStart } from './backfill.js'
import { exerciseMuscleSnapshot } from './muscles.js'
import { EXIDX, normalizeStr } from './exercises.js'

// Sports done outside the gym (swimming, climbing, padel), logged as one cardio row: minutes and
// an RPE. recovery.js already scales a cardio row by its minutes and effort (CARDIO_MINUTES_PER_SET);
// what a sport adds is the muscles it works and how hard they work per minute.
//
// `cardioDensity` is the effective sets one 30-minute row is worth on a primary muscle, before the
// effort weight: a run is 1 (the default), an hour of bouldering at 3 is six sets on the forearms,
// which is closer to what the next day's pull session meets. Secondaries take their usual 0.4.
// These are estimates for the fatigue map, not measurements: tune them here, the tests read them.

export const CARDIO_DENSITY_DEFAULT = 1
export const CARDIO_DENSITY_MIN = 0.25
export const CARDIO_DENSITY_MAX = 4

/**
 * The density of a cardio exercise, clamped to [CARDIO_DENSITY_MIN, CARDIO_DENSITY_MAX]. Reads the
 * exercise first, then the muscle snapshot a finished entry keeps, so a deleted custom sport still
 * scores as it did. Anything missing or unreadable is the default, which is cardio as before.
 */
export function cardioDensityOf(ex) {
  const raw = ex?.cardioDensity ?? ex?.muscleSnapshot?.cardioDensity
  const n = Number(raw)
  if (raw == null || raw === '' || !Number.isFinite(n) || n <= 0) return CARDIO_DENSITY_DEFAULT
  return Math.min(CARDIO_DENSITY_MAX, Math.max(CARDIO_DENSITY_MIN, n))
}

// Ready-made sports, as custom exercises: `bp: 'cardio'` so they log minutes and speed, with
// explicit muscles so recovery shades the right ones. Names stay English like the catalogue; the
// screens translate them. `aliases` are the words someone may use for it when telling Claude
// (findSport), in the languages the users speak most.
export const SPORTS = [
  {
    key: 'swimming', n: 'Swimming', bp: 'cardio', eq: 'body weight', cardioDensity: 1.5,
    aliases: ['swim', 'natation', 'piscine', 'nage', 'natacion', 'schwimmen', 'nuoto', 'natacao'],
    primaries: ['upper-back', 'deltoids'], secondaries: ['triceps', 'chest'],
  },
  {
    key: 'climbing', n: 'Climbing', bp: 'cardio', eq: 'body weight', cardioDensity: 3,
    aliases: ['bouldering', 'boulder', 'escalade', 'bloc', 'grimpe', 'escalada', 'klettern', 'bouldern', 'arrampicata'],
    primaries: ['forearm', 'upper-back', 'biceps'], secondaries: ['deltoids', 'abs'],
  },
  {
    key: 'padel', n: 'Padel', bp: 'cardio', eq: 'body weight', cardioDensity: 1.5,
    aliases: ['paddle tennis'],
    primaries: ['quadriceps', 'calves', 'gluteal'], secondaries: ['deltoids', 'forearm', 'obliques'],
  },
]

/**
 * A custom exercise for the sport `key`, ready to push to `S.customEx`; null for an unknown key.
 * It keeps `sport: key`, so it is found again whatever name it was given (findSport).
 */
export function sportExercise(key, id) {
  const sport = SPORTS.find(s => s.key === key)
  if (!sport) return null
  const { key: _key, aliases: _aliases, primaries, secondaries, ...rest } = sport
  return {
    ...rest, id, sport: key, custom: true, desc: '',
    tg: primaries[0], sm: [...secondaries],
    primaries: [...primaries], secondaries: [...secondaries], muscleGroups: [...primaries, ...secondaries],
  }
}

/** A sport is a cardio exercise that says how hard it works its muscles; a plain run says nothing. */
export const isSportExercise = ex => !!ex && ex.bp === 'cardio' && ex.cardioDensity != null

// The three steps the custom-exercise form offers for a sport's density, light to hard. A run is
// light; climbing is hard (SPORTS above).
export const SPORT_INTENSITIES = [
  { key: 'light', label: 'Light', density: 1 },
  { key: 'moderate', label: 'Moderate', density: 1.5 },
  { key: 'hard', label: 'Hard', density: 3 },
]

/** The intensity step closest to `density`; null for a plain cardio exercise (no density at all). */
export function intensityOf(density) {
  if (density == null || density === '') return null
  const d = cardioDensityOf({ cardioDensity: density })
  return SPORT_INTENSITIES.reduce((a, b) => (Math.abs(b.density - d) < Math.abs(a.density - d) ? b : a)).key
}

export const SPORT_MAX_MIN = 12 * 60

/**
 * A finished session of one sport, ready for log-workout.js appendLoggedWorkout: one cardio row of
 * `minutes` at `rpe` (1-10, optional) on the custom exercise `exerciseId`. Today it ends `now`;
 * a past day starts at the backfill's 18:00. Returns `{ problems }` instead when the input is off.
 */
export function buildSportWorkout(S, { exerciseId, date, minutes, rpe = null, note = '' }, { now = Date.now(), today } = {}) {
  const ex = (S?.customEx || []).find(c => c?.id === exerciseId)
  const problems = []
  if (!ex || ex.bp !== 'cardio') problems.push({ field: 'exerciseId', problem: 'is not one of your cardio exercises' })
  const min = Math.round(Number(minutes))
  if (!Number.isFinite(min) || min < 1 || min > SPORT_MAX_MIN) problems.push({ field: 'minutes', problem: `must be 1 to ${SPORT_MAX_MIN}` })
  const effort = rpe == null || rpe === '' ? null : Number(rpe)
  if (effort != null && !(Number.isFinite(effort) && effort >= 1 && effort <= 10)) problems.push({ field: 'rpe', problem: 'must be 1 to 10' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) problems.push({ field: 'date', problem: 'must be YYYY-MM-DD' })
  else if (today && date > today) problems.push({ field: 'date', problem: 'is in the future' })
  if (problems.length) return { problems }

  const past = !!today && date < today
  let start, end
  if (past) {
    start = backfillStart(date)
    end = start + min * 60000
  } else {
    end = now
    // A session that would begin before midnight is filed from midnight: it is today's.
    start = Math.max(end - min * 60000, new Date(date + 'T00:00:00').getTime())
  }
  const set = { min, done: true, ...(effort != null ? { rpe: effort } : {}) }
  const workout = buildCompletedWorkout(
    { id: 'sp' + start.toString(36) + exerciseId, d: date, start, name: ex.n, bw: null, routineIds: [], note: String(note || '').trim().slice(0, 500),
      entries: [{ id: exerciseId, sets: [set], target: { mode: 'cardio' } }] },
    { end, prs: [], snapshotFor: () => exerciseMuscleSnapshot(ex) },
  )
  workout.vol = 0
  return { workout, past, customEx: [] }
}

/**
 * One of the user's sports from what they called it: an exercise id, a ready-made sport (its key,
 * English name or an alias: "escalade" is climbing), or the name of a cardio exercise of their
 * own. `{ id }` when they have it, `{ create: sport }` for a ready-made sport they have not used
 * yet, `{ problem, candidates }` otherwise.
 */
export function findSport(S, ref) {
  const own = (S?.customEx || []).filter(c => c && c.bp === 'cardio')
  const raw = String(ref ?? '').trim()
  if (!raw) return { problem: 'no sport given', candidates: sportCandidates(own) }
  const byId = own.find(c => c.id === raw)
  if (byId) return { id: byId.id }
  const q = normalizeStr(raw)
  const preset = SPORTS.find(sp => [sp.key, sp.n, ...sp.aliases].some(w => normalizeStr(w) === q))
  if (preset) {
    const words = [preset.key, preset.n, ...preset.aliases].map(normalizeStr)
    const mine = own.find(c => c.sport === preset.key) || own.find(c => words.includes(normalizeStr(c.n)))
    return mine ? { id: mine.id } : { create: preset }
  }
  const named = own.find(c => normalizeStr(c.n) === q)
  if (named) return { id: named.id }
  return { problem: `no sport called "${raw}"`, candidates: sportCandidates(own) }
}
const sportCandidates = own => [...new Set([...own.filter(isSportExercise).map(c => c.n), ...SPORTS.map(sp => sp.key)])]

/**
 * Whether a finished workout is a sport session: every entry is a sport (isSportExercise), read
 * from the library or, for a deleted one, the snapshot the entry kept. A gym session with a sport
 * entry in it is still a gym session.
 */
export function isSportWorkout(w) {
  const entries = w?.entries || []
  return entries.length > 0 && entries.every(e => isSportExercise(EXIDX[e?.id] || e?.muscleSnapshot))
}
