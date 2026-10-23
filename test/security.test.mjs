// File: test/security.test.mjs · what a client must NOT be able to do, as raw REST calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { harness, unique, password, printObservations, rest } from './helpers.mjs';

let h;
before(async () => { h = await harness(); });
after(async () => { printObservations('security observations', h.observations); await h.cleanup(); });

test('/users/me without a session token is denied (209)', async () => {
  const r = await h.me(undefined);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 209);
});

test('listing or fetching other users is denied: no session → CLP; with a session → only your own row', async () => {
  const a = await h.anonymous();
  const b = await h.anonymous();
  const anon = await rest(h.env, 'GET', '/users', undefined, { raw: true });
  assert.ok(anon.status >= 400 && [101, 119].includes(anon.json.code), `CLP find requiresAuthentication → got ${anon.status} ${JSON.stringify(anon.json)}`);
  h.observe('GET /users without a session', `HTTP ${anon.status} code ${anon.json.code} "${anon.json.error}"`);
  const list = await rest(h.env, 'GET', '/users', undefined, { raw: true, session: b.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.results.map((u) => u.objectId), [b.objectId], 'owner-only ACL: a find returns just yourself');
  const get = await rest(h.env, 'GET', `/users/${a.objectId}`, undefined, { raw: true, session: b.token });
  assert.equal(get.json.code, 101, "another user's row reads as Object not found");
  // The ACL itself is only visible to the master key: the suite reads it through testWidenAcl (next test) instead.
});

test("changing another user's username with a foreign session is denied (ACL), and by the hook when the ACL is widened", async (t) => {
  const victim = await h.anonymous();
  const attacker = await h.anonymous();
  const r1 = await h.update(victim.objectId, { username: unique('stolen') }, attacker.token);
  assert.ok(r1.status >= 400);
  h.observe("foreign PUT /users/<id> {username} with owner-only ACL", `HTTP ${r1.status} code ${r1.json.code} "${r1.json.error}"`);
  // Widen the victim's ACL (a misconfiguration, done with the master key inside Cloud Code) — now only the hook stands in the way.
  const widened = await h.widenAcl(victim.objectId);
  if (!widened) { t.skip('SKIP: widening an ACL needs testWidenAcl (SETUP_ENABLED=false on this backend) or a MASTER_KEY'); return; }
  assert.deepEqual(widened.before, { [victim.objectId]: { read: true, write: true } }, 'enforcePrivateUsers: new users had an owner-only ACL');
  const r2 = await h.update(victim.objectId, { username: unique('stolen') }, attacker.token);
  assert.equal(r2.status, 400);
  assert.equal(r2.json.code, 119);
  assert.equal(r2.json.error, 'Only the account owner can change its sign-in methods.');
  const r3 = await h.update(victim.objectId, { email: 'x@example.test' }, attacker.token);
  assert.equal(r3.json.code, 119);
  const r4 = await h.update(victim.objectId, { authData: { anonymous: null } }, attacker.token);
  assert.equal(r4.json.code, 119, 'nor unlink a provider of someone else');
  const r5 = await h.update(victim.objectId, { email: 'x@example.test' }, undefined);
  h.observe('PUT /users/<id> with NO session on a public-write row', `HTTP ${r5.status} code ${r5.json.code} "${r5.json.error}"`);
  const stillMine = await h.me(victim.token);
  assert.equal(stillMine.json.username, victim.json.username);
});

test('clients cannot forge hasPassword', async () => {
  const a = await h.anonymous();
  const r = await h.update(a.objectId, { hasPassword: true }, a.token);
  assert.equal(r.status, 200);
  assert.equal((await h.me(a.token)).json.hasPassword, false, 'hook restores the stored value');
  const b = await h.signUp(unique('u'), password());
  const r2 = await h.update(b.objectId, { hasPassword: false }, b.token);
  assert.equal(r2.status, 200);
  assert.equal((await h.me(b.token)).json.hasPassword, true);
});

test('forged authData.google is rejected: non-JWT token (no network), then a self-signed JWT (checked against Google certs)', async (t) => {
  const r1 = await rest(h.env, 'POST', '/users', { authData: { google: { id: '1', id_token: 'definitely.not.a.jwt' } } }, { raw: true });
  assert.ok(r1.status >= 400);
  assert.equal(r1.json.code, 101);
  h.observe('authData.google with a non-JWT id_token', `HTTP ${r1.status} code ${r1.json.code} "${r1.json.error}"`);
  const r1b = await rest(h.env, 'POST', '/users', { authData: { google: { id: '1' } } }, { raw: true });
  h.observe('authData.google without id_token', `HTTP ${r1b.status} code ${r1b.json.code} "${r1b.json.error}"`);

  if (process.env.OFFLINE) { t.diagnostic('OFFLINE set: skipping the self-signed JWT (parse-server would fetch https://www.googleapis.com/oauth2/v3/certs)'); return; }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', kid: 'forged-kid', typ: 'JWT' })}.${b64({ iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID || 'x', sub: '1', iat: now, exp: now + 3600 })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url');
  const r2 = await rest(h.env, 'POST', '/users', { authData: { google: { id: '1', id_token: `${unsigned}.${sig}` } } }, { raw: true });
  assert.ok(r2.status >= 400, 'a token Google did not sign never creates a user');
  assert.equal(r2.json.objectId, undefined);
  h.observe('authData.google with a self-signed RS256 JWT (unknown kid)', `HTTP ${r2.status} code ${r2.json.code} "${r2.json.error}"`);
});

