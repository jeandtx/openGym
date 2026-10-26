/* The write path every plan and body-weight tool shares: read the profile from the server, change
   a copy, PUT it back over the revision it was read at, and on a 409 do it again on top of the
   document the server sent back — the same round trip log_workout makes (write-tools.js) and the
   one the app's own devices make.

   The PUT carries the document exactly as the server sent it plus the change, and no `stamped`
   flag: the server then stamps what changed itself, against its stored copy, at its own time
   (api/sync-stamps.js, "an API client"), so every device's next merge keeps the edit. */
import { localUid, invalidate } from './state.js'
import { apiConfig, apiFetch } from './api-client.js'

// Two writers racing the same profile resolve in a round or two; past that something keeps
// writing, and the user is better told than retried at.
const MAX_ATTEMPTS = 3

export function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Change the profile on the server. `mutate(S)` gets a private copy of the document to edit in
 * place and returns `{ result, changed }`: `changed: false` writes nothing (a dry run, a no-op),
 * and a throw writes nothing either — the copy is dropped. It may run more than once (after a
 * conflict), each time on a fresh copy of the newer document, so it must not keep state between
 * calls. Resolves `result`, with `revision` added once written.
 */
export async function commitProfile(mutate, { env = process.env, fetchImpl } = {}) {
  const cfg = apiConfig(env)
  const opts = fetchImpl ? { fetchImpl } : {}

  const me = await apiFetch(cfg, '/api/me', opts)
  const uid = me.body?.user?.id
  if (typeof uid !== 'string' || !uid) throw fail('EAPI', 'the openGym server did not say which profile OPENGYM_TOKEN belongs to (GET /api/me); nothing was saved')
  const local = localUid()
  if (local && local !== uid) {
    // The ids go to the operator on stderr, not into the model's context (state.js ambiguousUid).
    console.error(`[opengym-mcp] OPENGYM_TOKEN is for profile ${uid}, this server reads ${local}`)
    throw fail('EPROFILE', 'OPENGYM_TOKEN belongs to another profile than the one this server reads: pair again from the right profile, or set OPENGYM_UID to match (the ids are on the server\'s stderr)')
  }

  let got = await apiFetch(cfg, '/api/data', opts)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const doc = got.body?.state
    if (!doc || typeof doc !== 'object') {
      throw fail('ENOSTATE', 'this profile has no synced data on the server yet: open openGym and sign in on a device once, then try again')
    }
    const S = structuredClone(doc)
    const { result, changed } = mutate(S)
    if (!changed) return result
    const put = await apiFetch(cfg, '/api/data', { ...opts, method: 'PUT', body: { state: S, baseRev: got.body.rev ?? 0, ...(typeof doc._wid === 'string' ? { baseWid: doc._wid } : {}) } })
    if (put.status !== 409) {
      invalidate()
      return { ...result, revision: put.body?.rev ?? null }
    }
    if (!put.body?.state || typeof put.body.state !== 'object' || typeof put.body.rev !== 'number') {
      throw fail('EAPI', 'the openGym server answered 409 without the current profile; nothing was saved')
    }
    got = { status: 200, body: { state: put.body.state, rev: put.body.rev } }
  }
  throw fail('ECONFLICT', `the profile kept changing on the server (${MAX_ATTEMPTS} attempts); nothing was saved — try again in a moment`)
}
