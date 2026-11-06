// Sign in with ChatGPT for an owner-operated Film Studio. OAuth runs on the Mac;
// this server verifies the transferred registration and exclusively owns refresh.
// https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DATA, getSettings, readJSON } from '../store.js';
import { ProviderError } from '../http.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const REQUIRED_SCOPES = ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const PENDING_MS = 10 * 60 * 1000;
const REQUEST_MS = 15000;
const MODEL_CACHE_MS = 60000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const opaque = () => crypto.randomBytes(32).toString('base64url');
const validString = (value, max = 32768) => typeof value === 'string' && value.length > 0 && value.length <= max;
// Constant-time and byte-safe: compare digests, so different lengths or multi-byte text never throw or leak length.
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
// This process instance. In Docker the engine restarts with the same PID (often 1), so a PID alone can't tell
// a crashed holder from a live one; the boot id can.
const BOOT = crypto.randomBytes(16).toString('hex');
const problem = (message, status = 400, options) => new ProviderError('codex', status, message, options);
const cancelled = () => problem('Request cancelled', 499);
const scopesOf = (value) => typeof value === 'string' ? value.trim().split(/\s+/).filter(Boolean) : [];
function requireScopes(value) {
  const scopes = scopesOf(value);
  if (!REQUIRED_SCOPES.every((scope) => scopes.includes(scope))) throw problem('ChatGPT plan usage and offline access must be authorized');
  return scopes;
}
function officialAuthURL(value) {
  try {
    const url = new URL(value);
    if (url.origin === ISSUER && !url.username && !url.password && !url.hash) return url.href;
  } catch {}
  throw problem('OpenAI returned invalid authentication metadata', 502);
}

// Never pass upstream messages, tokens, response bodies, or authorization URLs to
// logs/client errors. Known codes give useful recovery without exposing payloads.
const ERRORS = {
  invalid_grant: 'ChatGPT authorization expired or was revoked. Connect again on your Mac.',
  invalid_client: 'ChatGPT registration is no longer valid. Connect again on your Mac.',
  insufficient_scope: 'ChatGPT plan usage was not authorized. Connect again and approve plan usage.',
  subscription_sharing_usage_limit_exceeded: 'This app reached its ChatGPT plan usage limit. Review the app limit in ChatGPT Settings → Usage.',
  subscription_sharing_usage_unavailable: 'ChatGPT plan usage is currently unavailable for this account.',
  rate_limit_exceeded: 'ChatGPT is rate limited. Try again later.',
  model_not_found: 'That model is no longer available to the connected ChatGPT account. Refresh the model list.',
};
function upstreamError(status, code) {
  const known = Object.hasOwn(ERRORS, code || '') ? code : null;
  const e = problem(ERRORS[known] || (status === 401 ? 'ChatGPT authorization was rejected. Connect again on your Mac.' : `ChatGPT request failed (${status || 'stream error'}).`), status || 502, {
    quota: status === 429 || known?.startsWith('subscription_sharing_usage_'),
    retryable: status === 429 || status >= 500,
  });
  e.code = known;
  return e;
}

