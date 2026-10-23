/* The Postgres storage of the Vercel + Supabase mode (pg-store.js, docs/VERCEL_SUPABASE.md).
   Real server.js in children, each pointed at one fresh database made for this file; two servers
   on the same database stand in for two serverless instances. Skipped unless PG_TEST_URL names a
   Postgres the tests may create databases on, e.g.
     PG_TEST_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
   The authenticator is software, as in server-passkeys.test.js. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(API, '..', 'supabase', 'migrations');
const ADMIN_URL = process.env.PG_TEST_URL || '';
const skip = !ADMIN_URL && 'PG_TEST_URL not set';
const ORIGIN = 'http://localhost:8080';
const CRON_SECRET = crypto.randomBytes(24).toString('hex');
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();

const cborHead = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborText = s => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = b => Buffer.concat([cborHead(2, b.length), b]);
function softPasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')
  ]);
  const raw = crypto.randomBytes(16);
  const id = b64u(raw);
  let counter = 0;
  return {
    id,
    attestation(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
      const len = Buffer.from([raw.length >> 8, raw.length & 255]);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, raw, cose]);
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authData)
      ]);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] } };
    },
    assertion(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
      const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x05]), c]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null } };
    }
  };
}

let sql, dbUrl, dbName, admin, env;
before(async () => {
  if (skip) return;
  const { default: postgres } = await import('postgres');
  dbName = 'og_test_' + crypto.randomBytes(5).toString('hex');
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN_URL); u.pathname = '/' + dbName;
  dbUrl = u.toString();
  sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
  for (const f of fs.readdirSync(MIGRATIONS).sort()) await sql.unsafe(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  const vapid = JSON.parse(execFileSync(process.execPath, ['-e', "const w=require('web-push');process.stdout.write(JSON.stringify(w.generateVAPIDKeys()))"], { cwd: API }));
  env = {
    DATABASE_URL: dbUrl, SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, CRON_SECRET,
    ORIGIN, RP_ID: 'localhost', TRUST_PROXY: '1', COACH_DISABLED: '1', FIRST_USER_ADMIN: '1', AUDIT_LOG: '1'
  };
});
after(async () => {
  if (skip) return;
  await sql?.end();
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});
const reset = () => sql.unsafe('truncate users, credentials, push_subs, invites, device_links, user_state, audit_log, challenges, pairings, rate_limits, presence, rest_timers restart identity cascade');

async function startServer(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-pg-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, INVITE_ONLY: '', ADMIN_UIDS: '', ...env, ...extra }
  });
  const h = { log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.req = async (method, p, { body, cookie, ip = '198.51.100.7', headers = {} } = {}) => {
    const r = await fetch(`${h.api}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = r.headers.getSetCookie().find(c => c.startsWith('gymsid=') && !c.startsWith('gymsid=;'));
    return { status: r.status, body: await r.json(), cookie: setCookie ? setCookie.split(';')[0] : null };
  };
  return h;
}
async function register(h, name, key = softPasskey()) {
  const o = await h.req('POST', '/api/register/options', { body: { name } });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const v = await h.req('POST', '/api/register/verify', { body: { cid: o.body.cid, credential: key.attestation(o.body.options.challenge) } });
  assert.equal(v.status, 200, JSON.stringify(v.body) + h.log);
  return { key, user: v.body.user, cookie: v.cookie };
}
async function signIn(h, key, other = h) {
  const o = await h.req('POST', '/api/login/options', { body: {} });
  return other.req('POST', '/api/login/verify', { body: { cid: o.body.cid, credential: key.assertion(o.body.options.challenge) } });
}
const doc = extra => ({ routines: [], workouts: [], bodyweight: [], unit: 'kg', ...extra });

test('a profile made with a passkey lands in users and credentials, the first one as admin', { skip }, async t => {
  await reset();
  const h = await startServer(t);
  const { user, cookie } = await register(h, 'Jean');
  assert.ok(cookie);
  assert.equal(user.admin, true);
  const [row] = await sql`select data from users where id = ${user.id}`;
  assert.equal(row.data.name, 'Jean');
  assert.equal(row.data.admin, true);
  const creds = await sql`select user_id, data from credentials`;
  assert.equal(creds.length, 1);
  assert.equal(creds[0].user_id, user.id);
  assert.ok(creds[0].data.publicKey);
  assert.equal((await h.req('GET', '/api/me', { cookie })).body.user.id, user.id);
  const ev = (await sql`select data from audit_log order by id`).map(r => r.data.ev);
  assert.deepEqual(ev, ['admin.first-user', 'auth.register.ok']);
  // The second profile is no admin: "first" was decided against the database, not memory.
  const second = await register(h, 'Bea');
  assert.equal(second.user.admin, false);
});

test('sign out and back in, on another instance than the one that handed out the challenge', { skip }, async t => {
  await reset();
  const a = await startServer(t), b = await startServer(t);
  const { key, user, cookie } = await register(a, 'Jean');
  assert.equal((await a.req('POST', '/api/logout', { cookie })).status, 200);
  const r = await signIn(a, key, b);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, user.id);
  // The cookie one instance signed is good on the other: one SESSION_SECRET for all of them.
  assert.equal((await a.req('GET', '/api/me', { cookie: r.cookie })).status, 200);
  const [cred] = await sql`select data from credentials`;
  assert.equal(cred.data.counter, 1);
  // "Sign out everywhere" on one instance ends the cookie on the other.
  assert.equal((await b.req('POST', '/api/logout/all', { cookie: r.cookie })).status, 200);
  assert.equal((await a.req('GET', '/api/me', { cookie: r.cookie })).status, 401);
});

test('a save on the right revision lands, a stale one gets 409 with the current document, the merge then lands', { skip }, async t => {
  await reset();
  const h = await startServer(t);
  const { user, cookie } = await register(h, 'Jean');
  assert.deepEqual((await h.req('GET', '/api/data', { cookie })).body, { state: null, rev: 0 });

  const first = await h.req('PUT', '/api/data', { cookie, body: { baseRev: 0, state: doc({ workouts: [{ id: 'w1', d: '2026-10-20' }] }) } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.rev, 1);
  const [row] = await sql`select revision, doc from user_state where user_id = ${user.id}`;
  assert.equal(Number(row.revision), 1);
  assert.equal(row.doc._rev, 1);

  // A second device that last saw revision 0 pushes: refused, with what is there now.
  const stale = await h.req('PUT', '/api/data', { cookie, body: { baseRev: 0, state: doc({ workouts: [{ id: 'w2', d: '2026-10-21' }] }) } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 1);
  assert.deepEqual(stale.body.state.workouts.map(w => w.id), ['w1']);

  // It merges what it was handed and pushes on top of it.
  const merged = doc({ workouts: [...stale.body.state.workouts, { id: 'w2', d: '2026-10-21' }] });
  const ok = await h.req('PUT', '/api/data', { cookie, body: { baseRev: stale.body.rev, baseWid: stale.body.state._wid, state: merged } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.rev, 2);
  assert.deepEqual((await h.req('GET', '/api/data/rev', { cookie })).body, { rev: 2, wid: ok.body.wid });
  const back = await h.req('GET', '/api/data', { cookie });
  assert.deepEqual(back.body.state.workouts.map(w => w.id), ['w1', 'w2']);
  assert.equal(back.body.state._wids.length, 1);
  // A wrong write id over the right number is a conflict too.
  const wrongWid = await h.req('PUT', '/api/data', { cookie, body: { baseRev: 2, baseWid: 'deadbeefdeadbeef', state: merged } });
  assert.equal(wrongWid.status, 409);
});

test('the write is conditional on the revision column: a write from outside the API makes it a 409', { skip }, async t => {
  await reset();
  const h = await startServer(t);
  const { user, cookie } = await register(h, 'Jean');
  assert.equal((await h.req('PUT', '/api/data', { cookie, body: { baseRev: 0, state: doc({ unit: 'kg' }) } })).status, 200);
  // Someone else moved the row on without touching the document's own counter.
  await sql`update user_state set revision = 7 where user_id = ${user.id}`;
  const r = await h.req('PUT', '/api/data', { cookie, body: { baseRev: 1, state: doc({ unit: 'lb' }) } });
  assert.equal(r.status, 409);
  assert.equal(r.body.state.unit, 'kg');
  const [row] = await sql`select revision, doc from user_state where user_id = ${user.id}`;
  assert.equal(Number(row.revision), 7);
  assert.equal(row.doc.unit, 'kg');
});

test('a challenge is one-shot, refused once expired, and the cron tick purges the ones nobody used', { skip }, async t => {
  await reset();
  const h = await startServer(t);
  const { key } = await register(h, 'Jean');
  const o = await h.req('POST', '/api/login/options', { body: {} });
  const credential = key.assertion(o.body.options.challenge);
  await sql`update challenges set data = (data::jsonb || jsonb_build_object('exp', ${Date.now() - 1000}::bigint))::json where cid = ${o.body.cid}`;
  const late = await h.req('POST', '/api/login/verify', { body: { cid: o.body.cid, credential } });
  assert.equal(late.status, 400);
  assert.equal(late.body.code, 'challenge-expired');
  assert.equal((await sql`select 1 from challenges where cid = ${o.body.cid}`).length, 0, 'taken even though refused');

  const o2 = await h.req('POST', '/api/login/options', { body: {} });
  const cred2 = key.assertion(o2.body.options.challenge);
  assert.equal((await h.req('POST', '/api/login/verify', { body: { cid: o2.body.cid, credential: cred2 } })).status, 200);
  assert.equal((await h.req('POST', '/api/login/verify', { body: { cid: o2.body.cid, credential: cred2 } })).body.code, 'challenge-expired');

  await sql`insert into challenges (cid, data, expires_at) values ('old', '{"kind":"login","exp":1}', now() - interval '1 minute')`;
  await sql`insert into challenges (cid, data, expires_at) values ('fresh', '{"kind":"login","exp":9999999999999}', now() + interval '5 minutes')`;
  assert.equal((await h.req('POST', '/api/cron/tick', { headers: { Authorization: 'Bearer wrong-secret-0000' } })).status, 401);
  const tick = await h.req('POST', '/api/cron/tick', { headers: { Authorization: `Bearer ${CRON_SECRET}`, 'Sec-Fetch-Site': '' } });
  assert.equal(tick.status, 200, JSON.stringify(tick.body) + h.log);
  assert.deepEqual((await sql`select cid from challenges`).map(r => r.cid), ['fresh']);
});

test('a rest timer is a row until the cron tick finds it due', { skip }, async t => {
  await reset();
  const h = await startServer(t);
  const { user, cookie } = await register(h, 'Jean');
  assert.equal((await h.req('POST', '/api/push/rest-timer', { cookie, body: { seconds: 90, deviceId: 'phone-0001' } })).status, 200);
  const [row] = await sql`select user_id, device_id, due_at from rest_timers`;
  assert.equal(row.user_id, user.id);
  assert.equal(row.device_id, 'phone-0001');
  assert.ok(Math.abs(row.due_at.getTime() - (Date.now() + 90000)) < 5000);
  const auth = { Authorization: `Bearer ${CRON_SECRET}` };
  assert.equal((await h.req('POST', '/api/cron/tick', { headers: auth })).body.rest, 0);
  await sql`update rest_timers set due_at = now() - interval '1 second'`;
  assert.equal((await h.req('POST', '/api/cron/tick', { headers: auth })).body.rest, 1);
  assert.equal((await sql`select 1 from rest_timers`).length, 0);
  // Cancelling removes it without a tick.
  await h.req('POST', '/api/push/rest-timer', { cookie, body: { seconds: 60, deviceId: 'phone-0001' } });
  await h.req('POST', '/api/push/rest-timer/cancel', { cookie, body: { deviceId: 'phone-0001' } });
  assert.equal((await sql`select 1 from rest_timers`).length, 0);
});

test('invite-only signup, codes made by the admin, burned in the database', { skip }, async t => {
  await reset();
  const open = await startServer(t);
  const { cookie } = await register(open, 'Jean');
  const h = await startServer(t, { INVITE_ONLY: '1' });
  const denied = await h.req('POST', '/api/register/options', { body: { name: 'Eve', code: 'NOPE' } });
  assert.equal(denied.status, 403);
  const inv = await h.req('POST', '/api/admin/invites/new', { cookie, body: { note: 'Bea' } });
  assert.equal(inv.status, 200);
  const o = await h.req('POST', '/api/register/options', { body: { name: 'Bea', code: inv.body.invite.code } });
  const v = await h.req('POST', '/api/register/verify', { body: { cid: o.body.cid, credential: softPasskey().attestation(o.body.options.challenge) } });
  assert.equal(v.status, 200);
  const [row] = await sql`select data from invites`;
  assert.equal(row.data.usedBy, v.body.user.id);
  const users = (await h.req('GET', '/api/admin/users', { cookie })).body.users;
  assert.deepEqual(users.map(u => u.name), ['Jean', 'Bea']);
});

test('the sign-in counters are kept in the database, so a second instance sees the same budget', { skip }, async t => {
  await reset();
  const a = await startServer(t), b = await startServer(t);
  // POST /api/device-link/options spends 60 a minute per address (AUTH_BURST) on any instance.
  let last;
  for (let i = 0; i < 61; i++) last = await (i % 2 ? b : a).req('POST', '/api/device-link/options', { body: { code: 'X' }, ip: '203.0.113.9' });
  assert.equal(last.status, 429);
  const rows = await sql`select name from rate_limits where key = '203.0.113.9'`;
  assert.ok(rows.some(r => r.name === 'AUTH_BURST'));
});

test('deleting an account removes its rows everywhere, the document included', { skip }, async t => {
  await reset();
  const h = await startServer(t);
  await register(h, 'Jean');
  const bea = await register(h, 'Bea');
  await h.req('PUT', '/api/data', { cookie: bea.cookie, body: { baseRev: 0, state: doc() } });
  const r = await h.req('POST', '/api/account/delete', { cookie: bea.cookie, body: { name: 'Bea', ...(await (async () => {
    const o = await h.req('POST', '/api/login/options', { body: {} });
    return { cid: o.body.cid, credential: bea.key.assertion(o.body.options.challenge) };
  })()) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const table of ['credentials', 'user_state']) {
    assert.equal((await sql.unsafe(`select 1 from ${table} where user_id = $1`, [bea.user.id])).length, 0, table);
  }
  assert.equal((await sql`select 1 from users where id = ${bea.user.id}`).length, 0);
});

test('without its secrets the server refuses to start rather than make up new ones', { skip }, async () => {
  const out = await new Promise(resolve => {
    const child = spawn(process.execPath, ['server.js'], { cwd: API, env: { ...process.env, ...env, PORT: '0', SESSION_SECRET: '' } });
    let log = '';
    child.stderr.on('data', d => log += d);
    child.on('exit', code => resolve({ code, log }));
  });
  assert.notEqual(out.code, 0);
  assert.match(out.log, /SESSION_SECRET must be set/);
});

test('scripts/vercel/import-data.mjs moves a ./data in, and the old cookies keep working with its secret', { skip }, async t => {
  await reset();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-import-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const key = softPasskey();
  const oldSecret = crypto.randomBytes(32).toString('hex');
  const u = { id: 'u_import_1', name: 'Jean', created: '2026-01-01T00:00:00.000Z', admin: true, owner: true };
  fs.writeFileSync(path.join(dataDir, 'secret'), oldSecret);
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [u], creds: [{ id: key.id, userId: u.id, publicKey: 'x', counter: 3 }, { id: 'orphan', userId: 'gone', publicKey: 'y', counter: 0 }],
    subs: [], invites: [{ code: 'ABC', created: '2026-01-02' }]
  }));
  fs.writeFileSync(path.join(dataDir, `state-${u.id}.json`), JSON.stringify({ _rev: 12, _wid: 'w12', workouts: [{ id: 'w', d: '2026-02-02' }], routines: [] }));
  fs.writeFileSync(path.join(dataDir, 'audit.log'), JSON.stringify({ id: 1, ts: 1, ev: 'auth.login.ok', ok: true }) + '\ntorn line\n');

  const run = (...a) => new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(API, '..', 'scripts', 'vercel', 'import-data.mjs'), ...a], { env: { ...process.env, DATABASE_URL: dbUrl } });
    let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
    c.on('exit', code => resolve({ code, out }));
  });
  const r = await run(dataDir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /imported 1 profile\(s\), 1 passkey\(s\).*1 document\(s\), 1 audit row/);
  assert.equal((await run(dataDir)).code, 1, 'a second import into a database with profiles is refused');

  const h = await startServer(t, { SESSION_SECRET: oldSecret });
  const payload = `${u.id}:${Date.now() + 86400000}:0`;
  const cookie = 'gymsid=' + payload + '.' + crypto.createHmac('sha256', oldSecret).update(payload).digest('base64url');
  const data = await h.req('GET', '/api/data', { cookie });
  assert.equal(data.status, 200);
  assert.equal(data.body.rev, 12);
  assert.deepEqual(data.body.state.workouts, [{ id: 'w', d: '2026-02-02' }]);
  assert.deepEqual((await h.req('GET', '/api/data/rev', { cookie })).body, { rev: 12, wid: 'w12' });
  assert.equal((await h.req('PUT', '/api/data', { cookie, body: { baseRev: 12, state: doc() } })).body.rev, 13);
});
