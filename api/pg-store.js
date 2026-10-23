/* Postgres storage for server.js — the Vercel + Supabase mode (docs/VERCEL_SUPABASE.md).
 *
 * Loaded only when DATABASE_URL is set; without it nothing here is imported and the API keeps its
 * JSON files exactly as before. The driver (`postgres`) is an optional dependency for that reason.
 *
 * server.js keeps its whole working set in the process: db.json as one object it mutates in place,
 * the WebAuthn challenges, pairing codes, live presence, rest timers and the sign-in counters in
 * Maps. On a serverless host there is no process that outlives a request, and two requests can
 * land on two instances. So every request is one unit of work here, in one transaction:
 *
 *   1. take a transaction-scoped advisory lock (writers queue behind each other, across instances),
 *   2. load what the request may touch into the very objects server.js already uses,
 *   3. run the unchanged route handler against them, its answer held back in a buffer,
 *   4. write every row that changed, commit, and only then send the answer.
 *
 * An answer is therefore never sent for a write that did not land, and the routes keep the
 * "nothing awaited between the check and the write" reasoning they were written with. The cost is
 * that requests are serialized, which is nothing on an instance of a few profiles — the case this
 * mode is for.
 *
 * The synced document (`user_state`) is the exception: PUT /api/data reads and writes it itself
 * (readStateDoc / writeStateDoc), with the write conditional on the revision it read. */
import crypto from 'node:crypto';
import fs from 'node:fs';

let postgres;
try { ({ default: postgres } = await import('postgres')); }
catch { throw new Error('DATABASE_URL is set but the optional dependency "postgres" is not installed (npm install in api/)'); }

const URL_ = process.env.DATABASE_URL;
const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(URL_) || /host=\/|%2F/.test(URL_);
// One connection per instance, no prepared statements: the Supabase pooler in transaction mode
// (port 6543) hands a connection to whoever runs the next transaction, so a statement prepared on
// it would be found missing, or someone else's, on the next one.
export const sql = postgres(URL_, {
  max: +(process.env.PG_POOL_MAX || 1),
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: local || /sslmode=disable/.test(URL_) ? false : 'require',
  onnotice: () => {}
});

/* ---------- secrets from the environment ---------- */
// No file survives a cold start here, so the two secrets a long-lived server makes on first boot
// come from the environment instead (scripts/vercel/gen-secrets.mjs makes them). Refusing to start
// without them is the point: a random key per instance would sign everybody out on every request
// that lands on another instance, and push subscriptions would stop verifying.
function need(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error(`${name} must be set when DATABASE_URL is (scripts/vercel/gen-secrets.mjs)`);
  return v;
}
export function sessionSecret() {
  const s = need('SESSION_SECRET');
  if (s.length < 32) throw new Error('SESSION_SECRET is too short: use 32 random bytes as hex (scripts/vercel/gen-secrets.mjs)');
  return s;
}
export const vapidKeys = () => ({ publicKey: need('VAPID_PUBLIC_KEY'), privateKey: need('VAPID_PRIVATE_KEY') });

/* ---------- the records of db.json ---------- */
// Collection in db.json -> table, the field a row is keyed by, and the owner column if it has one.
const COLLECTIONS = [
  { name: 'users', table: 'users', key: 'id', col: 'id' },
  { name: 'creds', table: 'credentials', key: 'id', col: 'id', owner: 'userId' },
  { name: 'subs', table: 'push_subs', key: 'endpoint', col: 'endpoint', owner: 'userId' },
  { name: 'invites', table: 'invites', key: 'code', col: 'code' },
  { name: 'deviceLinks', table: 'device_links', key: 'h', col: 'h', owner: 'userId' }
];
const usable = (c, r) => !!r && typeof r === 'object' && typeof r[c.key] === 'string' && (!c.owner || typeof r[c.owner] === 'string');

export const emptyDb = () => ({ users: [], creds: [], subs: [], invites: [], deviceLinks: [] });

