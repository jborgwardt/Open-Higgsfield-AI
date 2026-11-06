// Device sign-in (code shown in the app, approved in a browser) end to end against a fake Pocket ID.
// Starts the real engine on a free port with a throwaway data dir. No network beyond 127.0.0.1.
// Run: node --test engine/test/device-signin.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'device-'));
const EMAIL = 'owner@example.test';
let engine, idp, ENGINE, ISSUER;
let identity = { email: EMAIL, sub: 'owner-sub' }; // who the fake Pocket ID signs in
let authAge = 0; // seconds since the passkey was used (simulates an old Pocket ID session)
const seenPrompts = [];

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;

/** A minimal OIDC provider: discovery, an authorize step that approves at once, and a token endpoint. */
function fakeIdp(port) {
  const codes = new Map();
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    if (u.pathname === '/.well-known/openid-configuration') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` }));
    }
    if (u.pathname === '/authorize') {
      const code = `c${codes.size}${Math.random().toString(36).slice(2)}`;
      seenPrompts.push({ prompt: u.searchParams.get('prompt'), maxAge: u.searchParams.get('max_age') });
      codes.set(code, { nonce: u.searchParams.get('nonce'), client: u.searchParams.get('client_id') });
      res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      let body = ''; for await (const c of req) body += c;
      const c = codes.get(new URLSearchParams(body).get('code'));
      res.setHeader('Content-Type', 'application/json');
      if (!c) { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
      return res.end(JSON.stringify({ id_token: jwt({ iss: ISSUER, aud: c.client, nonce: c.nonce, exp: Date.now() / 1000 + 300, auth_time: Math.floor(Date.now() / 1000) - authAge, ...identity, name: 'Owner', groups: [] }) }));
    }
    res.statusCode = 404; res.end();
  });
}

before(async () => {
  const [ep, ip] = [await freePort(), await freePort()];
  ENGINE = `http://127.0.0.1:${ep}`; ISSUER = `http://127.0.0.1:${ip}`;
  idp = fakeIdp(ip); await new Promise((r) => idp.listen(ip, '127.0.0.1', r));
  const env = { ...process.env, ENGINE_PORT: String(ep), ENGINE_DATA: DATA, ENGINE_DIST: path.join(DATA, 'no-dist'), OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'film-studio', OIDC_ALLOWED_EMAILS: EMAIL, PUBLIC_URL: ENGINE };
  for (const k of Object.keys(env)) if (/_(API_)?KEY$|_TOKEN$/.test(k)) delete env[k];
  engine = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('engine did not start')), 15000);
    engine.stdout.on('data', (d) => { if (String(d).includes('engine →')) { clearTimeout(t); resolve(); } });
    engine.on('exit', (c) => reject(new Error(`engine exited ${c}`)));
  });
});
after(() => { engine?.kill(); idp?.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

const api = (p, body, headers = {}) => fetch(`${ENGINE}/engine/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
const poll = async (deviceCode) => (await api('/auth/device/poll', { deviceCode })).json();

/** A tiny browser: follows redirects by hand and keeps cookies for the engine origin. */
function browser() {
  const jar = new Map();
  const store = (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv, ...attrs] = c.split(';'); const [k, v] = kv.split('=');
      if (/max-age=0/i.test(attrs.join(';')) || !v) jar.delete(k.trim()); else jar.set(k.trim(), v.trim());
    }
  };
  const cookieHeader = (url) => (url.startsWith(ENGINE) && jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {});
  async function go(url, opts = {}) {
    url = url.startsWith('http') ? url : `${ENGINE}${url}`;
    let r = await fetch(url, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), ...cookieHeader(url) } });
    if (url.startsWith(ENGINE)) store(r);
    for (let i = 0; i < 8 && r.status === 302; i++) {
      url = new URL(r.headers.get('location'), url).toString();
      r = await fetch(url, { redirect: 'manual', headers: cookieHeader(url) });
      if (url.startsWith(ENGINE)) store(r);
    }
    return r;
  }
  const post = (fields) => go('/engine/auth/device', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { go, post, jar };
}

/** Open the link, use the passkey, type the code, approve. */
async function approveAs(code, b = browser()) {
  const entry = await b.go('/engine/auth/device');
  const check = await b.post({ action: 'check', code });
  const done = await b.post({ action: 'approve', code });
  return { b, entry, check, done };
}

test('start returns a secret device code, a readable user code and a link without the code', async () => {
  const r = await api('/auth/device', { name: 'iPhone 15 Pro Max' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.ok(d.deviceCode.length >= 40);
  assert.equal(d.verifyUrl, `${ENGINE}/engine/auth/device`);
  assert.equal(d.verifyUrlComplete, undefined, 'no pre-filled link (phishing)');
  assert.equal(d.expiresIn, 600);
  assert.deepEqual(await poll(d.deviceCode), { status: 'pending' });
});

test('full flow: fresh passkey → type code → details → approve → app gets a working session', async () => {
  const d = await (await api('/auth/device', { name: '<b>Sim</b>' })).json();
  const b = browser();
  seenPrompts.length = 0;
  const entry = await b.go('/engine/auth/device?code=' + d.userCode); // a ?code= in a link is ignored
  assert.deepEqual(seenPrompts.at(-1), { prompt: 'login', maxAge: '0' }, 'passkey is forced even with a Pocket ID session');
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get('x-frame-options'), 'DENY');
  assert.match(entry.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(b.jar.has('device_handoff') && !b.jar.has('engine_session'), 'only the scoped handoff cookie, never a session cookie');
  const entryHtml = await entry.text();
  assert.match(entryHtml, /Type the code/);
  assert.ok(!entryHtml.includes(d.userCode), 'code is never pre-filled');
  assert.equal((await poll(d.deviceCode)).status, 'pending');

  const check = await b.post({ action: 'check', code: d.userCode.toLowerCase().replace('-', ' ') });
  const html = await check.text();
  assert.ok(html.includes(d.userCode) && html.includes('&lt;b&gt;Sim&lt;/b&gt;') && !html.includes('<b>Sim</b>'), 'details shown, name escaped');
  assert.match(html, /Requested \d+ seconds ago from/);
  assert.equal((await poll(d.deviceCode)).status, 'pending', 'checking approves nothing');

  const done = await b.post({ action: 'approve', code: d.userCode });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Device signed in/);
  assert.ok(!b.jar.has('device_handoff'), 'handoff cookie cleared');

  const p = await poll(d.deviceCode);
  assert.equal(p.status, 'approved');
  assert.equal((await poll(d.deviceCode)).session, p.session, 'repeated briefly in case the response was lost');
  const me = await fetch(`${ENGINE}/engine/api/settings`, { headers: { Authorization: `Bearer ${p.session}` } });
  assert.equal(me.status, 200);
  assert.equal((await fetch(`${ENGINE}/engine/api/settings`)).status, 401);
});

test('an old Pocket ID session (no fresh passkey) cannot approve a device', async () => {
  const d = await (await api('/auth/device', {})).json();
  authAge = 3600;
  try {
    const b = browser();
    const r = await b.go('/engine/auth/device');
    assert.match(await r.text(), /passkey again/);
    assert.ok(!b.jar.has('device_handoff'));
  } finally { authAge = 0; }
  assert.equal((await poll(d.deviceCode)).status, 'pending');
});

test('a handoff approves once; a used code cannot be approved again', async () => {
  const d = await (await api('/auth/device', {})).json();
  const { b, done } = await approveAs(d.userCode);
  assert.equal(done.status, 200);
  assert.equal((await b.post({ action: 'approve', code: d.userCode })).status, 400, 'handoff used up');
  const second = await approveAs(d.userCode);
  assert.match(await second.check.text(), /valid or has expired/);
});

test('approve without the passkey handoff cookie (forged / cross-site form) is refused', async () => {
  const d = await (await api('/auth/device', {})).json();
  const anon = browser();
  for (const fields of [{ action: 'approve', code: d.userCode }, { action: 'check', code: d.userCode }]) {
    assert.equal((await anon.post(fields)).status, 400);
  }
  const forged = await fetch(`${ENGINE}/engine/auth/device`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'device_handoff=forged' }, body: new URLSearchParams({ action: 'approve', code: d.userCode }) });
  assert.equal(forged.status, 400);
  assert.equal((await poll(d.deviceCode)).status, 'pending');
});

test('a device handoff cannot be used on the native (app) route, and burns there', async () => {
  const b = browser();
  await b.go('/engine/auth/device');
  const h = b.jar.get('device_handoff');
  assert.ok(h);
  const r = await fetch(`${ENGINE}/engine/auth/native?handoff=${encodeURIComponent(h)}&state=a`, { redirect: 'manual' });
  const loc = r.headers.get('location');
  assert.ok(loc.startsWith('filmstudio://auth') && !loc.includes('session='), 'no session leaked into a native redirect');
  const d = await (await api('/auth/device', {})).json();
  await b.post({ action: 'check', code: d.userCode });
  assert.equal((await b.post({ action: 'approve', code: d.userCode })).status, 400, 'the misused handoff is gone');
  assert.equal((await poll(d.deviceCode)).status, 'pending');
});

test('Cancel ends the passkey sign-in without approving anything', async () => {
  const d = await (await api('/auth/device', {})).json();
  const b = browser();
  await b.go('/engine/auth/device');
  assert.match(await (await b.post({ action: 'cancel' })).text(), /Nothing was approved/);
  assert.ok(!b.jar.has('device_handoff'));
  assert.equal((await b.post({ action: 'approve', code: d.userCode })).status, 400);
  assert.equal((await poll(d.deviceCode)).status, 'pending');
});

test('someone not on the allowlist cannot approve', async () => {
  const d = await (await api('/auth/device', {})).json();
  identity = { email: 'stranger@example.test', sub: 'x' };
  try {
    const b = browser();
    const r = await b.go('/engine/auth/device');
    assert.match(await r.text(), /not allowed/);
    assert.ok(!b.jar.has('device_handoff'));
  } finally { identity = { email: EMAIL, sub: 'owner-sub' }; }
  assert.equal((await poll(d.deviceCode)).status, 'pending');
});

test('bad input: unknown codes and junk device codes', async () => {
  const b = browser();
  await b.go('/engine/auth/device');
  assert.match(await (await b.post({ action: 'check', code: 'ZZZZ-ZZZZ' })).text(), /valid or has expired/);
  assert.match(await (await b.post({ action: 'check', code: '<script>' })).text(), /valid or has expired/);
  for (const deviceCode of [undefined, '', 'nope', 'x'.repeat(500), 42, { a: 1 }]) assert.equal((await poll(deviceCode)).status, 'expired');
  assert.equal((await fetch(`${ENGINE}/engine/api/settings`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
});

test('flooding codes cannot lock others out; per-address limits use the proxy-added hop', async () => {
  // Same real client, forged leftmost hops: still one client → rate-limited.
  let last;
  for (let i = 0; i < 12; i++) last = await api('/auth/device', {}, { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` });
  assert.equal(last.status, 429);
  // Another client can still start (and a requester only holds its 3 newest codes).
  const other = await api('/auth/device', {}, { 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(other.status, 200);
});
