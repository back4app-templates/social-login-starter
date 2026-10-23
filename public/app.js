// File: public/app.js · plain JS, Parse JS SDK 8 (loaded in index.html), Google Identity Services.
// Every call below is a normal Parse REST call under the hood; nothing here needs a server of ours except
// `linkInfo` and `signOutEverywhere`, which are Cloud functions in cloud/main.js.
/* global Parse, google */
'use strict';

const cfg = window.APP_CONFIG;
Parse.initialize(cfg.appId, cfg.jsKey);
Parse.serverURL = cfg.serverUrl;

const $ = (id) => document.getElementById(id);

// The backend KEEPS authData.anonymous when another method is linked (measured: PUT /users/<id> via REST). The JS SDK
// does not: setUsername() and linkWith() both call stripAnonymity(), which adds authData.anonymous=null to the same
// request. With KEEP_GUEST_ID=true this app bypasses those two helpers so the guest id stays linked and "Unlink guest
// id" is a real choice; set it to false to get the SDK's convention (guest id dropped as soon as a real method exists).
const KEEP_GUEST_ID = true;

const PROVIDER_LABELS = { anonymous: 'Guest id (anonymous)', google: 'Google', facebook: 'Facebook', apple: 'Apple', twitter: 'X', vkontakte: 'VK' };

// ---------------------------------------------------------------- messages

function say(text, kind = '') {
  const el = $('msg');
  el.textContent = text; el.className = `msg ${kind}`; el.hidden = !text;
}
// Parse errors carry a numeric code; showing it alongside the backend's own text is what makes collisions debuggable:
// 202 "Account already exists for this username.", 203 "Account already exists for this email address.".
const errorText = (e) => (e && e.code !== undefined ? `Error ${e.code}: ${e.message}` : String(e && e.message || e));

async function run(button, fn) {
  if (button) button.disabled = true;
  say('');
  try { await fn(); } catch (e) { say(errorText(e), 'error'); console.error(e); }
  finally { if (button) button.disabled = false; await render(); }
}

// ---------------------------------------------------------------- Google Identity Services

// GIS gives us an ID token (a JWT signed by Google). Parse Server verifies its signature and audience against the
// client id configured on the backend — the browser never talks to an OAuth server of ours.
function decodeJwtPayload(token) {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(atob(b64).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
}

async function onGoogleCredential(response) {
  const payload = decodeJwtPayload(response.credential);
  const authData = { id: payload.sub, id_token: response.credential };
  await run(null, async () => {
    const current = Parse.User.current();
    if (current) {
      // Both branches end as PUT /users/<id> {authData:{google:{…}}} with the current session; linkWith() additionally
      // sends anonymous:null (see KEEP_GUEST_ID). Parse Server validates the id_token before storing anything.
      if (KEEP_GUEST_ID) await current.save({ authData: { ...(current.get('authData') || {}), google: authData } });
      else await current.linkWith('google', { authData });
      say(`Google account ${payload.email || payload.sub} linked.`, 'ok');
    } else {
      const user = await Parse.User.logInWith('google', { authData }); // POST /users {authData:{google:{…}}}
      say(`Signed in with Google as ${payload.email || payload.sub}${user.existed() ? '' : ' (new account)'}.`, 'ok');
    }
  });
}

let gisReady = false;
function setupGoogle() {
  if (gisReady || !window.google || !google.accounts) return;
  gisReady = true;
  google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogleCredential, ux_mode: 'popup', auto_select: false });
  renderGoogleButtons();
}
// GIS sizes its button when it renders it; a button rendered inside a hidden section comes out 0 px wide. So the
// buttons are (re)rendered every time a view becomes visible (render() below). locale: without it the button follows
// the browser language.
function renderGoogleButtons() {
  if (!gisReady) return;
  for (const [id, text] of [['google-signin', 'signin_with'], ['google-link', 'continue_with']]) {
    const el = $(id);
    if (el.hidden || el.closest('[hidden]')) continue;
    el.innerHTML = '';
    google.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', text, shape: 'pill', locale: 'en' });
  }
}
// The GIS script is async: poll briefly for it; if it never arrives (blocked, or origin not authorized) say so.
const gisTimer = setInterval(() => {
  setupGoogle();
  if (gisReady) clearInterval(gisTimer);
}, 200);
setTimeout(() => {
  clearInterval(gisTimer);
  if (!gisReady) for (const id of ['google-signin', 'google-link']) $(id).textContent = 'Google button unavailable (script blocked?)';
}, 8000);

// ---------------------------------------------------------------- render

