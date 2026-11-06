// Run on the VPS in an isolated test container. All network calls and OAuth
// credentials are synthetic; no ChatGPT account or paid generation is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const importData = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-import-'));
process.env.ENGINE_DATA = importData;
const { createChatGPTProvider, readResponseStream } = await import('../lib/providers/chatgpt.js');
test.after(() => fs.rm(importData, { recursive: true, force: true }));

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', alg: 'RS256', use: 'sig' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signed(claims, header = {}) {
  const input = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode(claims)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (...events) => new Response(events.map(event).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const done = { type: 'response.completed', response: { status: 'completed' } };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-provider-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = 1800000000000;
  const calls = [], state = { refreshes: 0, revocations: 0, catalog: null, response: null, refreshError: null, revokeError: null };
  function claims(extra = {}) { return { iss: ISSUER, sub: 'account-one', iat: Math.floor(time / 1000), nbf: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 3600, ...extra }; }
  function credentials(attempt, extra = {}) {
    const clientId = extra.clientId || 'oaiapp_test_registration';
    return {
      connectionId: attempt.connectionId, clientId,
      idToken: signed(claims({ aud: clientId, email: 'director@example.test', nonce: attempt.nonce, ...extra.idClaims })),
      accessToken: signed(claims({ aud: RESOURCE, client_id: clientId, scope: SCOPE, ...extra.accessClaims })),
      refreshToken: 'synthetic-refresh-one', tokenType: 'Bearer', scope: SCOPE, expiresIn: 3600,
      ...extra.payload,
    };
  }
  async function fetcher(url, options = {}) {
    assert.equal(options.redirect, 'error', 'Credential requests must not follow redirects');
    calls.push({ url, options });
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` });
    if (url === `${ISSUER}/.well-known/jwks.json`) { if (state.jwksDown) throw new TypeError('network down'); return json({ keys: [jwk] }); }
    if (url === `${RESOURCE}/models`) {
      assert.match(options.headers.Authorization, /^Bearer /);
      if (state.catalog) return state.catalog(url, options);
      return json({ models: [{ slug: 'model-b', display_name: 'B first', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'model-a', display_name: 'A second', visibility: 'list' }, { slug: 'model-b', display_name: 'Duplicate', visibility: 'list' }] });
    }
    if (url === `${ISSUER}/api/accounts/oauth/token`) {
      state.refreshes++;
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('client_id'), 'oaiapp_test_registration');
      assert.equal(options.body.get('resource'), RESOURCE);
      assert.equal(options.body.has('scope'), false);
      if (state.tokenGate) { state.tokenSignal = options.signal; await state.tokenGate; }
      if (state.refreshError) return json({ error: state.refreshError, error_description: 'SECRET-UPSTREAM-REFLECTION' }, 400);
      if (state.badJwks) state.jwksDown = true;
      return json({ access_token: signed(claims({ aud: RESOURCE, client_id: 'oaiapp_test_registration', scope: SCOPE }), state.newKid ? { kid: 'rotated-key' } : {}), refresh_token: `synthetic-refresh-rotated-${state.refreshes}`, token_type: 'Bearer', scope: SCOPE, ...(state.noExpiresIn ? {} : { expires_in: 3600 }) });
    }
    if (url === `${ISSUER}/api/accounts/oauth/revoke`) {
      state.revocations++;
      assert.equal(options.body.get('token_type_hint'), 'refresh_token');
      assert.equal(options.body.get('client_id'), 'oaiapp_test_registration');
      return new Response('', { status: state.revokeError || 200 });
    }
    if (url === `${RESOURCE}/responses`) return state.response ? state.response(url, options) : sse({ type: 'response.output_text.delta', delta: '{"shots":[]}' }, done);
    assert.fail(`Unexpected endpoint: ${url}`);
  }
  const options = { dataDir: dir, studioOwner: 'studio-owner', now: () => time, fetch: fetcher };
  const provider = createChatGPTProvider(options);
  async function connect(extra) { const attempt = await provider.beginConnection('studio-owner'); await provider.completeConnection('studio-owner', credentials(attempt, extra)); return attempt; }
  const saved = async () => JSON.parse(await fs.readFile(path.join(dir, 'chatgpt', 'connection.json'), 'utf8'));
  return { dir, provider, options, state, calls, claims, credentials, connect, saved, advance: (ms) => { time += ms; } };
}

test('pending connection is owner bound, cancellable, expiring, and secret-free', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.provider.chatgptStatus('studio-owner')).state, 'signed_out');
  await assert.rejects(f.provider.beginConnection('another-owner'), /Only the Film Studio owner/);
  const attempt = await f.provider.beginConnection('studio-owner');
  assert.ok(Date.parse(attempt.expiresAt));
  assert.equal(attempt.clientId, undefined);
  const status = await f.provider.chatgptStatus('studio-owner');
  assert.equal(status.state, 'pending');
  assert.equal(status.loginMethod, 'mac_local_oauth');
  assert.equal(JSON.stringify(status).includes(attempt.nonce), false);
  await f.provider.cancelConnection('studio-owner', 'unrelated');
  assert.equal((await f.provider.chatgptStatus('studio-owner')).state, 'pending');
  await f.provider.cancelConnection('studio-owner', attempt.connectionId);
  await assert.rejects(f.provider.completeConnection('studio-owner', f.credentials(attempt)), /cancelled/);
  const expired = await f.provider.beginConnection('studio-owner');
  f.advance(600001);
  await assert.rejects(f.provider.completeConnection('studio-owner', f.credentials(expired)), /expired/);
  assert.equal(f.calls.length, 0);
});

test('connection validates signed identity and live models before preserving private credentials', async (t) => {
  const f = await fixture(t);
  const attempt = await f.provider.beginConnection('studio-owner');
  const before = await f.saved();
  const credentials = f.credentials(attempt);
  const status = await f.provider.completeConnection('studio-owner', credentials);
  assert.equal(status.available, true);
  assert.deepEqual(status.account, { email: 'director@example.test', plan: null });
  for (const secret of [credentials.accessToken, credentials.refreshToken, credentials.idToken, attempt.nonce]) assert.equal(JSON.stringify(status).includes(secret), false);
  const saved = await f.saved();
  assert.equal(saved.hostId, before.hostId, 'Imported credentials must preserve VM host identity');
  assert.notEqual(saved.ownerHash, 'studio-owner');
  assert.equal((await fs.stat(path.join(f.dir, 'chatgpt'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.dir, 'chatgpt', 'connection.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await f.provider.chatgptModels({ owner: 'studio-owner' }), [{ id: 'model-b', label: 'B first' }, { id: 'model-a', label: 'A second' }]);
  await assert.rejects(f.provider.chatgptModels({ owner: 'another-owner' }), /Only the Film Studio owner/);
  const changedOwner = createChatGPTProvider({ ...f.options, studioOwner: 'replacement-owner' });
  assert.equal((await changedOwner.chatgptStatus()).available, false);
  await assert.rejects(changedOwner.beginConnection('replacement-owner'), /different studio owner/);
});

test('invalid OAuth token combinations cannot establish a connection', async (t) => {
  const cases = [
    ['nonce', { idClaims: { nonce: 'wrong' } }],
    ['issuer', { idClaims: { iss: 'https://attacker.invalid' } }],
    ['ID audience', { idClaims: { aud: 'other-client' } }],
    ['access audience', { accessClaims: { aud: 'other-resource' } }],
    ['access client', { accessClaims: { client_id: 'other-client' } }],
    ['subject', { accessClaims: { sub: 'another-account' } }],
    ['expired', { idClaims: { exp: 100 } }],
    ['future', { idClaims: { nbf: 9999999999 } }],
    ['response scope', { payload: { scope: 'openid email' } }],
    ['access scope', { accessClaims: { scope: 'openid email' } }],
    ['entrypoint client', { clientId: 'dynamic_agent_client' }],
    ['missing refresh', { payload: { refreshToken: '' } }],
    ['non-bearer', { payload: { tokenType: 'Basic' } }],
    ['bad signature', { payload: { idToken: `${encode({ alg: 'none', kid: jwk.kid })}.${encode({})}.invalid` } }],
  ];
  for (const [name, invalid] of cases) await t.test(name, async (t) => {
    const f = await fixture(t);
    const attempt = await f.provider.beginConnection('studio-owner');
    await assert.rejects(f.provider.completeConnection('studio-owner', f.credentials(attempt, invalid)));
    assert.equal((await f.provider.chatgptStatus('studio-owner')).loggedIn, false);
    assert.equal((await f.saved()).credentials, undefined);
  });
});

test('cancelling a sign-in while admission is pending prevents late credential installation', async (t) => {
  const f = await fixture(t);
  let admissionStarted, releaseAdmission;
  const started = new Promise((resolve) => { admissionStarted = resolve; });
  const released = new Promise((resolve) => { releaseAdmission = resolve; });
  f.state.catalog = async () => { admissionStarted(); await released; return json({ models: [{ slug: 'model-b', visibility: 'list' }] }); };
  const attempt = await f.provider.beginConnection('studio-owner');
  const completion = f.provider.completeConnection('studio-owner', f.credentials(attempt));
  const rejected = assert.rejects(completion, /cancelled/);
  await started;
  await f.provider.cancelConnection('studio-owner', attempt.connectionId);
  releaseAdmission();
  await rejected;
  assert.equal((await f.provider.chatgptStatus('studio-owner')).loggedIn, false);
});

test('reauthorization reuses registration and rejects an account switch without destroying the active session', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const before = await f.saved();
  const attempt = await f.provider.beginConnection('studio-owner');
  assert.equal(attempt.clientId, 'oaiapp_test_registration');
  await assert.rejects(f.provider.completeConnection('studio-owner', f.credentials(attempt, { idClaims: { sub: 'another-account' } })), /does not match/);
  assert.equal((await f.provider.chatgptStatus('studio-owner')).loggedIn, true);
  assert.equal((await f.saved()).credentials.refreshToken, before.credentials.refreshToken);
});

test('concurrent provider instances serialize a rotating refresh and preserve the VM identity', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const before = await f.saved();
  f.advance(3550000);
  const second = createChatGPTProvider(f.options);
  await Promise.all([f.provider.chatgptModels({ fresh: true }), second.chatgptModels({ fresh: true }), f.provider.chatgptModels({ fresh: true })]);
  assert.equal(f.state.refreshes, 1);
  const after = await f.saved();
  assert.equal(after.credentials.refreshToken, 'synthetic-refresh-rotated-1');
  assert.equal(after.hostId, before.hostId);
});

test('revoked refresh grant requires sign-in and never falls back to API billing', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.advance(3550000);
  f.state.refreshError = 'invalid_grant';
  await assert.rejects(f.provider.chatgptModels({ fresh: true }), (error) => /Connect again/.test(error.message) && !error.message.includes('SECRET-UPSTREAM-REFLECTION'));
  assert.equal((await f.provider.chatgptStatus('studio-owner')).loggedIn, false);
  await assert.rejects(f.provider.chatgptChat({ model: 'model-b', messages: [{ role: 'user', content: 'Write.' }] }), /Connect ChatGPT/);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/responses')).length, 0);
});

test('director uses only the account catalog and public streaming Responses endpoint', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const messages = [{ role: 'system', content: 'Write JSON.' }, { role: 'user', content: 'Plan one shot.' }];
  assert.equal(await f.provider.chatgptChat({ messages }), '{"shots":[]}');
  const call = f.calls.find((call) => call.url === `${RESOURCE}/responses`);
  assert.deepEqual(JSON.parse(call.options.body), { model: 'model-b', input: messages, store: false, stream: true });
  // An id the account doesn't offer falls back to its first model (see the stale-model test) rather than failing.
  await f.provider.chatgptChat({ model: 'not-in-catalog', messages });
  await assert.rejects(f.provider.chatgptChat({ messages: [{ role: 'user', content: [{ type: 'image_url', url: 'secret' }] }] }), /text messages only/);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/responses')).length, 2, 'the image message never reached OpenAI');
});

test('stream handling requires completion and rejects late quota errors, truncation, and incomplete output', async () => {
  await assert.rejects(readResponseStream(sse({ type: 'response.output_text.delta', delta: 'partial' })), /interrupted/);
  await assert.rejects(readResponseStream(sse({ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'SECRET' } } })), (error) => error.quota && /usage limit/.test(error.message) && !error.message.includes('SECRET'));
  await assert.rejects(readResponseStream(sse({ type: 'response.incomplete' })), /before completing/);
  assert.equal(await readResponseStream(sse({ type: 'response.output_text.delta', delta: 'draft' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'final' }] }] } })), 'final');
  const encoded = new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'héllo' }) + event(done));
  const chunked = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.equal(await readResponseStream(new Response(chunked)), 'héllo');
});

test('disconnect aborts active inference, clears all tokens, and preserves registration for reauthorization', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const before = await f.saved();
  let started;
  const streaming = new Promise((resolve) => { started = resolve; });
  f.state.response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'partial' }))); started(); } }));
  const call = f.provider.chatgptChat({ model: 'model-b', messages: [{ role: 'user', content: 'Write.' }] });
  const rejected = assert.rejects(call, /cancelled/);
  await streaming;
  const status = await f.provider.disconnect('studio-owner');
  await rejected;
  assert.equal(status.loggedIn, false);
  assert.equal(f.state.revocations, 1);
  const after = await f.saved();
  assert.equal(after.credentials, null);
  assert.equal(after.hostId, before.hostId);
  assert.deepEqual(after.registration, before.registration);
  // With no live session the next sign-in registers fresh (so a different ChatGPT account can be chosen).
  assert.equal((await f.provider.beginConnection('studio-owner')).clientId, undefined);
});

test('failed remote revocation is reported accurately after local token removal', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.state.revokeError = 503;
  const status = await f.provider.disconnect('studio-owner');
  assert.equal(status.loggedIn, false);
  assert.match(status.error, /Remote revocation was not confirmed/);
  assert.equal(f.state.revocations, 2);
  assert.equal((await f.saved()).credentials, null);
});

test('a caller cancelling mid-refresh never loses the rotated tokens', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.advance(3550000); // access token near expiry → the next use refreshes (and rotates the refresh token)
  let release;
  f.state.tokenGate = new Promise((resolve) => { release = resolve; });
  const caller = new AbortController();
  const pending = f.provider.chatgptModels({ fresh: true, signal: caller.signal });
  while (!f.state.tokenSignal) await new Promise((r) => setTimeout(r, 5));
  caller.abort(); // the request that started the refresh goes away while OpenAI is answering
  assert.equal(f.state.tokenSignal.aborted, false, 'the refresh request itself is not aborted by the caller');
  release();
  await assert.rejects(pending, /cancelled/i);
  const saved = await f.saved();
  assert.equal(saved.credentials.refreshToken, 'synthetic-refresh-rotated-1', 'the rotated refresh token was stored');
  f.state.tokenGate = null;
  await f.provider.chatgptModels({ fresh: true }); // next use works with the stored session, no second refresh
  assert.equal(f.state.refreshes, 1);
});

test('a lock left by a crashed engine (same PID after a container restart) is recovered', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const lock = path.join(f.dir, 'chatgpt', 'connection.lock');
  // Same host and PID as this process (Docker restarts reuse PID 1) but an earlier boot: the holder is gone.
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), boot: 'previous-boot', nonce: 'stale', at: Date.now() }));
  const started = Date.now();
  assert.equal((await f.provider.chatgptStatus('studio-owner')).loggedIn, true);
  await f.provider.cancelConnection('studio-owner', 'nothing-pending'); // a locked operation
  assert.ok(Date.now() - started < 5000, 'recovered without waiting for the busy timeout');
  // A lock from a different host (an old container) is only recovered once it is far older than any refresh.
  await fs.writeFile(lock, JSON.stringify({ pid: 1, host: 'old-container', boot: 'x', nonce: 'stale2', at: Date.now() - 10 * 60 * 1000 }));
  await f.provider.cancelConnection('studio-owner', 'nothing-pending');
  await assert.rejects(fs.access(lock));
});

test('identifier comparison is byte-safe (other lengths, multibyte text, non-strings)', async (t) => {
  const f = await fixture(t);
  await f.provider.beginConnection('studio-owner');
  for (const connectionId of ['é', 'x'.repeat(5000), '🎬🎬', 42, null]) {
    await assert.rejects(f.provider.completeConnection('studio-owner', { connectionId }), (e) => e.status === 409 || /expired or was cancelled/.test(e.message));
  }
  await assert.rejects(f.provider.chatgptStatus('ówner'), (e) => e.status === 403);
});

test('a rotated refresh token is saved even if checking the new tokens fails (key fetch down)', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.advance(3550000);
  f.state.newKid = true; f.state.badJwks = true; // new signing key + JWKS unreachable right after rotation
  await assert.rejects(f.provider.chatgptModels({ fresh: true }), (e) => e.status === 503);
  const saved = await f.saved();
  assert.equal(saved.credentials.refreshToken, 'synthetic-refresh-rotated-1', 'the new refresh token survived');
  assert.equal(saved.credentials.accessToken, null);
  f.state.newKid = false; f.state.badJwks = false; f.state.jwksDown = false;
  await f.provider.chatgptModels({ fresh: true }); // recovers with the stored rotated token
  assert.equal((await f.saved()).credentials.refreshToken, 'synthetic-refresh-rotated-2');
});

test('a refresh reply without expires_in uses the access token expiry', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.advance(3550000);
  f.state.noExpiresIn = true;
  await f.provider.chatgptModels({ fresh: true });
  const saved = await f.saved();
  assert.equal(saved.credentials.refreshToken, 'synthetic-refresh-rotated-1');
  assert.ok(saved.credentials.expiresAt > 0 && saved.credentials.accessToken);
});

test('a dead client registration is forgotten so the next sign-in registers fresh', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.advance(3550000);
  f.state.refreshError = 'invalid_client';
  await assert.rejects(f.provider.chatgptModels({ fresh: true }), /Connect again/);
  const saved = await f.saved();
  assert.equal(saved.credentials, null);
  assert.equal(saved.registration, null);
  assert.equal((await f.provider.beginConnection('studio-owner')).clientId, undefined);
});

test('other unusable refresh-token codes sign out instead of retrying a dead token', async (t) => {
  for (const code of ['refresh_token_expired', 'refresh_token_reused', 'invalid_refresh_token']) {
    const f = await fixture(t);
    await f.connect();
    f.advance(3550000);
    f.state.refreshError = code;
    await assert.rejects(f.provider.chatgptModels({ fresh: true }), /Connect again/);
    assert.equal((await f.provider.chatgptStatus('studio-owner')).loggedIn, false, code);
  }
});

test('a stale or foreign model id falls back to the account model instead of failing', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const text = await f.provider.chatgptChat({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'Plan.' }] });
  assert.equal(text, '{"shots":[]}');
  const sent = JSON.parse(f.calls.filter((c) => c.url.endsWith('/responses')).at(-1).options.body);
  assert.equal(sent.model, 'model-b');
});

test('a connection dropped mid-stream is a retryable interruption, never a partial plan', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.state.response = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: '{"sho' }))); c.error(new TypeError('socket hang up')); } }));
  await assert.rejects(f.provider.chatgptChat({ model: 'model-b', messages: [{ role: 'user', content: 'Plan.' }] }), (e) => e.retryable === true && /interrupted/.test(e.message));
});
