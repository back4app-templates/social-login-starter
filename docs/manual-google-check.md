# Manual check — the Google path

The automated suite cannot sign in with Google: that needs a Google-signed ID token for a real account, issued in a
browser. This is the exact click-through to run after a deploy, and what to write down. Budget: 10 minutes.

Record the results in `docs/evidence/manual-google-<YYYY-MM-DD>.md` using the template at the bottom. Never paste a
token, a session token or a guest id into the evidence file — object ids and status codes only.

## Prerequisites

- The deployed page (or `http://localhost:8080` for the local loop) is listed under *Authorized JavaScript origins* of
  the Google OAuth client. If not, the button renders but the console logs
  `[GSI_LOGGER]: The given origin is not allowed for the given client ID.` — that is the first thing to record.
- Back4app → Authentication → Google → Client ID holds the same client id as `/config.js` on the page. Open
  `https://<app>.b4a.run/config.js` and compare.
- Browser DevTools open on the Network tab, filter `parseapi` (or `localhost:1337`). Preserve log.
- A Google account you can use for testing. The user it creates will be deleted at the end.

## Steps

1. **Fresh sign-in with Google.** Signed out, click *Sign in with Google*, pick the account.
   Expect: message "Signed in with Google as <email> (new account)". Panel: *Google — linked*, *E-mail / password — not
   linked*, username is a 25-character random string, `hasPassword: false`, `authData: { google: "{ id, id_token }" }`.
   Network: `POST /users` → **201**. Record: objectId, status, the request time shown by DevTools.
2. **Repeat sign-in.** *Sign out*, then *Sign in with Google* again with the same account.
   Expect: same objectId, `POST /users` → **200**, message without "(new account)". Record both.
3. **Link e-mail/password to the Google user.** *Link e-mail/password…*, fill a username, the Google e-mail (or
   another) and a password, *Link*. Expect: message mentions a new session token; panel now shows both methods;
   `session.createdAt` in the stored JSON changed. Network: `PUT /users/<id>` → **200** with `sessionToken` in the
   response body. Record whether `authData.google` is still present (expected: yes).
4. **Password login keeps Google linked.** *Sign out*, log in with the username/password from step 3.
   Expect: panel shows Google linked. Record.
5. **E-mail collision.** In a second browser profile (or after *Sign out*), *Continue as guest* and try to link
   e-mail/password with the e-mail from step 3. Expect: red message `Error 203: Account already exists for this email
   address.` Record the exact text.
6. **Link Google to a guest.** Signed out, *Continue as guest*, then click the Google button inside the panel
   (*Continue with Google*) with a **different** Google account than step 1 (the first one is already linked to another
   user — using it here must fail with **208** "this auth is already used"; record that too if you try it).
   Expect with `KEEP_GUEST_ID = true` (default): `authData: { anonymous, google }`, both listed as linked, *Unlink guest
   id* enabled. Network: `PUT /users/<id>` → **200**. Record the authData keys.
7. **Latency placeholder (b1, Google path).** From the signed-out state, sign in with Google five times (sign out in
   between). In DevTools, read the *Time* column of each `POST /users` (that is the backend round trip including Google
   token verification on the server). Record the five values and their median in the evidence file **and** replace the
   `google_id_token` placeholder row in the latest `docs/evidence/measure-<target>-<date>-summary.csv`
   (`runs=5`, `p50_ms`, `max_ms`, note `manual, DevTools`).
8. **Unlink Google.** On the user from step 6, *Unlink Google*. Expect: Google gone from the panel, session still valid.
   Sign out, sign in with that Google account again: expect a **new** objectId (the old account is no longer reachable
   through Google). Record both ids.
9. **Sign out everywhere.** Sign in with Google in two browser profiles. In profile A click *Sign out everywhere*:
   expect "1 other session(s) revoked"; in profile B any click now shows "Your session is no longer valid…" and the
   signed-out view. Record.
10. **Wrong client id (optional, 2 minutes).** Temporarily set a different client id in Back4app → Authentication →
    Google, sign in with Google: expect `POST /users` → 400 with code **101** and a message about the audience
    (`jwt audience invalid` or `id token not authorized for this clientId`). Put the real id back. Record the text.
11. **Cleanup.** Delete the test users from the dashboard's Database browser, or — while `SETUP_ENABLED` is still true —
    with `POST /functions/testCleanup` `{"objectIds":["<id>", …]}` (REST key; only users younger than 2 h). Note how
    many you deleted.

## Evidence template

```markdown
# Manual Google check — <date>, <app URL>, Parse Server <version from dashboard>
Google client id: ends in …<last 6 chars>   Origins authorized: yes/no (console message if no)
| step | expectation | observed | status |
|---|---|---|---|
| 1 fresh sign-in | 201, new account | objectId …, 201, 412 ms | PASS |
| 2 repeat | 200 same id | … | |
| 3 link password | 200 + new token, google kept | … | |
| 4 password login | google linked | … | |
| 5 e-mail collision | 203 text | … | |
| 6 guest + google | both linked | … | |
| 7 latency ×5 | median | … ms (…, …, …, …, …) | |
| 8 unlink google | new id on re-sign-in | … | |
| 9 sign out everywhere | other profile signed out | … | |
| 10 wrong client id | 101 | … | |
Cleanup: N users deleted.
```