async function loadDb(tx) {
  const db = emptyDb();
  for (const c of COLLECTIONS) {
    const rows = await tx`select data from ${tx(c.table)} order by seq`;
    db[c.name] = rows.map(r => r.data);
  }
  return db;
}
// What each row looked like when it was loaded, by key, so only what a handler changed is written.
function fingerprint(db) {
  const out = {};
  for (const c of COLLECTIONS) {
    const m = new Map();
    for (const r of db[c.name] || []) if (usable(c, r)) m.set(r[c.key], JSON.stringify(r));
    out[c.name] = m;
  }
  return out;
}
async function saveDb(tx, before, db) {
  const after = fingerprint(db);
  let n = 0;
  // Removals first, the rows that point at a user before the user, then additions the other way.
  for (const c of [...COLLECTIONS].reverse()) {
    const gone = [...before[c.name].keys()].filter(k => !after[c.name].has(k));
    if (gone.length) { await tx`delete from ${tx(c.table)} where ${tx(c.col)} in ${tx(gone)}`; n += gone.length; }
  }
  for (const c of COLLECTIONS) {
    const users = after.users;
    for (const r of db[c.name] || []) {
      if (!usable(c, r)) continue;
      const k = r[c.key], text = after[c.name].get(k);
      if (before[c.name].get(k) === text) continue;
      // A row that names a profile which is not there (a passkey of a deleted account still in
      // memory) would fail the foreign key and take the whole request down; it is dropped instead.
      if (c.owner && c.name !== 'deviceLinks' && !users.has(r[c.owner])) continue;
      n++;
      if (c.name === 'users') {
        await tx`insert into users (id, data) values (${k}, ${text}::text::json)
                 on conflict (id) do update set data = excluded.data, updated_at = now()`;
      } else if (c.owner) {
        await tx`insert into ${tx(c.table)} (${tx(c.col)}, user_id, data) values (${k}, ${r[c.owner]}, ${text}::text::json)
                 on conflict (${tx(c.col)}) do update set data = excluded.data, user_id = excluded.user_id`;
      } else {
        await tx`insert into ${tx(c.table)} (${tx(c.col)}, data) values (${k}, ${text}::text::json)
                 on conflict (${tx(c.col)}) do update set data = excluded.data`;
      }
    }
  }
  return n;
}

/* ---------- the Maps server.js keeps in memory ---------- */
const snap = m => new Map([...m].map(([k, v]) => [k, JSON.stringify(v)]));
const changes = (before, m) => ({
  gone: [...before.keys()].filter(k => !m.has(k)),
  set: [...m].filter(([k, v]) => before.get(k) !== JSON.stringify(v))
});

/* ---------- the unit of work ---------- */
let current = null;          // the request being served: { tx, states, audit, pending, auditRows }
let queue = Promise.resolve();
const LOCK_KEY = 0x6f70656e;   // 'open': one lock for the instance's whole data set

export const tx = () => {
  if (!current) throw new Error('no unit of work open');
  return current.tx;
};

// Promises a handler started without awaiting (a push sent after the answer, as the rest timer
// and the reminder do on a long-lived server). A serverless instance may be frozen the moment
// the answer is out, so they are awaited before the commit instead.
export function track(p) {
  if (current) current.pending.push(Promise.resolve(p).catch(e => console.error('background task', e)));
  return p;
}

export function auditAppend(rec) {
  if (!current) return false;
  current.audit.push(rec);
  return true;
}
export const auditRows = () => current?.auditRows || [];
export async function clearAudit() {
  await tx()`delete from audit_log`;
  current.auditRows = [];
}

