// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Settings → Account → Connect Claude: the row on a signed-in web app (not the phone app, not a
   guest), and its sheet minting a paired-session token the way pairing does — a code, redeemed at
   once — into the one `claude mcp add` command that connects Claude Code to /api/mcp. */
const mocks = vi.hoisted(() => {
  // `kept` is one array for good: KeptChangesRows re-asks whenever the function changes, and a
  // fresh [] per answer would re-render it forever.
  const state = { S: null, user: null, sync: null, config: null, webauthn: true, sheets: [], kept: [] }
  state.passkeyLogin = vi.fn(async () => ({ id: 'u1', name: 'andi' }))
  state.list = { passkeys: [{ id: 'k1', name: 'Laptop', created: null, lastUsed: null, transports: [] }, { id: 'k2', name: null, created: null, lastUsed: null, transports: [] }], password: true, lastWayIn: false }
  state.api = vi.fn(async path => path === '/api/account/password' ? { set: true, setAt: null, passkeys: 2, name: 'andi', nameTaken: false }
    : path === '/api/account/passkeys' || path === '/api/account/passkeys/rename' ? state.list : {})
  state.snapshot = () => ({
    S: state.S, user: state.user, sync: state.sync, config: state.config, coachLocal: null,
    update: vi.fn(), replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(), resetDemo: vi.fn(),
    syncNow: vi.fn(), unsyncedChanges: () => ({ owed: false, count: 0 }), keptChanges: async () => state.kept,
    disconnectServer: vi.fn(), signOut: vi.fn(), signOutAll: vi.fn(), adoptProfile: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: (render, opts) => { mocks.sheets.push({ render, opts }); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: (...a) => mocks.api(...a), webauthnOK: () => mocks.webauthn, passkeyLogin: (...a) => mocks.passkeyLogin(...a), passkeyRegister: vi.fn(), IS_ANDROID: false,
  passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(), createPasskey: vi.fn(),
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(), askAddDeviceData: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const section = (page, title) => [...page.querySelectorAll('.sect')].find(s => s.querySelector('.sect-t')?.textContent === title)
const titles = el => [...el.querySelectorAll('.lrow-t')].map(t => t.textContent)
const rowByTitle = (el, title) => [...el.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)

beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none', gifSize: 'full', workouts: [], routines: [], exWeights: {} }
  mocks.user = { id: 'u1', name: 'andi' }
  mocks.sync = { status: 'ok', offline: false, pending: false, auth: false, lastError: null, lastSynced: Date.now(), server: null }
  mocks.config = { password_login: true }
  mocks.webauthn = true
  mocks.sheets.length = 0
  mocks.passkeyLogin.mockClear()
  mocks.api.mockClear()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Settings: Connect Claude', () => {
  it('a signed-in browser offers it in Account; a guest does not', async () => {
    const page = mount(<Settings page="account" />)
    await settle()
    expect(titles(section(page, 'Account'))).toContain('Connect Claude')
    mocks.user = null
    const guest = mount(<Settings page="account" />)
    await settle()
    expect(titles(guest)).not.toContain('Connect Claude')
  })

  it('the sheet pairs, redeems at once, and shows the command with the token in it', async () => {
    const answer = mocks.api.getMockImplementation()
    mocks.api.mockImplementation(async (path, opts) => path === '/api/pair/create' ? { code: 'ABCD-1234' }
      : path === '/api/pair/redeem' ? (JSON.parse(opts.body).code === 'ABCD-1234' ? { token: 'u1:99:0.mac' } : {})
        : answer(path))
    const page = mount(<Settings page="account" />)
    await settle()
    act(() => rowByTitle(section(page, 'Account'), 'Connect Claude').click())
    const sheet = mount(mocks.sheets.at(-1).render(() => {}))
    expect(mocks.api.mock.calls.some(([p]) => p === '/api/pair/create')).toBe(false)   // nothing minted until asked
    const button = [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Create the command')
    await act(async () => { button.click() })
    await settle()
    expect(sheet.textContent).toContain(`claude mcp add --transport http opengym ${location.origin}/api/mcp --header "Authorization: Bearer u1:99:0.mac"`)
    expect([...sheet.querySelectorAll('button')].map(b => b.textContent)).toContain('Copy command')
  })

  it('a failed mint says so and shows no command', async () => {
    const answer = mocks.api.getMockImplementation()
    mocks.api.mockImplementation(async path => { if (path === '/api/pair/create') throw new Error('HTTP 500'); return answer(path) })
    const page = mount(<Settings page="account" />)
    await settle()
    act(() => rowByTitle(section(page, 'Account'), 'Connect Claude').click())
    const sheet = mount(mocks.sheets.at(-1).render(() => {}))
    await act(async () => { [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Create the command').click() })
    await settle()
    expect(sheet.textContent).toContain('Could not create a token')
    expect(sheet.textContent).not.toContain('claude mcp add')
  })
})
