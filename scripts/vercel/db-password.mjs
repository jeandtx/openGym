#!/usr/bin/env node
// A password for the API's database role (opengym_api), without the password ever leaving this
// machine in the clear (docs/VERCEL_SUPABASE.md):
//
//   node scripts/vercel/db-password.mjs <project-ref> <pooler-host> [env-file] [verifier-file]
//
// writes DATABASE_URL (the Supabase pooler, transaction mode, port 6543) to env-file (default
// .env.local, gitignored), and to verifier-file the statement that sets the role's password from
// its SCRAM-SHA-256 verifier:
//
//   alter role opengym_api password 'SCRAM-SHA-256$4096:…'
//
// A verifier is what Postgres stores in place of a password. It lets the server check a sign-in;
// it does not let anyone sign in. So the statement can be run through the Supabase SQL editor or
// an MCP tool without handing the password to either. Running this again makes a new password,
// and the old DATABASE_URL stops working once the new statement is run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [ref, host, envArg, verArg] = process.argv.slice(2);
if (!/^[a-z0-9]{20}$/.test(ref || '') || !/^[a-z0-9.-]+\.supabase\.com$/.test(host || '')) {
  console.error('usage: db-password.mjs <project-ref> <pooler-host, e.g. aws-0-eu-west-3.pooler.supabase.com> [env-file] [verifier-file]');
  process.exit(2);
}
const envFile = path.resolve(envArg || path.join(ROOT, '.env.local'));
const verFile = path.resolve(verArg || path.join(ROOT, '.vercel', 'db-verifier.sql'));

// URL-safe, so it needs no escaping inside the connection string.
const password = crypto.randomBytes(24).toString('base64url');
const iterations = 4096;
const salt = crypto.randomBytes(16);
const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const storedKey = crypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest();
const serverKey = hmac(salted, 'Server Key');
const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;

const url = `postgresql://opengym_api.${ref}:${password}@${host}:6543/postgres?sslmode=require`;
let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
text = text.replace(/^DATABASE_URL=.*\n?/m, '');
if (text && !text.endsWith('\n')) text += '\n';
fs.writeFileSync(envFile, text + `DATABASE_URL=${url}\n`, { mode: 0o600 });
fs.chmodSync(envFile, 0o600);
fs.mkdirSync(path.dirname(verFile), { recursive: true });
fs.writeFileSync(verFile, `alter role opengym_api password '${verifier}';\n`, { mode: 0o600 });
console.log(`DATABASE_URL written to ${envFile}; the statement that sets the password is in ${verFile}`);
