// Engine model catalog + one generate() that runs any model on any provider and returns a local asset.
import fsp from 'node:fs/promises';
import { getSettings, getAsset, assetPath, addAsset, updateAsset, newAssetPath, assetFromUrl } from './store.js';
import { download, ProviderError } from './http.js';
import * as ff from './ffmpeg.js';
import { xaiVideo, xaiExtend, xaiImage, xaiAvailable } from './providers/xai.js';
import { googleVideo, googleImage, googleAvailable } from './providers/google.js';
import { falRun } from './providers/fal.js';
import { replicateRun, replicateUpload } from './providers/replicate.js';
import { muapiRun, muapiUpload, muapiUrl } from './providers/muapi.js';
import { kieJob, kieVeo, kieUpload } from './providers/kie.js';
import { comfyRun, listTemplates } from './providers/comfy.js';
import { apimartVideo, apimartUpload, apimartAvailable } from './providers/apimart.js';
// Higgsfield-parity (tools agent): extra image/video models + tool-only models.
import { apimartImage, apimartVeoExtend } from './providers/apimart.js';
import { falUpload } from './providers/fal.js';
import { elevenAvailable } from './providers/eleven.js';
import { TOOL_MODELS } from './toolmodels.js';
import { qwenImage, qwenVideo, qwenAvailable } from './providers/qwen.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const first = (o) => (Array.isArray(o) ? o[0] : o);
const AR_ALL = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

export const PROVIDERS = {
  xai: { label: 'xAI · Grok', note: 'SuperGrok sign-in or API key' },
  google: { label: 'Google · Gemini API', note: 'API key (AI Ultra includes $100/mo Cloud credits)' },
  apimart: { label: 'ApiMart', note: 'API key — Veo 3.1, Kling, Seedance, Wan + director LLMs' },
  fal: { label: 'fal.ai', note: 'API key' },
  replicate: { label: 'Replicate', note: 'API token' },
  muapi: { label: 'muapi.ai', note: 'API key' },
  kie: { label: 'kie.ai', note: 'API key' },
  comfy: { label: 'ComfyUI', note: 'self-hosted' },
  local: { label: 'Offline (ffmpeg)', note: 'previs, free' },
  handoff: { label: 'Subscription hand-off', note: 'you generate in Flow / grok.com, Gaffer imports the clip' },
  qwen: { label: 'Qwen Cloud · Token Plan', note: 'subscription key — HappyHorse video, Qwen-Image' },
};

/* ------------------------------------------------------------------ video models */