async function render() {
  const user = Parse.User.current();
  $('signed-out').hidden = !!user;
  $('signed-in').hidden = !user;
  if (!user) { renderGoogleButtons(); return; }

  // What the backend tells us about this account. linkInfo adds hasPassword and the session's createdAt, which the
  // SDK cannot see; everything else comes from the user object itself (GET /users/me).
  let info = null;
  try {
    await user.fetch();                                           // refresh authData/email after link/unlink
    info = await Parse.Cloud.run('linkInfo');
  } catch (e) {
    if (e.code === Parse.Error.INVALID_SESSION_TOKEN) {          // 209: the session was revoked from elsewhere
      await Parse.User.logOut().catch(() => {});
      say('Your session is no longer valid (signed out elsewhere, or the password changed). Please sign in again.', 'error');
      return render();
    }
    throw e;
  }

  const authData = user.get('authData') || {};
  const providers = Object.keys(authData).filter((k) => authData[k]);
  const rows = [
    ['E-mail / password', info.hasPassword ? `on · ${user.get('username')}${user.get('email') ? ` · ${user.get('email')}` : ''}` : 'not linked'],
    ...Object.keys(PROVIDER_LABELS).filter((p) => p === 'anonymous' || p === 'google' || providers.includes(p))
      .map((p) => [PROVIDER_LABELS[p], providers.includes(p) ? 'linked' : 'not linked']),
  ];
  $('methods').innerHTML = rows.map(([label, state]) =>
    `<li class="${/^(on|linked)/.test(state) ? 'on' : ''}"><span>${label}</span><span class="state">${state}</span></li>`).join('');
  $('who').textContent = `objectId ${user.id}`;

  $('unlink-google').hidden = !providers.includes('google');
  $('unlink-anonymous').hidden = !providers.includes('anonymous');
  // Guard against orphaning the account: never offer to remove the only way in (see test "unlink the LAST sign-in method").
  const ways = providers.length + (info.hasPassword ? 1 : 0);
  for (const id of ['unlink-google', 'unlink-anonymous']) $(id).disabled = ways <= 1;
  $('link-email-toggle').hidden = info.hasPassword;
  $('google-link').hidden = providers.includes('google');
  renderGoogleButtons();

  // The stored record, with provider payloads reduced to their keys: id tokens and guest ids never reach the screen.
  const stored = {
    objectId: user.id,
    username: user.get('username'),
    email: user.get('email') || null,
    emailVerified: user.get('emailVerified'),
    hasPassword: info.hasPassword,
    authData: Object.fromEntries(providers.map((p) => [p, `{ ${Object.keys(authData[p]).join(', ')} }`])),
    ACL: user.getACL() ? user.getACL().toJSON() : undefined,
    session: info.session ? { createdAt: info.session.createdAt, expiresAt: info.session.expiresAt, activeSessions: info.sessionCount } : null,
    createdAt: user.createdAt, updatedAt: user.updatedAt,
  };
  $('stored').textContent = JSON.stringify(stored, null, 2);
}

// ---------------------------------------------------------------- actions

$('guest').onclick = (e) => run(e.target, async () => {
  const user = await Parse.AnonymousUtils.logIn();                 // POST /users {authData:{anonymous:{id:<uuid>}}}
  say(`Signed in as guest ${user.id}. The guest id is stored in this browser; clearing site data loses it.`, 'ok');
});

$('email-form').onsubmit = (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || 'login';
  const f = new FormData(e.target);
  run(e.submitter, async () => {
    if (mode === 'signup') {
      const user = new Parse.User({ username: f.get('username'), password: f.get('password') });
      if (f.get('email')) user.setEmail(f.get('email'));
      await user.signUp();                                         // POST /users {username,password,email}
      say(`Account created: ${user.get('username')}.`, 'ok');
    } else {
      const user = await Parse.User.logIn(f.get('username'), f.get('password')); // POST /login
      say(`Welcome back, ${user.get('username')}.`, 'ok');
    }
    e.target.reset();
  });
};

$('link-email-toggle').onclick = () => { $('link-form').hidden = false; $('link-form').username.focus(); };
$('link-cancel').onclick = () => { $('link-form').hidden = true; };
$('link-form').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  run(e.submitter, async () => {
    const user = Parse.User.current();
    const sessionBefore = user.getSessionToken();
    if (KEEP_GUEST_ID) user.set('username', f.get('username'));   // plain set(): no stripAnonymity()
    else user.setUsername(f.get('username'));
    user.setPassword(f.get('password'));
    user.setEmail(f.get('email'));
    await user.save();                                             // PUT /users/<id> with the current session
    // Parse answers with a NEW session token and revokes the old ones (including other devices of this guest).
    const changed = user.getSessionToken() !== sessionBefore;
    say(`E-mail/password linked.${changed ? ' The backend issued a new session token and revoked the previous ones.' : ''}`, 'ok');
    e.target.reset(); $('link-form').hidden = true;
  });
};

$('unlink-google').onclick = (e) => run(e.target, async () => {
  await Parse.User.current()._unlinkFrom('google');                // PUT /users/<id> {authData:{google:null}}
  say('Google unlinked. Signing in with that Google account again would create a new, separate user.', 'ok');
});

$('unlink-anonymous').onclick = (e) => run(e.target, async () => {
  await Parse.User.current()._unlinkFrom('anonymous');             // PUT /users/<id> {authData:{anonymous:null}}
  say('Guest id unlinked. This browser can no longer resume the account as a guest.', 'ok');
});

$('signout').onclick = (e) => run(e.target, async () => {
  await Parse.User.logOut();                                       // POST /logout — only this session
  say('Signed out on this device only.', 'ok');
});

$('signout-everywhere').onclick = (e) => run(e.target, async () => {
  const { revoked } = await Parse.Cloud.run('signOutEverywhere');  // Cloud Code: destroys the other _Session rows
  say(`Signed out everywhere else: ${revoked} other session(s) revoked. This device stays signed in.`, 'ok');
});

render();
