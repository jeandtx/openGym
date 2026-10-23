#!/usr/bin/env node
// The secrets the Vercel + Supabase mode reads from its environment (docs/VERCEL_SUPABASE.md):
//
//   SESSION_SECRET      the key every session cookie is signed with (what DATA_DIR/secret is)
//   VAPID_PUBLIC_KEY    the push keys (what DATA_DIR/vapid.json is)
//   VAPID_PRIVATE_KEY
//   CRON_SECRET         what Supabase pg_cron sends to POST /api/cron/tick
//
//   node scripts/vercel/gen-secrets.mjs [file]      default: .env.local at the repository root
//
// Only names missing from the file are made, so running it again never replaces a key: a new
// SESSION_SECRET signs everybody out, new VAPID keys silence every push subscription. Nothing is
// printed but the names. The file is gitignored; copy the values into Vercel (vercel env add) from
// there, never through a chat or a ticket.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.resolve(process.argv[2] || path.join(ROOT, '.env.local'));
const webpush = createRequire(path.join(ROOT, 'api', 'package.json'))('web-push');

const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const has = name => new RegExp(`^${name}=.+`, 'm').test(text);
const vapid = has('VAPID_PUBLIC_KEY') && has('VAPID_PRIVATE_KEY') ? null : webpush.generateVAPIDKeys();
const wanted = {
  SESSION_SECRET: () => crypto.randomBytes(32).toString('hex'),
  VAPID_PUBLIC_KEY: () => vapid.publicKey,
  VAPID_PRIVATE_KEY: () => vapid.privateKey,
  CRON_SECRET: () => crypto.randomBytes(32).toString('base64url')
};
const added = [];
let out = text && !text.endsWith('\n') ? text + '\n' : text;
for (const [name, make] of Object.entries(wanted)) {
  // Both VAPID halves are made together or not at all: one half alone would not match the other.
  if (has(name) && !(vapid && name.startsWith('VAPID_'))) continue;
  out = out.replace(new RegExp(`^${name}=.*\\n?`, 'm'), '');
  out += `${name}=${make()}\n`;
  added.push(name);
}
fs.writeFileSync(file, out, { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(added.length ? `${path.relative(process.cwd(), file) || file}: added ${added.join(', ')}` : `${file}: nothing to add, every secret is there`);
