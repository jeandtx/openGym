// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'

const params = { id: 'w2', exId: 'squat' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => params,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))
vi.mock('../sheets.jsx', () => ({
  WorkoutRow: ({ w }) => <div className="wrow">{w.name}</div>,
}))

const { default: Visualize } = await import('./Visualize.jsx')
const { default: VisualizeSession } = await import('./VisualizeSession.jsx')
const { default: VisualizeExercise } = await import('./VisualizeExercise.jsx')

const T0 = Date.UTC(2026, 9, 26, 11)
const at = (day, sec) => T0 + day * 7 * 86400000 + sec * 1000
const workout = (i, w, ticks = true) => ({
  id: 'w' + i, name: 'Legs', d: new Date(at(i, 0)).toISOString().slice(0, 10), start: at(i, 0), end: at(i, 1500), vol: 0,
  entries: [
    { id: 'squat', target: { restSec: 90 }, sets: [
      { phase: 'warmup', w: 20, r: 10, done: true, ...(ticks ? { at: at(i, 200) } : {}) },
      { w, r: 8, done: true, rpe: 8, ...(ticks ? { at: at(i, 300) } : {}) },
      { w, r: 7, done: true, type: 'dropset', drops: [{ w: w - 20, r: 6 }], ...(ticks ? { at: at(i, 420) } : {}) },
    ] },
    { id: 'plank', sg: 'A', target: { mode: 'time' }, sets: [{ sec: 45, done: true, ...(ticks ? { at: at(i, 700) } : {}) }] },
    { id: 'crunch', sg: 'A', target: {}, sets: [{ w: 0, r: 15, done: true, ...(ticks ? { at: at(i, 760) } : {}) }] },
  ],
})

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const mount = (el, workouts = [workout(0, 60), workout(1, 62.5), workout(2, 65)]) => {
  useStore.setState(s => ({ S: { ...s.S, unit: 'kg', restSec: 90, workouts, routines: [], active: null }, user: null }))
  act(() => root.render(el))
}

describe('Visualize', () => {
  it('lists the workouts, newest first', () => {
    mount(<Visualize />)
    expect([...host.querySelectorAll('.wrow')]).toHaveLength(3)
    expect(host.querySelector('h1').textContent).toBe('Visualize')
  })

  it('draws a session: tiles, a timeline lane per exercise, a card per exercise and every set in the table', () => {
    mount(<VisualizeSession />)
    expect(host.querySelector('h1').textContent).toBe('Legs')
    const tiles = [...host.querySelectorAll('.viz-tiles .tile .l')].map(el => el.textContent)
    expect(tiles).toContain('Work sets')
    expect(tiles).toContain('Median rest')
    expect(host.querySelectorAll('.viz-tl .viz-lane').length).toBeGreaterThanOrEqual(3)
    expect(host.querySelectorAll('.viz-cards .card')).toHaveLength(3)
    // the superset is named on its members' cards
    expect(host.textContent).toContain('Superset')
    expect(host.querySelectorAll('.viz-table tbody tr')).toHaveLength(5)
  })

  it('explains, instead of drawing, when a session has no set times', () => {
    mount(<VisualizeSession />, [workout(2, 65, false)])
    expect(host.querySelector('.viz-tl')).toBe(null)
    expect(host.textContent).toContain('no set times')
    expect(host.querySelectorAll('.viz-cards .card')).toHaveLength(3)
  })

  it('follows an exercise on its estimated 1RM, with the change from last time and the trend', () => {
    mount(<VisualizeExercise />)
    expect(host.textContent).toContain('Est. 1RM')
    expect(host.querySelector('.viz-info')).toBeTruthy()
    expect(host.textContent).toContain('vs last time')
    expect(host.textContent).toContain('Progressing')
    expect(host.querySelectorAll('.viz-cards .card')).toHaveLength(3)
  })
})
