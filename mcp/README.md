# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — directly from your
self-hosted `./data` directory or through your own server, review a block of training, and
change your plan: log a workout or a weigh-in, edit routines, schedule next week.

It runs locally as a stdio process spawned by the LLM client and adds no new container. With a
data directory the read tools need no authentication: they read the same `state-<uid>.json`
files the openGym api already writes, and the LLM never sees passkeys, VAPID keys, or session
secrets. The write tools are off until you pair it with your server (see
[Logging workouts](#logging-workouts)); once paired, an instance whose data is not a folder on
this machine (a remote server, the Vercel + Supabase mode) is read through the server too
([Server mode](#server-mode)).

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Read tools, reviews, and the first write tools. See **Roadmap** below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js

# no data directory here (a remote or Vercel + Supabase instance): read through the server,
# with the token from pairing (see Server mode):
OPENGYM_URL=https://gym.example.com OPENGYM_TOKEN=<token> node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Tools

Nine read tools, three review tools, and five that write:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |
| `training_review` | How did the last four weeks go against the four before? Sessions, volume, effort, per-exercise estimated 1RM and trend, stalled lifts, PRs, per-muscle work, body weight. [Reviews and planning](#reviews-and-planning). |
| `recovery_status` | Which muscles are fatigued, recovering or ready right now, and which are losing strength from neglect (the Stats screen's model). |
| `find_exercise` | An exercise name → the library id the plan tools take, or candidates when it is ambiguous. |
| `log_workout` | *Writes.* "I did dumbbell curls, 12 kg, 12/12/10" → a logged session in your history, on every device. Needs pairing: [Logging workouts](#logging-workouts). |
| `log_bodyweight` | *Writes.* A weigh-in for a day; a second one that day replaces it. |
| `apply_plan_changes` | *Writes.* Routine and weekly-plan edits in the AI Coach's change format (sets, reps, swap, add/remove an exercise or a routine, progression, the weekday plan), all or nothing, snapshotted first. |
| `revert_last_plan_change` | *Writes.* Undo the last `apply_plan_changes` (or the in-app Coach's last change). |
| `schedule_week` | *Writes.* Next week's sessions as a coach week: routines in order, offered one by one on the days you train, optionally pinned to dates. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## Logging workouts

`log_workout` lets you tell your LLM what you did instead of tapping it in:

> "Log today: dumbbell curls, 12 kg, three sets of 12 except the last was 10. Then planks, 3 × 60 s."

The LLM turns that into exercises and sets; the tool matches the exercises against your library,
builds the workout the way the app's Finish button does (PR badges, the next suggested weight,
warm-ups kept out of volume) and saves it through your openGym server, so every signed-in
device shows it within half a minute. Asking for the same thing twice logs it once.

Exercise names are matched the way a CSV import matches them. A common name resolves to the
library's default variant ("shoulder press" is the barbell one, "leg press" the 45° sled), and the
reply shows what it was matched to so the LLM can check with you. What it will not do is pick
between two entries: "lever chest press" is two in the library, and a name like that, or one that
matches nothing, comes back as a question with candidates. It only creates one of your own
exercises when you confirm the library has none.

### Pairing

Writes go through the api rather than straight into `./data`, because the api is what keeps a
phone's sync and this write from overwriting each other. So the MCP server needs your server's
address and a sign-in:

1. In the app, signed in as the profile to log into: **Settings → Account → Pair the mobile app**.
   It shows a one-time code (valid five minutes).
2. Turn the code into a token:

   ```bash
   node mcp/scripts/pair.mjs https://gym.example.com ABCD-1234
   ```

3. Add both to the MCP server's `env` in your client config:

   ```jsonc
   "env": {
     "OPENGYM_DATA": "/absolute/path/to/openGym/data",
     "OPENGYM_URL": "https://gym.example.com",
     "OPENGYM_TOKEN": "<the token pair.mjs printed>"
   }
   ```

Things to know about that token:

- It is a **full sign-in to your profile**, the same kind the paired phone app holds, not a
  workout-only key. Your client's config file holds it in plain text; treat it like a password.
- `OPENGYM_URL` has to be `https://` (plain `http://` only to `localhost`), so it never crosses a
  network in the clear.
- It lasts `SESSION_DAYS` (90 days by default). **Sign out everywhere** in Settings ends it at
  once. Either way `log_workout` then says the token was not accepted: pair again.
- Pairing again gets you a new token but does **not** end the old one. To retire a token you
  think has leaked, use Sign out everywhere (which also disconnects paired phones).
- If the MCP server also reads a `./data` directory, the token has to belong to the same profile
  (`OPENGYM_UID`); a token for another one is refused. The server can be remote: without
  `OPENGYM_DATA` the read tools read through it too ([Server mode](#server-mode)).

### Server mode

With `OPENGYM_URL` and `OPENGYM_TOKEN` set and no `OPENGYM_DATA`, the MCP server reads the
profile through the api instead of a folder: `GET /api/me` once to learn whose token it is, then
before each tool call `GET /api/data/rev` — the same cheap poll the app makes every half minute —
and `GET /api/data` only when the revision moved. A session logged on the phone is in the next
answer; a write made through a tool is re-read at once. This is the setup for an instance whose
data you cannot mount: a server you reach only over https, or the Vercel + Supabase mode
(`docs/VERCEL_SUPABASE.md`), where the data lives in Postgres.

```jsonc
"env": {
  "OPENGYM_URL": "https://gym.example.com",
  "OPENGYM_TOKEN": "<the token pair.mjs printed>"
}
```

For Claude Code, `claude mcp add` does the same from the command line:

```bash
claude mcp add opengym -s user \
  -e OPENGYM_URL=https://gym.example.com -e OPENGYM_TOKEN=<token> \
  -- node /absolute/path/to/openGym/mcp/src/index.js
```

### What it does not do (yet)

- Cardio by time and speed, supersets, per-side sets. Log those in the app.
- Edit or delete a workout. Fix a mistake in the app's History.
- Complete a routine's session. A logged workout is freestyle: it counts in history, stats,
  1RM, PRs and the muscle map, and like any freestyle session it can inform a routine that has
  no history of its own, but it does not tick off a planned day or a coach week's session.

## Reviews and planning

The review tools put a block of training on the table in one call, so a monthly check-in does
not start with forty `get_workout` calls the model has to add up:

> "Review my last month and propose next week."

1. `training_review` compares a period (the last 28 days by default) with the one just before
   it: sessions per week against the weekly plan, volume, work sets (warm-ups left out), effort
   (share of sets to failure, average RIR/RPE), each exercise's estimated 1RM — best, first and
   last in the period, change against the previous period, trend — the lifts trained three
   times or more without a gain (`stalled`), those dropped since, PRs, effective sets per muscle
   and per week, the muscles not trained, and body weight against the goal.
2. `recovery_status` says what is fatigued today, and `get_week_plan` / `get_routine` /
   `preview_session` what is planned and at which weights.
3. The proposal goes to the user. Only once they agree:
   `apply_plan_changes` (new routines, sets/reps, swaps — `dry_run` first), then `schedule_week`
   with the week's sessions in order. `revert_last_plan_change` undoes a plan change.

`apply_plan_changes` speaks the AI Coach's change format and runs the Coach's own code
(`frontend/src/lib/coach.js`): the closed list of change types, the check that `before` is
still what the plan holds (an edit made on the phone meanwhile makes the whole set refuse rather
than be overwritten), and a snapshot taken first. Exercise names are resolved against the
library like `log_workout`'s; an ambiguous one comes back as a question. Weights are left to the
routine's progression policy, which is what decides them in the app anyway.

`schedule_week` writes a coach week (`S.queue`, `frontend/src/lib/queue.js`): the format the app
already has for "a planner — any API client that PUTs state with a queue". The app offers its
first session not done yet on whatever day you next train, so a missed day shifts the week
instead of skipping a session; a session pinned to a date is offered on that date. The weekday
plan keeps showing its own routines beside it, and the answer says so when it has any. A week
still running, the in-app rotation, or a date with its own plan is only replaced with
`replace: true`.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** The read tools' boundary is the filesystem — same as `docker compose`
  running on the user's box. No passkey material, VAPID keys, or session secrets ever cross it.
  `log_workout` uses the paired-session token the phone app already uses; no new kind of
  credential, no new api route.
- **No telemetry.** The read tools make no network call. `log_workout` talks to your own
  openGym server and nothing else. The process exits when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
```

58 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

The review tools are tested in `review-tools.test.js` on a hand-built history whose numbers can
be checked by hand; the plan tools in `plan-tools.test.js`, pure and against a stand-in api;
server mode in `state-remote.test.js`, and end to end in `remote-mode.e2e.test.js`: the real MCP
server spawned by an MCP client over stdio with no data directory, reading and writing through
the real `api/server.js`.

`log_workout` has two more files: `write-tools.test.js` against a stand-in api (conflicts,
retries, a rejected token, dry runs, duplicates), and `log-workout.e2e.test.js` against the real
`api/server.js` on a temp data directory, which needs `npm ci` in `api/` (it skips without it on
a laptop and fails under `CI`). The workout it builds is tested in
`frontend/src/lib/log-workout.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Phase 2:** read+write over stdio, in pieces (#116). Writes go through the api's own
  `PUT /api/data` with the revision they read, as a paired device does, rather than into
  `state-<uid>.json` directly: the api is the one writer of that file, and its sync stamps are
  what keep a write from being undone by the next phone that merges.
  - **Done:** `log_workout`, on the paired-session token (`scripts/pair.mjs`).
  - **Done:** `log_bodyweight`, `apply_plan_changes` / `revert_last_plan_change` (routines and
    the weekday plan, in the Coach's change format), `schedule_week` (a coach week).
  - **Done:** server mode — the read tools through the api, for an instance with no data
    directory to mount.
  - Next: log corrections (edit or delete a logged workout), equipment profiles.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