/** Injectable dependencies keep all provider tests offline and credential-free. */
export function createChatGPTProvider({ dataDir = DATA, fetch: fetcher = globalThis.fetch, now = Date.now, studioOwner } = {}) {
  const directory = path.join(path.resolve(dataDir), 'chatgpt');
  const stateFile = path.join(directory, 'connection.json');
  const lockFile = path.join(directory, 'connection.lock');
  let serial = Promise.resolve();
  let discoveryCache, keysCache, modelsCache;
  const controllers = new Set();

  async function ownerHash(owner) {
    const trusted = typeof studioOwner === 'function' ? await studioOwner() : studioOwner;
    if (!validString(trusted, 1024) || (owner != null && !same(String(owner), trusted))) throw problem('Only the Film Studio owner can use this ChatGPT connection', 403);
    return digest(trusted);
  }

  async function ensureDirectory() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('ChatGPT credential directory is not a private directory', 500);
    await fs.chmod(directory, 0o700);
  }
  async function readState() {
    try {
      const stat = await fs.lstat(stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error();
      const value = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (value.version !== 1 || !validString(value.hostId, 100)) throw new Error();
      await fs.chmod(stateFile, 0o600);
      return value;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}` };
      throw problem('ChatGPT credential storage could not be read safely', 500);
    }
  }
  async function writeState(value) {
    const temp = `${stateFile}.${process.pid}.${opaque()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, stateFile);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  async function acquireLock() {
    await ensureDirectory();
    const deadline = Date.now() + 10000;
    const identity = { pid: process.pid, host: os.hostname(), boot: BOOT, nonce: opaque(), at: Date.now() };
    for (;;) {
      try {
        const handle = await fs.open(lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(identity));
        await handle.close();
        return async () => {
          const saved = JSON.parse(await fs.readFile(lockFile, 'utf8').catch(() => '{}'));
          if (saved.nonce === identity.nonce) await fs.unlink(lockFile).catch(() => {});
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw problem('ChatGPT credential storage could not be locked', 500);
        // Recover a lock only when its holder is demonstrably gone. Never age out a live refresh, which could
        // reuse a rotating refresh token. Gone = same host and (PID not running, or the PID now belongs to a
        // newer process instance: a restarted container reuses PID 1). A lock from another host (an old
        // container with a different hostname) is recovered only once it is far older than any refresh.
        try {
          const saved = JSON.parse(await fs.readFile(lockFile, 'utf8'));
          let dead = false;
          if (saved.host === os.hostname() && Number.isInteger(saved.pid) && saved.pid > 0) {
            if (saved.pid === process.pid) dead = saved.boot !== BOOT;
            else { try { process.kill(saved.pid, 0); } catch (err) { dead = err.code === 'ESRCH'; } }
          } else if (saved.host !== os.hostname()) {
            dead = Number.isFinite(saved.at) && Date.now() - saved.at > 5 * 60 * 1000;
          }
          if (dead) {
            const current = JSON.parse(await fs.readFile(lockFile, 'utf8'));
            if (current.nonce === saved.nonce) await fs.unlink(lockFile).catch(() => {});
          }
        } catch {}
        if (Date.now() >= deadline) throw problem('ChatGPT connection is busy. Retry shortly.', 503, { retryable: true });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  function locked(fn) {
    const operation = serial.catch(() => {}).then(async () => {
      const release = await acquireLock();
      try { return await fn(await readState()); } finally { await release(); }
    });
    serial = operation.catch(() => {});
    return operation;
  }

  async function request(url, options = {}, timeout = REQUEST_MS) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    try { return await fetcher(url, { ...options, redirect: 'error', signal }); }
    catch {
      if (options.signal?.aborted) throw cancelled();
      throw problem('Could not reach ChatGPT. Try again shortly.', 503, { retryable: true });
    }
  }
  async function jsonResponse(response) {
    const text = await response.text();
    if (text.length > 1024 * 1024) throw problem('ChatGPT returned an oversized response', 502);
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { throw problem('ChatGPT returned an unreadable response', 502); }
    if (!response.ok) throw upstreamError(response.status, typeof body.error === 'string' ? body.error : body.error?.code);
    return body;
  }
  async function discover() {
    if (discoveryCache && now() - discoveryCache.at < 3600000) return discoveryCache.value;
    const value = await jsonResponse(await request(`${ISSUER}/.well-known/openid-configuration`));
    if (value.issuer !== ISSUER) throw problem('OpenAI returned an unexpected issuer', 502);
    officialAuthURL(value.jwks_uri);
    if (value.revocation_endpoint) officialAuthURL(value.revocation_endpoint);
    discoveryCache = { at: now(), value };
    return value;
  }
  async function signingKey(kid, fresh = false) {
    if (fresh || !keysCache || now() - keysCache.at >= 3600000) {
      const doc = await discover();
      const value = await jsonResponse(await request(officialAuthURL(doc.jwks_uri)));
      if (!Array.isArray(value.keys)) throw problem('OpenAI signing keys are unavailable', 502);
      keysCache = { at: now(), value: value.keys };
    }
    const key = keysCache.value.find((key) => key.kid === kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
    if (!key && !fresh) return signingKey(kid, true);
    if (!key) throw problem('ChatGPT token signature could not be verified');
    try { return crypto.createPublicKey({ key, format: 'jwk' }); } catch { throw problem('OpenAI signing key is invalid', 502); }
  }
  async function verifyJWT(token, audience, { nonce, subject, clientId } = {}) {
    if (!validString(token)) throw problem('ChatGPT token is missing');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw problem('ChatGPT token is malformed');
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch { throw problem('ChatGPT token is malformed'); }
    if (header.alg !== 'RS256' || !validString(header.kid, 256) || header.crit?.length) throw problem('ChatGPT token signature is unsupported');
    const key = await signingKey(header.kid);
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw problem('ChatGPT token signature could not be verified');
    const timestamp = Math.floor(now() / 1000);
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (claims.iss !== ISSUER || !Array.isArray(audiences) || !audiences.includes(audience) || !Number.isFinite(claims.exp) || claims.exp <= timestamp || (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > timestamp + 30)) || (claims.iat != null && (!Number.isFinite(claims.iat) || claims.iat > timestamp + 30))) throw problem('ChatGPT token identity, audience, or expiry is invalid');
    if (!validString(claims.sub, 1024) || (subject && claims.sub !== subject)) throw problem('ChatGPT account does not match this registration');
    if (nonce && !same(claims.nonce, nonce)) throw problem('ChatGPT sign-in nonce does not match this attempt');
    if (clientId && claims.client_id !== clientId) throw problem('ChatGPT access token does not match this registration');
    if (audience !== RESOURCE && ((claims.azp && claims.azp !== audience) || (audiences.length > 1 && claims.azp !== audience))) throw problem('ChatGPT ID token has an invalid authorized party');
    return claims;
  }
  function validateClient(value) {
    if (!validString(value, 256) || /\s/.test(value) || value === 'dynamic_agent_client') throw problem('ChatGPT registration did not return an issued client ID');
    return value;
  }
  async function validateTokens(payload, pending, previous) {
    const clientId = validateClient(payload.clientId);
    if (pending?.clientId && pending.clientId !== clientId) throw problem('ChatGPT registration changed during sign-in');
    if (!validString(payload.refreshToken) || String(payload.tokenType).toLowerCase() !== 'bearer') throw problem('ChatGPT did not grant a renewable session');
    const scopes = requireScopes(payload.scope);
    const id = await verifyJWT(payload.idToken, clientId, { nonce: pending?.nonce, subject: pending?.subject || previous?.subject });
    const access = await verifyJWT(payload.accessToken, RESOURCE, { subject: id.sub, clientId });
    requireScopes(access.scope);
    const expiresIn = payload.expiresIn == null ? access.exp * 1000 - now() : Number(payload.expiresIn) * 1000;
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw problem('ChatGPT returned an invalid token lifetime');
    return {
      registration: { clientId, subject: id.sub, email: typeof id.email === 'string' ? id.email.slice(0, 320) : previous?.email || null },
      credentials: { accessToken: payload.accessToken, refreshToken: payload.refreshToken, idToken: payload.idToken, tokenType: 'Bearer', scopes, expiresAt: Math.min(access.exp * 1000, now() + expiresIn), savedAt: now() },
    };
  }
  function checkBinding(state, hash) {
    if (state.ownerHash && state.ownerHash !== hash) throw problem('This ChatGPT registration belongs to a different studio owner', 403);
  }
  function publicState(state, hash) {
    checkBinding(state, hash);
    const pending = state.pending && state.pending.expiresAt > now();
    const loggedIn = !!state.credentials?.refreshToken;
    return {
      installed: true, available: loggedIn, loggedIn,
      state: pending ? 'pending' : loggedIn ? 'connected' : state.error ? 'error' : 'signed_out',
      account: state.registration ? { email: state.registration.email || null, plan: null } : null,
      expiresAt: pending ? new Date(state.pending.expiresAt).toISOString() : null,
      error: state.error || null, loginMethod: 'mac_local_oauth',
    };
  }
  async function status(owner) {
    try { return publicState(await readState(), await ownerHash(owner)); }
    catch (e) {
      if (owner != null) throw e;
      return { installed: true, available: false, loggedIn: false, state: 'error', account: null, error: 'The studio owner must sign in before connecting ChatGPT', loginMethod: 'mac_local_oauth' };
    }
  }
  async function begin(owner) {
    const hash = await ownerHash(owner);
    return locked(async (state) => {
      checkBinding(state, hash);
      state.ownerHash = hash;
      state.pending = { connectionId: opaque(), nonce: opaque(), expiresAt: now() + PENDING_MS, clientId: state.registration?.clientId, subject: state.registration?.subject };
      state.error = null;
      await writeState(state); // Also persist this VM's identity before import.
      return { connectionId: state.pending.connectionId, nonce: state.pending.nonce, expiresAt: new Date(state.pending.expiresAt).toISOString(), ...(state.pending.clientId ? { clientId: state.pending.clientId } : {}) };
    });
  }
  function matchingPending(state, connectionId) {
    if (!state.pending || !same(state.pending.connectionId, connectionId) || state.pending.expiresAt <= now()) throw problem('This ChatGPT sign-in expired or was cancelled. Start again.', 409);
    return state.pending;
  }
  async function catalog(token, signal) {
    const data = await jsonResponse(await request(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal }));
    if (!Array.isArray(data.models)) throw problem('ChatGPT did not return an account model catalog', 502);
    const seen = new Set();
    return data.models.filter((model) => model.visibility === 'list' && validString(model.slug, 256) && !seen.has(model.slug) && seen.add(model.slug))
      .map((model) => ({ id: model.slug, label: typeof model.display_name === 'string' && model.display_name ? model.display_name.slice(0, 256) : model.slug }));
  }
  async function complete(owner, payload = {}) {
    const hash = await ownerHash(owner);
    const pending = await locked((state) => { checkBinding(state, hash); return { ...matchingPending(state, payload.connectionId) }; });
    let verified, models;
    try {
      verified = await validateTokens(payload, pending);
      models = await catalog(verified.credentials.accessToken);
      if (!models.length) throw problem('No director models are available to this ChatGPT account', 403);
    } catch (e) {
      await locked(async (state) => {
        checkBinding(state, hash);
        if (state.pending?.connectionId === payload.connectionId) {
          state.pending = null;
          state.error = e instanceof ProviderError ? e.message : 'ChatGPT connection could not be verified';
          await writeState(state);
        }
      });
      throw e instanceof ProviderError ? e : problem('ChatGPT connection could not be verified');
    }
    return locked(async (state) => {
      checkBinding(state, hash);
      matchingPending(state, payload.connectionId); // Cancellation/logout wins over late HTTP completion.
      Object.assign(state, verified, { ownerHash: hash, pending: null, error: null, sessionId: opaque() });
      await writeState(state);
      modelsCache = { sessionId: state.sessionId, at: now(), models };
      return publicState(state, hash);
    });
  }
  async function cancel(owner, connectionId) {
    const hash = await ownerHash(owner);
    return locked(async (state) => {
      checkBinding(state, hash);
      if (state.pending && same(state.pending.connectionId, connectionId)) { state.pending = null; state.error = null; await writeState(state); }
      return publicState(state, hash);
    });
  }

  async function credential(owner, { forceToken, signal } = {}) {
    const hash = await ownerHash(owner);
    return locked(async (state) => {
      checkBinding(state, hash);
      if (!state.credentials || !state.registration) throw problem('Connect ChatGPT in Film Studio on your Mac first', 401);
      if (signal?.aborted) throw cancelled();
      if (state.credentials.expiresAt > now() + 60000 && (!forceToken || state.credentials.accessToken !== forceToken)) return { ...state.credentials, ...state.registration, sessionId: state.sessionId };
      let tokens;
      try {
        // Refresh tokens rotate: once this request is sent the old one may already be spent, so it is never
        // aborted by one caller's cancellation (only by its own time limit). The replacement is saved below,
        // and only then is the caller's cancellation honoured.
        const response = await request(TOKEN_ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: state.registration.clientId, refresh_token: state.credentials.refreshToken, resource: RESOURCE }),
        });
        tokens = await jsonResponse(response);
      } catch (e) {
        if (e.code === 'invalid_grant' || e.code === 'invalid_client') {
          state.credentials = null; state.sessionId = opaque(); state.error = e.message; modelsCache = null;
          await writeState(state);
        }
        throw e;
      }
      // Refresh responses can omit an ID token. The signed new access token must
      // still belong to the same verified subject and issued registration.
      const access = await verifyJWT(tokens.access_token, RESOURCE, { subject: state.registration.subject, clientId: state.registration.clientId });
      const scopes = requireScopes(tokens.scope ?? state.credentials.scopes.join(' '));
      requireScopes(access.scope);
      if (!validString(tokens.refresh_token) || String(tokens.token_type).toLowerCase() !== 'bearer') throw problem('ChatGPT returned an invalid refreshed session', 502);
      if (tokens.id_token) await verifyJWT(tokens.id_token, state.registration.clientId, { subject: state.registration.subject });
      const lifetime = Number(tokens.expires_in) * 1000;
      if (!Number.isFinite(lifetime) || lifetime <= 0) throw problem('ChatGPT returned an invalid refreshed token lifetime', 502);
      state.credentials = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token || state.credentials.idToken, tokenType: 'Bearer', scopes, expiresAt: Math.min(access.exp * 1000, now() + lifetime), savedAt: now() };
      state.error = null;
      await writeState(state); // Rotating refresh and access tokens are replaced together.
      if (signal?.aborted) throw cancelled(); // only after the rotated tokens are safely stored
      return { ...state.credentials, ...state.registration, sessionId: state.sessionId };
    });
  }
  async function activeRequest(owner, signal, fn) {
    const controller = new AbortController();
    controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      if (combined.aborted) throw cancelled();
      const hash = await ownerHash(owner);
      const value = await fn(combined);
      if (combined.aborted) throw cancelled();
      const state = await readState();
      checkBinding(state, hash);
      if (!state.credentials || state.sessionId !== value.sessionId) throw cancelled();
      return value.result;
    } finally { controllers.delete(controller); }
  }
  async function models({ fresh = false, owner, signal } = {}) {
    return activeRequest(owner, signal, async (activeSignal) => {
      let token = await credential(owner, { signal: activeSignal });
      if (!fresh && modelsCache?.sessionId === token.sessionId && now() - modelsCache.at < MODEL_CACHE_MS) return { sessionId: token.sessionId, result: modelsCache.models.map((model) => ({ ...model })) };
      let result;
      try { result = await catalog(token.accessToken, activeSignal); }
      catch (e) {
        if (e.status !== 401) throw e;
        token = await credential(owner, { forceToken: token.accessToken, signal: activeSignal });
        result = await catalog(token.accessToken, activeSignal);
      }
      modelsCache = { sessionId: token.sessionId, at: now(), models: result };
      return { sessionId: token.sessionId, result };
    });
  }
  async function chat({ model, messages, signal, owner } = {}) {
    if (!Array.isArray(messages) || !messages.length || messages.some((message) => !['system', 'developer', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) throw problem('The ChatGPT director accepts text messages only');
    return activeRequest(owner, signal, async (activeSignal) => {
      const available = await models({ owner, signal: activeSignal });
      const selected = model || available[0]?.id;
      if (!selected || !available.some((item) => item.id === selected)) throw problem('Choose a model available to your connected ChatGPT account');
      let token = await credential(owner, { signal: activeSignal });
      const send = () => request(`${RESOURCE}/responses`, {
        method: 'POST', headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, signal: activeSignal,
        body: JSON.stringify({ model: selected, input: messages.map(({ role, content }) => ({ role, content })), store: false, stream: true }),
      }, 6 * 60 * 1000);
      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        token = await credential(owner, { forceToken: token.accessToken, signal: activeSignal });
        response = await send();
      }
      if (!response.ok) await jsonResponse(response);
      const result = await readResponseStream(response, activeSignal);
      return { sessionId: token.sessionId, result };
    });
  }
  async function disconnect(owner) {
    const hash = await ownerHash(owner);
    for (const controller of controllers) controller.abort();
    return locked(async (state) => {
      checkBinding(state, hash);
      let revoked = true;
      if (state.credentials?.refreshToken) {
        revoked = false;
        try {
          const doc = await discover();
          const endpoint = officialAuthURL(doc.revocation_endpoint);
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const response = await request(endpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: state.credentials.refreshToken, token_type_hint: 'refresh_token', client_id: state.registration.clientId }),
              });
              if (response.status === 200) { revoked = true; break; }
              if (response.status < 500) break;
            } catch {}
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch {}
      }
      state.credentials = null; state.pending = null; state.sessionId = opaque();
      state.error = revoked ? null : 'Disconnected locally. Remote revocation was not confirmed; disconnect Film Studio in ChatGPT Settings → Usage.';
      modelsCache = null;
      await writeState(state); // Retain only the account/client mapping and VM host identity.
      return publicState(state, hash);
    });
  }
  return { chatgptStatus: status, beginConnection: begin, completeConnection: complete, cancelConnection: cancel, disconnect, chatgptModels: models, chatgptChat: chat };
}

