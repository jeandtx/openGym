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
// screens translate them.
export const SPORTS = [
  {
    key: 'swimming', n: 'Swimming', bp: 'cardio', eq: 'body weight', cardioDensity: 1.5,
    primaries: ['upper-back', 'deltoids'], secondaries: ['triceps', 'chest'],
  },
  {
    key: 'climbing', n: 'Climbing', bp: 'cardio', eq: 'body weight', cardioDensity: 3,
    primaries: ['forearm', 'upper-back', 'biceps'], secondaries: ['deltoids', 'abs'],
  },
  {
    key: 'padel', n: 'Padel', bp: 'cardio', eq: 'body weight', cardioDensity: 1.5,
    primaries: ['quadriceps', 'calves', 'gluteal'], secondaries: ['deltoids', 'forearm', 'obliques'],
  },
]

/** A custom exercise for the sport `key`, ready to push to `S.customEx`; null for an unknown key. */
export function sportExercise(key, id) {
  const sport = SPORTS.find(s => s.key === key)
  if (!sport) return null
  const { key: _key, primaries, secondaries, ...rest } = sport
  return {
    ...rest, id, custom: true, desc: '',
    tg: primaries[0], sm: [...secondaries],
    primaries: [...primaries], secondaries: [...secondaries], muscleGroups: [...primaries, ...secondaries],
  }
}
