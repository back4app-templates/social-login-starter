# Build diary — social-login-starter

## 2026-10-23 — first build, everything local

Environment: macOS, Node 25.8.1 (parse-server 7.5.4 declares `<23` and only warns), Postgres 17 on port 5433,
`parse-server@7.5.4` with the bundled Postgres adapter (`pg-promise@11.14.0`), Parse JS SDK `8.6.2` from jsdelivr.
No remote server was contacted except the npm registry and, once, Google's public certificate endpoint (see security
test 5 below — the local parse-server fetches `https://www.googleapis.com/oauth2/v3/certs` to check a JWT signature).

Inputs respected: Back4app offers Apple, Google, Facebook, X and VK (no GitHub); Google is configured by a public
web client id; `authData.google {id, id_token}`; the feasibility results of 2026-10-20 (link → new token, old token
209, `authData.anonymous` kept, 202/203 collisions, password change revokes other sessions).

### What was built

- `public/` (300 lines total): guest, Google (GIS button → `id_token` → `Parse.User.logInWith('google', …)`),
  e-mail/password sign-up/login, linked-methods panel, link/unlink buttons, sign out, sign out everywhere, stored-record
  box with authData keys only, collision errors shown with the backend's text.
- `cloud/main.js`: `beforeSave(_User)` (owner-only identity changes, provider allow-list, `hasPassword` flag),
  `afterSave(_User)` placeholder, `linkInfo`, `signOutEverywhere`.
- `scripts/setup.mjs` (CLP), `scripts/dev-server.mjs` (local parse-server, exported for the tests),
  `scripts/measure.mjs` (b1 latency), `test/*.test.mjs` (15 node:test cases, raw REST).

### Lifecycle on local parse-server 7.5.4 — matches the Back4app feasibility run

| case | local 7.5.4 | Back4app 7.5.2 (2026-10-20) |
|---|---|---|
| anonymous POST /users new / repeat | 201 / 200 same objectId, new token | same |
| link username/password via session | 200, new sessionToken, old session 209, anonymous kept | same |
| second guest session after the link | 209 | same (c2) |
| same username / same e-mail from another user | 202 / 203, same texts | same |
| unlink anonymous via master (lab) vs via own session (here) | 200, session valid, old guest id → new user | same (f1/f2, done with master key there) |
| logout device 2 | device 1 valid, device 2 209 | same |
| password change via session | 200 + fresh token, caller and other sessions 209 | same (h) |
| signOutEverywhere | `{revoked: n}`, caller keeps its session | **not measured live yet** |

### Found while building

1. **The JS SDK drops the guest id, the server does not.** `ParseUser.setUsername()` and `ParseUser.linkWith()` both
   call `stripAnonymity()` → the same PUT carries `authData.anonymous = null`. First browser run showed
   `authData: {}` after linking a password while the REST tests showed `anonymous` kept. `public/app.js` now has
   `KEEP_GUEST_ID` (default true: plain `set('username')` and `save({authData: merged})`). Verified in the browser: guest
   → link password → `authData: { anonymous }` still there, *Unlink guest id* enabled → unlink → `{}`.
2. **`hasPassword` is derivable only in `beforeSave`.** The hook sees the plaintext `password` (hashing happens after
   triggers); `request.original` carries the stored flag for updates. A client PUT `{hasPassword: true}` is overwritten
   (tested). With the master key the API still never returns the hash (`RestQuery.cleanResultAuthData`).
3. **Unlinking the last method is allowed.** `PUT {authData:{anonymous:null}}` on a password-less guest → 200; the
   session stays valid; the account is orphaned. The UI disables unlink when `providers.length + hasPassword <= 1`.
4. **`[hidden]` vs. `display: grid`.** A class with `display:` beats the `hidden` attribute; fixed with
   `[hidden] { display: none !important }`. Noted because the link form showed up without the toggle.
5. **parse-server probes `serverURL/health` 1 s after mount.** Listening before `start()` and keeping the test server
   alive ≥ 1.5 s removes the spurious "Unable to connect" warning in test output.
6. **Port 8080 was taken on this machine** by an unrelated local app bound to 127.0.0.1; `PORT=8089 npm run dev` works.
   Containers sets `PORT` itself.
7. `npm run dev` now sets `NODE_ENV=development` so static files are served with `max-age=0` (the browser kept the old
   `app.js` for an hour otherwise). Deployed builds keep `1h`.

### Local measurements (not comparable with Back4app — same machine, in-process DB)

`npm run measure -- --local`, 20 warm-ups + 100 runs, 2026-10-23: `anonymous_new` p50 1.7 ms / p95 2.2 ms;
`anonymous_repeat` p50 1.8 / p95 2.3; `email_login` p50 42.6 / p95 43.2 (bcrypt dominates). Files:
`docs/evidence/measure-local-2026-10-23*.csv`. The `google_id_token` row is a placeholder until step 7 of
`docs/manual-google-check.md` is run on the deployed app.

### Re-verify on Back4app (behaviour seen locally that was not, or not identically, measured live)

| # | what | local parse-server 7.5.4 | why it may differ / how to check |
|---|---|---|---|
| R1 | `GET /users` without a session (CLP `find: requiresAuthentication`) | HTTP 404, code **101** "Permission denied, user needs to be authenticated." | older servers answered 119; `npm run setup` prints the probe |
| R2 | `PUT /users/<other>` with a foreign session, owner-only ACL | HTTP 400, code **206** "Insufficient auth." | the feasibility run did not try it; test "changing another user's username…" records it |
| R3 | new-user ACL (`enforcePrivateUsers`) | `{<id>: {read, write}}` — no public read | Back4app's server setting is not visible from here; the same test asserts the ACL shape with the master key and will fail if public read is on. If it is, the CLP `protectedFields` still hides email/authData/hasPassword; only `username`/`createdAt` would leak to signed-in users. |
| R4 | `authData.github` (provider not configured) | HTTP **500**, code 1 "Internal server error." (`GitHubAdapter.validateOptions: GitHub options are required`) | the hook's allow-list never ran because parse-server failed first; expect 252 or 500 live — record |
| R5 | forged `authData.google`: non-JWT / missing `id_token` / self-signed RS256 JWT | 101 "provided token does not decode as JWT" / 101 "id token is invalid for this user." / 101 "secret or public key must be provided" (after fetching Google's certs) | same adapter code in 7.5.2; confirm the texts |
| R6 | `signOutEverywhere` | `{revoked: n}` | Cloud Code must be deployed; test "signOutEverywhere…" |
| R7 | `linkInfo.session.createdAt` changes after linking a password | yes | proves the token swap on the live app |
| R8 | `protectedFields` on `*` and the owner reading `/users/me` | owner still sees email/authData/hasPassword | Parse exempts `objectId` queries on self; confirm on 7.5.2 |
| R9 | VK with `authData.vkontakte` | 400 with a non-numeric `code`: `"Vk only works with enableInsecureAuth: true"` | not in scope of the article; note only |
| R10 | latency b1 | local numbers above | run `npm run measure` against the live app from the same machine as the article's other measurements |

Run all of them with `TEST_SERVER_URL=https://parseapi.back4app.com npm test` and `npm run measure`
(after `npm run setup` and the Cloud Code upload). The suite prints "lifecycle observations" and "security
observations" blocks with the exact codes and texts to quote.
