// xAI — Grok Imagine video/image + Grok chat.
// Auth: either an API key (metered) or the SuperGrok / X Premium subscription via xAI's
// OAuth device-code sign-in (the same public Grok CLI client used by OpenCode, Warp,
// Crush and Goose). The user approves on accounts.x.ai; we only ever hold the tokens.
import { getSettings, setXaiOAuth } from '../store.js';
import { fetchJSON, sleep, form, ProviderError } from '../http.js';

const API = 'https://api.x.ai/v1';
const ISSUER = 'https://auth.x.ai';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const REFERRER = 'open-higgsfield';

/* ---------------- OAuth (device authorization grant, RFC 8628) ---------------- */

let pendingLogin = null; // { userCode, verificationUri, expiresAt, status, error }

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

async function tokenRequest(params) {
  const res = await fetch(`${ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: CLIENT_ID, ...params }),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

function storeTokens(json, previous = {}) {
  const claims = decodeJwt(json.id_token || '');
  return setXaiOAuth({
    access_token: json.access_token,
    refresh_token: json.refresh_token || previous.refresh_token,
    expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    email: claims.email || previous.email || null,
  });
}

export async function startDeviceLogin() {
  const dc = await fetchJSON('xai-auth', `${ISSUER}/oauth2/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: CLIENT_ID, scope: SCOPE, referrer: REFERRER }),
  });
  const login = {
    userCode: dc.user_code,
    verificationUri: dc.verification_uri_complete || dc.verification_uri,
    expiresAt: Date.now() + (dc.expires_in || 900) * 1000,
    status: 'pending',
    error: null,
  };
  pendingLogin = login;
  (async () => {
    let interval = Math.max(2, dc.interval || 5) * 1000;
    while (pendingLogin === login && Date.now() < login.expiresAt) {
      await sleep(interval);
      const r = await tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code }).catch((e) => ({ ok: false, json: { error: e.message } }));
      if (r.ok && r.json.access_token) {
        await storeTokens(r.json);
        login.status = 'connected';
        return;
      }
      const err = r.json?.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { interval += 5000; continue; }
      login.status = 'error';
      login.error = err === 'access_denied' ? 'Sign-in was denied' : err === 'expired_token' ? 'Code expired — try again' : (r.json?.error_description || err || r.text || 'sign-in failed');
      return;
    }
    if (login.status === 'pending') { login.status = 'error'; login.error = 'Code expired — try again'; }
  })();
  return loginStatus();
}

export function loginStatus() {
  const s = getSettings();
  return {
    connected: !!s.xaiOAuth?.access_token,
    email: s.xaiOAuth?.email || null,
    pending: pendingLogin && pendingLogin.status === 'pending' ? { userCode: pendingLogin.userCode, verificationUri: pendingLogin.verificationUri, expiresAt: pendingLogin.expiresAt } : null,
    error: pendingLogin?.status === 'error' ? pendingLogin.error : null,
  };
}

export async function logout() {
  pendingLogin = null;
  await setXaiOAuth(null);
}

