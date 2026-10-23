# Changelog

## 0.2.0 — 2026-10-23

Nothing outside Cloud Code needs the master key any more.

- Cloud Code: `setupSchema` (idempotent `_User` CLP + `hasPassword` via `Parse.Schema`), `testCleanup({ usernamesPrefix?,
  objectIds? })` (users + their sessions; prefix ≥ 6 chars, ids ≤ 200 and younger than 2 h) and `testWidenAcl({ objectId })`
  (returns the ACL it found, then opens it). All three refuse with 119 when `cloud/config.js` has `SETUP_ENABLED: false`.
- `cloud/config.js`: new, uploaded next to `main.js`; `main.js` falls back to `SETUP_ENABLED: true` when it is missing.
- `scripts/setup.mjs`: without `MASTER_KEY` calls `setupSchema` with the REST key (`--cloud` forces that path); readable
  errors for "not deployed" (141) and "disabled" (119).
- Tests: the harness applies the schema through `setupSchema`, deletes its users through `testCleanup` and widens the
  ACL through `testWidenAcl`, locally and live; the master key is only a fallback. With the helpers disabled and no
  master key the two affected tests skip with a `SKIP` line. New test for the helpers' input validation (16 tests).
- `scripts/measure.mjs`: cleanup through `testCleanup` when there is no master key (timings were REST-key only already).
- README/AGENTS: no-master-key path, Containers env vars table, Google origin requirement, "Before going public".

## 0.1.0 — 2026-10-23

First version, built and verified against a local parse-server 7.5.4 (Postgres); live verification on Back4app pending
(see `docs/notes/build-diary.md`, "Re-verify on Back4app").

- Web app (`public/`): guest, Google (Google Identity Services ID token), e-mail/password; linked-methods panel with
  link/unlink, sign out, sign out everywhere, stored-record box (authData keys only); backend error texts surfaced.
  `KEEP_GUEST_ID` switch documenting the JS SDK's `stripAnonymity()` behaviour.
- Cloud Code: `beforeSave(_User)` (owner-only identity changes, provider allow-list, `hasPassword`), `afterSave(_User)`
  placeholder, `linkInfo`, `signOutEverywhere`.
- `server.js` for Back4app Containers (Node.js Buildpack), `/healthz`, `/config.js`.
- `scripts/setup.mjs` (CLP), `scripts/dev-server.mjs` (local parse-server), `scripts/measure.mjs` (b1 latency CSVs).
- Tests: 15 node:test cases over raw REST (lifecycle + security), runnable locally or against a live app via
  `TEST_SERVER_URL`.
- Docs: README (deploy steps), AGENTS.md, `docs/manual-google-check.md`, build diary, local latency evidence.