const VIDEO = [
  { id: 'xai/grok-imagine-video-1.5', provider: 'xai', label: 'Grok Imagine Video 1.5', blurb: 'Native 1080p with audio, start + end frame.', caps: { t2v: true, i2v: true, end: true, extend: true }, durations: [6, 8, 10, 15], aspects: AR_ALL, resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'xai/grok-imagine-video-1.5-lite', provider: 'xai', label: 'Grok Imagine Video 1.5 Lite', blurb: 'Cheapest Grok video per second.', caps: { t2v: true, i2v: true, end: true, extend: true }, durations: [6, 8, 10, 15], aspects: AR_ALL, resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'xai/grok-imagine-video', provider: 'xai', label: 'Grok Imagine Video (classic)', blurb: 'Supports native extension.', caps: { t2v: true, i2v: true, end: false, extend: true }, durations: [6, 8, 10, 15], aspects: AR_ALL, resolutions: ['480p', '720p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'google/gemini-omni-1.1-flash', provider: 'google', label: 'Gemini Omni Flash', blurb: 'Google video with audio, first+last frame, multi-turn extension.', caps: { t2v: true, i2v: true, end: true, extend: true }, durations: [4, 6, 8, 10], aspects: ['16:9', '9:16'], resolutions: ['360p', '720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 10 },
  { id: 'apimart/veo3.1-quality', provider: 'apimart', label: 'Veo 3.1 Quality (ApiMart)', blurb: 'Top-tier Veo with native audio, start + end frame. 8 s clips.', caps: { t2v: true, i2v: true, end: true }, durations: [8], aspects: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 8 },
  { id: 'apimart/veo3.1-fast', provider: 'apimart', label: 'Veo 3.1 Fast (ApiMart)', blurb: 'Cheaper Veo 3.1 with native audio, start + end frame. 8 s clips.', caps: { t2v: true, i2v: true, end: true }, durations: [8], aspects: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 8 },
  { id: 'apimart/kling-v3', provider: 'apimart', label: 'Kling 3.0 (ApiMart)', blurb: 'Kling 3.0, start + end frame, 3–15 s. 720p std / 1080p pro / 4k.', caps: { t2v: true, i2v: true, end: true }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/kling-v4', provider: 'apimart', label: 'Kling V4 (ApiMart)', blurb: 'Kling V4 with native stereo audio, start + end frame, 3–30 s.', caps: { t2v: true, i2v: true, end: true }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '21:9'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/seedance-2.0', provider: 'apimart', label: 'Seedance 2.0 (ApiMart)', blurb: 'ByteDance Seedance 2.0 with audio, start + end frame, 4–15 s.', caps: { t2v: true, i2v: true, end: true }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/seedance-2.5', provider: 'apimart', label: 'Seedance 2.5 (ApiMart)', blurb: 'Seedance 2.5 with audio, start + end frame, 4–30 s.', caps: { t2v: true, i2v: true, end: true }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/wan2.6', provider: 'apimart', label: 'Wan 2.6 (ApiMart)', blurb: 'Wan 2.6, start frame, 5 / 10 / 15 s.', caps: { t2v: true, i2v: true }, durations: [5, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/wan3.0-video', provider: 'apimart', label: 'Wan 3.0 (ApiMart)', blurb: 'Wan 3.0 cinema video with audio, start + end frame, 2–30 s.', caps: { t2v: true, i2v: true, end: true }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'fal/wan22-a14b', provider: 'fal', label: 'Wan 2.2 A14B (fal)', blurb: 'Open weights, Apache-2.0. 720p, start + end frame.', caps: { t2v: true, i2v: true, end: true }, durations: [3, 5, 8], aspects: ['16:9', '9:16', '1:1'], resolutions: ['480p', '720p'], resolutionDefault: '720p', maxClip: 10 },
  { id: 'fal/ltxv-13b', provider: 'fal', label: 'LTX-Video 13B (fal)', blurb: 'Open weights, very fast.', caps: { t2v: false, i2v: true }, durations: [3, 5, 8], aspects: ['16:9', '9:16', '1:1'], resolutions: ['480p', '720p'], resolutionDefault: '720p', maxClip: 10 },
  { id: 'replicate/wan22-fast', provider: 'replicate', label: 'Wan 2.2 Fast (Replicate)', blurb: 'Open weights, 480p, start + end frame.', caps: { t2v: true, i2v: true, end: true }, durations: [5, 7], aspects: ['16:9', '9:16'], resolutions: ['480p', '720p'], resolutionDefault: '480p', maxClip: 7 },
  { id: 'muapi/veo3.1-fast-image-to-video', provider: 'muapi', label: 'Veo 3.1 Fast (muapi)', caps: { t2v: false, i2v: true }, durations: [8], aspects: ['16:9', '9:16'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 8 },
  { id: 'muapi/kling-v3.0-pro-image-to-video', provider: 'muapi', label: 'Kling 3.0 Pro (muapi)', caps: { t2v: false, i2v: true }, durations: [5, 10], aspects: ['16:9', '9:16', '1:1'], maxClip: 10 },
  { id: 'muapi/seedance-pro-i2v', provider: 'muapi', label: 'Seedance Pro (muapi)', caps: { t2v: false, i2v: true }, durations: [5, 10], aspects: ['16:9', '9:16', '1:1'], maxClip: 10 },
  { id: 'muapi/wan2.6-image-to-video', provider: 'muapi', label: 'Wan 2.6 (muapi)', caps: { t2v: false, i2v: true }, durations: [5, 10], aspects: ['16:9', '9:16', '1:1'], maxClip: 10 },
  { id: 'kie/veo3_fast', provider: 'kie', label: 'Veo 3 Fast (kie.ai)', caps: { t2v: true, i2v: true }, durations: [8], aspects: ['16:9', '9:16'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 8 },
  { id: 'kie/bytedance/seedance-2', provider: 'kie', label: 'Seedance 2.0 (kie.ai)', caps: { t2v: true, i2v: true }, durations: [5, 10], aspects: ['16:9', '9:16', '1:1', '4:3', '21:9'], resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 10 },
  { id: 'kie/kling-3.0/video', provider: 'kie', label: 'Kling 3.0 (kie.ai)', caps: { t2v: true, i2v: true }, durations: [5, 10], aspects: ['16:9', '9:16', '1:1'], maxClip: 10 },
  { id: 'local/animatic', provider: 'local', label: 'Animatic (offline previs)', blurb: 'Slow push-in on the keyframe. Free, instant, no AI.', caps: { t2v: true, i2v: true }, durations: [4, 6, 8, 10], aspects: AR_ALL, maxClip: 15 },
  { id: 'handoff/flow', provider: 'handoff', label: 'Hand-off: Google Flow (AI Ultra)', blurb: 'Generate in Flow with your Ultra credits; Gaffer imports the clip.', caps: { t2v: true, i2v: true, end: true }, durations: [8], aspects: ['16:9', '9:16'], maxClip: 8, url: 'https://labs.google/fx/tools/flow' },
  { id: 'handoff/grok', provider: 'handoff', label: 'Hand-off: Grok Imagine app (SuperGrok)', blurb: 'Generate on grok.com/imagine; Gaffer imports the clip.', caps: { t2v: true, i2v: true }, durations: [6, 10, 15], aspects: AR_ALL, maxClip: 15, url: 'https://grok.com/imagine' },
];

/* ------------------------------------------------------------------ image models */

const IMAGE = [
  { id: 'google/gemini-nano-banana-2.1', provider: 'google', label: 'Nano Banana 2.1 (Gemini)', blurb: 'Best character consistency from reference images.', refs: 6, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'google/gemini-3-pro-image', provider: 'google', label: 'Nano Banana Pro (Gemini)', refs: 6, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'xai/grok-imagine-image-2.0', provider: 'xai', label: 'Grok Imagine Image 2.0', refs: 5, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'fal/flux-dev', provider: 'fal', label: 'FLUX.1 [dev] (fal)', refs: 0, aspects: ['16:9', '9:16', '1:1', '4:3'] },
  { id: 'fal/flux-schnell', provider: 'fal', label: 'FLUX.1 [schnell] (fal)', refs: 0, aspects: ['16:9', '9:16', '1:1', '4:3'] },
  { id: 'fal/kontext-dev', provider: 'fal', label: 'FLUX Kontext [dev] edit (fal)', refs: 1, aspects: ['16:9', '9:16', '1:1', '4:3'] },
  { id: 'replicate/flux-schnell', provider: 'replicate', label: 'FLUX.1 [schnell] (Replicate)', refs: 0, aspects: ['16:9', '9:16', '1:1', '4:3', '21:9'] },
  { id: 'kie/nano-banana-2', provider: 'kie', label: 'Nano Banana 2 (kie.ai)', refs: 4, aspects: ['16:9', '9:16', '1:1', '4:3', '21:9'] },
  { id: 'local/plate', provider: 'local', label: 'Previs plate (offline)', refs: 0, aspects: AR_ALL },
];

/* ------------------------------------------------------------------ Higgsfield-parity models */
// Higgsfield's model hub carries GPT Image 2.x, Seedream 5, FLUX.2, Kling 3 Omni, Hailuo, MiniMax and Veo Lite;
// these run on ApiMart with the request shapes in providers/apimart.js. `refs` on a video model = reference images.

const PARITY_IMAGE = [
  { id: 'apimart/gpt-image-2.6-flare', provider: 'apimart', label: 'GPT Image 2.6 (ApiMart)', blurb: 'OpenAI’s newest: precise edits, text, up to 16 references.', refs: 8, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'apimart/gpt-image-2.6-sunburst', provider: 'apimart', label: 'GPT Image 2.6 Sunburst (ApiMart)', blurb: 'Precision tier for intricate detail and tight edits.', refs: 8, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'apimart/gpt-image-2', provider: 'apimart', label: 'GPT Image 2 (ApiMart)', refs: 8, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'apimart/seedream-5-0-pro', provider: 'apimart', label: 'Seedream 5.0 Pro (ApiMart)', blurb: 'ByteDance flagship, 2K, up to 10 references.', refs: 8, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'apimart/flux-2-max', provider: 'apimart', label: 'FLUX.2 Max (ApiMart)', blurb: '4 MP photoreal, up to 8 references.', refs: 7, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
];

const PARITY_VIDEO = [
  { id: 'apimart/kling-v3-omni', provider: 'apimart', label: 'Kling 3.0 Omni (ApiMart)', blurb: 'Audio, start + end frame and up to 4 reference images; 720p / 1080p / 4K.', caps: { t2v: true, i2v: true, end: true }, refs: 4, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '1080p', maxClip: 15 },
  { id: 'apimart/veo3.1-lite', provider: 'apimart', label: 'Veo 3.1 Lite (ApiMart)', blurb: 'Cheapest Veo 3.1 with audio. 8 s clips.', caps: { t2v: true, i2v: true, end: true }, durations: [8], aspects: ['16:9', '9:16'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 8 },
  { id: 'apimart/MiniMax-H3', provider: 'apimart', label: 'MiniMax H3 (ApiMart)', blurb: '2K with audio, start + end frame, reference images.', caps: { t2v: true, i2v: true, end: true }, refs: 6, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: ['768p', '2k'], resolutionDefault: '2k', maxClip: 15 },
  { id: 'apimart/MiniMax-Hailuo-2.3', provider: 'apimart', label: 'Hailuo 2.3 (ApiMart)', blurb: 'Strong physics and camera moves; 6 / 10 s.', caps: { t2v: true, i2v: true }, durations: [6, 10], aspects: ['16:9'], resolutions: ['768p', '1080p'], resolutionDefault: '768p', maxClip: 10 },
  { id: 'apimart/kling-3.0-turbo', provider: 'apimart', label: 'Kling 3.0 Turbo (ApiMart)', blurb: 'Fast Kling 3.0, 3–15 s.', caps: { t2v: true, i2v: true }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/seedance-2.0-fast', provider: 'apimart', label: 'Seedance 2.0 Fast (ApiMart)', blurb: 'Cheaper Seedance 2.0 with audio, up to 720p.', caps: { t2v: true, i2v: true, end: true }, refs: 6, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: ['480p', '720p'], resolutionDefault: '720p', maxClip: 15 },
];
// Qwen Token Plan (subscription credits). HappyHorse routes to t2v / i2v / r2v (identity-preserving references).
PARITY_VIDEO.push({ id: 'qwen/happyhorse-1.1', provider: 'qwen', label: 'HappyHorse 1.1 (Qwen plan)', blurb: 'Alibaba’s top video model on your Qwen subscription; up to 9 identity references.', caps: { t2v: true, i2v: true }, refs: 9, durations: [3, 5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 });
PARITY_IMAGE.push(
  { id: 'qwen/qwen-image-3.0-pro', provider: 'qwen', label: 'Qwen-Image 3.0 Pro (Qwen plan)', blurb: 'Strong text rendering and layout.', refs: 3, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
  { id: 'qwen/wan2.7-image-pro', provider: 'qwen', label: 'Wan 2.7 Image Pro (Qwen plan)', blurb: 'Edits with up to 4 references.', refs: 4, aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
);
// Seedance 2.x also takes reference images (and reference video/audio) when no start frame is given.
for (const m of VIDEO) if (/^apimart\/seedance-2\.[05]$/.test(m.id)) m.refs = 6;

/** Every modelKind a model can serve (tools filter GET /catalog by these). */
export function kindsOf(m) {
  if (m.kind === 'image') return ['image', ...(m.refs ? ['image-edit'] : [])];
  if (m.kind === 'video') return ['video', ...(m.caps?.t2v ? ['t2v'] : []), ...(m.caps?.i2v ? ['i2v'] : []), ...(m.caps?.end ? ['video-end'] : []), ...(m.refs ? ['video-refs'] : [])];
  return [m.kind];
}

function comfyModels() {
  return listTemplates().map((t) => ({
    id: `comfy/${t.id}`, provider: 'comfy', label: `${t.label} (ComfyUI)`, template: t, refs: t.kind === 'edit' ? 1 : 0,
    ...(t.kind === 'video' ? { caps: { t2v: t.mode !== 'i2v', i2v: t.mode !== 't2v' }, durations: [3, 5], aspects: ['16:9', '9:16', '1:1'], maxClip: 5 } : { aspects: ['16:9', '9:16', '1:1', '4:3'] }),
    kind: t.kind === 'video' ? 'video' : 'image',
  }));
}

export function availableProviders() {
  const s = getSettings();
  return {
    xai: xaiAvailable(),
    google: googleAvailable(),
    apimart: apimartAvailable(),
    fal: !!s.falKey,
    replicate: !!s.replicateToken,
    muapi: !!s.muapiKey,
    kie: !!s.kieKey,
    comfy: !!globalThis.__comfyOnline,
    local: true,
    handoff: true,
    eleven: elevenAvailable(),
    qwen: qwenAvailable(),
  };
}

export function allModels() {
  return [
    ...VIDEO.map((m) => ({ ...m, kind: 'video' })),
    ...PARITY_VIDEO.map((m) => ({ ...m, kind: 'video' })),
    ...IMAGE.map((m) => ({ ...m, kind: 'image' })),
    ...PARITY_IMAGE.map((m) => ({ ...m, kind: 'image' })),
    ...comfyModels(),
    ...TOOL_MODELS,
  ];
}

export const getModel = (id) => allModels().find((m) => m.id === id);

export function publicCatalog() {
  const avail = availableProviders();
  return allModels().map(({ template, ...m }) => ({ ...m, kinds: kindsOf(m), available: !!avail[m.provider] }));
}

/* ------------------------------------------------------------------ media plumbing */

/** Accepts an engine asset id, an /engine/media URL, or a remote URL; returns a local asset. */
export async function materialize(ref, signal) {
  if (!ref) return null;
  if (typeof ref === 'object' && ref.id) return ref;
  const local = getAsset(ref) || assetFromUrl(ref);
  if (local) return local;
  if (/^https?:\/\//.test(ref)) {
    const f = await download(ref, { signal });
    return addAsset({ buffer: f.buffer, mime: f.mime, remote: { source: ref } });
  }
  if (/^data:/.test(ref)) {
    const m = ref.match(/^data:([\w/+.-]+);base64,(.+)$/);
    return addAsset({ buffer: Buffer.from(m[2], 'base64'), mime: m[1] });
  }
  throw new Error(`unknown media reference ${String(ref).slice(0, 80)}`);
}

const age = (t) => (t ? Date.now() - Date.parse(t) : Infinity);

/** Convert a local asset into whatever the provider accepts. 'public' = a public https URL (fal CDN), for video/audio inputs. */
export async function asInput(provider, asset, signal) {
  if (!asset) return null;
  const abs = assetPath(asset);
  if (provider === 'local') return abs;
  const buffer = await fsp.readFile(abs);
  const remote = asset.remote || {};
  const cache = async (k, fn, maxAge) => {
    if (remote[k] && age(remote[`${k}At`]) < maxAge) return remote[k];
    const url = await fn();
    updateAsset(asset.id, { remote: { ...remote, [k]: url, [`${k}At`]: new Date().toISOString() } });
    return url;
  };
  switch (provider) {
    case 'google': return { mime: asset.mime, base64: buffer.toString('base64'), kind: asset.kind };
    case 'xai':
    case 'qwen':
    case 'fal': return remote.source && /^https:/.test(remote.source) && age(asset.createdAt) < 864e5 ? remote.source : `data:${asset.mime};base64,${buffer.toString('base64')}`;
    case 'replicate': return cache('replicate', () => replicateUpload({ token: getSettings().replicateToken, buffer, mime: asset.mime, filename: asset.file, signal }), 20 * 36e5);
    case 'muapi': return cache('muapi', () => muapiUpload({ buffer, mime: asset.mime, filename: asset.file }, signal), 20 * 36e5);
    case 'kie': return cache('kie', () => kieUpload({ buffer, mime: asset.mime, filename: asset.file }, signal), 20 * 36e5);
    case 'apimart': return cache('apimart', () => apimartUpload({ buffer, mime: asset.mime, filename: asset.file }, signal), 48 * 36e5);
    case 'comfy': return { buffer, mime: asset.mime, filename: `gaffer_${asset.file}` };
    case 'public': return cache('falcdn', () => falUpload({ key: getSettings().falKey, buffer, mime: asset.mime, filename: asset.file, signal }), 5 * 24 * 36e5);
    default: throw new Error(`no media path for ${provider}`);
  }
}

export async function saveResult(r, { kind, signal, meta = {} }) {
  let asset;
  if (r.buffer) asset = await addAsset({ buffer: r.buffer, mime: r.mime || (kind === 'video' ? 'video/mp4' : 'image/jpeg'), meta });
  else if (r.url) {
    const f = await download(r.url, { signal });
    asset = await addAsset({ buffer: f.buffer, mime: f.mime, remote: { source: r.url }, meta });
  } else if (r.abs) asset = await addAsset({ ...r, meta });
  else throw new Error(`provider returned no ${kind}`);
  if (asset.kind === 'video') {
    const info = await ff.probe(assetPath(asset)).catch(() => ({}));
    updateAsset(asset.id, info);
    const p = newAssetPath('image/jpeg');
    try {
      await ff.poster(assetPath(asset), p.abs);
      const posterAsset = await addAsset({ ...p, mime: 'image/jpeg', meta: { source: 'poster' } });
      updateAsset(asset.id, { posterUrl: posterAsset.url, posterId: posterAsset.id });
    } catch {}
  }
  return getAsset(asset.id);
}

const falSize = (aspect) => { const { W, H } = ff.frameSize(aspect, 1280); return { width: Math.round(W / 16) * 16, height: Math.round(H / 16) * 16 }; };

/* ------------------------------------------------------------------ generate */

/**
 * job: { model, prompt, image, endImage, refs[], aspect, duration, resolution, seed, extend: { ref, sourceDuration } }
 * Returns { asset, ref, trimStart }
 */
export async function generate(job, { onStatus, signal } = {}) {
  const m = getModel(job.model);
  if (!m) throw new Error(`unknown model ${job.model}`);
  if (m.provider === 'handoff') throw new Error('hand-off models are completed by importing a clip');
  if (m.kind !== 'image' && m.kind !== 'video') throw new Error(`${m.label} is a tool model — run it from Tools (/engine/api/tools)`);
  const avail = availableProviders();
  if (!avail[m.provider]) throw new ProviderError(m.provider, 0, `${PROVIDERS[m.provider]?.label || m.provider} is not connected — open Providers`);
  const P = m.provider;
  const slug = m.id.slice(P.length + 1);
  const ctx = { onStatus, signal };
  const startA = await materialize(job.image, signal);
  const endA = await materialize(job.endImage, signal);
  const refAs = await Promise.all((job.refs || []).slice(0, m.refs ?? 0).map((r) => materialize(r, signal)));
  const img = startA && (await asInput(P, startA, signal));
  const end = endA && m.caps?.end ? await asInput(P, endA, signal) : null;
  const refs = await Promise.all(refAs.map((a) => asInput(P, a, signal)));
  const dur = clamp(Number(job.duration) || 5, 1, m.maxClip || 15);
  const seed = Number.isInteger(job.seed) ? job.seed : undefined;
  const meta = { model: m.id, prompt: job.prompt };

  if (m.kind === 'image') {
    let r;
    switch (P) {
      case 'google': r = await googleImage({ model: slug, prompt: job.prompt, image: img, refs, aspect: job.aspect }, ctx); break;
      case 'xai': r = await xaiImage({ model: slug, prompt: job.prompt, image: img, refs, aspect: job.aspect }, ctx); break;
      case 'fal': {
        const ep = { 'flux-dev': 'fal-ai/flux/dev', 'flux-schnell': 'fal-ai/flux/schnell', 'kontext-dev': 'fal-ai/flux-kontext/dev' }[slug];
        const input = slug === 'kontext-dev'
          ? { prompt: job.prompt, image_url: img || refs[0], resolution_mode: 'match_input', seed }
          : { prompt: job.prompt, image_size: falSize(job.aspect), seed, num_inference_steps: slug === 'flux-schnell' ? 4 : 28, output_format: 'jpeg' };
        if (slug === 'kontext-dev' && !input.image_url) throw new Error('Kontext needs a source image');
        r = { url: (await falRun({ key: getSettings().falKey, endpoint: ep, input, onStatus, signal })).images?.[0]?.url };
        break;
      }
      case 'replicate': r = { url: first(await replicateRun({ token: getSettings().replicateToken, model: 'black-forest-labs/flux-schnell', input: { prompt: job.prompt, aspect_ratio: job.aspect === '3:4' ? '3:4' : job.aspect, output_format: 'jpg', seed, go_fast: true }, onStatus, signal })) }; break;
      case 'kie': r = await kieJob({ model: 'nano-banana-2', input: { prompt: job.prompt, aspect_ratio: job.aspect, output_format: 'jpg', ...(img || refs.length ? { image_input: [img, ...refs].filter(Boolean) } : {}) } }, ctx); break;
      case 'qwen': r = await qwenImage({ model: slug, prompt: job.prompt, images: [img, ...refs].filter(Boolean), aspect: job.aspect }, ctx); break;
      case 'apimart': {
        const maskA = await materialize(job.mask, signal);
        r = await apimartImage({ model: slug, label: m.label, prompt: job.prompt, image: img, refs, aspect: job.aspect, resolution: job.resolution, mask: maskA && (await asInput('apimart', maskA, signal)), format: job.format }, ctx);
        break;
      }
      case 'comfy': {
        const { W, H } = ff.frameSize(job.aspect, 1280);
        r = await comfyRun({ base: getSettings().comfyUrl, template: m.template, vars: { prompt: job.prompt, seed: seed ?? Math.floor(Math.random() * 2 ** 31), width: Math.round(W / 16) * 16, height: Math.round(H / 16) * 16, negative: '' }, files: { image: img || refs[0] }, kind: 'image', onStatus, signal });
        break;
      }
      case 'local': {
        const out = newAssetPath('image/jpeg');
        await ff.plate({ out: out.abs, aspect: job.aspect, prompt: job.prompt, signal });
        r = { ...out, mime: 'image/jpeg' };
        break;
      }
      default: throw new Error(`${P} cannot make images`);
    }
    return { asset: await saveResult(r, { kind: 'image', signal, meta }) };
  }

  /* ---- video ---- */
  if (!img && !m.caps?.t2v) throw new Error(`${m.label} needs a start frame`);
  let r;
  let trimStart = 0;
  const ext = job.extend;
  switch (P) {
    case 'xai': {
      if (ext?.ref?.provider === 'xai' && ext.ref.videoUrl && !ext.ref.extended && (ext.ref.duration || 0) <= 15) {
        r = await xaiExtend({ videoUrl: ext.ref.videoUrl, prompt: job.prompt, duration: Math.min(10, dur) }, ctx);
        trimStart = ext.ref.duration || ext.sourceDuration || 0;
      } else {
        r = await xaiVideo({ model: slug, prompt: job.prompt, image: img, endImage: end, aspect: job.aspect, duration: dur, resolution: job.resolution || m.resolutionDefault }, ctx);
      }
      break;
    }
    case 'google': {
      const prev = ext?.ref?.provider === 'google' ? ext.ref.interactionId : null;
      r = await googleVideo({ model: slug, prompt: prev ? `Continue the scene: ${job.prompt}` : job.prompt, image: img, endImage: end, aspect: job.aspect, resolution: job.resolution || '720p', duration: dur, previousInteractionId: prev }, ctx);
      if (prev) r.maybeIncludesSource = ext.sourceDuration || 0;
      break;
    }
    case 'apimart': {
      // Native Veo 3.1 extension when the previous clip was rendered by the same ApiMart Veo model.
      if (ext?.ref?.provider === 'apimart' && ext.ref.taskId && ext.ref.model === slug && /^veo3\.1-(fast|quality)$/.test(slug)) {
        r = await apimartVeoExtend({ taskId: ext.ref.taskId, model: slug, prompt: job.prompt, aspect: job.aspect, resolution: job.resolution || m.resolutionDefault }, ctx);
        break;
      }
      // Reference video / audio (Seedance 2.x, MiniMax H3) must be public URLs — hosted on fal's CDN.
      const pub = async (list) => Promise.all((list || []).slice(0, 3).map(async (x) => asInput('public', await materialize(x, signal), signal)));
      r = await apimartVideo({ model: slug, label: m.label, prompt: job.prompt, image: img, endImage: end, refs, videos: await pub(job.videos), audios: await pub(job.audios), aspect: job.aspect, resolution: job.resolution || m.resolutionDefault, duration: dur, seed }, ctx);
      break;
    }
    case 'qwen': r = await qwenVideo({ prompt: job.prompt, image: img, refs, aspect: job.aspect, resolution: job.resolution || m.resolutionDefault, duration: dur, seed }, ctx); break;
    case 'fal': {
      const vAspect = ['16:9', '9:16', '1:1'].includes(job.aspect) ? job.aspect : '16:9';
      if (slug === 'wan22-a14b') {
        const input = { prompt: job.prompt, num_frames: clamp(Math.round(dur * 16) + 1, 17, 161), frames_per_second: 16, resolution: job.resolution === '480p' ? '480p' : '720p', aspect_ratio: img ? 'auto' : vAspect, seed, enable_prompt_expansion: false, ...(img && { image_url: img }), ...(img && end && { end_image_url: end }) };
        r = { url: (await falRun({ key: getSettings().falKey, endpoint: img ? 'fal-ai/wan/v2.2-a14b/image-to-video' : 'fal-ai/wan/v2.2-a14b/text-to-video', input, onStatus, signal })).video?.url };
      } else {
        const frames = clamp(Math.round((dur * 24) / 8) * 8 + 1, 9, 1441);
        r = { url: (await falRun({ key: getSettings().falKey, endpoint: 'fal-ai/ltxv-13b-098-distilled/image-to-video', input: { prompt: job.prompt, image_url: img, num_frames: frames, frame_rate: 24, resolution: '720p', aspect_ratio: 'auto', seed }, onStatus, signal })).video?.url };
      }
      break;
    }
    case 'replicate': {
      const frames = clamp(Math.round(dur * 16) + 1, 81, 121);
      const out = img
        ? await replicateRun({ token: getSettings().replicateToken, model: 'wan-video/wan-2.2-i2v-fast', input: { prompt: job.prompt, image: img, ...(end && { last_image: end }), num_frames: frames, resolution: job.resolution || '480p', frames_per_second: 16, go_fast: true, seed }, onStatus, signal })
        : await replicateRun({ token: getSettings().replicateToken, model: 'wan-video/wan-2.2-t2v-fast', input: { prompt: job.prompt, aspect_ratio: job.aspect === '9:16' ? '9:16' : '16:9', num_frames: frames, resolution: job.resolution || '480p', frames_per_second: 16, go_fast: true, seed }, onStatus, signal });
      r = { url: first(out) };
      break;
    }
    case 'muapi': {
      const out = await muapiRun({ endpoint: slug, input: { prompt: job.prompt, image_url: img, aspect_ratio: job.aspect, duration: dur, ...(job.resolution && { resolution: job.resolution }) } }, ctx);
      r = { url: muapiUrl(out) };
      break;
    }
    case 'kie': {
      if (slug === 'veo3_fast') r = await kieVeo({ model: 'veo3_fast', prompt: job.prompt, image: img, aspect: job.aspect, resolution: job.resolution }, ctx);
      else {
        const input = { prompt: job.prompt, aspect_ratio: job.aspect, duration: String(dur), ...(job.resolution && { resolution: job.resolution }) };
        if (img) input.image_urls = [img];
        r = await kieJob({ model: slug, input }, ctx);
      }
      break;
    }
    case 'comfy': {
      const { W, H } = ff.frameSize(job.aspect, 1280);
      r = await comfyRun({ base: getSettings().comfyUrl, template: m.template, vars: { prompt: job.prompt, negative: '', seed: seed ?? Math.floor(Math.random() * 2 ** 31), width: Math.floor(W / 32) * 32, height: Math.floor(H / 32) * 32, fps: 24, frames: Math.round(dur * 24) + 1 }, files: { image: img }, kind: 'video', onStatus, signal });
      break;
    }
    case 'local': {
      let src = img;
      if (!src) {
        const p = newAssetPath('image/jpeg');
        await ff.plate({ out: p.abs, aspect: job.aspect, prompt: job.prompt, signal });
        src = p.abs;
      }
      const out = newAssetPath('video/mp4');
      onStatus?.({ message: 'Rendering animatic' });
      await ff.animatic({ image: src, out: out.abs, duration: dur, aspect: job.aspect, signal });
      r = { ...out, mime: 'video/mp4' };
      break;
    }
    default: throw new Error(`${P} cannot make video`);
  }
  onStatus?.({ message: 'Downloading result' });
  const asset = await saveResult(r, { kind: 'video', signal, meta });
  // Extension endpoints may return source + continuation; keep only the new part.
  if (r.maybeIncludesSource && asset.duration > r.maybeIncludesSource + dur * 0.6) trimStart = r.maybeIncludesSource;
  if (trimStart && asset.duration && trimStart >= asset.duration - 0.5) trimStart = 0;
  return { asset, ref: r.ref || null, trimStart };
}
