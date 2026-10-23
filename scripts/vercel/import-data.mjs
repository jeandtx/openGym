#!/usr/bin/env node
// Moves an existing self-hosted ./data into the Postgres of the Vercel + Supabase mode
// (docs/VERCEL_SUPABASE.md): db.json (profiles, passkeys, push subscriptions, invites, device
// links), every state-<uid>.json and audit.log.
//
//   DATABASE_URL=postgres://… node scripts/vercel/import-data.mjs ./data [--replace]
//
// Into an empty database only, unless --replace, which first empties every table this mode uses.
// One transaction: it all lands or none of it does. Sessions do not move with it — a cookie is
// signed with DATA_DIR/secret, and to keep everybody signed in, set SESSION_SECRET to the contents
// of that file. VAPID keys likewise: set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from data/vapid.json
// and the push subscriptions keep working; with new keys every device re-subscribes on its own.
// Photos and videos under data/uploads/ are not imported: this mode does not store them.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const dir = path.resolve(args.find(a => !a.startsWith('--')) || 'data');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (!fs.existsSync(path.join(dir, 'db.json'))) { console.error(`${dir}/db.json not found`); process.exit(2); }

const postgres = createRequire(path.join(ROOT, 'api', 'package.json'))('postgres');
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: local ? false : 'require', onnotice: () => {} });

const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
const users = (db.users || []).filter(u => u && typeof u.id === 'string');
const ids = new Set(users.map(u => u.id));
const owned = (list, key) => (list || []).filter(r => r && typeof r[key] === 'string' && ids.has(r.userId));
const creds = owned(db.creds, 'id');
const subs = owned(db.subs, 'endpoint');
const links = (db.deviceLinks || []).filter(l => l && typeof l.h === 'string' && l.exp > Date.now());
const invites = (db.invites || []).filter(i => i && typeof i.code === 'string');
const dropped = (db.creds || []).length - creds.length + (db.subs || []).length - subs.length;

const TABLES = 'users, credentials, push_subs, invites, device_links, user_state, audit_log, challenges, pairings, rate_limits, presence, rest_timers';
const t0 = Date.now();
let states = 0, audit = 0;
try {
  await sql.begin(async tx => {
    const [{ n }] = await tx`select count(*)::int as n from users`;
    if (n && !replace) throw new Error(`the database already has ${n} profile(s); run again with --replace to empty it first`);
    if (replace) await tx.unsafe(`truncate ${TABLES} restart identity cascade`);
    const j = v => JSON.stringify(v);
    for (const u of users) await tx`insert into users (id, data) values (${u.id}, ${j(u)}::text::json)`;
    for (const c of creds) await tx`insert into credentials (id, user_id, data) values (${c.id}, ${c.userId}, ${j(c)}::text::json) on conflict do nothing`;
    for (const s of subs) await tx`insert into push_subs (endpoint, user_id, data) values (${s.endpoint}, ${s.userId}, ${j(s)}::text::json) on conflict do nothing`;
    for (const i of invites) await tx`insert into invites (code, data) values (${i.code}, ${j(i)}::text::json) on conflict do nothing`;
    for (const l of links) await tx`insert into device_links (h, user_id, data) values (${l.h}, ${l.userId}, ${j(l)}::text::json) on conflict do nothing`;
    for (const u of users) {
      const f = path.join(dir, 'state-' + u.id.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
      if (!fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      const doc = JSON.parse(text);        // an unreadable one stops the import: better than losing it
      await tx`insert into user_state (user_id, doc, revision) values (${u.id}, ${text}::text::json, ${Number(doc?._rev) || 0})`;
      states++;
    }
    const log = path.join(dir, 'audit.log');
    if (fs.existsSync(log)) {
      for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r || !r.ev || !r.ts) continue;
        const { id: _old, ...data } = r;
        await tx`insert into audit_log (ts, data) values (${r.ts}, ${j(data)}::text::json)`;
        audit++;
      }
    }
  });
} catch (e) {
  console.error('import failed, nothing was written:', e.message);
  await sql.end();
  process.exit(1);
}
await sql.end();
console.log(`imported ${users.length} profile(s), ${creds.length} passkey(s), ${subs.length} push subscription(s), ${invites.length} invite(s), ${states} document(s), ${audit} audit row(s) in ${Date.now() - t0} ms` +
  (dropped ? ` — ${dropped} passkey/subscription row(s) of profiles that no longer exist were left out` : ''));
if (fs.existsSync(path.join(dir, 'uploads'))) console.log('note: data/uploads/ (photos and videos of custom exercises) is not imported; this mode does not store them');