/* The synced document, read and written by PUT/GET /api/data themselves. */
export async function readStateDoc(uid) {
  const [row] = await tx()`select doc from user_state where user_id = ${uid}`;
  return row ? row.doc : null;
}
export async function readRev(uid) {
  const [row] = await tx()`select revision, doc->>'_wid' as wid from user_state where user_id = ${uid}`;
  return row ? { _rev: Number(row.revision), ...(row.wid ? { _wid: row.wid } : {}) } : null;
}
// Compare-and-set on the revision that was read: true when the document was written, false when
// another write got there first (the caller answers 409 with what is stored now).
export async function writeStateDoc(uid, text, baseRev, newRev) {
  const t = tx();
  const up = await t`update user_state set doc = ${text}::text::json, revision = ${newRev}, updated_at = now()
                     where user_id = ${uid} and revision = ${baseRev}`;
  if (up.count === 1) return true;
  if (baseRev !== 0) return false;
  const ins = await t`insert into user_state (user_id, doc, revision) values (${uid}, ${text}::text::json, ${newRev})
                      on conflict (user_id) do nothing`;
  if (ins.count === 1 && current) current.states.set(uid, JSON.parse(text));
  return ins.count === 1;
}
// Documents a route reads synchronously (readState in server.js) are loaded before it runs.
export function preloadedState(uid) {
  if (!current) return null;
  if (!current.states.has(uid)) throw new Error(`state of ${uid} was not loaded for this route (pg-store statesFor)`);
  return current.states.get(uid);
}

// Read-only routes: no lock to queue behind. Should one of them change something after all, the
// lock is taken before that is written.
const READ_ONLY = new Set([
  'GET /api/health', 'GET /api/config', 'GET /api/me', 'GET /api/data/rev', 'GET /api/nudge-check',
  'GET /api/push/public-key', 'GET /api/push/status', 'GET /api/account/passkeys', 'GET /api/account/password',
  'GET /api/admin/users', 'GET /api/admin/user', 'GET /api/admin/invites', 'GET /api/admin/audit'
]);

// A body is read whole before the transaction opens (readBody in server.js takes it from here),
// so the challenge it names can be loaded with everything else.
function bufferBody(req, max) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return Promise.resolve({ chunks: [], over: false });
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', d => { size += d.length; if (size > max) { over = true; chunks.length = 0; if (size > 2 * max) req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve({ chunks, over }));
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}
function bodyField(buf, name) {
  if (buf.over || !buf.chunks.length) return '';
  try { const v = JSON.parse(Buffer.concat(buf.chunks).toString('utf8'))?.[name]; return typeof v === 'string' ? v : ''; }
  catch { return ''; }
}

