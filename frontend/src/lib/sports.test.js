import { describe, expect, it } from 'vitest'
import {
  CARDIO_DENSITY_DEFAULT,
  CARDIO_DENSITY_MAX,
  CARDIO_DENSITY_MIN,
  SPORTS,
  SPORT_INTENSITIES,
  buildSportWorkout,
  cardioDensityOf,
  intensityOf,
  isSportExercise,
  isSportWorkout,
  findSport,
  sportExercise,
} from './sports.js'
import { MUSCLES, exerciseMuscleSnapshot, musclesOf } from './muscles.js'
import { appendLoggedWorkout } from './log-workout.js'
import { registerCustom } from './exercises.js'
import { fatigueOf } from './recovery.js'

describe('cardioDensityOf', () => {
  it('is the default for a plain cardio exercise and anything unreadable', () => {
    for (const ex of [undefined, null, {}, { cardioDensity: null }, { cardioDensity: '' }, { cardioDensity: 'hard' }, { cardioDensity: 0 }, { cardioDensity: -2 }]) {
      expect(cardioDensityOf(ex)).toBe(CARDIO_DENSITY_DEFAULT)
    }
  })

  it('reads the exercise, then the snapshot of a finished entry, and clamps', () => {
    expect(cardioDensityOf({ cardioDensity: 3 })).toBe(3)
    expect(cardioDensityOf({ cardioDensity: '1.5' })).toBe(1.5)
    expect(cardioDensityOf({ muscleSnapshot: { cardioDensity: 2 } })).toBe(2)
    expect(cardioDensityOf({ cardioDensity: 2, muscleSnapshot: { cardioDensity: 3 } })).toBe(2)
    expect(cardioDensityOf({ cardioDensity: 50 })).toBe(CARDIO_DENSITY_MAX)
    expect(cardioDensityOf({ cardioDensity: 0.01 })).toBe(CARDIO_DENSITY_MIN)
  })
})

describe('SPORTS', () => {
  it('names only muscles the map draws, with a density in range', () => {
    for (const sport of SPORTS) {
      for (const slug of [...sport.primaries, ...sport.secondaries]) expect(MUSCLES).toContain(slug)
      expect(sport.cardioDensity).toBeGreaterThanOrEqual(CARDIO_DENSITY_MIN)
      expect(sport.cardioDensity).toBeLessThanOrEqual(CARDIO_DENSITY_MAX)
    }
    expect(SPORTS.map(s => s.key)).toEqual(['swimming', 'climbing', 'padel'])
  })

  it('builds a cardio custom exercise whose muscles are the sport\'s own', () => {
    const climbing = sportExercise('climbing', 'c1')
    expect(climbing).toMatchObject({ id: 'c1', n: 'Climbing', bp: 'cardio', custom: true, cardioDensity: 3, sport: 'climbing' })
    expect(climbing.key).toBeUndefined()
    expect(climbing.aliases).toBeUndefined()
    expect(musclesOf(climbing)).toEqual({ forearm: 1, 'upper-back': 1, biceps: 1, deltoids: 0.4, abs: 0.4 })
    expect(sportExercise('curling', 'x')).toBeNull()
  })

  it('keeps the density in the snapshot a finished entry stores', () => {
    expect(exerciseMuscleSnapshot(sportExercise('padel', 'p1')).cardioDensity).toBe(1.5)
    expect(exerciseMuscleSnapshot({ n: 'Run', bp: 'cardio' })).not.toHaveProperty('cardioDensity')
  })
})

describe('intensities', () => {
  it('tells a sport from a plain cardio exercise', () => {
    expect(isSportExercise(sportExercise('padel', 'p'))).toBe(true)
    expect(isSportExercise({ bp: 'cardio', n: 'Treadmill' })).toBe(false)
    expect(isSportExercise({ bp: 'back', cardioDensity: 2 })).toBe(false)
  })

  it('maps a density to its nearest step, and none to nothing', () => {
    expect(SPORT_INTENSITIES.map(i => i.density)).toEqual([1, 1.5, 3])
    expect(intensityOf(undefined)).toBeNull()
    expect(intensityOf(1)).toBe('light')
    expect(intensityOf(1.5)).toBe('moderate')
    expect(intensityOf(2.5)).toBe('hard')
    expect(intensityOf(4)).toBe('hard')
  })
})

