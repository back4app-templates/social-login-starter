// File: cloud/main.js · Parse Server Cloud Code (CommonJS, Parse Server 7, Node 19 on Back4app)
//
// Everything about linking sign-in methods already happens inside Parse Server: POST /users with authData logs in or
// creates, PUT /users/<id> with the user's own session links, authData.<provider> = null unlinks. This file adds only
// what Parse Server does not do by itself, and says why next to each piece.
'use strict';

// Providers this app is willing to store in authData. Parse Server already rejects providers that are not configured
// (code 252 "This authentication method is unsupported"), so this list is a second line of defence: if someone enables
// a provider in the dashboard by accident, the hook still refuses it until the list here is updated on purpose.
// Names are Parse's: X is "twitter", VK is "vkontakte" (Back4app's dashboard lists Apple, Google, Facebook, X, VK).
const ALLOWED_PROVIDERS = ['anonymous', 'google', 'facebook', 'apple', 'vkontakte', 'twitter'];

const forbidden = (message) => { throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, message); }; // 119

// Deploy-time switches (cloud/config.js, uploaded next to this file). Defaults apply when the file was not uploaded.
let config = { SETUP_ENABLED: true };
try { config = { ...config, ...require('./config.js') }; } catch (e) { /* no config.js on this deploy: defaults */ }

// ---------------------------------------------------------------- _User hooks

// beforeSave(_User) exists for three reasons:
//  1. Identity fields belong to the account owner. Parse's ACL already restricts writes to the owner, but an ACL is
//     data on the row and can be widened by mistake (or by an older client). The hook makes "only you, or the master
//     key, can change your username/email" a rule the database layer cannot forget.
//  2. Whitelist authData providers (see ALLOWED_PROVIDERS).
//  3. Parse never tells a client whether a user has a password (the hash is hidden even from the master key through
//     the API). The plaintext password IS visible to beforeSave, which runs before hashing, so the hook maintains a
//     `hasPassword` flag the UI can show in the "Linked methods" panel. Clients cannot forge it: the hook overwrites
//     whatever they send.
Parse.Cloud.beforeSave(Parse.User, (request) => {
  const user = request.object;
  const caller = request.user; // undefined for sign-up (no session yet) and for master-key calls

  if (!user.isNew() && !request.master) {
    const isSelf = caller && caller.id === user.id;
    if (!isSelf && (user.dirty('username') || user.dirty('email') || user.dirty('password') || user.dirty('authData'))) {
      forbidden('Only the account owner can change its sign-in methods.');
    }
  }

  const authData = user.get('authData');
  if (authData && typeof authData === 'object') {
    for (const provider of Object.keys(authData)) {
      if (!ALLOWED_PROVIDERS.includes(provider)) forbidden(`Sign-in provider "${provider}" is not enabled for this app.`);
    }
  }

  const password = user.get('password');
  if (typeof password === 'string' && password.length > 0) {
    user.set('hasPassword', true);
  } else if (user.isNew()) {
    user.set('hasPassword', false);
  } else if (user.dirty('hasPassword') && !request.master) {
    // A client tried to set the flag directly: put back the stored value.
    user.set('hasPassword', request.original ? request.original.get('hasPassword') === true : false);
  }

  //  4. Parse Server lets a user unlink their last sign-in method (measured: PUT {authData:{anonymous:null}} on a
  //     password-less guest answers 200 and leaves an account nobody can ever sign into again). The demo's UI disables
  //     that button, but a UI rule is not a rule: anyone with the keys can send the PUT. This refuses it on the server.
  //     The master key may still do it (support tooling, account deletion flows).
  if (!user.isNew() && !request.master && user.dirty('authData')) {
    const remaining = Object.keys(authData || {}).filter((p) => authData[p] !== null && authData[p] !== undefined);
    const keepsPassword = user.get('hasPassword') === true;
    if (remaining.length === 0 && !keepsPassword) {
      forbidden('Cannot remove the last sign-in method: link another one first.');
    }
  }
});

// afterSave(_User) is intentionally empty. It is the place for side effects that must happen once an identity change
// has been committed — e.g. sending a "a new sign-in method was added to your account" e-mail, or creating the user's
// Profile row on first sign-up. It is kept here so that the deploy that adds such a side effect is a one-line change.
Parse.Cloud.afterSave(Parse.User, () => {});

// ---------------------------------------------------------------- functions

