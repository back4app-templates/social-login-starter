// File: scripts/dev-server.mjs · local parse-server ^7 with the Postgres adapter, same Cloud Code as production.
//   npm run dev:server                → http://localhost:1337/parse (database postgres://localhost:5433/social_dev)
// Imported by the tests, which start their own instance on another port and database.
// Needs a Postgres listening on 5433 (brew: postgresql@17). The database is created with `createdb` if missing.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ParseServer } from 'parse-server';
import { LOCAL, ROOT, loadDotEnv } from './lib.mjs';

const PG_BIN = ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin'];

export function ensureDatabase(databaseURI) {
  const u = new URL(databaseURI);
  const dbName = u.pathname.replace(/^\//, '');
  const dir = PG_BIN.find((d) => existsSync(path.join(d, 'createdb')));
  if (!dir) { console.warn(`createdb not found in ${PG_BIN.join(', ')} — assuming ${dbName} exists`); return; }
  const common = ['-h', u.hostname, '-p', u.port || '5432', ...(u.username ? ['-U', u.username] : [])];
  const list = execFileSync(path.join(dir, 'psql'), [...common, '-lqt'], { encoding: 'utf8' });
  if (list.split('\n').some((l) => l.split('|')[0].trim() === dbName)) return;
  execFileSync(path.join(dir, 'createdb'), [...common, dbName], { stdio: 'inherit' });
  console.log(`created database ${dbName}`);
}

/** Starts parse-server + express. Returns { server, http, url, close() }. */
export async function startServer({ port = LOCAL.port, databaseURI = LOCAL.databaseURI, googleClientId, quiet = false } = {}) {
  loadDotEnv();
  googleClientId = googleClientId || process.env.GOOGLE_CLIENT_ID || 'missing-google-client-id.apps.googleusercontent.com';
  ensureDatabase(databaseURI);

  const serverURL = `http://localhost:${port}/parse`;
  const server = new ParseServer({
    appId: LOCAL.appId,
    javascriptKey: LOCAL.jsKey,
    restAPIKey: LOCAL.restKey,
    masterKey: LOCAL.masterKey,
    serverURL,
    databaseURI,
    cloud: path.join(ROOT, 'cloud', 'main.js'),
    appName: 'social-login-starter (local)',
    // Mirrors what the article relies on. Back4app's values for these are checked in docs/notes/build-diary.md.
    auth: {
      anonymous: { enabled: true },
      google: { clientId: googleClientId },
    },
    enforcePrivateUsers: true,       // new users get an owner-only ACL (parse-server 7 default; stated explicitly)
    allowClientClassCreation: false,
    allowExpiredAuthDataToken: false,
    revokeSessionOnPasswordReset: true,
    logLevel: quiet ? 'error' : 'info',
    silent: quiet,
    verbose: false,
  });
  // Listen first: start() probes serverURL over HTTP and warns "Unable to connect" if nothing answers yet.
  const app = express();
  app.use('/parse', server.app);
  const http = await new Promise((resolve) => { const h = app.listen(port, () => resolve(h)); });
  await server.start();
  const startedAt = Date.now();
  if (!quiet) console.log(`parse-server ${serverURL} · appId ${LOCAL.appId} · db ${databaseURI} · google clientId ${googleClientId ? 'set' : 'MISSING'}`);
  return {
    server, http, url: serverURL,
    close: async () => {
      // parse-server probes serverURL/health 1 s after mount; a suite faster than that would log a spurious warning.
      await new Promise((r) => setTimeout(r, Math.max(0, 1500 - (Date.now() - startedAt))));
      await new Promise((r) => http.close(r));
      await server.handleShutdown();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts', 'dev-server.mjs')) {
  loadDotEnv();
  startServer({ databaseURI: process.env.DATABASE_URL || LOCAL.databaseURI }).catch((e) => { console.error(e); process.exit(1); });
}
