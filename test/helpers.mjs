// File: test/helpers.mjs · shared by the node:test suites. Raw REST only — no Parse SDK, no browser.
//
// Target: by default an in-process parse-server (scripts/dev-server.mjs) on a free port with the database
// postgres://localhost:5433/social_test. Set TEST_SERVER_URL (+ APP_ID/JS_KEY/REST_KEY in .env) to run the same suite
// against a live Back4app app — nothing is purged there; every user the suite creates is deleted at the end.
//
// The master key is NOT needed: schema setup, cleanup and the one ACL-widening test go through the Cloud functions
// setupSchema / testCleanup / testWidenAcl (cloud/main.js, guarded by cloud/config.js SETUP_ENABLED). The local run
// uses the same path, so `npm test` proves those functions. If a MASTER_KEY is present it is only a fallback for a
// backend whose helpers are switched off; with neither, the affected parts print a SKIP line instead of failing.
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import { rest, LOCAL, loadDotEnv } from '../scripts/lib.mjs';
import { applyUserSchema, SETUP_DISABLED_RE } from '../scripts/setup.mjs';

export { rest };
export const uuid = () => crypto.randomUUID();
export const unique = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const password = () => 'Pw-' + crypto.randomBytes(9).toString('base64url');

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** Starts (or attaches to) the server; returns { env, created, cleanup, isLocal, helpers, observe, widenAcl }. */
export async function harness() {
  loadDotEnv();
  let env; let handle = null; let isLocal = true;
  if (process.env.TEST_SERVER_URL) {
    isLocal = false;
    env = {
      name: 'remote', serverUrl: process.env.TEST_SERVER_URL.replace(/\/$/, ''),
      appId: process.env.APP_ID, jsKey: process.env.JS_KEY, restKey: process.env.REST_KEY, masterKey: process.env.MASTER_KEY,
    };
  } else {
    const { startServer } = await import('../scripts/dev-server.mjs');
    const port = await freePort();
    handle = await startServer({ port, databaseURI: process.env.TEST_DATABASE_URL || 'postgres://localhost:5433/social_test', quiet: true });
    env = { ...LOCAL, name: 'local-test', serverUrl: handle.url };
  }
  // Schema + CLP through Cloud Code (no master key). helpers = 'cloud' | 'master' | 'none' says what the suite may use.
  let helpers = 'cloud';
  const setup = await rest(env, 'POST', '/functions/setupSchema', {}, { raw: true });
  if (setup.status !== 200) {
    const reason = setup.json?.code === 119 && SETUP_DISABLED_RE.test(setup.json.error || '') ? 'SETUP_ENABLED=false'
      : setup.json?.code === 141 ? 'Cloud Code not deployed' : `HTTP ${setup.status} ${JSON.stringify(setup.json)}`;
    if (env.masterKey) { helpers = 'master'; await applyUserSchema(env); }
    else if (reason === 'SETUP_ENABLED=false') { helpers = 'none'; }
    else throw new Error(`setupSchema failed (${reason}) and no MASTER_KEY to fall back on. Deploy cloud/main.js + cloud/config.js first.`);
    console.log(`SKIP Cloud setup helpers (${reason}): ${helpers === 'master' ? 'falling back to the MASTER_KEY' : 'assuming the schema is in place; cleanup and the ACL-widening test are skipped'}`);
  }

  const created = new Set();
  const observations = [];
  const h = {
    env, isLocal, created, observations, helpers,
    /** Records a measured fact for the article (printed at the end of the suite). */
    observe(label, value) { observations.push({ label, value }); },
    async anonymous(id = uuid()) {
      const r = await rest(env, 'POST', '/users', { authData: { anonymous: { id } } }, { raw: true });
      if (r.json?.objectId) created.add(r.json.objectId);
      return { ...r, id, objectId: r.json?.objectId, token: r.json?.sessionToken };
    },
    async signUp(username, pw, email) {
      const r = await rest(env, 'POST', '/users', { username, password: pw, ...(email ? { email } : {}) }, { raw: true });
      if (r.json?.objectId) created.add(r.json.objectId);
      return { ...r, objectId: r.json?.objectId, token: r.json?.sessionToken };
    },
    login: (username, pw) => rest(env, 'POST', '/login', { username, password: pw }, { raw: true }),
    me: (token) => rest(env, 'GET', '/users/me', undefined, { raw: true, session: token }),
    update: (objectId, body, token) => rest(env, 'PUT', `/users/${objectId}`, body, { raw: true, session: token }),
    fn: (name, params, token) => rest(env, 'POST', `/functions/${name}`, params || {}, { raw: true, session: token }),
    logout: (token) => rest(env, 'POST', '/logout', {}, { raw: true, session: token }),
    /** "valid" | "invalid(<code>)" for a session token, via GET /users/me. */
    async sessionState(token) { const r = await h.me(token); return r.status === 200 ? 'valid' : `invalid(${r.json?.code})`; },
    /** Widens one user's ACL to public read+write (a misconfiguration) and returns { before, after }; null when not possible. */
    async widenAcl(objectId) {
      if (helpers === 'cloud') {
        const r = await h.fn('testWidenAcl', { objectId });
        if (r.status !== 200) throw new Error(`testWidenAcl: HTTP ${r.status} ${JSON.stringify(r.json)}`);
        return r.json.result;
      }
      if (helpers === 'master') {
        const before = (await rest(env, 'GET', `/users/${objectId}`, undefined, { master: true })).ACL;
        const after = { '*': { read: true, write: true } };
        await rest(env, 'PUT', `/users/${objectId}`, { ACL: after }, { master: true });
        return { objectId, before, after };
      }
      return null;
    },
    async cleanup() {
      const ids = [...created];
      if (helpers === 'cloud') {
        let deleted = 0;
        for (const part of chunks(ids, 100)) {
          const r = await h.fn('testCleanup', { objectIds: part });
          if (r.status === 200) deleted += r.json.result.deleted; else console.log(`cleanup: testCleanup failed HTTP ${r.status} ${JSON.stringify(r.json)}`);
        }
        console.log(`cleanup: testCleanup deleted ${deleted} of ${ids.length} user(s)`);
      } else if (helpers === 'master') {
        for (const id of ids) { try { await rest(env, 'DELETE', `/users/${id}`, undefined, { master: true }); } catch { /* already gone */ } }
      } else if (ids.length) {
        console.log(`SKIP cleanup: ${ids.length} user(s) left behind (${ids.join(', ')}) — testCleanup is disabled and no MASTER_KEY`);
      }
      if (isLocal) { try { await rest(env, 'DELETE', '/purge/_Session', undefined, { master: true }); } catch { /* fine */ } }
      if (handle) await handle.close();
    },
  };
  return h;
}

/** Prints the observations table so a test run doubles as evidence for the article. */
export function printObservations(title, observations) {
  const lines = [`\n## ${title}`, ...observations.map((o) => `- ${o.label}: ${o.value}`)];
  console.log(lines.join('\n'));
}