// The answer, held until the commit.
class HeldResponse {
  constructor() { this.statusCode = 200; this.headers = new Map(); this.chunks = []; this.headersSent = false; this.writableEnded = false; }
  setHeader(k, v) { this.headers.set(String(k).toLowerCase(), [k, v]); return this; }
  getHeader(k) { return this.headers.get(String(k).toLowerCase())?.[1]; }
  removeHeader(k) { this.headers.delete(String(k).toLowerCase()); }
  writeHead(code, h) {
    this.statusCode = code;
    if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  write(c) { if (c != null) this.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; }
  end(c) { this.write(c); this.headersSent = true; this.writableEnded = true; return this; }
  destroy() { this.destroyed = true; }
  sendTo(res) {
    for (const [k, v] of this.headers.values()) res.setHeader(k, v);
    res.writeHead(this.statusCode);
    res.end(Buffer.concat(this.chunks));
  }
}

/* `hooks` is what server.js hands in: the objects it keeps (getDb/setDb, the Maps, the limiters)
   and the questions only it can answer (routeKey, sessionUserId, statesFor). */
export function unitOfWork(hooks, inner) {
  return async (req, res) => {
    let buf;
    try { buf = await bufferBody(req, hooks.maxBody); }
    catch { return; }                       // the client hung up mid-body: nobody to answer
    req.bufferedBody = buf;
    const run = queue.then(() => serve(hooks, inner, req, res, buf));
    queue = run.catch(() => {});
    return run;
  };
}

async function serve(hooks, inner, req, res, buf) {
  const key = hooks.routeKey(req);
  const held = new HeldResponse();
  try {
    await sql.begin(async t => {
      const locked = !READ_ONLY.has(key);
      if (locked) await t`select pg_advisory_xact_lock(${LOCK_KEY})`;
      current = { tx: t, states: new Map(), audit: [], pending: [], auditRows: null };

      const db = await loadDb(t);
      const dbBefore = fingerprint(db);
      hooks.setDb(db);

      // The Maps: challenges by the id the body names (anyone may ask for one, so they are never
      // loaded wholesale), the rest whole — each is bounded by the number of profiles.
      const now = new Date();
      const maps = hooks.maps;
      const cid = bodyField(buf, 'cid');
      const ch = cid ? await t`select cid, data from challenges where cid = ${cid}` : [];
      maps.challenges.clear(); for (const r of ch) maps.challenges.set(r.cid, r.data);
      const pr = await t`select code, data from pairings where expires_at > ${now}`;
      maps.pairings.clear(); for (const r of pr) maps.pairings.set(r.code, r.data);
      const pe = await t`select user_id, data from presence`;
      maps.presence.clear(); for (const r of pe) maps.presence.set(r.user_id, r.data);
      const rt = await t`select user_id, device_id, due_at, lang from rest_timers`;
      maps.restTimers.clear();
      for (const r of rt) maps.restTimers.set(`${r.user_id}:${r.device_id}`, { userId: r.user_id, deviceId: r.device_id, due: r.due_at.getTime(), lang: r.lang });
      const mapsBefore = Object.fromEntries(Object.entries(maps).map(([n, m]) => [n, snap(m)]));

      const rl = await t`select name, key, data from rate_limits`;
      const byName = {};
      for (const r of rl) (byName[r.name] ||= []).push([r.key, r.data]);
      for (const [n, lim] of Object.entries(hooks.limiters)) lim.restore(byName[n] || []);
      const limBefore = Object.fromEntries(Object.entries(hooks.limiters).map(([n, l]) => [n, new Map(l.snapshot().map(([k, v]) => [k, JSON.stringify(v)]))]));

      // The documents this route reads synchronously.
      const want = hooks.statesFor(key, req, hooks.sessionUserId(req));
      if (want === 'all' || want.length) {
        const rows = want === 'all'
          ? await t`select user_id, doc from user_state`
          : await t`select user_id, doc from user_state where user_id in ${t(want)}`;
        if (want !== 'all') for (const u of want) current.states.set(u, null);
        else for (const u of db.users) current.states.set(u.id, null);
        for (const r of rows) current.states.set(r.user_id, r.doc);
      }
      if (key === 'GET /api/admin/audit') {
        const rows = await t`select id, data from audit_log order by id`;
        current.auditRows = rows.map(r => ({ ...r.data, id: Number(r.id) }));
      }

      await inner(req, held);
      // What the handler set going and did not wait for, then once more for what those started.
      while (current.pending.length) await Promise.all(current.pending.splice(0));

      let wrote = 0;
      const ensureLock = async () => { if (!locked && !wrote++) await t`select pg_advisory_xact_lock(${LOCK_KEY})`; };
      const dbAfter = fingerprint(hooks.getDb());
      const dbChanged = COLLECTIONS.some(c => {
        const a = dbAfter[c.name], b = dbBefore[c.name];
        return a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v);
      });
      if (dbChanged) { await ensureLock(); await saveDb(t, dbBefore, hooks.getDb()); }

      for (const [n, m] of Object.entries(maps)) {
        const d = changes(mapsBefore[n], m);
        if (!d.gone.length && !d.set.length) continue;
        await ensureLock();
        await flushMap(t, n, d, m);
      }
      for (const [n, lim] of Object.entries(hooks.limiters)) {
        const after = new Map(lim.snapshot());
        const before = limBefore[n];
        const gone = [...before.keys()].filter(k => !after.has(k));
        const set = [...after].filter(([k, v]) => before.get(k) !== JSON.stringify(v));
        if (!gone.length && !set.length) continue;
        await ensureLock();
        if (gone.length) await t`delete from rate_limits where name = ${n} and key in ${t(gone)}`;
        for (const [k, v] of set) {
          await t`insert into rate_limits (name, key, data) values (${n}, ${k}, ${JSON.stringify(v)}::text::json)
                  on conflict (name, key) do update set data = excluded.data, updated_at = now()`;
        }
      }
      for (const rec of current.audit) {
        const { id: _local, ...data } = rec;
        await t`insert into audit_log (ts, data) values (${rec.ts}, ${JSON.stringify(data)}::text::json)`;
      }
    });
  } catch (e) {
    current = null;
    if (e?.clientGone) return;
    console.error(hooks.routeKey(req), 'unit of work failed:', e);
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '2' });
      res.end(JSON.stringify({ error: 'storage unavailable, try again in a moment', code: 'storage' }));
    }
    return;
  }
  current = null;
  held.sendTo(res);
}

