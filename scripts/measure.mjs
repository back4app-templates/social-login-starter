// File: scripts/measure.mjs · (b1) backend session-creation latency, measured from this machine with raw REST calls.
//   npm run measure -- --local                      # against the local parse-server (npm run dev:server)
//   npm run measure                                 # against the Back4app app in .env
//   options: --warmups 20 --runs 100 --out docs/evidence
// Scenarios (each run is one HTTP round trip that ends with a usable session token):
//   anonymous_new     POST /users  {authData:{anonymous:{id:<fresh uuid>}}}   → creates a user + session (201)
//   anonymous_repeat  POST /users  {authData:{anonymous:{id:<same uuid>}}}    → logs the guest back in (200)
//   email_login       POST /login  {username,password}                         → password check + session (200)
//   google_id_token   NOT automated: needs a Google-signed ID token for a real account. Measured by hand with the
//                     browser's Network tab, see docs/manual-google-check.md; the summary carries a placeholder row.
// Output: <out>/measure-<target>-<date>.csv (one row per run) and <out>/measure-<target>-<date>-summary.csv (p50/p95).
// Needs only APP_ID + REST_KEY. Cleanup: every user created is deleted through the Cloud function testCleanup (no master
// key; cloud/config.js SETUP_ENABLED must be true), or directly with the master key when .env has one.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rest, target, args, ROOT } from './lib.mjs';

const a = args();
const env = target(a);
const WARMUPS = Number(a.warmups ?? 20);
const RUNS = Number(a.runs ?? 100);
const outDir = path.resolve(ROOT, a.out || 'docs/evidence');
mkdirSync(outDir, { recursive: true });

const created = new Set();
const rows = [];
const q = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function timed(scenario, run, fn) {
  const r = await fn();
  if (r.json?.objectId && r.status === 201) created.add(r.json.objectId);
  if (run >= 0) rows.push({ scenario, run, ms: r.ms.toFixed(1), status: r.status });
  if (r.status >= 400) console.error(`${scenario} run ${run}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

async function scenario(name, fn) {
  for (let i = 0; i < WARMUPS; i++) await timed(name, -1, fn);
  for (let i = 0; i < RUNS; i++) await timed(name, i, fn);
  const ms = rows.filter((r) => r.scenario === name).map((r) => Number(r.ms));
  const errors = rows.filter((r) => r.scenario === name && r.status >= 400).length;
  const s = { scenario: name, runs: RUNS, warmups: WARMUPS, p50_ms: q(ms, 0.5).toFixed(1), p95_ms: q(ms, 0.95).toFixed(1), min_ms: Math.min(...ms).toFixed(1), max_ms: Math.max(...ms).toFixed(1), errors };
  console.log(`${name.padEnd(18)} p50 ${s.p50_ms} ms · p95 ${s.p95_ms} ms · min ${s.min_ms} · max ${s.max_ms} · errors ${errors}`);
  return s;
}

const date = new Date().toISOString().slice(0, 10);
const host = new URL(env.serverUrl).host;
console.log(`target ${env.name} (${host}) · ${WARMUPS} warm-ups + ${RUNS} runs per scenario`);

const summary = [];
summary.push(await scenario('anonymous_new', () => rest(env, 'POST', '/users', { authData: { anonymous: { id: crypto.randomUUID() } } }, { raw: true })));

const guestId = crypto.randomUUID();
await timed('anonymous_repeat', -1, () => rest(env, 'POST', '/users', { authData: { anonymous: { id: guestId } } }, { raw: true }));
summary.push(await scenario('anonymous_repeat', () => rest(env, 'POST', '/users', { authData: { anonymous: { id: guestId } } }, { raw: true })));

const username = `measure_${crypto.randomBytes(5).toString('hex')}`; const password = 'Pw-' + crypto.randomBytes(9).toString('base64url');
await timed('email_signup', -1, () => rest(env, 'POST', '/users', { username, password }, { raw: true }));
summary.push(await scenario('email_login', () => rest(env, 'POST', '/login', { username, password }, { raw: true })));

summary.push({ scenario: 'google_id_token', runs: 0, warmups: 0, p50_ms: '', p95_ms: '', min_ms: '', max_ms: '', errors: '', note: 'placeholder — measure manually (docs/manual-google-check.md, step 7)' });

const base = path.join(outDir, `measure-${env.name}-${date}`);
const csv = (list, cols) => [cols.join(','), ...list.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n';
writeFileSync(`${base}.csv`, csv(rows, ['scenario', 'run', 'ms', 'status']));
writeFileSync(`${base}-summary.csv`, `# target=${env.name} host=${host} date=${new Date().toISOString()} node=${process.version} client=${process.platform}\n`
  + csv(summary, ['scenario', 'runs', 'warmups', 'p50_ms', 'p95_ms', 'min_ms', 'max_ms', 'errors', 'note']));
console.log(`wrote ${base}.csv and ${base}-summary.csv`);

if (env.masterKey) {
  let n = 0;
  for (const id of created) { try { await rest(env, 'DELETE', `/users/${id}`, undefined, { master: true }); n++; } catch { /* keep going */ } }
  console.log(`cleanup: deleted ${n} user(s) created by this run (master key)`);
} else {
  // No master key: the Cloud function testCleanup deletes by id (users created in the last 2 h) and by username prefix.
  const ids = [...created];
  let n = 0; let failed = null;
  for (let i = 0; i < Math.max(1, Math.ceil(ids.length / 100)); i++) {
    const params = { objectIds: ids.slice(i * 100, (i + 1) * 100), ...(i === 0 ? { usernamesPrefix: 'measure_' } : {}) };
    const r = await rest(env, 'POST', '/functions/testCleanup', params, { raw: true });
    if (r.status === 200) n += r.json.result.deleted; else { failed = r.json?.error || `HTTP ${r.status}`; break; }
  }
  if (failed) console.log(`cleanup skipped (testCleanup: ${failed}): ${created.size} user(s) left behind`);
  else console.log(`cleanup: testCleanup deleted ${n} user(s) created by this run (no master key)`);
}