// linkInfo exists because the client can see its own authData (via /users/me) but not two things the panel needs:
// whether a password is set (see beforeSave) and when the current session was created — which is how the article shows
// that linking a password to a guest account silently replaces the session token.
Parse.Cloud.define('linkInfo', async (request) => {
  if (!request.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Sign in first.'); // 209
  const user = await new Parse.Query(Parse.User).get(request.user.id, { useMasterKey: true });
  const authData = user.get('authData') || {};
  const providers = Object.keys(authData).filter((k) => authData[k] !== null && authData[k] !== undefined);

  const token = request.user.getSessionToken();
  const session = token
    ? await new Parse.Query(Parse.Session).equalTo('sessionToken', token).first({ useMasterKey: true })
    : null;
  const sessionCount = await new Parse.Query(Parse.Session).equalTo('user', request.user).count({ useMasterKey: true });

  return {
    objectId: user.id,
    username: user.get('username') || null,
    email: user.get('email') || null,
    hasPassword: user.get('hasPassword') === true,
    providers,
    session: session ? { createdAt: session.createdAt, expiresAt: session.get('expiresAt') || null } : null,
    sessionCount,
  };
});

// signOutEverywhere exists because Parse has no built-in "log out my other devices". POST /logout kills only the
// calling session, and a password change kills ALL sessions including the current one. This function deletes every
// _Session row of the caller except the one making the call. _Session rows are owner-readable but only the master key
// can delete them in bulk, hence Cloud Code.
Parse.Cloud.define('signOutEverywhere', async (request) => {
  if (!request.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Sign in first.'); // 209
  const current = request.user.getSessionToken();
  const others = await new Parse.Query(Parse.Session)
    .equalTo('user', request.user)
    .notEqualTo('sessionToken', current)
    .limit(1000)
    .find({ useMasterKey: true });
  await Parse.Object.destroyAll(others, { useMasterKey: true });
  return { revoked: others.length };
});

// ---------------------------------------------------------------- setup and test helpers (guarded by SETUP_ENABLED)

// On Back4app the master key is not handed to scripts or CI: these three functions do the privileged work INSIDE Cloud
// Code instead, so `npm run setup`, `npm test` and `npm run measure` only ever need the app id + REST key. They are
// deliberately dumb and narrow, and every one of them refuses to run once cloud/config.js says SETUP_ENABLED: false.
// Set that before the app has real users (README, "Before going public").
const SETUP_DISABLED = 'Setup helpers are disabled (cloud/config.js: SETUP_ENABLED=false).';
const requireSetupEnabled = () => { if (config.SETUP_ENABLED !== true) forbidden(SETUP_DISABLED); };
const invalid = (message) => { throw new Parse.Error(Parse.Error.VALIDATION_ERROR, message); }; // 142

// The _User class-level permissions, same object as scripts/setup.mjs (USER_SCHEMA) and explained there:
// sign-up public, everything else needs a session, protectedFields hide the identity columns from everyone but the owner.
const USER_CLP = {
  find: { requiresAuthentication: true },
  count: {},
  get: { requiresAuthentication: true },
  create: { '*': true },
  update: { requiresAuthentication: true },
  delete: { requiresAuthentication: true },
  addField: {},
  protectedFields: { '*': ['email', 'authData', 'hasPassword', 'emailVerified'] },
};

// setupSchema: idempotent. Adds the hasPassword column when missing and (re)applies USER_CLP. Parse.Schema always uses
// the master key, which is exactly why this lives here and not in a script.
Parse.Cloud.define('setupSchema', async () => {
  requireSetupEnabled();
  const schema = new Parse.Schema('_User');
  const existing = await schema.get();
  const newFields = [];
  if (!existing.fields || !existing.fields.hasPassword) { schema.addBoolean('hasPassword'); newFields.push('hasPassword'); }
  schema.setCLP(USER_CLP);
  await schema.update();
  return { className: '_User', newFields, clp: USER_CLP, summary: `schema _User: updated (${newFields.length} new field(s)), CLP set` };
});

// testCleanup({ usernamesPrefix?, objectIds? }): deletes test users and their sessions.
//   usernamesPrefix — at least 6 characters (e.g. "measure_"), so a sloppy call cannot sweep real users;
//   objectIds       — at most 200, and only users created in the last 2 hours (the test suite tracks every user it
//                     creates by id because guests get a random username).
Parse.Cloud.define('testCleanup', async (request) => {
  requireSetupEnabled();
  const params = request.params || {};
  const prefix = params.usernamesPrefix === undefined ? '' : params.usernamesPrefix;
  const ids = params.objectIds === undefined ? [] : params.objectIds;
  if (typeof prefix !== 'string' || (prefix && prefix.length < 6)) invalid('usernamesPrefix must be a string of at least 6 characters.');
  if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !id)) invalid('objectIds must be an array of at most 200 object ids.');
  if (!prefix && ids.length === 0) invalid('Pass usernamesPrefix and/or objectIds.');

  const queries = [];
  if (prefix) queries.push(new Parse.Query(Parse.User).startsWith('username', prefix));
  if (ids.length) queries.push(new Parse.Query(Parse.User).containedIn('objectId', ids).greaterThan('createdAt', new Date(Date.now() - 2 * 60 * 60 * 1000)));
  const query = queries.length === 1 ? queries[0] : Parse.Query.or(...queries);
  const users = await query.limit(1000).find({ useMasterKey: true });
  if (users.length === 0) return { deleted: 0, sessionsDeleted: 0 };
  const sessions = await new Parse.Query(Parse.Session).containedIn('user', users).limit(1000).find({ useMasterKey: true });
  await Parse.Object.destroyAll(sessions, { useMasterKey: true });
  await Parse.Object.destroyAll(users, { useMasterKey: true });
  return { deleted: users.length, sessionsDeleted: sessions.length };
});

// testWidenAcl({ objectId }): simulates the misconfiguration the security suite needs — a public read+write ACL on one
// user — and reports the ACL it found first, which is how the suite checks enforcePrivateUsers without the master key.
Parse.Cloud.define('testWidenAcl', async (request) => {
  requireSetupEnabled();
  const objectId = request.params && request.params.objectId;
  if (typeof objectId !== 'string' || !objectId) invalid('objectId is required.');
  const user = await new Parse.Query(Parse.User).get(objectId, { useMasterKey: true });
  const before = user.getACL() ? user.getACL().toJSON() : null;
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(true);
  acl.setPublicWriteAccess(true);
  user.setACL(acl);
  await user.save(null, { useMasterKey: true });
  return { objectId, before, after: acl.toJSON() };
});
