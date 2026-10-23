// File: test/helpers.mjs · shared by the node:test suites. Raw REST only — no Parse SDK, no browser.
//
// Target: by default an in-process parse-server (scripts/dev-server.mjs) on a free port with the database
// postgres://localhost:5433/social_test. Set TEST_SERVER_URL (+ APP_ID/JS_KEY/REST_KEY/MASTER_KEY in .env) to run the
// same suite against a live Back4app app — nothing is purged there; every user the suite creates is deleted at the end.
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import { rest, LOCAL, loadDotEnv } from '../scripts/lib.mjs';
import { applyUserSchema } from '../scripts/setup.mjs';

export { rest };
export const uuid = () => crypto.randomUUID();
export const unique = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const password = () => 'Pw-' + crypto.randomBytes(9).toString('base64url');

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Starts (or attaches to) the server; returns { env, created, cleanup, isLocal, observe }. */
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
  await applyUserSchema(env);

  const created = new Set();
  const observations = [];
  const h = {
    env, isLocal, created, observations,
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
    async cleanup() {
      for (const id of created) {
        try { await rest(env, 'DELETE', `/users/${id}`, undefined, { master: true }); } catch { /* already gone */ }
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
