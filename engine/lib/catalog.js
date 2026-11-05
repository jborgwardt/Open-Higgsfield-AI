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
import { apimartVideo, apimartUpload, apimartAvailable, apimartAvatarAsset } from './providers/apimart.js';

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
};

/* ------------------------------------------------------------------ video models */

const VIDEO = [
  { id: 'xai/grok-imagine-video-1.5', provider: 'xai', label: 'Grok Imagine Video 1.5', blurb: 'Native 1080p with audio, start + end frame, up to 14 character references (720p).', caps: { t2v: true, i2v: true, end: true, extend: true, refs: 14, refsWithImage: true, refTag: 'xai' }, durations: [6, 8, 10, 15], aspects: AR_ALL, resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'xai/grok-imagine-video-1.5-lite', provider: 'xai', label: 'Grok Imagine Video 1.5 Lite', blurb: 'Cheapest Grok video per second.', caps: { t2v: true, i2v: true, end: true, extend: true }, durations: [6, 8, 10, 15], aspects: AR_ALL, resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'xai/grok-imagine-video', provider: 'xai', label: 'Grok Imagine Video (classic)', blurb: 'Supports native extension and up to 7 character references.', caps: { t2v: true, i2v: true, end: false, extend: true, refs: 7, refTag: 'xai' }, durations: [6, 8, 10, 15], aspects: AR_ALL, resolutions: ['480p', '720p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'google/gemini-omni-1.1-flash', provider: 'google', label: 'Gemini Omni Flash', blurb: 'Google video with audio, first+last frame, multi-turn extension. Refuses real people\'s likeness.', caps: { t2v: true, i2v: true, end: true, extend: true, noRealPeople: true }, durations: [4, 6, 8, 10], aspects: ['16:9', '9:16'], resolutions: ['360p', '720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 10 },
  { id: 'apimart/veo3.1-quality', provider: 'apimart', label: 'Veo 3.1 Quality (ApiMart)', blurb: 'Top-tier Veo with native audio, start + end frame. 8 s clips.', caps: { t2v: true, i2v: true, end: true }, durations: [8], aspects: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 8 },
  { id: 'apimart/veo3.1-fast', provider: 'apimart', label: 'Veo 3.1 Fast (ApiMart)', blurb: 'Cheaper Veo 3.1 with native audio, start + end frame, or up to 3 character references. 8 s clips.', caps: { t2v: true, i2v: true, end: true, refs: 3, refTag: 'plain' }, durations: [8], aspects: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 8 },
  { id: 'apimart/kling-v3', provider: 'apimart', label: 'Kling 3.0 (ApiMart)', blurb: 'Kling 3.0, start + end frame, 3–15 s. 720p std / 1080p pro / 4k.', caps: { t2v: true, i2v: true, end: true }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/kling-v4', provider: 'apimart', label: 'Kling V4 (ApiMart)', blurb: 'Kling V4 with native stereo audio, start + end frame or up to 10 character references, 3–30 s.', caps: { t2v: true, i2v: true, end: true, refs: 10, refTag: 'kling' }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '21:9'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/kling-v3-omni', provider: 'apimart', label: 'Kling 3.0 Omni (ApiMart)', blurb: 'Kling 3.0 Omni: up to 7 character references, start + end frame, 3–15 s.', caps: { t2v: true, i2v: true, end: true, refs: 7, refTag: 'omni' }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1'], resolutions: ['720p', '1080p', '4k'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/seedance-2.0', provider: 'apimart', label: 'Seedance 2.0 (ApiMart)', blurb: 'ByteDance Seedance 2.0 with audio, start + end frame or character references, 4–15 s.', caps: { t2v: true, i2v: true, end: true, refs: 9, refTag: 'plain' }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/seedance-2.5', provider: 'apimart', label: 'Seedance 2.5 (ApiMart)', blurb: 'Seedance 2.5 with audio, start + end frame or character references, 4–30 s.', caps: { t2v: true, i2v: true, end: true, refs: 30, refTag: 'plain' }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/wan2.6', provider: 'apimart', label: 'Wan 2.6 (ApiMart)', blurb: 'Wan 2.6, start frame, 5 / 10 / 15 s.', caps: { t2v: true, i2v: true }, durations: [5, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['720p', '1080p'], resolutionDefault: '720p', maxClip: 15 },
  { id: 'apimart/wan2.7-r2v', provider: 'apimart', label: 'Wan 2.7 Reference-to-Video (ApiMart)', blurb: 'Keeps characters consistent from up to 5 references (+ optional start frame), 2–15 s. Needs a character or start frame.', caps: { t2v: false, i2v: true, refs: 5, refsWithImage: true, refTag: 'plain' }, durations: [5, 8, 10, 15], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['720p', '1080p'], resolutionDefault: '1080p', maxClip: 15 },
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
  };
}

export function allModels() {
  return [
    ...VIDEO.map((m) => ({ ...m, kind: 'video' })),
    ...IMAGE.map((m) => ({ ...m, kind: 'image' })),
    ...comfyModels(),
  ];
}

export const getModel = (id) => allModels().find((m) => m.id === id);

export function publicCatalog() {
  const avail = availableProviders();
  return allModels().map(({ template, ...m }) => ({ ...m, available: !!avail[m.provider] }));
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

/** Convert a local asset into whatever the provider accepts. */
async function asInput(provider, asset, signal) {
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
    case 'fal': return remote.source && /^https:/.test(remote.source) && age(asset.createdAt) < 864e5 ? remote.source : `data:${asset.mime};base64,${buffer.toString('base64')}`;
    case 'replicate': return cache('replicate', () => replicateUpload({ token: getSettings().replicateToken, buffer, mime: asset.mime, filename: asset.file, signal }), 20 * 36e5);
    case 'muapi': return cache('muapi', () => muapiUpload({ buffer, mime: asset.mime, filename: asset.file }, signal), 20 * 36e5);
    case 'kie': return cache('kie', () => kieUpload({ buffer, mime: asset.mime, filename: asset.file }, signal), 20 * 36e5);
    case 'apimart': return cache('apimart', () => apimartUpload({ buffer, mime: asset.mime, filename: asset.file }, signal), 48 * 36e5);
    case 'comfy': return { buffer, mime: asset.mime, filename: `gaffer_${asset.file}` };
    default: throw new Error(`no media path for ${provider}`);
  }
}

async function saveResult(r, { kind, signal, meta = {} }) {
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

/** asset → asset://… id in ApiMart's Seedance avatar library (free; cached on the asset). */
async function seedanceRef(asset, url, signal) {
  if (asset.remote?.seedanceAsset) return asset.remote.seedanceAsset;
  const id = await apimartAvatarAsset({ url, name: asset.id }, { signal });
  updateAsset(asset.id, { remote: { ...(getAsset(asset.id)?.remote || {}), seedanceAsset: id } });
  return id;
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
  const avail = availableProviders();
  if (!avail[m.provider]) throw new ProviderError(m.provider, 0, `${PROVIDERS[m.provider]?.label || m.provider} is not connected — open Providers`);
  // Characters: route their best references into whatever this model can take (engine/lib/characters.js).
  if (job.characters?.length) {
    const next = await (await import('./characters.js')).applyCharacters(job, m, { onStatus, signal });
    if (next.model !== job.model) return generate(next, { onStatus, signal }); // e.g. Omni can't animate real people
    job = next;
  }
  const P = m.provider;
  const slug = m.id.slice(P.length + 1);
  const ctx = { onStatus, signal };
  const startA = await materialize(job.image, signal);
  const endA = await materialize(job.endImage, signal);
  const refMax = m.kind === 'image' ? m.refs ?? 0 : job.refMode ? m.caps?.refs ?? 0 : 0;
  const refAs = await Promise.all((job.refs || []).slice(0, refMax).map((r) => materialize(r, signal)));
  const img = startA && (await asInput(P, startA, signal));
  const end = endA && m.caps?.end ? await asInput(P, endA, signal) : null;
  const refs = await Promise.all(refAs.map((a) => asInput(P, a, signal)));
  const dur = clamp(Number(job.duration) || 5, 1, m.maxClip || 15);
  const seed = Number.isInteger(job.seed) ? job.seed : undefined;
  const meta = { model: m.id, prompt: job.prompt, ...(job.characterIds?.length && { characters: job.characterIds }) };

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
  if (!img && !m.caps?.t2v && !(job.refMode && refs.length)) throw new Error(`${m.label} needs a start frame${m.caps?.refs ? ' or a character' : ''}`);
  let r;
  let trimStart = 0;
  const ext = job.extend;
  switch (P) {
    case 'xai': {
      if (ext?.ref?.provider === 'xai' && ext.ref.videoUrl && !ext.ref.extended && (ext.ref.duration || 0) <= 15) {
        r = await xaiExtend({ videoUrl: ext.ref.videoUrl, prompt: job.prompt, duration: Math.min(10, dur) }, ctx);
        trimStart = ext.ref.duration || ext.sourceDuration || 0;
      } else {
        r = await xaiVideo({ model: slug, prompt: job.prompt, image: img, endImage: end, aspect: job.aspect, duration: dur, resolution: job.resolution || m.resolutionDefault, refs: job.refMode ? refs : null }, ctx);
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
      // Seedance blocks real faces given as raw URLs: register them once in ApiMart's private avatar library.
      const vrefs = job.refMode ? (/^seedance/.test(slug) ? await Promise.all(refAs.map((a, i) => seedanceRef(a, refs[i], signal))) : refs) : [];
      r = await apimartVideo({ model: slug, label: m.label, prompt: job.prompt, image: img, endImage: end, aspect: job.aspect, resolution: job.resolution || m.resolutionDefault, duration: dur, seed, refs: vrefs }, ctx);
      break;
    }
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
