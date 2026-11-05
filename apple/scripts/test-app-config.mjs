// Tests for the server-driven app config and remote diagnostics routes.
//   node --test apple/scripts/test-app-config.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from './harness.mjs';
import { startFakeOidc } from './fake-oidc.mjs';

let local; // loopback engine without sign-in (like `npm run engine`)
let secured; // engine with Pocket ID (fake) sign-in, like films.heil.haus
let idp;

const json = async (res) => ({ status: res.status, body: await res.json() });
const call = (base, method, path, body, headers = {}) => fetch(`${base}/engine/api${path}`, {
  method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(json);

before(async () => {
  local = await startEngine();
  idp = await startFakeOidc();
  const port = 4900 + Math.floor(Math.random() * 90);
  secured = await startEngine({ port, env: { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'filmstudio-test', PUBLIC_URL: `http://127.0.0.1:${port}` } });
});
after(async () => { local?.stop(); secured?.stop(); await idp?.close(); });

test('defaults: tabs, features, polling, capture copy', async () => {
  const { status, body } = await call(local.base, 'GET', '/app/config');
  assert.equal(status, 200);
  assert.deepEqual(body.tabs.map((t) => t.id), ['library', 'create', 'films', 'characters', 'tools', 'settings']);
  assert.ok(body.tabs.every((t) => t.kind === 'native' && t.sfSymbol && t.title && t.path));
  assert.equal(body.features.characters, true);
  assert.ok(body.polling.jobMs > 0 && body.polling.productionMs > 0);
  assert.equal(body.capture.checklist.length, 9);
  assert.equal(body.notice, null);
});

test('flip one tab to web, disable a feature, change a default, set a notice — then reset', async () => {
  let r = await call(local.base, 'PATCH', '/app/config', {
    tabs: { films: { kind: 'web', path: '/#longform' } },
    features: { saveToPhotos: false },
    defaults: { aspect: '9:16' },
    notice: { title: 'Heads up', body: 'Server maintenance at 22:00', level: 'warning' },
  });
  assert.equal(r.status, 200);
  const films = r.body.tabs.find((t) => t.id === 'films');
  assert.equal(films.kind, 'web');
  assert.equal(films.title, 'Films', 'a per-id tab patch keeps the other fields');
  assert.equal(r.body.tabs.length, 6);
  assert.equal(r.body.features.saveToPhotos, false);
  assert.equal(r.body.features.deleteMedia, true, 'other flags keep their defaults');
  assert.equal(r.body.defaults.aspect, '9:16');
  assert.ok(r.body.defaults.videoModels.length > 0, 'merge, not replace');
  assert.equal(r.body.notice.level, 'warning');
  assert.ok(r.body.updatedAt);

  // Reorder / hide with an array.
  r = await call(local.base, 'PATCH', '/app/config', { tabs: [{ id: 'films', title: 'Films', sfSymbol: 'film', kind: 'native', path: '/' }, { id: 'settings', title: 'Settings', sfSymbol: 'gearshape', kind: 'native', path: '/' }] });
  assert.deepEqual(r.body.tabs.map((t) => t.id), ['films', 'settings']);

  // Persisted across restarts? (Re-read.)
  r = await call(local.base, 'GET', '/app/config');
  assert.equal(r.body.features.saveToPhotos, false);

  // null resets a key to the default.
  r = await call(local.base, 'PATCH', '/app/config', { tabs: null, notice: null, features: { saveToPhotos: null } });
  assert.equal(r.body.tabs.length, 6);
  assert.equal(r.body.notice, null);
  assert.equal(r.body.features.saveToPhotos, true);
  r = await call(local.base, 'PATCH', '/app/config', { reset: true });
  assert.equal(r.body.defaults.aspect, '16:9');
});

test('bad patches are rejected', async () => {
  assert.equal((await call(local.base, 'PATCH', '/app/config', { tabs: 'nope' })).status, 400);
});

test('version is public, config and log need a session on a signed-in server', async () => {
  const v = await call(secured.base, 'GET', '/app/version');
  assert.equal(v.status, 200);
  assert.deepEqual(Object.keys(v.body).sort(), ['latestVersion', 'minVersion', 'updateUrl']);
  assert.equal((await call(secured.base, 'GET', '/app/config')).status, 401);
  assert.equal((await call(secured.base, 'PATCH', '/app/config', { notice: { title: 'x' } })).status, 401);
  assert.equal((await call(secured.base, 'POST', '/app/log', { message: 'x' })).status, 401);
  assert.equal((await call(secured.base, 'GET', '/app/log')).status, 401);
});

test('diagnostics: batch append, newest first, filters, ring buffer, clear', async () => {
  const device = { app: '1.0.0', build: '1', device: 'iPhone18,1', os: 'iOS 27.0', platform: 'iOS', install: 'abc' };
  let r = await call(local.base, 'POST', '/app/log', {
    device,
    entries: [
      { level: 'info', kind: 'event', message: 'launch' },
      { level: 'error', kind: 'request', method: 'GET', route: '/productions/x', status: 500, message: 'boom' },
      { level: 'error', kind: 'decode', route: '/catalog', message: 'keyNotFound models', detail: { path: ['models', 3] } },
      { level: 'crash', kind: 'crash', message: 'SIGSEGV', detail: 'stack…' },
      { level: 'bogus', message: 'unknown level becomes error' },
    ],
  });
  assert.deepEqual(r.body, { ok: true, stored: 5 });
  r = await call(local.base, 'GET', '/app/log');
  assert.equal(r.body[0].message, 'unknown level becomes error');
  assert.equal(r.body[0].level, 'error');
  assert.equal(r.body.at(-1).message, 'launch');
  assert.equal(r.body[1].device, 'iPhone18,1');
  assert.equal(r.body[1].app, '1.0.0');
  assert.equal(r.body[2].detail, '{"path":["models",3]}');
  r = await call(local.base, 'GET', '/app/log?level=error&kind=request');
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].status, 500);

  // Ring buffer keeps the newest 2000.
  for (let i = 0; i < 12; i++) await call(local.base, 'POST', '/app/log', { entries: Array.from({ length: 200 }, (_, k) => ({ level: 'info', message: `m${i * 200 + k}` })) });
  r = await call(local.base, 'GET', '/app/log?limit=5000');
  assert.equal(r.body.length, 2000);
  assert.equal(r.body[0].message, 'm2399');

  assert.equal((await call(local.base, 'DELETE', '/app/log')).status, 200);
  assert.equal((await call(local.base, 'GET', '/app/log')).body.length, 0);
});

test('the defaults bundled in the app match the engine defaults', async () => {
  const fs = await import('node:fs');
  const { OUT } = await import('./export-default-config.mjs');
  const { body } = await call(local.base, 'GET', '/app/config');
  const { updatedAt, ...served } = body;
  assert.deepEqual(JSON.parse(fs.readFileSync(OUT, 'utf8')), served, 'run: node apple/scripts/export-default-config.mjs');
});
