#!/usr/bin/env node
// Builds openGym for Vercel as Build Output API v3 (docs/VERCEL_SUPABASE.md):
//
//   .vercel/output/static/                 the Vite build, plus exercise-media/ from catalogue/media
//   .vercel/output/functions/api.func/     ONE Node function: api/server.js bundled with esbuild,
//                                          plus the MCP endpoint at /api/mcp (mcp/src/http.js)
//   .vercel/output/config.json             /api/* -> that function, then the files, one origin
//
// Why not Vercel's zero-config: it turns every file under a root `api/` folder into its own
// function, and this repository's api/ is a server, its modules and its tests (past the Hobby
// plan's 12 functions, the deployment is refused). Renaming the folder would make every upstream
// update a conflict. So vercel.json lists one build explicitly — which switches the detection off —
// and that build (@vercel/static-build, `npm run vercel-build`) runs this script and deploys the
// .vercel/output it leaves as it is.
//
//   node scripts/vercel/build.mjs          (what vercel.json's buildCommand runs)
//
// The headers are the web container's (web/nginx.conf.template), with the CSP read from
// web/Dockerfile so an upstream change to it lands here too.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.vercel', 'output');
const TOOLS = path.join(ROOT, '.vercel', 'tools');
const FN = path.join(OUT, 'functions', 'api.func');
const ESBUILD = '0.28.2';
const REGION = process.env.VERCEL_FUNCTION_REGION || 'cdg1';   // Paris, next to Supabase eu-west-3

const npm = (args, cwd) => execFileSync('npm', [...args, '--no-audit', '--no-fund'], { cwd, stdio: 'inherit' });
const step = s => console.log(`\n▸ ${s}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'static'), { recursive: true });

step('build tools (esbuild, and the postgres driver the bundle takes in)');
const pgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'package.json'), 'utf8')).optionalDependencies.postgres;
fs.mkdirSync(TOOLS, { recursive: true });
fs.writeFileSync(path.join(TOOLS, 'package.json'), '{"private":true}');
npm(['install', '--no-package-lock', `esbuild@${ESBUILD}`, `postgres@${pgVersion}`], TOOLS);

// On Vercel the checkout is fresh; on a development machine the node_modules already there are
// used as they are, so a local build does not strip the Coach runtime out of them.
const fresh = dir => process.env.VERCEL || !fs.existsSync(path.join(ROOT, dir, 'node_modules'));
step('api dependencies (no Coach runtime: the optional Agent SDK is half a gigabyte and off here)');
if (fresh('api')) npm(['ci', '--omit=dev', '--omit=optional'], path.join(ROOT, 'api'));

step('mcp dependencies (the MCP SDK and zod, bundled into the function for /api/mcp)');
if (fresh('mcp')) npm(['ci', '--omit=dev', '--ignore-scripts'], path.join(ROOT, 'mcp'));

step('frontend');
if (fresh('frontend')) npm(['ci', '--ignore-scripts'], path.join(ROOT, 'frontend'));
execFileSync('npm', ['run', 'build'], { cwd: path.join(ROOT, 'frontend'), stdio: 'inherit', env: { ...process.env, APP_BUILD: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || '' } });
fs.cpSync(path.join(ROOT, 'frontend', 'dist'), path.join(OUT, 'static'), { recursive: true });

step('exercise media (catalogue/media, served from this deployment — never hotlinked, see its NOTICE.md)');
const media = path.join(ROOT, 'catalogue', 'media');
const dest = path.join(OUT, 'static', 'exercise-media');
let files = 0;
for (const [sub, ext] of [['still', '.webp'], ['clip', '.mp4']]) {
  if (process.env.OPENGYM_NO_CLIPS === '1' && sub === 'clip') continue;   // fallback if the deployment is too big
  fs.mkdirSync(path.join(dest, sub), { recursive: true });
  for (const f of fs.readdirSync(path.join(media, sub))) {
    if (!f.endsWith(ext)) continue;
    fs.copyFileSync(path.join(media, sub, f), path.join(dest, sub, f));
    files++;
  }
}
fs.copyFileSync(path.join(media, 'NOTICE.md'), path.join(dest, 'NOTICE.md'));
console.log(`${files} media files`);

step('api function (esbuild bundle of api/server.js)');
const { build } = await import(pathToFileURL(path.join(TOOLS, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
fs.mkdirSync(FN, { recursive: true });
await build({
  entryPoints: { index: path.join(ROOT, 'scripts', 'vercel', 'api-entry.mjs') },
  outdir: FN,
  bundle: true,
  splitting: true,            // server.js imports pg-store.js lazily, and that one awaits at top level
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  nodePaths: [path.join(TOOLS, 'node_modules')],
  // The Coach's runtimes: loaded by name at run time, absent here, and caught when missing.
  external: ['@anthropic-ai/*'],
  // CommonJS dependencies (web-push and what it pulls in) call require() on node's built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning'
});
fs.writeFileSync(path.join(FN, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: false,
  maxDuration: 30,
  regions: [REGION],
  // The two things this mode can never do, whatever the project's variables say.
  environment: { MEDIA_UPLOADS: '0', COACH_DISABLED: '1' }
}, null, 2));
fs.writeFileSync(path.join(FN, 'package.json'), '{"type":"module"}');

step('routes and headers');
const csp = /^ENV CONTENT_SECURITY_POLICY="([^"]+)"/m.exec(fs.readFileSync(path.join(ROOT, 'web', 'Dockerfile'), 'utf8'))?.[1];
if (!csp) throw new Error('CONTENT_SECURITY_POLICY not found in web/Dockerfile');
const security = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': csp };
fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    // Everything under /api goes to the one function, with its path untouched (server.js routes
    // on req.url). Before the filesystem, so no static file can shadow an API route.
    { src: '^/api(/.*)?$', dest: '/api', check: false },
    // OAuth discovery for the MCP endpoint (api/oauth.js), which the spec fixes at the root.
    { src: '^/\\.well-known/oauth-(authorization-server|protected-resource)(/.*)?$', dest: '/api', check: false },
    { src: '^/exercise-media/.+\\.(webp|mp4|png|jpg|gif)$', headers: { ...security, 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'public, max-age=2592000, immutable' }, continue: true },
    { src: '^/.*\\.(js|css|json|html)$', headers: { ...security, 'Cache-Control': 'no-cache, must-revalidate' }, continue: true },
    { src: '^/(.*\\.(png|ico|svg|woff2?|webp))$', headers: { ...security, 'Cache-Control': 'public, max-age=2592000, immutable' }, continue: true },
    { src: '^/(.*)$', headers: security, continue: true },
    { handle: 'filesystem' },
    // The app routes in the hash (HashRouter): a path that is not a file goes back to the root,
    // as the web container's try_files does.
    { src: '^/(.*)$', status: 302, headers: { Location: '/' } }
  ]
}, null, 2));
console.log(`\ndone: ${path.relative(ROOT, OUT)}`);
