// File: test/lifecycle.test.mjs · the linking lifecycle, as raw REST calls, against a local parse-server 7.
// Every assertion here was first observed on Back4app (parse-server 7.5.2, 2026-10-20); see docs/notes/build-diary.md
// for the cases where the local server answers differently.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, unique, password, printObservations } from './helpers.mjs';

let h;
before(async () => { h = await harness(); });
after(async () => { printObservations('lifecycle observations', h.observations); await h.cleanup(); });

test('anonymous: first POST /users creates (201), repeating the same id logs in (200, same user, new token)', async () => {
  const a = await h.anonymous();
  assert.equal(a.status, 201);
  assert.ok(a.objectId && a.token);
  assert.match(a.json.username, /^[A-Za-z0-9]{25}$/, 'parse-server auto-generates a 25-char username for guests');
  const again = await h.anonymous(a.id);
  assert.equal(again.status, 200);
  assert.equal(again.objectId, a.objectId);
  assert.notEqual(again.token, a.token);
  h.observe('anonymous sign-up response carries authData', 'authData' in a.json ? 'yes' : `no (authDataResponse=${JSON.stringify(a.json.authDataResponse)})`);
  const me = await h.me(a.token);
  assert.deepEqual(Object.keys(me.json.authData), ['anonymous']);
  assert.equal(me.json.hasPassword, false, 'cloud hook sets hasPassword=false on sign-up');
});

test('link email/password to a guest: new session token, old sessions revoked, authData.anonymous kept', async () => {
  const a = await h.anonymous();
  const second = await h.anonymous(a.id);              // same user, "device 2"
  const username = unique('u'); const pw = password(); const email = `${username}@example.test`;
  const before = await h.fn('linkInfo', {}, a.token);
  assert.equal(before.json.result.hasPassword, false);

  const link = await h.update(a.objectId, { username, password: pw, email }, a.token);
  assert.equal(link.status, 200);
  assert.ok(link.json.sessionToken, 'the PUT answers with a NEW session token');
  assert.notEqual(link.json.sessionToken, a.token);
  assert.equal(await h.sessionState(a.token), 'invalid(209)', 'the session that performed the link is revoked');
  h.observe('second guest session after the link', await h.sessionState(second.token));

  const me = await h.me(link.json.sessionToken);
  assert.equal(me.json.username, username);
  assert.equal(me.json.email, email);
  assert.deepEqual(Object.keys(me.json.authData), ['anonymous'], 'authData.anonymous is KEPT after linking a password');
  assert.equal(me.json.hasPassword, true);

  const info = await h.fn('linkInfo', {}, link.json.sessionToken);
  assert.deepEqual(info.json.result.providers, ['anonymous']);
  assert.equal(info.json.result.hasPassword, true);
  assert.notEqual(info.json.result.session.createdAt.iso, before.json.result.session.createdAt.iso, 'session createdAt changes: it is a different session');

  const login = await h.login(username, pw);
  assert.equal(login.status, 200);
  assert.equal(login.json.objectId, a.objectId, 'password login resolves to the same user');
});

test('unlink anonymous: authData.anonymous=null; the old guest id now creates a different user', async () => {
  const a = await h.anonymous();
  const username = unique('u'); const pw = password();
  const link = await h.update(a.objectId, { username, password: pw }, a.token);
  const token = link.json.sessionToken;
  const unlink = await h.update(a.objectId, { authData: { anonymous: null } }, token);
  assert.equal(unlink.status, 200);
  const me = await h.me(token);
  assert.equal(me.json.authData, undefined, 'no providers left in authData (Parse drops null entries from responses)');
  assert.equal(await h.sessionState(token), 'valid', 'unlinking does not touch the session');
  const info = await h.fn('linkInfo', {}, token);
  assert.deepEqual(info.json.result.providers, []);
  assert.equal(info.json.result.hasPassword, true);
  const replay = await h.anonymous(a.id);
  assert.equal(replay.status, 201, 'the old anonymous id is free again');
  assert.notEqual(replay.objectId, a.objectId);
});

