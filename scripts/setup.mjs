// File: scripts/setup.mjs · Node 22 · idempotent · local server or Back4app, with or without the master key.
// Sets the _User class-level permissions and the one extra field the Cloud Code maintains. No dashboard clicks.
//   npm run setup -- --local            # local parse-server (npm run dev:server must be running): master key path
//   npm run setup                       # Back4app app from .env. With MASTER_KEY: direct /schemas call.
//                                       # Without it: calls the Cloud function `setupSchema` (cloud/main.js) with the
//                                       # REST key — Cloud Code must be deployed first (README, "Deploy on Back4app").
//   npm run setup -- --cloud            # force the Cloud-function path even when MASTER_KEY is set (to prove it works)
//
// What the CLP says, and why:
//   create: public      — sign-up (POST /users) must stay open: that is how guests and Google users are created.
//   find/get: signed-in — nobody can list users without a session; with one, the owner-only ACL on each row
//                          (enforcePrivateUsers) means a user still only ever sees their own row.
//   update/delete: signed-in — further narrowed to the owner by the ACL and by the beforeSave hook in cloud/main.js.
//   addField: master    — the schema is fixed here; clients cannot add columns to _User.
//   protectedFields '*' — e-mail, authData and hasPassword are never returned to anyone but the owner (and master),
//                          even if an ACL is widened by mistake. Parse exempts the owner reading their own row.
import path from 'node:path';
import { rest, target, args, ParseError, ROOT } from './lib.mjs';

export const USER_SCHEMA = {
  className: '_User',
  fields: { hasPassword: { type: 'Boolean' } },
  classLevelPermissions: {
    find: { requiresAuthentication: true },
    count: {},
    get: { requiresAuthentication: true },
    create: { '*': true },
    update: { requiresAuthentication: true },
    delete: { requiresAuthentication: true },
    addField: {},
    protectedFields: { '*': ['email', 'authData', 'hasPassword', 'emailVerified'] },
  },
};

/**
 * Creates or updates the _User schema + CLP. With env.masterKey (and unless opts.cloud) it talks to /schemas directly;
 * otherwise it calls the Cloud function `setupSchema`, which does the same thing with the master key inside Cloud Code.
 * Returns a one-line description of what happened.
 */
export async function applyUserSchema(env, opts = {}) {
  if (!env.masterKey || opts.cloud) return applyUserSchemaViaCloud(env);
  let existing = null;
  try { existing = await rest(env, 'GET', '/schemas/_User', undefined, { master: true }); }
  catch (e) { if (!(e instanceof ParseError) || (e.status !== 400 && e.status !== 404)) throw e; }

  const body = { ...USER_SCHEMA };
  if (existing) {
    body.fields = Object.fromEntries(Object.entries(USER_SCHEMA.fields).filter(([f]) => !existing.fields?.[f]));
    await rest(env, 'PUT', '/schemas/_User', body, { master: true });
    return `schema _User: updated (${Object.keys(body.fields).length} new field(s)), CLP set`;
  }
  await rest(env, 'POST', '/schemas', body, { master: true });
  return 'schema _User: created, CLP set';
}

export const SETUP_DISABLED_RE = /Setup helpers are disabled/;

/** `POST /functions/setupSchema` with the REST key. Throws a readable error when Cloud Code is not deployed or the helper is off. */
export async function applyUserSchemaViaCloud(env) {
  const r = await rest(env, 'POST', '/functions/setupSchema', {}, { raw: true });
  if (r.status === 200 && r.json?.result) return `${r.json.result.summary} (Cloud function setupSchema)`;
  if (r.json?.code === 141 && /Invalid function/.test(r.json.error || '')) {
    throw new Error('setupSchema is not deployed. Upload cloud/main.js and cloud/config.js (Dashboard → Cloud Code → Upload → Deploy) and retry; or put MASTER_KEY in .env.');
  }
  if (r.json?.code === 119 && SETUP_DISABLED_RE.test(r.json.error || '')) {
    throw new Error(`${r.json.error} Set SETUP_ENABLED: true in cloud/config.js and redeploy, or put MASTER_KEY in .env.`);
  }
  throw new ParseError(r.status, r.json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts', 'setup.mjs')) {
  const a = args();
  const env = target(a);
  if (!env.masterKey) console.log(`[${env.name}] no MASTER_KEY in .env: using the Cloud function setupSchema with the REST key`);
  try { console.log(`[${env.name}] ${await applyUserSchema(env, { cloud: a.cloud === true })}`); }
  catch (e) { console.error(`[${env.name}] setup failed: ${e.message}`); process.exit(1); }
  // Prove the CLP took: a find without a session must be refused (parse-server 7 answers 101 "Permission denied, user
  // needs to be authenticated."; older servers answered 119).
  const probe = await rest(env, 'GET', '/users', undefined, { raw: true });
  const ok = probe.status >= 400 && [101, 119].includes(probe.json?.code);
  console.log(`[${env.name}] GET /users without a session → HTTP ${probe.status} code ${probe.json?.code} "${probe.json?.error}" ${ok ? 'OK' : 'UNEXPECTED'}`);
}
