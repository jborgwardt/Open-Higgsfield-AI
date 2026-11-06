// File-backed engine storage: settings (keys/tokens), media assets, productions, jobs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const ENGINE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const REPO_ROOT = path.resolve(ENGINE_ROOT, '..');
export const DATA = process.env.ENGINE_DATA || path.join(REPO_ROOT, 'engine-data');
export const MEDIA = path.join(DATA, 'media');
export const PRODUCTIONS = path.join(DATA, 'productions');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const ASSETS_FILE = path.join(DATA, 'assets.json');

for (const d of [DATA, MEDIA, PRODUCTIONS]) fs.mkdirSync(d, { recursive: true });

export const uid = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex');
export const now = () => new Date().toISOString();

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export async function writeJSON(file, value, mode) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  await fsp.rename(tmp, file);
}

/* ---------------- settings ---------------- */

const DEFAULTS = {
  falKey: '',
  replicateToken: '',
  xaiKey: '',
  xaiOAuth: null, // { access_token, refresh_token, expires_at, email }
  xaiPreferSubscription: true,
  googleKey: '',
  muapiKey: '',
  kieKey: '',
  apimartKey: '',
  veniceKey: '',
  elevenKey: '',
  elevenModel: 'eleven_v4',
  qwenKey: '', // Qwen Cloud Token Plan (HappyHorse video, Qwen-Image / Wan 2.7 images); base URL via QWEN_BASE
  comfyUrl: 'http://127.0.0.1:8188',
  llmBaseUrl: 'http://127.0.0.1:11434/v1',
  llmModel: 'qwen3:8b',
  llmKey: '',
  directorProvider: '', // chosen by the user, no default: codex | claude | google | xai | apimart | qwen | openai | split
  directorModel: '',
  handoffDir: path.join(os.homedir(), 'Downloads'),
  concurrency: { xai: 2, google: 2, apimart: 3, fal: 4, replicate: 3, muapi: 2, kie: 3, comfy: 1, local: 2, qwen: 1 },
  accessToken: '', // required when the engine is reachable from other devices
  oidcIssuer: '',
  oidcClientId: '',
  oidcClientSecret: '',
  publicUrl: '',
  googleUltra: null, // { refresh_token, access_token, expires_at, email } — Ultra subscription via cloudcode OAuth
  googleUltraPrefer: true, // prefer the Ultra subscription over a billed API key when both are present
};

let settings = { ...DEFAULTS, ...readJSON(SETTINGS_FILE, {}) };
settings.concurrency = { ...DEFAULTS.concurrency, ...(settings.concurrency || {}) };
if (settings.directorProvider === 'auto') settings.directorProvider = ''; // there is no automatic director any more

const ENV = {
  falKey: ['FAL_KEY', 'FAL_API_KEY'],
  replicateToken: ['REPLICATE_API_TOKEN'],
  xaiKey: ['XAI_API_KEY'],
  googleKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  muapiKey: ['MUAPI_KEY'],
  kieKey: ['KIE_API_KEY'],
  apimartKey: ['APIMART_API_KEY'],
  veniceKey: ['VENICE_API_KEY'],
  elevenKey: ['ELEVENLABS_API_KEY', 'ELEVEN_API_KEY'],
  qwenKey: ['QWEN_API_KEY'],
  comfyUrl: ['COMFY_URL'],
  llmBaseUrl: ['LLM_BASE_URL'],
  llmModel: ['LLM_MODEL'],
  llmKey: ['LLM_API_KEY'],
};
const fromEnv = (k) => ENV[k]?.map((n) => process.env[n]).find(Boolean);

export function getSettings() {
  const s = { ...settings };
  for (const k of Object.keys(ENV)) s[k] = fromEnv(k) || s[k];
  return s;
}

const SECRET_KEYS = ['falKey', 'replicateToken', 'xaiKey', 'googleKey', 'muapiKey', 'kieKey', 'apimartKey', 'qwenKey', 'veniceKey', 'elevenKey', 'llmKey', 'accessToken', 'oidcClientSecret'];

