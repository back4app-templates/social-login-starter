# social-login-starter

Companion repository for the article *"How to let a signed-in user link several sign-in methods to one account
(Google, anonymous guest, email/password) on a Parse backend — without an auth server"*.

One static page, the Parse JS SDK, Google Identity Services and 90 lines of Cloud Code. The backend is a Back4app app
(Parse Server 7); the page is served by a tiny Express app on Back4app Containers. No OAuth server of ours, no token
exchange endpoint: the browser hands Google's ID token to Parse Server, which verifies it against Google.

Built by Back4app Engineering · MIT.

## What it shows

| Action in the UI | What the browser sends | What Parse Server does |
|---|---|---|
| Continue as guest | `POST /users {authData:{anonymous:{id:<uuid>}}}` | creates a user (201) or logs the same guest back in (200), new session either way |
| Sign in with Google | `POST /users {authData:{google:{id, id_token}}}` | verifies the ID token signature + audience against Google, then creates/logs in |
| Sign up / Log in | `POST /users {username,password,email}` / `POST /login` | the classic path |
| Link e-mail/password (signed in) | `PUT /users/<id> {username,password,email}` with the session | sets the password, **answers with a new session token and revokes the old ones**, keeps `authData.anonymous` |
| Link Google (signed in) | `PUT /users/<id> {authData:{google:{…}}}` | verifies the token, links; a Google id already used by another user → 208 |
| Unlink Google / guest id | `PUT /users/<id> {authData:{google:null}}` | removes the provider; the session stays valid; removing the last way in is allowed (the UI prevents it) |
| Sign out | `POST /logout` | kills this session only |
| Sign out everywhere | Cloud function `signOutEverywhere` | deletes every other `_Session` row of the caller (Parse has no built-in for this) |
| "What the backend stored" | `GET /users/me` + Cloud function `linkInfo` | authData *keys* only, `hasPassword` (maintained by a `beforeSave` hook), session `createdAt` |

Collisions are shown with the backend's own text: `202 Account already exists for this username.`,
`203 Account already exists for this email address.`

### Things worth knowing before you copy this

- **The backend keeps the guest id when you link something else; the JS SDK removes it.** `setUsername()` and
  `linkWith()` both call `stripAnonymity()` and send `authData.anonymous = null` in the same request. `public/app.js`
  has a `KEEP_GUEST_ID` switch and explains both choices.
- **Linking a password = new session.** Any `PUT` that sets `password` through a session revokes *all* sessions of
  that user (other devices included) and returns a fresh token. The SDK swaps the token for you; other open tabs are
  signed out.
- **Parse never says whether a user has a password.** The hook in `cloud/main.js` sees the plaintext password in
  `beforeSave` (it runs before hashing) and maintains a `hasPassword` boolean that clients cannot forge.
- **Unlinking the last method is allowed by the server.** A guest with no password who unlinks `anonymous` keeps a
  working session and an account nobody can ever sign into again. The UI disables the button in that state.
- **Providers**: the Back4app dashboard offers Apple, Google, Facebook, X and VK (Parse names: `apple`, `google`,
  `facebook`, `twitter`, `vkontakte`). GitHub is not offered. The hook allow-lists exactly those plus `anonymous`.

## Repository layout

```
public/            index.html · app.js · style.css — the whole client (~300 lines)
cloud/main.js      beforeSave(_User), afterSave(_User) placeholder, linkInfo, signOutEverywhere
server.js          Express: static files, /config.js (APP_ID, JS_KEY, SERVER_URL, GOOGLE_CLIENT_ID), /healthz
scripts/setup.mjs  _User schema + class-level permissions (master key), local or live
scripts/dev-server.mjs  local parse-server ^7 + Postgres, same cloud/main.js, Google client id from .env
scripts/measure.mjs     session-creation latency (anonymous new/repeat, email login), CSV in docs/evidence/
test/              node:test suites: lifecycle + security, raw REST, no browser
docs/manual-google-check.md   the click-through that cannot be automated (needs a real Google account)
docs/notes/build-diary.md     what was observed while building, and what to re-verify on Back4app
```

## Run it locally

Prerequisites: Node 22+, Postgres on port 5433 (`brew install postgresql@17`, started on 5433), a Google OAuth
**Web application** client id whose *Authorized JavaScript origins* include `http://localhost:8080`.