describe('buildSportWorkout', () => {
  const NOW = new Date('2026-10-28T20:00:00').getTime()
  const TODAY = '2026-10-28'
  const S = () => ({ customEx: [sportExercise('climbing', 'cl')], workouts: [], exWeights: {} })

  it('files today\'s session as one cardio row ending now, with the sport\'s muscles kept', () => {
    const built = buildSportWorkout(S(), { exerciseId: 'cl', date: TODAY, minutes: 90, rpe: 8 }, { now: NOW, today: TODAY })
    expect(built.problems).toBeUndefined()
    const w = built.workout
    expect(w).toMatchObject({ d: TODAY, name: 'Climbing', end: NOW, start: NOW - 90 * 60000, vol: 0, routineIds: [] })
    expect(w.entries).toHaveLength(1)
    expect(w.entries[0]).toMatchObject({ id: 'cl', target: { mode: 'cardio' }, sets: [{ min: 90, rpe: 8, done: true }] })
    expect(w.entries[0].muscleSnapshot.cardioDensity).toBe(3)
    expect(built.past).toBe(false)
  })

  it('starts a past day at 18:00 and leaves the RPE out when not given', () => {
    const built = buildSportWorkout(S(), { exerciseId: 'cl', date: '2026-10-25', minutes: 60 }, { now: NOW, today: TODAY })
    expect(built.past).toBe(true)
    expect(new Date(built.workout.start).getHours()).toBe(18)
    expect(built.workout.end - built.workout.start).toBe(60 * 60000)
    expect(built.workout.entries[0].sets[0]).toEqual({ min: 60, done: true })
  })

  it('never starts today\'s session before midnight', () => {
    const early = new Date('2026-10-28T00:30:00').getTime()
    const built = buildSportWorkout(S(), { exerciseId: 'cl', date: TODAY, minutes: 90 }, { now: early, today: TODAY })
    expect(built.workout.start).toBe(new Date('2026-10-28T00:00:00').getTime())
  })

  it('says what is wrong instead of building', () => {
    const { problems } = buildSportWorkout(S(), { exerciseId: 'nope', date: '2026-10-30', minutes: 0, rpe: 11 }, { now: NOW, today: TODAY })
    expect(problems.map(p => p.field).sort()).toEqual(['date', 'exerciseId', 'minutes', 'rpe'])
    expect(buildSportWorkout({ customEx: [{ id: 'b', bp: 'back', n: 'Row' }] }, { exerciseId: 'b', date: TODAY, minutes: 30 }, { now: NOW, today: TODAY }).problems).toHaveLength(1)
  })

  it('goes into the history and loads recovery like any finished session', () => {
    const state = S()
    const built = buildSportWorkout(state, { exerciseId: 'cl', date: TODAY, minutes: 90, rpe: 8 }, { now: NOW, today: TODAY })
    expect(appendLoggedWorkout(state, built, { now: NOW }).added).toBe(true)
    expect(appendLoggedWorkout(state, built, { now: NOW }).added).toBe(false)
    expect(state.workouts).toHaveLength(1)
    registerCustom(state.customEx)
    try {
      const fatigue = fatigueOf(state.workouts, NOW)
      expect(fatigue.forearm).toBeGreaterThan(0.5)
      expect(fatigue.quadriceps).toBe(0)
    } finally {
      registerCustom([])
    }
  })
})

describe('findSport', () => {
  const S = {
    customEx: [
      { ...sportExercise('climbing', 'cl'), n: 'Escalade' },
      { id: 'sq', n: 'Squash', bp: 'cardio', cardioDensity: 1.5, primaries: ['quadriceps'] },
      { id: 'tm', n: 'Treadmill walk', bp: 'cardio' },
      { id: 'bp', n: 'Bench', bp: 'chest' },
    ],
  }

  it('finds a ready-made sport by key, English name or alias, whatever the user named it', () => {
    for (const ref of ['climbing', 'Climbing', 'escalade', 'BLOC', 'bouldering']) expect(findSport(S, ref)).toEqual({ id: 'cl' })
  })

  it('offers to create a ready-made sport the user has not used yet', () => {
    expect(findSport(S, 'natation').create.key).toBe('swimming')
    expect(findSport(S, 'Pádel').create.key).toBe('padel')
  })

  it('finds the user\'s own cardio exercises by id or name, never a lift', () => {
    expect(findSport(S, 'sq')).toEqual({ id: 'sq' })
    expect(findSport(S, 'squash')).toEqual({ id: 'sq' })
    expect(findSport(S, 'treadmill walk')).toEqual({ id: 'tm' })
    expect(findSport(S, 'Bench').problem).toMatch(/Bench/)
  })

  it('lists what it knows when nothing matches', () => {
    const r = findSport(S, 'curling')
    expect(r.problem).toMatch(/curling/)
    expect(r.candidates).toEqual(['Escalade', 'Squash', 'swimming', 'climbing', 'padel'])
    expect(findSport(S, '  ').problem).toBe('no sport given')
  })
})

describe('isSportWorkout', () => {
  it('is a session made only of sports, read from the library or a deleted one\'s snapshot', () => {
    registerCustom([sportExercise('padel', 'pa')])
    try {
      expect(isSportWorkout({ entries: [{ id: 'pa', sets: [] }] })).toBe(true)
      expect(isSportWorkout({ entries: [{ id: 'pa' }, { id: '0025' }] })).toBe(false)
      expect(isSportWorkout({ entries: [{ id: 'gone', muscleSnapshot: { bp: 'cardio', cardioDensity: 3 } }] })).toBe(true)
      expect(isSportWorkout({ entries: [{ id: '0685' }] })).toBe(false)
      expect(isSportWorkout({ entries: [] })).toBe(false)
    } finally {
      registerCustom([])
    }
  })
})
