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