async function flushMap(t, name, d, m) {
  if (name === 'challenges') {
    if (d.gone.length) await t`delete from challenges where cid in ${t(d.gone)}`;
    for (const [k, v] of d.set) {
      await t`insert into challenges (cid, data, expires_at) values (${k}, ${JSON.stringify(v)}::text::json, ${new Date(v.exp)})
              on conflict (cid) do update set data = excluded.data, expires_at = excluded.expires_at`;
    }
  } else if (name === 'pairings') {
    if (d.gone.length) await t`delete from pairings where code in ${t(d.gone)}`;
    for (const [k, v] of d.set) {
      await t`insert into pairings (code, user_id, data, expires_at) values (${k}, ${v.uid}, ${JSON.stringify(v)}::text::json, ${new Date(v.exp)})
              on conflict (code) do update set data = excluded.data, expires_at = excluded.expires_at`;
    }
  } else if (name === 'presence') {
    if (d.gone.length) await t`delete from presence where user_id in ${t(d.gone)}`;
    for (const [k, v] of d.set) {
      await t`insert into presence (user_id, data) values (${k}, ${JSON.stringify(v)}::text::json)
              on conflict (user_id) do update set data = excluded.data, updated_at = now()`;
    }
  } else if (name === 'restTimers') {
    for (const k of d.gone) {
      const i = k.indexOf(':');
      await t`delete from rest_timers where user_id = ${k.slice(0, i)} and device_id = ${k.slice(i + 1)}`;
    }
    for (const [, v] of d.set) {
      await t`insert into rest_timers (user_id, device_id, due_at, lang) values (${v.userId}, ${v.deviceId || ''}, ${new Date(v.due)}, ${v.lang || null})
              on conflict (user_id, device_id) do update set due_at = excluded.due_at, lang = excluded.lang`;
    }
  }
  void m;
}

/* ---------- housekeeping, run by the cron tick ---------- */
export async function purge({ auditDays, auditMax }) {
  const t = tx();
  const now = new Date();
  await t`delete from challenges where expires_at < ${now}`;
  await t`delete from pairings where expires_at < ${now}`;
  await t`delete from rate_limits where updated_at < ${new Date(Date.now() - 2 * 86400000)}`;
  if (auditDays) await t`delete from audit_log where ts < ${Date.now() - auditDays * 86400000}`;
  if (auditMax) await t`delete from audit_log where id <= (select id from audit_log order by id desc offset ${auditMax} limit 1)`;
}

// The cron route's credential: a Bearer equal to CRON_SECRET, compared in constant time.
export function cronAuthorized(req) {
  const want = String(process.env.CRON_SECRET || '');
  if (want.length < 16) return false;
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b) && got.length === want.length;
}

// The schema, for the tests and for a first start against an empty local database. Supabase gets
// it as a migration (supabase/migrations/), never from here.
export async function applyMigrations(dir) {
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    await sql.unsafe(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  }
}
