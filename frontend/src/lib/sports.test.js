import { describe, expect, it } from 'vitest'
import {
  CARDIO_DENSITY_DEFAULT,
  CARDIO_DENSITY_MAX,
  CARDIO_DENSITY_MIN,
  SPORTS,
  cardioDensityOf,
  sportExercise,
} from './sports.js'
import { MUSCLES, exerciseMuscleSnapshot, musclesOf } from './muscles.js'

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
    expect(climbing).toMatchObject({ id: 'c1', n: 'Climbing', bp: 'cardio', custom: true, cardioDensity: 3 })
    expect(climbing.key).toBeUndefined()
    expect(musclesOf(climbing)).toEqual({ forearm: 1, 'upper-back': 1, biceps: 1, deltoids: 0.4, abs: 0.4 })
    expect(sportExercise('curling', 'x')).toBeNull()
  })

  it('keeps the density in the snapshot a finished entry stores', () => {
    expect(exerciseMuscleSnapshot(sportExercise('padel', 'p1')).cardioDensity).toBe(1.5)
    expect(exerciseMuscleSnapshot({ n: 'Run', bp: 'cardio' })).not.toHaveProperty('cardioDensity')
  })
})