test('unlink the LAST sign-in method of a guest (no password): refused by the hook (119); allowed once a password exists', async () => {
  const a = await h.anonymous();
  const r = await h.update(a.objectId, { authData: { anonymous: null } }, a.token);
  h.observe('unlink last provider of a password-less guest', `HTTP ${r.status}${r.json?.code ? ` code ${r.json.code} "${r.json.error}"` : ''}`);
  assert.equal(r.status, 400, 'parse-server alone would answer 200 here (measured); the beforeSave hook refuses');
  assert.equal(r.json.code, 119);
  assert.match(r.json.error, /last sign-in method/);
  const info = await h.fn('linkInfo', {}, a.token);
  assert.deepEqual(info.json.result.providers, ['anonymous'], 'nothing changed');
  // With a password linked, unlinking the guest id is fine: the account stays reachable.
  const username = unique('keep'); const pw = password();
  const linked = await h.update(a.objectId, { username, password: pw, email: `${username}@example.test` }, a.token);
  assert.equal(linked.status, 200);
  const token2 = linked.json.sessionToken || a.token;
  const r2 = await h.update(a.objectId, { authData: { anonymous: null } }, token2);
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  const info2 = await h.fn('linkInfo', {}, token2);
  assert.deepEqual(info2.json.result.providers, []);
  assert.equal(info2.json.result.hasPassword, true);
  const replay = await h.anonymous(a.id);
  assert.notEqual(replay.objectId, a.objectId, 'the old guest id now creates a separate user');
  h.observe('last-method guard', `password-less guest: ${r.status}/${r.json.code}; after linking a password the unlink answers ${r2.status}`);
});

test('collisions: a second account cannot take the same username (202) or e-mail (203)', async () => {
  const a = await h.anonymous();
  const username = unique('u'); const pw = password(); const email = `${username}@example.test`;
  await h.update(a.objectId, { username, password: pw, email }, a.token);
  const b = await h.anonymous();
  const sameName = await h.update(b.objectId, { username, password: password() }, b.token);
  assert.equal(sameName.status, 400);
  assert.equal(sameName.json.code, 202);
  h.observe('username collision error text', JSON.stringify(sameName.json.error));
  const sameMail = await h.update(b.objectId, { username: unique('u'), password: password(), email }, b.token);
  assert.equal(sameMail.status, 400);
  assert.equal(sameMail.json.code, 203);
  h.observe('e-mail collision error text', JSON.stringify(sameMail.json.error));
  const sameMailSignUp = await h.signUp(unique('u'), password(), email);
  assert.equal(sameMailSignUp.json.code, 203, 'same answer for a fresh sign-up');
});

test('sessions: POST /logout on device 2 leaves device 1 signed in', async () => {
  const username = unique('u'); const pw = password();
  const d1 = await h.signUp(username, pw);
  const d2 = await h.login(username, pw);
  assert.notEqual(d1.token, d2.json.sessionToken);
  const out = await h.logout(d2.json.sessionToken);
  assert.equal(out.status, 200);
  assert.equal(await h.sessionState(d1.token), 'valid');
  assert.equal(await h.sessionState(d2.json.sessionToken), 'invalid(209)');
});

test('password change through a session revokes EVERY session (including the caller) and returns a fresh token', async () => {
  const username = unique('u'); const pw = password(); const pw2 = password();
  const d1 = await h.signUp(username, pw);
  const d3 = await h.login(username, pw);
  const change = await h.update(d1.objectId, { password: pw2 }, d1.token);
  assert.equal(change.status, 200);
  assert.ok(change.json.sessionToken && change.json.sessionToken !== d1.token, 'fresh token in the response');
  assert.equal(await h.sessionState(d1.token), 'invalid(209)', 'the caller session is gone too');
  assert.equal(await h.sessionState(d3.json.sessionToken), 'invalid(209)');
  assert.equal(await h.sessionState(change.json.sessionToken), 'valid');
  const login = await h.login(username, pw2);
  assert.equal(login.status, 200);
  assert.equal((await h.login(username, pw)).json.code, 101, 'old password rejected (101 Invalid username/password)');
});

test('signOutEverywhere (Cloud function) deletes all other sessions and keeps only the caller', async () => {
  const username = unique('u'); const pw = password();
  const d1 = await h.signUp(username, pw);
  const d2 = await h.login(username, pw);
  const d3 = await h.login(username, pw);
  const before = await h.fn('linkInfo', {}, d1.token);
  assert.equal(before.json.result.sessionCount, 3);
  const r = await h.fn('signOutEverywhere', {}, d2.json.sessionToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.result, { revoked: 2 });
  assert.equal(await h.sessionState(d1.token), 'invalid(209)');
  assert.equal(await h.sessionState(d2.json.sessionToken), 'valid', 'the caller keeps its session');
  assert.equal(await h.sessionState(d3.json.sessionToken), 'invalid(209)');
  const after = await h.fn('linkInfo', {}, d2.json.sessionToken);
  assert.equal(after.json.result.sessionCount, 1);
  const twice = await h.fn('signOutEverywhere', {}, d2.json.sessionToken);
  assert.deepEqual(twice.json.result, { revoked: 0 }, 'idempotent');
});