/** Deltas are provisional; never return partial output without response.completed. */
export async function readResponseStream(response, signal) {
  if (!response.body) throw problem('ChatGPT returned no response stream', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', bytes = 0, completed = false;
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  function event(block) {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let value;
    try { value = JSON.parse(data); } catch { throw problem('ChatGPT returned an invalid stream event', 502); }
    if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') text += value.delta;
    else if (value.type === 'response.failed' || value.type === 'error') throw upstreamError(0, value.response?.error?.code || value.error?.code || value.code);
    else if (value.type === 'response.incomplete') throw problem('ChatGPT stopped before completing the director response. Try a smaller request.', 502);
    else if (value.type === 'response.completed') {
      if (value.response?.status && value.response.status !== 'completed') throw problem('ChatGPT did not complete the director response', 502);
      const output = value.response?.output;
      if (Array.isArray(output)) {
        const finalText = output.filter((item) => item.type === 'message').flatMap((item) => item.content || []).filter((item) => item.type === 'output_text').map((item) => item.text || '').join('');
        if (finalText) text = finalText;
      }
      completed = true;
    }
  }
  try {
    while (!completed) {
      if (signal?.aborted) throw cancelled();
      const next = await reader.read();
      if (signal?.aborted) throw cancelled();
      if (next.done) { buffer += decoder.decode(); break; }
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw problem('ChatGPT director response exceeded the size limit', 502);
      buffer += decoder.decode(next.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) { event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); if (completed) break; }
    }
    if (!completed && buffer.trim()) event(buffer);
    if (!completed) throw problem('ChatGPT response was interrupted before completion. No partial plan was accepted.', 502, { retryable: true });
    if (!text.trim()) throw problem('ChatGPT completed without a text response', 502);
    return text;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function currentStudioOwner() {
  const settings = getSettings();
  // A partially configured issuer still fails closed rather than silently using the no-OIDC local identity.
  // With an allowlist, only a single-email allowlist has an owner: recorded in owner.json (see recordStudioOwner)
  // the first time that person uses the ChatGPT routes. Group or multi-person allowlists have no implicit owner.
  if (process.env.OIDC_ISSUER || settings.oidcIssuer || process.env.OIDC_CLIENT_ID || settings.oidcClientId) {
    if (process.env.OIDC_ALLOWED_GROUPS || allowedEmails().length > 1) return null;
    const owner = readJSON(path.join(DATA, 'owner.json'), null);
    const emails = allowedEmails();
    if (emails.length === 1 && owner?.email !== emails[0]) return null; // allowlist changed since: no owner
    return owner?.sub || null;
  }
  return 'local-studio';
}
const allowedEmails = () => (process.env.OIDC_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/**
 * Single-email allowlist: remember the signed-in owner's Pocket ID subject (owner.json) so the ChatGPT
 * connection can be bound to it and used by background director calls. No-op otherwise or once recorded.
 */
export async function recordStudioOwner(user) {
  const emails = allowedEmails();
  if (process.env.OIDC_ALLOWED_GROUPS || emails.length !== 1 || !user?.sub || String(user.email || '').toLowerCase() !== emails[0]) return;
  const file = path.join(DATA, 'owner.json');
  const existing = readJSON(file, null);
  if (existing?.sub && existing.email === emails[0]) return;
  await fs.writeFile(file, JSON.stringify({ sub: user.sub, email: emails[0], at: new Date().toISOString(), via: 'allowlist' }, null, 2), { mode: 0o600 });
}
const provider = createChatGPTProvider({ studioOwner: currentStudioOwner });
export const { chatgptStatus, beginConnection, completeConnection, cancelConnection, disconnect, chatgptModels, chatgptChat } = provider;
