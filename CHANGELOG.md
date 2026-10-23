# Changelog

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
