// state.js in server mode (OPENGYM_URL, no OPENGYM_DATA): who the token is, then one revision
// poll per tool call and the document only when the revision moved.
import { describe, test, expect, beforeEach } from 'vitest'
import { refresh, getState, getUser, localUid, remoteMode, invalidate, _resetForTests } from '../src/state.js'

const ENV = { OPENGYM_URL: 'https://gym.example.com', OPENGYM_TOKEN: 'tok.abc' }

function fakeServer() {
  const s = { rev: 4, doc: { unit: 'lb', routines: [{ id: 'r1', name: 'Push', ex: [] }], _wid: 'w1' }, calls: [] }
  s.fetchImpl = async (url, init) => {
    const p = new URL(url).pathname
    s.calls.push(p)
    expect(init.headers.authorization).toBe('Bearer tok.abc')
    const body = p === '/api/me' ? { user: { id: 'u1', name: 'Jean' } }
      : p === '/api/data/rev' ? { rev: s.rev, wid: s.doc?._wid }
        : p === '/api/data' ? { state: s.doc, rev: s.rev }
          : null
    return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }
  return s
}

describe('server mode', () => {
  beforeEach(() => _resetForTests())

  test('is on with OPENGYM_URL, and off whenever a data directory is named', () => {
    expect(remoteMode(ENV)).toBe(true)
    expect(remoteMode({ ...ENV, OPENGYM_DATA: '/data' })).toBe(false)
    expect(remoteMode({})).toBe(false)
  })

  test('learns the profile, reads the document, and fetches it again only when the revision moved', async () => {
    const s = fakeServer()
    await refresh({ env: ENV, fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual(['/api/me', '/api/data/rev', '/api/data'])
    expect(getUser()).toEqual({ id: 'u1', name: 'Jean', created: null })
    expect(localUid()).toBe('u1')
    // the defaults the app fills in, under what the server sent
    expect(getState()).toMatchObject({ unit: 'lb', routines: [{ id: 'r1' }], workouts: [], bodyweight: [] })

    s.calls.length = 0
    await refresh({ env: ENV, fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual(['/api/data/rev'])

    s.rev = 5
    s.doc = { ...s.doc, routines: [] }
    s.calls.length = 0
    await refresh({ env: ENV, fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual(['/api/data/rev', '/api/data'])
    expect(getState().routines).toEqual([])

    // after a write of its own: read again, whatever the revision says
    invalidate()
    s.calls.length = 0
    await refresh({ env: ENV, fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual(['/api/data/rev', '/api/data'])
  })

  test('a token the server refuses is a coded error, not an empty profile', async () => {
    const fetchImpl = async () => new Response('{}', { status: 401 })
    await expect(refresh({ env: ENV, fetchImpl })).rejects.toMatchObject({ code: 'EAUTH' })
  })

  test('a profile that never synced reads as no state', async () => {
    const s = fakeServer()
    s.doc = null
    await refresh({ env: ENV, fetchImpl: s.fetchImpl })
    expect(getState()).toBeNull()
  })

  test('a no-op in data-directory mode', async () => {
    const s = fakeServer()
    await refresh({ env: { OPENGYM_DATA: '/nowhere' }, fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual([])
  })
})