test('authData for a provider that is not configured never creates a user', async () => {
  const r = await rest(h.env, 'POST', '/users', { authData: { github: { id: '1', access_token: 'x' } } }, { raw: true });
  assert.ok(r.status >= 400);
  assert.equal(r.json.objectId, undefined);
  h.observe('authData.github (not configured, also not in the hook allow-list)', `HTTP ${r.status} code ${r.json.code} "${r.json.error || r.json.message}"`);
  const a = await h.anonymous();
  const link = await h.update(a.objectId, { authData: { github: { id: '1', access_token: 'x' } } }, a.token);
  assert.ok(link.status >= 400);
  assert.equal((await h.me(a.token)).json.authData.github, undefined);
});

test('Cloud functions refuse anonymous (no session) callers with 209', async () => {
  for (const name of ['linkInfo', 'signOutEverywhere']) {
    const r = await h.fn(name, {}, undefined);
    assert.equal(r.status, 400); assert.equal(r.json.code, 209);
  }
});

test('setup helpers: setupSchema is idempotent; testCleanup validates its input and deletes only what it is told', async (t) => {
  if (h.helpers !== 'cloud') { t.skip('SKIP: the Cloud setup helpers are disabled on this backend (SETUP_ENABLED=false)'); return; }
  const again = await h.fn('setupSchema', {});
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.result.newFields, [], 'second call adds no field');
  assert.equal((await h.fn('testCleanup', {})).json.code, 142, 'nothing to match → refused');
  assert.equal((await h.fn('testCleanup', { usernamesPrefix: 'u_' })).json.code, 142, 'a short prefix could sweep real users → refused');
  assert.equal((await h.fn('testCleanup', { objectIds: 'abc' })).json.code, 142);
  const nobody = await h.fn('testCleanup', { usernamesPrefix: 'zz_nobody_here_' });
  assert.deepEqual(nobody.json.result, { deleted: 0, sessionsDeleted: 0 });
  const a = await h.anonymous();
  const d = await h.fn('testCleanup', { objectIds: [a.objectId] });
  assert.deepEqual(d.json.result, { deleted: 1, sessionsDeleted: 1 });
  assert.equal(await h.sessionState(a.token), 'invalid(209)', 'the deleted user\'s session is gone too');
  h.created.delete(a.objectId);
  const absent = await h.fn('testWidenAcl', { objectId: a.objectId });
  assert.equal(absent.json.code, 101, 'testWidenAcl on a deleted user → Object not found');
});