export function publicSettings() {
  const s = getSettings();
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (SECRET_KEYS.includes(k)) out[k] = { set: !!v, env: !!fromEnv(k) };
    else if (k === 'xaiOAuth') out[k] = v ? { connected: true, email: v.email || null, expiresAt: v.expires_at } : { connected: false };
    else if (k === 'googleUltra') out[k] = v?.refresh_token ? { connected: true, email: v.email || null } : { connected: false };
    else out[k] = v;
  }
  return out;
}

export async function updateSettings(patch = {}) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS) || ['xaiOAuth', 'googleUltra', 'accessToken', 'oidcIssuer', 'oidcClientId', 'oidcClientSecret', 'publicUrl'].includes(k)) continue;
    if (k === 'concurrency' && v && typeof v === 'object') settings.concurrency = { ...settings.concurrency, ...v };
    else if (typeof DEFAULTS[k] === 'boolean') settings[k] = !!v;
    else if (typeof v === 'string') settings[k] = v.trim();
  }
  await saveSettings();
  return publicSettings();
}

export async function setXaiOAuth(tokens) {
  settings.xaiOAuth = tokens;
  await saveSettings();
}

export async function setGoogleUltra(tokens) {
  settings.googleUltra = tokens;
  await saveSettings();
}

const saveSettings = () => writeJSON(SETTINGS_FILE, settings, 0o600);

/* ---------------- media assets ---------------- */

let assets = readJSON(ASSETS_FILE, {});
let assetsQueue = Promise.resolve();
const saveAssets = () => (assetsQueue = assetsQueue.then(() => writeJSON(ASSETS_FILE, assets)).catch((e) => console.error('assets save', e)));

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aiff': 'aiff', 'text/vtt': 'vtt', 'application/x-subrip': 'srt', 'application/json': 'json' };
export const extFor = (mime) => EXT[mime] || (mime?.startsWith('video/') ? 'mp4' : mime?.startsWith('image/') ? 'jpg' : 'bin');
export const mimeForExt = (ext) => Object.entries(EXT).find(([, e]) => e === String(ext).replace('.', '').toLowerCase())?.[0] || 'application/octet-stream';

export function sniffMime(buf, fallback) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.subarray(4, 8).toString() === 'ftyp') return buf.subarray(8, 10).toString() === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3') return 'video/webm';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(buf.subarray(0, 256).toString())) return 'image/svg+xml';
  return fallback || 'application/octet-stream';
}

export function newAssetPath(mime) {
  const id = uid('a_');
  const file = `${id}.${extFor(mime)}`;
  return { id, file, abs: path.join(MEDIA, file) };
}

export async function addAsset({ buffer, mime, abs, id, file, meta = {}, remote = null }) {
  if (buffer) {
    mime = sniffMime(buffer, mime);
    ({ id, file, abs } = newAssetPath(mime));
    await fsp.writeFile(abs, buffer);
  }
  const kind = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
  const asset = { id, file, mime, kind, url: `/engine/media/${file}`, createdAt: now(), remote, ...meta };
  assets[id] = asset;
  saveAssets();
  return asset;
}

export const getAsset = (id) => (id ? assets[id] || null : null);
export const listAssets = () => Object.values(assets);
export const assetPath = (a) => path.join(MEDIA, a.file);
export function assetFromUrl(url) {
  const m = String(url || '').match(/\/engine\/media\/(a_[0-9a-f]+)\./);
  return m ? getAsset(m[1]) : null;
}
export function updateAsset(id, patch) {
  if (!assets[id]) return null;
  Object.assign(assets[id], patch);
  saveAssets();
  return assets[id];
}

/* ---------------- access token (remote use) ---------------- */

export function accessToken() {
  if (process.env.ENGINE_TOKEN) return process.env.ENGINE_TOKEN;
  if (!settings.accessToken) {
    settings.accessToken = crypto.randomBytes(18).toString('base64url');
    saveSettings().catch(() => {});
  }
  return settings.accessToken;
}

export function tokenMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(accessToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
