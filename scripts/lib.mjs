// File: scripts/lib.mjs · Node 22 · shared by scripts and tests: .env loading, target selection, raw Parse REST calls.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Fixed keys of the LOCAL parse-server (scripts/dev-server.mjs). They are not secrets: the server only listens on
// localhost and the database is a throwaway. Keeping them constant lets `npm run dev`, the tests and the measure script
// agree without touching .env, which is reserved for the Back4app app.
export const LOCAL = {
  appId: 'social-login-dev',
  jsKey: 'social-login-dev-js',
  restKey: 'social-login-dev-rest',
  masterKey: 'social-login-dev-master',
  serverUrl: 'http://localhost:1337/parse',
  port: 1337,
  databaseURI: 'postgres://localhost:5433/social_dev',
};

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** Target selection: `--local` (or TARGET=local) → the local parse-server; otherwise the Back4app app from .env. */
export function target(a = args()) {
  loadDotEnv();
  if (a.local || process.env.TARGET === 'local') return { ...LOCAL, name: 'local' };
  const env = {
    name: 'live',
    appId: process.env.APP_ID, jsKey: process.env.JS_KEY, restKey: process.env.REST_KEY, masterKey: process.env.MASTER_KEY,
    serverUrl: (process.env.SERVER_URL || 'https://parseapi.back4app.com').replace(/\/$/, ''),
  };
  if (!env.appId) { console.error('Missing APP_ID — copy .env.example to .env and fill it in, or pass --local.'); process.exit(1); }
  return env;
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export class ParseError extends Error {
  constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.code = body?.code; this.body = body; }
}

/**
 * rest(env, method, path, body, { master, session, headers, raw }) → parsed JSON; throws ParseError on non-2xx.
 * With { raw: true } it never throws and returns { status, json, ms } — the tests use that to record exact codes.
 */
export async function rest(env, method, p, body, opts = {}) {
  const headers = { 'X-Parse-Application-Id': env.appId, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.master) headers['X-Parse-Master-Key'] = env.masterKey;
  else if (env.restKey) headers['X-Parse-REST-API-Key'] = env.restKey;
  else if (env.jsKey) headers['X-Parse-Javascript-Key'] = env.jsKey;
  if (opts.session) headers['X-Parse-Session-Token'] = opts.session;
  const t0 = performance.now();
  const res = await fetch(env.serverUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
  if (opts.raw) return { status: res.status, json, ms };
  if (!res.ok) throw new ParseError(res.status, json);
  return json;
}

export const where = (obj) => encodeURIComponent(JSON.stringify(obj));
