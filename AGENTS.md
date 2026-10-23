# AGENTS.md — running this project end to end without a human unsticking you

For an AI agent (or a developer in a hurry) that has to set up, verify or redeploy the social-login starter. Every step,
which ones are unavoidably manual, and what to hand back to a human.

## What you are deploying

- **Backend**: a Back4app app (Parse Server 7). Only the built-in `_User` / `_Session` classes are used. Cloud Code in
  `cloud/main.js`: `beforeSave(_User)` (owner-only identity changes, provider allow-list, `hasPassword` flag),
  `afterSave(_User)` (empty placeholder), functions `linkInfo` and `signOutEverywhere`, plus the privileged helpers
  `setupSchema`, `testCleanup({ usernamesPrefix?, objectIds? })` and `testWidenAcl({ objectId })`, guarded by
  `SETUP_ENABLED` in `cloud/config.js` (upload both files).
- **Web**: `server.js` (Express) serves `public/` and `/config.js`; deployed on Back4app Containers from GitHub,
  Node.js Buildpack, no Dockerfile.
- **Google**: a public OAuth *Web application* client id. It is configured in two places: the Containers env var
  `GOOGLE_CLIENT_ID` (printed into the page) and Back4app → Authentication → Google → Client ID (used by Parse Server to
  verify ID tokens). They must be the same value.

## Secrets and where they live

- `.env` (gitignored): `APP_ID`, `JS_KEY`, `REST_KEY`, `SERVER_URL`, `GOOGLE_CLIENT_ID`, `DATABASE_URL`, optionally
  `MASTER_KEY`. Scripts read it. Never commit it, never print `MASTER_KEY`. The Google client id is public by nature
  but is still kept out of git (placeholder in `.env.example`).
- **The master key is not available to scripts on the live backend, and nothing here needs it.** `npm run setup`,
  `npm test` and `npm run measure` work with `APP_ID` + `REST_KEY`; the privileged parts run inside Cloud Code
  (`setupSchema`, `testCleanup`, `testWidenAcl`). If `.env` happens to contain `MASTER_KEY`, the scripts use it
  directly instead (that is the local path, where the key is a fixed non-secret).
- The Containers app gets only `APP_ID`, `JS_KEY`, `SERVER_URL`, `GOOGLE_CLIENT_ID`. Never give it the master key.
- The local parse-server uses fixed keys from `scripts/lib.mjs` (`LOCAL`); they are not secrets.

## Steps (in order)

| # | Step | Manual? | Command / where |
|---|---|---|---|
| 1 | Create a Back4app account | **yes** | https://www.back4app.com/signup |
| 2 | Create a backend app | **yes** (dashboard) | Dashboard → New App → *Build your Backend* → name it → Create |
| 3 | Copy keys into `.env` | **yes** | App → App Settings → Security & Keys: App ID, JavaScript key, REST key. Master key not needed |
| 4 | Create a Google OAuth client id | **yes** (Google console) | APIs & Services → Credentials → OAuth client ID → Web application; origins `http://localhost:8080` + the Containers URL (step 10) |
| 5 | Enable Google on the backend | **yes** (dashboard) | App → Authentication → Google → Client ID = the value from step 4 → Save |
| 6 | Deploy Cloud Code | **yes** (dashboard) | Cloud Code → *Upload → Upload Files* → `cloud/main.js` **and** `cloud/config.js` → badge "Files pending deploy (2)" → Deploy. Prove with the curl in the README (expect 209 from `linkInfo`, not 141). |
| 7 | Schema + CLP | no | `npm run setup` (no `MASTER_KEY` → calls the Cloud function `setupSchema`; needs step 6) |
| 8 | Verify the backend | no | `TEST_SERVER_URL=https://parseapi.back4app.com npm test` · `npm run measure` (REST key only) |
| 9 | Push the repo to GitHub | no | `git push` |
| 10 | Create the Containers app | **yes** (dashboard) | Containers → Deploy a web app → GitHub repository → *Build & run* → **Node.js Buildpack** → Port 8080, Health check `/healthz` → env vars exactly `APP_ID`, `JS_KEY`, `SERVER_URL` (`https://parseapi.back4app.com`), `GOOGLE_CLIENT_ID` → Create app |
| 11 | Authorize the deployed origin in Google | **yes** (Google console) | the client's *Authorized JavaScript origins* must contain `https://<app>.b4a.run` (no path, no trailing slash); propagation takes minutes |
| 12 | Confirm the deploy | no | `curl -s https://<app>.b4a.run/healthz` → `{"ok":true,…}` |
| 13 | Google click-through | **yes** (browser, real Google account) | `docs/manual-google-check.md`; record results in `docs/evidence/` |
| 14 | Switch the setup helpers off | **yes** (dashboard) | `cloud/config.js` → `SETUP_ENABLED: false` → upload it again → Deploy → curl `setupSchema` expects code 119 (README, "Before going public") |

