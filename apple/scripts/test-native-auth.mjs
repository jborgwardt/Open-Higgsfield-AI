// End-to-end test of the engine's native (Film Studio app) sign-in against a fake OIDC provider.
//   node --test apple/scripts/test-native-auth.mjs
// Starts a throwaway engine (harness.mjs: temp data dir, no provider keys) with OIDC pointed at the fake provider,
// then walks the redirects the way ASWebAuthenticationSession would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from './harness.mjs';
import { startFakeOidc } from './fake-oidc.mjs';

const PORT = 4900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let idp;
let engine;

const get = (url, headers = {}) => fetch(url.startsWith('http') ? url : `${BASE}${url}`, { redirect: 'manual', headers });
const loc = (res) => res.headers.get('location');

/** Follow the browser part of the flow from `start` until the engine redirects to a non-http URL. */
async function walk(start) {
  let url = start;
  const cookies = [];
  for (let i = 0; i < 8; i++) {
    const res = await get(url);
    cookies.push(...(res.headers.getSetCookie?.() || []));
    assert.equal(res.status, 302, `expected a redirect from ${url}, got ${res.status}`);
    const next = loc(res);
    if (!/^https?:|^\//.test(next)) return { final: next, cookies, last: url };
    url = next.startsWith('/') ? `${BASE}${next}` : next;
  }
  throw new Error('too many redirects');
}

before(async () => {
  idp = await startFakeOidc();
  engine = await startEngine({ port: PORT, env: { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'filmstudio-test', PUBLIC_URL: BASE, OIDC_ALLOWED_EMAILS: 'justin@example.com' } });
});

after(async () => {
  engine?.stop();
  await idp?.close();
});

test('native sign-in ends at filmstudio://auth with a session and the app state', async () => {
  const { final, cookies } = await walk(`${BASE}/engine/auth/native?state=abc-123_XYZ`);
  const u = new URL(final);
  assert.equal(u.protocol, 'filmstudio:');
  assert.equal(u.host, 'auth');
  assert.equal(u.searchParams.get('state'), 'abc-123_XYZ');
  assert.ok(u.searchParams.get('session')?.length >= 40);
  assert.equal(u.searchParams.get('error'), null);
  assert.ok(!cookies.some((c) => c.startsWith('engine_session=') && !/Max-Age=0/.test(c)), 'native sign-in must not leave a browser session cookie');
});

test('the documented entry /engine/auth/login?next=/engine/auth/native works too', async () => {
  const { final } = await walk(`${BASE}/engine/auth/login?next=${encodeURIComponent('/engine/auth/native')}`);
  assert.match(final, /^filmstudio:\/\/auth\?session=[\w-]+$/);
});

test('the session works as a Bearer token for the API and media, and only as that', async () => {
  const { final } = await walk(`${BASE}/engine/auth/native?state=s1`);
  const session = new URL(final).searchParams.get('session');
  const auth = { Authorization: `Bearer ${session}` };

  assert.equal((await get('/engine/api/media')).status, 401, 'no token → 401');
  assert.equal((await get('/engine/api/media', { Authorization: 'Bearer nope' })).status, 401, 'bogus token → 401');
  const ok = await get('/engine/api/media', auth);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), []);

  const health = await (await get('/engine/api/health', auth)).json();
  assert.equal(health.authed, true);
  assert.equal(health.mode, 'oidc');
  assert.equal(health.user.email, 'justin@example.com');

  // Upload + fetch the file through /engine/media with the same token.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = await fetch(`${BASE}/engine/api/upload?name=dot.png`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 200);
  const asset = await up.json();
  assert.equal((await get(asset.url)).status, 401);
  assert.equal((await get(asset.url, auth)).status, 200);
});

test('a handoff code is single-use', async () => {
  const { last } = await walk(`${BASE}/engine/auth/native?state=once`);
  assert.match(last, /handoff=/);
  const again = await get(last);
  const u = new URL(loc(again));
  assert.equal(u.protocol, 'filmstudio:');
  assert.equal(u.searchParams.get('session'), null);
  assert.match(u.searchParams.get('error'), /expired/);
  assert.equal(u.searchParams.get('state'), 'once');
});

test('a forged handoff never yields a session', async () => {
  const u = new URL(loc(await get('/engine/auth/native?handoff=forged&state=x')));
  assert.equal(u.searchParams.get('session'), null);
  assert.ok(u.searchParams.get('error'));
});

test('the allowlist still applies to app sign-in and the error goes back to the app', async () => {
  idp.state.user = { sub: 'u-other', email: 'mallory@example.com', name: 'Mallory' };
  try {
    const { final } = await walk(`${BASE}/engine/auth/native?state=deny1`);
    const u = new URL(final);
    assert.equal(u.protocol, 'filmstudio:');
    assert.equal(u.searchParams.get('session'), null);
    assert.match(u.searchParams.get('error'), /not allowed/);
    assert.equal(u.searchParams.get('state'), 'deny1');
  } finally {
    idp.state.user = { sub: 'u-justin', email: 'justin@example.com', name: 'Justin' };
  }
});

test('unsafe state values are dropped, never reflected', async () => {
  const { final } = await walk(`${BASE}/engine/auth/native?state=${encodeURIComponent('"><script>')}`);
  const u = new URL(final);
  assert.equal(u.searchParams.get('state'), null);
  assert.ok(u.searchParams.get('session'));
});

test('signing out with the Bearer token ends that session', async () => {
  const { final } = await walk(`${BASE}/engine/auth/native`);
  const auth = { Authorization: `Bearer ${new URL(final).searchParams.get('session')}` };
  assert.equal((await get('/engine/api/status', auth)).status, 200);
  const out = await fetch(`${BASE}/engine/api/logout`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(out.status, 200);
  assert.equal((await get('/engine/api/status', auth)).status, 401);
});

test('the browser flow is unchanged: cookie session, same-site next only', async () => {
  let url = loc(await get(`/engine/auth/login?next=${encodeURIComponent('/library')}`));
  url = loc(await get(url));
  const cb = await get(url);
  assert.equal(loc(cb), '/library');
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('engine_session='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=2592000/, 'same 30-day lifetime');

  for (const evil of ['//evil.example/x', '/\\evil.example', 'https://evil.example']) {
    let u = loc(await get(`/engine/auth/login?next=${encodeURIComponent(evil)}`));
    u = loc(await get(u));
    assert.equal(loc(await get(u)), '/', `next=${evil} must not redirect off-site`);
  }
});
