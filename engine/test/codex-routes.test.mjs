// HTTP authorization and transport boundaries for ChatGPT account connections.
// Run on the VPS: node --test engine/test/codex-routes.test.mjs
// Every engine gets a temporary data/home directory and no real provider access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = new URL('../server.js', import.meta.url).href;
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MAINTENANCE_TOKEN = 'synthetic-studio-maintenance-token';
const OWNER_SESSION = 'synthetic-pocket-id-owner-session';
const TOKEN_MARKERS = ['synthetic-access-secret', 'synthetic-refresh-secret', 'synthetic-id-secret'];
const ROUTES = [
  ['GET', '/codex/login'],
  ['POST', '/codex/login'],
  ['POST', '/codex/login/complete'],
  ['POST', '/codex/login/cancel'],
  ['POST', '/codex/logout'],
  ['GET', '/codex/models'],
];

async function unusedPort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function engineFor(t, { oidc = false, open = false, allowlist = false, statusProbes = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmstudio-codex-http-'));
  let child;
  let closed;
  let output = '';
  let spawnError;
  let providerFetchAttempted = false;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1500);
      force.unref();
      await closed;
      clearTimeout(force);
    }
    await fs.rm(dir, { recursive: true, force: true });
    // /status pings the other providers (all stubbed to fail here); only that test may trigger them.
    if (!statusProbes) assert.equal(providerFetchAttempted, false, 'Connection boundary checks must never call a provider');
  });

  if (oidc) {
    const now = Date.now();
    // allowlist: the live setup (OIDC_ALLOWED_EMAILS with one address) has no owner.json until first use.
    if (!allowlist) await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ sub: 'test-owner', email: 'owner@example.invalid' }), { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'sessions.json'), JSON.stringify({
      [crypto.createHash('sha256').update(OWNER_SESSION).digest('hex')]: {
        sub: 'test-owner', email: 'owner@example.invalid', name: 'Test Owner',
        created: now, expires: now + 60_000,
      },
    }), { mode: 0o600 });
  }

  const port = await unusedPort();
  // Deliberately do not spread process.env: neither a provider key, NODE_OPTIONS,
  // proxy configuration, nor a real home/credential directory may leak in.
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: dir, TMPDIR: dir,
    ENGINE_DATA: dir, ENGINE_DIST: path.join(dir, 'no-web-build'),
    ENGINE_HOST: '127.0.0.1', ENGINE_PORT: String(port), ...(open ? {} : { ENGINE_REQUIRE_AUTH: '1' }),
    ENGINE_TOKEN: MAINTENANCE_TOKEN, CLAUDE_CLI: path.join(dir, 'no-claude'),
    ...(oidc ? {
      OIDC_ISSUER: 'https://pocket-id.example.invalid', OIDC_CLIENT_ID: 'synthetic-filmstudio',
      ...(allowlist ? { OIDC_ALLOWED_EMAILS: 'owner@example.invalid' } : {}),
    } : {}),
  };
  const bootstrap = `
    globalThis.fetch = async () => {
      process.stderr.write('FORBIDDEN_PROVIDER_FETCH\\n');
      throw new Error('Provider requests are disabled in route integration tests');
    };
    await import(${JSON.stringify(SERVER)});
  `;
  child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve) => child.once('close', resolve));
  child.on('error', (error) => { spawnError = error; });
  const capture = (chunk) => {
    const text = String(chunk);
    if (text.includes('FORBIDDEN_PROVIDER_FETCH')) providerFetchAttempted = true;
    output = (output + text).slice(-24_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const base = `http://127.0.0.1:${port}/engine/api`;

  async function request(method, route, { token = MAINTENANCE_TOKEN, body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method, redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.match(response.headers.get('content-type') || '', /application\/json/, `${method} ${route}: ${text}`);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Engine exited during startup:\n${output}`);
    try {
      const health = await request('GET', '/health', { token: null });
      if (health.status === 200 && health.body.ok) return { request, logs: () => output };
    } catch { /* Allow the child to bind its socket before the next attempt. */ }
    await delay(40);
  }
  throw new Error(`Engine did not become ready:\n${output}`);
}

function assertSanitized(value) {
  const encoded = JSON.stringify(value);
  for (const marker of TOKEN_MARKERS) assert.ok(!encoded.includes(marker), 'A credential was echoed to the client');
  const forbiddenKeys = /^(access_?token|refresh_?token|id_?token|client_?secret|credentials|password)$/i;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.ok(!forbiddenKeys.test(key), `Public response contains credential field ${key}`);
      walk(child);
    }
  }
  walk(value);
}

function assertSignedOut(response) {
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.installed, true);
  assert.equal(response.body.state, 'signed_out');
  assert.equal(response.body.loggedIn, false);
  assert.equal(response.body.available, false);
  assert.equal(response.body.loginMethod, 'mac_local_oauth');
  assertSanitized(response.body);
}

test('all six ChatGPT routes reject missing or incorrect studio authentication without changing an attempt', async (t) => {
  const engine = await engineFor(t);
  const begin = await engine.request('POST', '/codex/login', { body: {} });
  assert.equal(begin.status, 200, begin.text);
  for (const token of [null, 'incorrect-test-token']) {
    for (const [method, route] of ROUTES) {
      const response = await engine.request(method, route, {
        token, ...(method === 'POST' ? { body: { connectionId: begin.body.connectionId } } : {}),
      });
      assert.equal(response.status, 401, `${method} ${route}: ${response.text}`);
      assert.equal(response.body.auth, true);
      assertSanitized(response.body);
    }
  }
  const status = await engine.request('GET', '/codex/login');
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'pending', 'Unauthorized cancel/logout must leave the owner attempt intact');
});

test('authorized begin, status, cancel and disconnect preserve director choice and reveal no credentials', async (t) => {
  const engine = await engineFor(t);
  assertSignedOut(await engine.request('GET', '/codex/login'));
  const before = await engine.request('GET', '/settings');
  const startedAt = Date.now();
  const begin = await engine.request('POST', '/codex/login', { body: {} });
  assert.equal(begin.status, 200, begin.text);
  assert.equal(typeof begin.body.connectionId, 'string');
  assert.ok(begin.body.connectionId.length >= 16);
  assert.equal(typeof begin.body.nonce, 'string');
  assert.ok(begin.body.nonce.length >= 16);
  const expiry = Date.parse(begin.body.expiresAt);
  assert.ok(expiry > startedAt && expiry <= Date.now() + 10 * 60_000 + 1000, 'Connection must have a bounded ISO expiry');
  assert.ok(begin.body.clientId == null || typeof begin.body.clientId === 'string');
  assertSanitized(begin.body);

  const pending = await engine.request('GET', '/codex/login');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.state, 'pending');
  assert.equal(pending.body.loggedIn, false);
  assert.equal(pending.body.available, false);
  assert.ok(!pending.text.includes(begin.body.nonce), 'Status must not expose the private login nonce');
  assertSanitized(pending.body);

  assertSignedOut(await engine.request('POST', '/codex/login/cancel', { body: { connectionId: begin.body.connectionId } }));
  assertSignedOut(await engine.request('GET', '/codex/login'));
  const next = await engine.request('POST', '/codex/login', { body: {} });
  assert.equal(next.status, 200, next.text);
  assert.notEqual(next.body.connectionId, begin.body.connectionId);
  assert.notEqual(next.body.nonce, begin.body.nonce);
  assertSignedOut(await engine.request('POST', '/codex/logout', { body: {} }));
  const after = await engine.request('GET', '/settings');
  assert.equal(after.body.directorProvider, before.body.directorProvider);
  assert.equal(after.body.directorModel, before.body.directorModel);
});

test('credential completion over an unencrypted forwarded request fails before consuming the attempt', async (t) => {
  const engine = await engineFor(t);
  const begin = await engine.request('POST', '/codex/login', { body: {} });
  assert.equal(begin.status, 200, begin.text);
  const response = await engine.request('POST', '/codex/login/complete', {
    headers: { 'X-Forwarded-For': '198.51.100.24', 'X-Forwarded-Proto': 'http' },
    body: {
      connectionId: begin.body.connectionId, clientId: 'synthetic-client',
      accessToken: TOKEN_MARKERS[0], refreshToken: TOKEN_MARKERS[1], idToken: TOKEN_MARKERS[2],
      scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct', tokenType: 'Bearer', expiresIn: 3600,
    },
  });
  assert.equal(response.status, 400, response.text);
  assert.match(response.body.error, /HTTPS/i);
  assertSanitized(response.body);
  const pending = await engine.request('GET', '/codex/login');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.state, 'pending');
  assertSanitized(pending.body);
  for (const marker of TOKEN_MARKERS) assert.ok(!engine.logs().includes(marker), 'The server logged a credential');
});

test('Pocket ID maintenance access cannot read or mutate a ChatGPT account without an owner session', async (t) => {
  const engine = await engineFor(t, { oidc: true });
  const health = await engine.request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.mode, 'oidc');
  assert.equal(health.body.authed, true, 'The token must be valid for ordinary loopback maintenance');

  const begin = await engine.request('POST', '/codex/login', { token: OWNER_SESSION, body: {} });
  assert.equal(begin.status, 200, begin.text);
  for (const [method, route] of ROUTES) {
    const response = await engine.request(method, route, {
      ...(method === 'POST' ? { body: { connectionId: begin.body.connectionId } } : {}),
    });
    assert.equal(response.status, 401, `${method} ${route}: ${response.text}`);
    assert.match(response.body.error, /Sign in to Film Studio/i);
    assertSanitized(response.body);
  }
  const pending = await engine.request('GET', '/codex/login', { token: OWNER_SESSION });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.state, 'pending');
  assertSanitized(pending.body);
  assertSignedOut(await engine.request('POST', '/codex/login/cancel', {
    token: OWNER_SESSION, body: { connectionId: begin.body.connectionId },
  }));
});

test('an open local engine still requires an explicit studio token for ChatGPT account routes', async (t) => {
  const engine = await engineFor(t, { open: true });
  const health = await engine.request('GET', '/health', { token: null });
  assert.equal(health.body.authed, true, 'the rest of a local engine is open on this machine');
  for (const [method, route] of ROUTES) {
    const response = await engine.request(method, route, { token: null, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(response.status, 401, `${method} ${route}: ${response.text}`);
    assertSanitized(response.body);
  }
  const begin = await engine.request('POST', '/codex/login', { body: {} }); // with the access code: allowed
  assert.equal(begin.status, 200, begin.text);
});

test('single-email allowlist: the signed-in owner can connect, and status never breaks before that', async (t) => {
  const engine = await engineFor(t, { oidc: true, allowlist: true, statusProbes: true });
  const status = await engine.request('GET', '/status', { token: OWNER_SESSION });
  assert.equal(status.status, 200, status.text);
  assert.equal(status.body.chatgpt.loggedIn, false);
  assertSanitized(status.body.chatgpt);
  const begin = await engine.request('POST', '/codex/login', { token: OWNER_SESSION, body: {} });
  assert.equal(begin.status, 200, begin.text);
  assert.equal((await engine.request('GET', '/codex/login', { token: OWNER_SESSION })).body.state, 'pending');
  // Maintenance access (the access code) is still not the owner.
  assert.equal((await engine.request('GET', '/codex/login')).status, 401);
});
