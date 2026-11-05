// Google AI Ultra via the cloudcode OAuth path — the subscription usage, not a billed API key.
//
// This authenticates as Google's first-party "Antigravity" client to reach the private
// cloudcode endpoint, the same mechanism the user's existing Gemini Studio uses. Google's ToS
// disallows third-party clients here and they have suspended accounts for it; the user has
// explicitly accepted that risk for their own account and subscription. Reachable natively this
// way: Lyria music, Gemini TTS narration, and Nano Banana images. Veo/Omni VIDEO is not exposed
// here — that goes through the Flow bridge (browser automation), handled separately.
import crypto from 'node:crypto';
import { getSettings, setGoogleUltra } from '../store.js';
import { ProviderError } from '../http.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CLOUDCODE = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUDCODE_UA = 'antigravity/1.104.0 darwin/arm64';
const CLOUDCODE_PROJECT = 'aicode-consumers';
// The client id is a public native-app identifier; the secret ships with the installed client and
// is supplied at runtime (env GOOGLE_ULTRA_CLIENT_SECRET) so it is never committed to the repo.
const CLIENT_ID = process.env.GOOGLE_ULTRA_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid';
const REDIRECT = 'http://localhost:8085/oauth-callback';

const clientSecret = () => process.env.GOOGLE_ULTRA_CLIENT_SECRET || getSettings().googleUltraClientSecret || '';

export const ultraAvailable = () => !!getSettings().googleUltra?.refresh_token;
export function ultraStatus() {
  const g = getSettings().googleUltra;
  return { connected: !!g?.refresh_token, email: g?.email || null, hasSecret: !!clientSecret() };
}

/** Build the Google consent URL. The sign-in lands on a localhost page that won't load; the user
 *  copies the `code=` from the address bar and pastes it back (same as the reference client). */
export function authUrl() {
  const p = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', state: crypto.randomBytes(12).toString('hex'),
  });
  return { url: `${AUTH_URL}?${p}`, redirect: REDIRECT };
}

function extractCode(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.includes('code=')) {
    try { const c = new URL(raw).searchParams.get('code'); if (c) return c; } catch {}
    const m = raw.match(/[?&]code=([^&\s]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return raw;
}

export async function finishLogin(codeOrUrl) {
  if (!clientSecret()) throw new ProviderError('google-ultra', 0, 'Ultra client secret not configured on the server');
  const code = extractCode(codeOrUrl);
  if (!code) throw new ProviderError('google-ultra', 0, 'Paste the code (or the whole localhost URL) from the Google sign-in page');
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: clientSecret(), redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new ProviderError('google-ultra', r.status, `Google token exchange failed: ${j.error_description || j.error || r.status}`);
  if (!j.refresh_token) throw new ProviderError('google-ultra', 0, 'Google returned no refresh token — revoke this app at myaccount.google.com/permissions and sign in again');
  let email = null;
  try { email = (await (await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${j.access_token}` } })).json()).email; } catch {}
  await setGoogleUltra({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 90000, email });
  return ultraStatus();
}

export async function logout() { await setGoogleUltra(null); }

let refreshing = null;
async function accessToken(force = false) {
  const g = getSettings().googleUltra;
  if (!g?.refresh_token) throw new ProviderError('google-ultra', 0, 'not signed in to Google AI Ultra');
  if (!force && g.access_token && Date.now() < g.expires_at) return g.access_token;
  refreshing ||= (async () => {
    const r = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: clientSecret(), refresh_token: g.refresh_token, grant_type: 'refresh_token' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new ProviderError('google-ultra', r.status, `Ultra session expired — sign in again (${j.error || r.status})`);
    await setGoogleUltra({ ...g, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 90000, refresh_token: j.refresh_token || g.refresh_token });
    return j.access_token;
  })().finally(() => (refreshing = null));
  return refreshing;
}

// Internal model names the cloudcode endpoint expects.
const MODEL_MAP = {
  'lyria-3.5': 'lyria-3-pro-preview',
  'lyria-3-pro-preview': 'lyria-3-pro-preview',
  'lyria-3-clip-preview': 'lyria-3-clip-preview',
  'gemini-3-pro-image': 'gemini-nano-banana-2.1',
  'gemini-nano-banana-2.1': 'gemini-nano-banana-2.1',
  'gemini-3.8-flash-tts': 'gemini-3.8-flash-tts',
};

async function cloudcode(model, request, { timeout = 180000, signal } = {}) {
  const ccModel = MODEL_MAP[model] || model;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await accessToken(attempt > 0);
    const r = await fetch(`${CLOUDCODE}/v1internal:generateContent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'User-Agent': CLOUDCODE_UA },
      body: JSON.stringify({ project: CLOUDCODE_PROJECT, model: ccModel, request }),
      signal: signal || AbortSignal.timeout(timeout),
    });
    if (r.status === 401 && attempt === 0) { lastErr = 'auth'; continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.error?.message || JSON.stringify(j).slice(0, 240);
      throw new ProviderError('google-ultra', r.status, `Ultra ${ccModel}: ${msg}`, { quota: r.status === 429 || /quota|exhausted|RESOURCE_EXHAUSTED/i.test(msg), retryable: r.status >= 500 });
    }
    return j.response || j;
  }
  throw new ProviderError('google-ultra', 401, `Ultra auth failed (${lastErr})`);
}

function inlineMedia(j) {
  const parts = j.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inl = p.inlineData || p.inline_data;
    if (inl?.data) return { buffer: Buffer.from(inl.data, 'base64'), mime: inl.mimeType || inl.mime_type || '' };
  }
  const text = parts.find((p) => p.text)?.text;
  throw new ProviderError('google-ultra', 0, text ? `no media returned: ${text.slice(0, 200)}` : 'Ultra returned no media');
}

export async function ultraMusic({ model = 'lyria-3.5', prompt, seconds }, ctx = {}) {
  const len = model === 'lyria-3.5' && seconds ? ` Length about ${Math.round(seconds)} seconds with a clean ending.` : '';
  const j = await cloudcode(model, {
    contents: [{ role: 'user', parts: [{ text: `${prompt}. Instrumental only, no vocals, sits under dialogue.${len}`.slice(0, 2000) }] }],
    generationConfig: { responseModalities: ['TEXT', 'AUDIO'] },
  }, { timeout: 300000, ...ctx });
  return inlineMedia(j);
}

export async function ultraSpeech({ text, voice = 'Kore' }, ctx = {}) {
  const j = await cloudcode('gemini-3.8-flash-tts', {
    contents: [{ role: 'user', parts: [{ text: String(text).slice(0, 4000) }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } },
  }, ctx);
  return inlineMedia(j);
}

export async function ultraImage({ prompt, refs = [], aspect }, ctx = {}) {
  const parts = [...refs.filter(Boolean).map((r) => ({ inlineData: { mimeType: r.mime, data: r.base64 } })), { text: prompt }];
  const cfg = { responseModalities: ['IMAGE'] };
  if (aspect && aspect !== 'auto') cfg.imageConfig = { aspectRatio: aspect };
  const j = await cloudcode('gemini-3-pro-image', { contents: [{ role: 'user', parts }], generationConfig: cfg }, ctx);
  return inlineMedia(j);
}

export const ULTRA_VOICES = ['Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir', 'Aoede', 'Leda', 'Orus'];