Steps marked **yes** need a browser session that belongs to the account owner; hand them back with the exact path.

## Live loop without the master key (exact commands)

```text
$ npm run setup                                                     # .env has APP_ID/JS_KEY/REST_KEY/SERVER_URL, no MASTER_KEY
[live] no MASTER_KEY in .env: using the Cloud function setupSchema with the REST key
[live] schema _User: updated (1 new field(s)), CLP set (Cloud function setupSchema)
[live] GET /users without a session → HTTP 404 code 101 "Permission denied, user needs to be authenticated." OK
$ TEST_SERVER_URL=https://parseapi.back4app.com npm test
cleanup: testCleanup deleted 11 of 11 user(s)
…
ℹ tests 16 · ℹ pass 16 · ℹ fail 0
$ npm run measure
target live (parseapi.back4app.com) · 20 warm-ups + 100 runs per scenario
anonymous_new      p50 … ms · p95 … ms
anonymous_repeat   p50 … ms · p95 … ms
email_login        p50 … ms · p95 … ms
cleanup: testCleanup deleted 121 user(s) created by this run (no master key)
```

`npm run setup` failing with "setupSchema is not deployed" means step 6 did not ship (see the 141-vs-209 curl). After
step 14 the suite prints `SKIP Cloud setup helpers (SETUP_ENABLED=false)`, skips the two tests that need them
(`ℹ skipped 2`) and lists the users it could not delete; `setup` and `measure` then need `MASTER_KEY` in `.env` or
the helpers switched back on.

## Local loop

```text
$ npm run dev:server                       # terminal 1
parse-server http://localhost:1337/parse · appId social-login-dev · db postgres://localhost:5433/social_dev · google clientId set
$ npm run setup -- --local
[local] schema _User: updated (0 new field(s)), CLP set
[local] GET /users without a session → HTTP 404 code 101 "Permission denied, user needs to be authenticated." OK
$ npm run dev                              # terminal 2 → http://localhost:8080 (PORT=8089 npm run dev if taken)
$ npm test
ℹ tests 16 · ℹ pass 16 · ℹ fail 0
$ npm run measure -- --local
anonymous_new      p50 … ms · p95 … ms
anonymous_repeat   p50 … ms · p95 … ms
email_login        p50 … ms · p95 … ms
wrote docs/evidence/measure-local-<date>.csv and …-summary.csv
```

Postgres must be listening on 5433 (`/opt/homebrew/opt/postgresql@17/bin/pg_isready -p 5433`); the scripts run
`createdb` for `social_dev` / `social_test` when missing. The tests start their own parse-server on a free port, so
`npm run dev:server` does not need to be running for `npm test`.

## Guarantees and limits (do not overstate them)

- Identity rules live in `beforeSave`: validation, not database constraints. Username/e-mail uniqueness *is* enforced by
  Parse Server itself (202/203).
- `signOutEverywhere` deletes up to 1,000 other sessions per call.
- The Google happy path is verified by hand only (step 13); the automated suite proves that forged tokens are rejected.
- Local parse-server 7.5.4 and Back4app's 7.5.2 agree on the lifecycle; the status codes that differ or were not
  measured live are listed in `docs/notes/build-diary.md` under "Re-verify on Back4app".

## Permission boundaries

- Never paste credentials into chat, logs, commits or screenshots.
- Never run the test suite against a backend with real users unless you accept that it creates and deletes its own
  test users there (it never touches other rows).
- Never put the master key in Containers env vars or in `public/`.
- Never leave `SETUP_ENABLED: true` on a backend that has real users: `testCleanup` deletes users by id or username
  prefix and `testWidenAcl` opens one user's ACL, to anyone with the REST key.