```bash
cp .env.example .env          # put your GOOGLE_CLIENT_ID in it; Back4app keys only needed for deploys
npm install
npm run dev:server            # parse-server on http://localhost:1337/parse (creates the social_dev database)
npm run setup -- --local      # _User class-level permissions + hasPassword field
npm run dev                   # http://localhost:8080 (PORT=8089 npm run dev if 8080 is taken)
npm test                      # 15 tests: starts its own parse-server on a free port, database social_test
npm run measure -- --local    # latency CSVs in docs/evidence/
```

Google's button only renders on `http://localhost`, never on `127.0.0.1`, and only for origins listed in the Google
console. Everything else (guest, e-mail/password, linking, sessions) works without Google.

## Deploy on Back4app

1. **Backend app** — Dashboard → New App → *Build your Backend* → name it → Create. Copy App ID, JavaScript key, REST
   key and Master key (App Settings → Security & Keys → *Show key*) into `.env`.
2. **Google** — Google Cloud Console → APIs & Services → Credentials → *Create credentials → OAuth client ID → Web
   application*. Authorized JavaScript origins: `http://localhost:8080` and, later, `https://<your-app>.b4a.run`.
   No redirect URI is needed (Google Identity Services uses a popup). Copy the client id to `.env` as
   `GOOGLE_CLIENT_ID` and into Back4app → your app → **Authentication → Google → Client ID** (save).
   Anonymous users are enabled by default on Parse Server; nothing to click.
3. **Schema and permissions** — `npm run setup` (uses the master key from `.env`; prints the CLP probe).
4. **Cloud Code** — Dashboard → Cloud Code → *Upload → Upload Files* → `cloud/main.js` → confirm the badge
   "Files pending deploy (1)" → Deploy. Prove it with a request, not with the dialog:
   ```bash
   curl -s -X POST https://parseapi.back4app.com/functions/linkInfo \
     -H "X-Parse-Application-Id: $APP_ID" -H "X-Parse-REST-API-Key: $REST_KEY" -H "Content-Type: application/json" -d '{}'
   # {"code":209,"error":"Sign in first."}      ← deployed (the function exists and rejects anonymous callers)
   # {"code":141,"error":"Invalid function: \"linkInfo\""}   ← not deployed yet
   ```
   On a fresh backend the first Deploy has been seen to report "Success" while shipping nothing; if you get 141, reload
   the editor, make the file dirty again, confirm the badge, Deploy.
5. **Verify the backend from here** — `TEST_SERVER_URL=https://parseapi.back4app.com npm test` runs the same 15 tests
   against the live app (it creates and deletes its own users; nothing is purged). `npm run measure` gives live latency.
6. **Containers** — push the repo to GitHub, then Containers → *Deploy a web app* → GitHub repository → select the
   repo → *Build & run* → **Node.js Buildpack** (no Dockerfile in this repo) → start command `node server.js` →
   Port `8080`, Health check `/healthz` → Environment variables `APP_ID`, `JS_KEY`, `SERVER_URL`
   (`https://parseapi.back4app.com`), `GOOGLE_CLIENT_ID` → Create app. Never add the master key there.
7. **Google again** — add `https://<your-app>.b4a.run` to the client's *Authorized JavaScript origins* (takes a few
   minutes to propagate). Until then the Google button logs `The given origin is not allowed for the given client ID`.
8. `curl -s https://<your-app>.b4a.run/healthz` → `{"ok":true,"version":"0.1.0",…}`, then walk through
   `docs/manual-google-check.md`.

## Security model in one paragraph

Sign-up is public (it has to be), everything else about a user is owner-only: new users get an owner-only ACL
(`enforcePrivateUsers`), the `_User` CLP requires a session for find/get/update/delete and hides `email`, `authData` and
`hasPassword` from everyone but the owner, and `beforeSave(_User)` refuses identity changes by anyone but the owner or
the master key — a rule that still holds if an ACL is widened by mistake (tested). Google ID tokens are verified by
Parse Server against Google's published keys and the configured client id, so a forged token never creates a user.
Sessions are revocable rows in `_Session`; `signOutEverywhere` deletes the others with the master key in Cloud Code.

## License

MIT — see `LICENSE`.