let refreshing = null;
async function oauthToken() {
  const tok = getSettings().xaiOAuth;
  if (!tok?.access_token) return null;
  if (Date.now() < tok.expires_at - 60000) return tok.access_token;
  if (!tok.refresh_token) return tok.access_token;
  refreshing ||= (async () => {
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
    if (!r.ok || !r.json.access_token) throw new ProviderError('xai', r.status, `SuperGrok session expired — sign in again (${r.json?.error || r.status})`);
    await storeTokens(r.json, tok);
    return r.json.access_token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Bearer credential + which billing path it uses. */
export async function credential() {
  const s = getSettings();
  const sub = s.xaiPreferSubscription || !s.xaiKey ? await oauthToken() : null;
  if (sub) return { token: sub, via: 'subscription' };
  if (s.xaiKey) return { token: s.xaiKey, via: 'api-key' };
  const fallback = await oauthToken();
  if (fallback) return { token: fallback, via: 'subscription' };
  throw new ProviderError('xai', 0, 'not connected — sign in with SuperGrok or add an xAI API key in Providers');
}

export const xaiAvailable = () => { const s = getSettings(); return !!(s.xaiKey || s.xaiOAuth?.access_token); };

async function call(path, { method = 'GET', body, signal } = {}) {
  const { token } = await credential();
  return fetchJSON('xai', `${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

/* ---------------- video ---------------- */

async function pollVideo(requestId, { onStatus, signal }) {
  for (;;) {
    await sleep(3000, signal);
    const r = await call(`/videos/${requestId}`, { signal });
    if (r.status === 'done') return r;
    if (r.status === 'failed' || r.status === 'expired') {
      throw new ProviderError('xai', 0, r.error?.message || `generation ${r.status}${r.error?.code ? ` (${r.error.code})` : ''}`, { retryable: r.error?.code === 'service_unavailable' || r.status === 'expired' });
    }
    onStatus?.({ message: `Grok Imagine rendering${r.progress != null ? ` · ${r.progress}%` : ''}`, progress: r.progress != null ? r.progress / 100 : undefined });
  }
}

/**
 * p: { model, prompt, image (data/http url), endImage, aspect, duration, resolution }
 */
export async function xaiVideo(p, { onStatus, signal } = {}) {
  const body = {
    model: p.model,
    prompt: p.prompt || undefined,
    duration: p.duration ? Math.min(15, Math.max(1, Math.round(p.duration))) : undefined,
    aspect_ratio: p.image ? undefined : p.aspect,
    resolution: p.resolution,
  };
  if (p.image) body.image = { url: p.image };
  if (p.endImage) body.last_frame = { url: p.endImage };
  const { via } = await credential();
  const { request_id: id } = await call('/videos/generations', { method: 'POST', body, signal });
  onStatus?.({ message: `Queued on Grok Imagine (${via === 'subscription' ? 'SuperGrok' : 'API'})`, remoteId: id });
  const r = await pollVideo(id, { onStatus, signal });
  return { url: r.video?.url, duration: r.video?.duration, ref: { provider: 'xai', videoUrl: r.video?.url, duration: r.video?.duration } };
}

/** Continue a clip from its last frame. Returned video = source + extension. */
export async function xaiExtend({ videoUrl, prompt, duration = 6 }, { onStatus, signal } = {}) {
  const { request_id: id } = await call('/videos/extensions', {
    method: 'POST',
    body: { model: 'grok-imagine-video', prompt, duration: Math.min(10, Math.max(2, Math.round(duration))), video: { url: videoUrl } },
    signal,
  });
  onStatus?.({ message: 'Extending on Grok Imagine', remoteId: id });
  const r = await pollVideo(id, { onStatus, signal });
  return { url: r.video?.url, duration: r.video?.duration, ref: { provider: 'xai', videoUrl: r.video?.url, duration: r.video?.duration, extended: true } };
}

/* ---------------- image ---------------- */

export async function xaiImage(p, { signal } = {}) {
  const body = { model: p.model || 'grok-imagine-image-2.0', prompt: p.prompt, n: 1, aspect_ratio: p.aspect || 'auto' };
  const refs = [p.image, ...(p.refs || [])].filter(Boolean);
  let r;
  if (refs.length === 1) r = await call('/images/edits', { method: 'POST', body: { ...body, image: { url: refs[0] } }, signal });
  else if (refs.length > 1) r = await call('/images/edits', { method: 'POST', body: { ...body, images: refs.slice(0, 5).map((url) => ({ url })) }, signal });
  else r = await call('/images/generations', { method: 'POST', body, signal });
  const d = r.data?.[0] || {};
  if (d.b64_json) return { buffer: Buffer.from(d.b64_json, 'base64'), mime: 'image/jpeg' };
  if (d.url) return { url: d.url };
  throw new ProviderError('xai', 0, 'no image returned');
}

/* ---------------- chat (Director) ---------------- */

export async function xaiModels() {
  const r = await call('/models');
  return (r.data || []).map((m) => m.id);
}

export async function xaiChat({ model, messages, signal }) {
  let m = model;
  if (!m) {
    const ids = await xaiModels().catch(() => []);
    m = ids.find((id) => /^grok-4/.test(id) && !/image|video|imagine/.test(id)) || ids.find((id) => /^grok/.test(id) && !/image|video|imagine/.test(id)) || 'grok-4.3';
  }
  const r = await call('/chat/completions', { method: 'POST', body: { model: m, messages, temperature: 0.7 }, signal });
  return r.choices?.[0]?.message?.content || '';
}

/* ---------------- voice ---------------- */

export async function xaiVoices() {
  const r = await call('/tts/voices');
  const list = r.voices || r.data || [];
  return list.map((v) => (typeof v === 'string' ? v : v.voice_id || v.id || v.name)).filter(Boolean);
}

export async function xaiSpeech({ text, voice = 'eve', language = 'en' }, { signal } = {}) {
  const r = await call('/tts', { method: 'POST', body: { text, voice_id: voice, language, output_format: { codec: 'mp3', sample_rate: 44100 } }, signal });
  if (!r.audio) throw new ProviderError('xai', 0, 'no audio returned');
  return { buffer: Buffer.from(r.audio, 'base64'), mime: 'audio/mpeg' };
}
