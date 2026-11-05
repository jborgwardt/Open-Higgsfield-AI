// ApiMart (https://api.apimart.ai/v1) — one key for premium video (Veo 3.1, Kling, Seedance, Wan)
// and hundreds of OpenAI-compatible LLMs (used as a director). Video is async: submit a task, poll
// /tasks/{id}. Generation endpoints take public image URLs only, so frames go through /uploads/images.
import { getSettings } from '../store.js';
import { fetchJSON, sleep, ProviderError } from '../http.js';

export const APIMART = 'https://api.apimart.ai/v1';
export const APIMART_DIRECTOR_DEFAULT = 'claude-haiku-5-5';
// Suggestions for the director model picker (any chat model ApiMart lists works).
export const APIMART_LLMS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'gemini-3.8-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'gpt-5.4-mini', 'qwen3.8-max', 'kimi-k3'];

export const apimartAvailable = () => !!getSettings().apimartKey;
const key = () => {
  const k = getSettings().apimartKey;
  if (!k) throw new ProviderError('apimart', 0, 'no ApiMart key — add one in Providers');
  return k;
};
const H = (json = true) => ({ Authorization: `Bearer ${key()}`, ...(json ? { 'Content-Type': 'application/json' } : {}) });

function check(j) {
  const code = Number(j?.code);
  if (code && code !== 200) {
    const msg = j.error?.message || j.message || j.msg || 'error';
    throw new ProviderError('apimart', code, msg, { quota: code === 402 || code === 429, retryable: code === 429 || code >= 500 });
  }
  return j;
}

/** Upload a frame; returns a public URL valid for 72 h. */
export async function apimartUpload({ buffer, mime, filename }, signal) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  const j = check(await fetchJSON('apimart', `${APIMART}/uploads/images`, { method: 'POST', headers: H(false), body: fd, signal }));
  const url = j.url || j.data?.url;
  if (!url) throw new ProviderError('apimart', 0, 'upload returned no URL');
  return url;
}

export async function apimartModels(signal) {
  const j = await fetchJSON('apimart', `${APIMART}/models`, { headers: H(false), signal: signal || AbortSignal.timeout(15000) });
  return (j.data || []).map((m) => m.id);
}

const firstUrl = (u) => {
  if (Array.isArray(u)) { for (const x of u) { const r = firstUrl(x); if (r) return r; } return null; }
  if (u && typeof u === 'object') return firstUrl(u.url || u.video_url || u.image_url);
  return typeof u === 'string' && u.trim() ? u.trim() : null;
};

async function waitTask(taskId, kind, { onStatus, signal, label = 'ApiMart' } = {}) {
  for (let i = 0; i < 800; i++) {
    await sleep(i < 6 ? 3000 : 5000, signal);
    let j;
    try {
      j = check(await fetchJSON('apimart', `${APIMART}/tasks/${encodeURIComponent(taskId)}?language=en`, { headers: H(false), signal }));
    } catch (e) {
      if (e.retryable && !signal?.aborted) continue; // transient gateway hiccup — keep polling
      throw e;
    }
    const d = j.data && !Array.isArray(j.data) ? j.data : j;
    const st = String(d.status || '').toLowerCase();
    if (['completed', 'succeeded', 'success'].includes(st)) {
      const res = d.result || {};
      const url = firstUrl(res[kind === 'video' ? 'videos' : 'images']) || firstUrl(d[`${kind}_url`]) || firstUrl(res.url);
      if (!url) throw new ProviderError('apimart', 0, `task finished without a ${kind} URL`);
      const extra = kind === 'image' ? (res.images || []).map((x) => firstUrl(x)).filter(Boolean) : [];
      return { url, urls: extra.length > 1 ? extra : undefined, cost: d.cost ?? null, taskId };
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(st)) {
      const err = d.error?.message || d.error || d.message || `generation ${st}`;
      throw new ProviderError('apimart', 0, typeof err === 'string' ? err : JSON.stringify(err));
    }
    const pct = Number(d.progress) || 0;
    onStatus?.({ message: `${label} · ${st || 'queued'}${pct ? ` ${pct}%` : ''}`, ...(pct ? { progress: pct / 100 } : {}) });
  }
  throw new ProviderError('apimart', 0, 'timed out');
}

/* ---------------- video request bodies (per model, from docs.apimart.ai) ---------------- */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const res = (r, list, fallback) => pick(String(r || '').toLowerCase(), list, fallback);
const roles = (img, end) => [{ url: img, role: 'first_frame' }, ...(end ? [{ url: end, role: 'last_frame' }] : [])];

// refs = character reference images (reference-to-video). A start frame always wins over refs on models that
// can't combine the two; the router (characters.js) only sends refs without a frame to those.
const asRefs = (refs) => (refs || []).map((url) => ({ url, role: 'reference_image' }));
const veo = ({ prompt, img, end, aspect, resolution, refs }) => ({
  prompt, duration: 8, aspect_ratio: pick(aspect, ['16:9', '9:16'], '16:9'), resolution: res(resolution, ['720p', '1080p', '4k'], '720p'),
  ...(img ? { image_urls: [img, end].filter(Boolean), generation_type: 'frame' } : refs?.length ? { image_urls: refs.slice(0, 3), generation_type: 'reference' } : {}),
});
const seedance = (maxDur, maxRefs) => ({ prompt, img, end, aspect, resolution, dur, seed, refs }) => ({
  prompt, duration: clamp(Math.round(dur), 4, maxDur), resolution: res(resolution, ['480p', '720p', '1080p'], '720p'),
  size: img ? 'adaptive' : pick(aspect, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], '16:9'),
  ...(img ? { image_with_roles: roles(img, end) } : refs?.length ? { image_with_roles: asRefs(refs.slice(0, maxRefs)) } : {}), ...(seed != null && { seed }),
});
// Seedance 2.x reference mode (no first/last frame): reference videos and audio (e.g. a voice line). Reference
// images ride in image_with_roles (seedance() above, asset:// ids for faces); image_urls would be mutually exclusive.
const refMedia = ({ img, videos = [], audios = [] }) => (img ? {} : {
  ...(videos.length && { video_urls: videos.slice(0, 3) }), ...(audios.length && { audio_urls: audios.slice(0, 3) }),
});

const BODY = {
  'veo3.1-quality': veo,
  'veo3.1-fast': veo,
  'kling-v3': ({ prompt, img, end, aspect, resolution, dur }) => ({
    prompt, duration: clamp(Math.round(dur), 3, 15), mode: { '720p': 'std', '1080p': 'pro', '4k': '4k' }[res(resolution, ['720p', '1080p', '4k'], '720p')],
    aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1'], '16:9'), watermark: false, ...(img && { image_urls: [img, end].filter(Boolean) }),
  }),
  'kling-v4': ({ prompt, img, end, aspect, resolution, dur, refs }) => ({
    prompt, duration: clamp(Math.round(dur), 3, 30), resolution: res(resolution, ['720p', '1080p'], '720p'),
    ...(img ? { image_urls: [img, end].filter(Boolean) } : { aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1', '21:9'], '16:9') }),
    // Reference-based generation: refs are @Image1… in the prompt.
    ...(!img && refs?.length && { image_with_roles: asRefs(refs.slice(0, 10)), omni_reference_task_type: 'reference' }),
  }),
  'seedance-2.0': (a) => ({ ...seedance(15, 9)(a), ...refMedia(a) }),
  'seedance-2.5': (a) => ({ ...seedance(30, 30)(a), watermark: false, ...(!a.img && a.refs?.length && { omni_reference_task_type: 'reference' }), ...refMedia(a) }),
  // Reference-to-video: refs are "image 1…" in the prompt; an optional first frame rides along (≤ 5 images in all).
  'wan2.7-r2v': ({ prompt, img, aspect, resolution, dur, seed, refs }) => ({
    prompt, duration: clamp(Math.round(dur), 2, 15), resolution: res(resolution, ['720p', '1080p'], '1080p').toUpperCase(), watermark: false, prompt_extend: false,
    ...(img ? {} : { size: pick(aspect, ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9') }),
    image_with_roles: [...asRefs((refs || []).slice(0, img ? 4 : 5)), ...(img ? [{ url: img, role: 'first_frame' }] : [])],
    ...(seed != null && { seed }),
  }),
  'wan2.6': ({ prompt, img, aspect, resolution, dur, seed }) => ({
    prompt, duration: nearest([5, 10, 15], dur), resolution: res(resolution, ['720p', '1080p'], '720p'), watermark: false,
    ...(img ? { image_urls: [img] } : { aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9') }), ...(seed != null && { seed }),
  }),
  // --- Higgsfield-parity additions ---
  'veo3.1-lite': ({ prompt, img, end, aspect, resolution }) => ({
    prompt, duration: 8, aspect_ratio: pick(aspect, ['16:9', '9:16'], '16:9'), resolution: res(resolution, ['720p', '1080p'], '720p'),
    ...(img && { image_urls: [img, end].filter(Boolean) }),
  }),
  'seedance-2.0-fast': (a) => ({ ...seedance(15, 9)({ ...a, resolution: res(a.resolution, ['480p', '720p'], '720p') }), ...refMedia(a) }),
  'kling-v3-omni': ({ prompt, img, end, refs = [], aspect, resolution, dur }) => {
    const withRoles = img ? [{ url: img, role: 'first_frame' }, ...(end ? [{ url: end, role: 'last_frame' }] : []), ...refs.slice(0, 4).map((url) => ({ url, role: 'reference' }))] : null;
    return {
      prompt, duration: clamp(Math.round(dur), 3, 15), mode: { '720p': 'std', '1080p': 'pro', '4k': '4k' }[res(resolution, ['720p', '1080p', '4k'], '720p')],
      aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1'], '16:9'), audio: true,
      ...(withRoles ? { image_with_roles: withRoles } : refs.length ? { image_urls: refs.slice(0, 7) } : {}),
    };
  },
  'kling-3.0-turbo': ({ prompt, img, aspect, resolution, dur }) => ({
    prompt, duration: clamp(Math.round(dur), 3, 15), resolution: res(resolution, ['720p', '1080p'], '720p'),
    ...(img ? { first_frame_image: img } : { aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1'], '16:9') }),
  }),
  'MiniMax-Hailuo-2.3': ({ prompt, img, resolution, dur }) => {
    const r = res(resolution, ['768p', '1080p'], '768p');
    return { prompt: prompt.slice(0, 2000), resolution: r, duration: r === '1080p' ? 6 : dur > 7 ? 10 : 6, prompt_optimizer: true, watermark: false, ...(img && { first_frame_image: img }) };
  },
  'MiniMax-H3': ({ prompt, img, end, refs = [], videos = [], audios = [], aspect, resolution, dur }) => ({
    prompt, duration: clamp(Math.round(dur), 4, 15), resolution: /2k|1080|4k/i.test(resolution || '') ? '2K' : '768P', watermark: false,
    ...(!img && { aspect_ratio: pick(aspect, ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], '16:9') }),
    ...(img && { first_frame_image: img }), ...(img && end && { last_frame_image: end }),
    ...(!img && refs.length && { image_urls: refs.slice(0, 9) }), ...(!img && videos.length && { video_urls: videos.slice(0, 3) }),
    ...(!img && audios.length && (refs.length || videos.length) && { audio_urls: audios.slice(0, 3) }),
  }),
  'wan3.0-video': ({ prompt, img, end, aspect, resolution, dur, seed }) => ({
    prompt, duration: clamp(Math.round(dur), 2, 30), resolution: res(resolution, ['480p', '720p', '1080p'], '720p').toUpperCase(), watermark: false,
    size: img ? 'adaptive' : pick(aspect, ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9'),
    ...(img && { image_with_roles: roles(img, end) }), ...(seed != null && { seed }),
  }),
};

/** Request body for a video model (exported so request shapes can be unit-tested offline). */
export function videoBody(p) {
  const build = BODY[p.model];
  if (!build) throw new ProviderError('apimart', 0, `no request shape for ${p.model}`);
  return { model: p.model, ...build({ prompt: String(p.prompt || '').slice(0, 4000), img: p.image, end: p.endImage, refs: (p.refs || []).filter(Boolean), videos: p.videos || [], audios: p.audios || [], aspect: p.aspect, resolution: p.resolution, dur: Number(p.duration) || 5, seed: p.seed }) };
}

/** Older name for videoBody (character request-shape tests). */
export const apimartVideoBody = (p) => videoBody(p);

/** p: { model, prompt, image (URL), endImage (URL), refs/videos/audios (URLs, reference-capable models), aspect, resolution, duration, seed } */
export async function apimartVideo(p, ctx = {}) {
  const r = await apimartTask('/videos/generations', videoBody(p), 'video', { ...ctx, label: p.label || p.model });
  // taskId lets Veo 3.1 clips be natively extended later (remix endpoint).
  return { ...r, ref: { provider: 'apimart', taskId: r.taskId, model: p.model } };
}

/* ======================= Higgsfield-parity additions (tools, images, edits) ======================= */

/** Submit any ApiMart async generation and wait for its media. Returns { url, urls?, cost, taskId }. */
export async function apimartTask(path, body, kind, ctx = {}) {
  const j = check(await fetchJSON('apimart', `${APIMART}${path}`, { method: 'POST', headers: H(), body: JSON.stringify(body), signal: ctx.signal }));
  const d = Array.isArray(j.data) ? j.data[0] : j.data || j;
  const taskId = d?.task_id || d?.id || j.task_id;
  if (!taskId) throw new ProviderError('apimart', 0, `no task id in reply: ${JSON.stringify(j).slice(0, 200)}`);
  const label = ctx.label || body.model;
  ctx.onStatus?.({ message: `Queued on ApiMart · ${label}`, remoteId: taskId });
  return waitTask(taskId, kind, { ...ctx, label });
}

// Image models (docs.apimart.ai/en/api-reference/images/*). All async: POST /images/generations → task.
const lower = (v, list, fb) => pick(String(v || '').toLowerCase(), list, fb);
const GPT_SIZES = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9'];
const gptImage = ({ prompt, images, aspect, resolution }) => ({
  prompt, n: 1, size: pick(aspect, GPT_SIZES, images.length ? 'auto' : '1:1'), resolution: lower(resolution, ['1k', '2k', '4k'], '2k'),
  ...(images.length && { image_urls: images.slice(0, 15) }),
});
const gpt26 = (a) => ({
  ...gptImage(a), quality: 'high', output_format: a.format || 'png', ...(a.mask && { mask_url: a.mask }),
  // SVG: the image model draws a reference, then a text model authors clean vector paths.
  ...(a.format === 'svg' && { n: 1, image_urls: undefined, svg: { model: 'gpt-5.4-mini' } }),
});
export const IMAGE_BODY = {
  'gpt-image-2': gptImage,
  'gpt-image-2.6-flare': gpt26,
  'gpt-image-2.6-sunburst': gpt26,
  'seedream-5-0-pro': ({ prompt, images, aspect }) => ({
    prompt, size: pick(aspect, ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'], 'auto'), resolution: '2K', output_format: 'jpeg', watermark: false,
    ...(images.length && { image_urls: images.slice(0, 10) }),
  }),
  'flux-2-max': ({ prompt, images, aspect }) => ({
    prompt, size: pick(aspect, ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'], images.length ? 'auto' : '16:9'), resolution: '4MP', output_format: 'jpeg', safety_tolerance: 2,
    ...(images.length && { image_urls: images.slice(0, 8) }),
  }),
};

export function imageBody(p) {
  const build = IMAGE_BODY[p.model];
  if (!build) throw new ProviderError('apimart', 0, `no request shape for ${p.model}`);
  const images = [p.image, ...(p.refs || [])].filter(Boolean);
  const body = { model: p.model, ...build({ prompt: String(p.prompt || '').slice(0, 30000), images, aspect: p.aspect && p.aspect !== 'auto' ? p.aspect : null, resolution: p.resolution, mask: p.mask, format: p.format }) };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/** p: { model, prompt, image (URL), refs (URLs), aspect, resolution, mask (URL), format } */
export async function apimartImage(p, ctx = {}) {
  return apimartTask('/images/generations', imageBody(p), 'image', { ...ctx, label: p.label || p.model });
}

/** Motion control: character image + driving video → video (Kling v3 / v2.6). */
export const motionBody = ({ model = 'kling-v3-motion-control', prompt, image, video, orientation = 'video', quality = 'pro', keepSound = true }) => ({
  model, prompt: prompt || 'The character performs the motion from the reference video, natural and smooth, consistent identity',
  image_url: image, video_url: video, keep_original_sound: keepSound ? 'yes' : 'no',
  character_orientation: orientation === 'image' ? 'image' : 'video', mode: quality === 'std' ? 'std' : 'pro', watermark_info: { enabled: false },
});

/** Video edit / restyle / recast: Kling 3.0 Omni (refer_type base) or Wan 2.7 VideoEdit. */
export function videoEditBody({ model, prompt, video, refs = [], resolution, keepAudio = true, seed }) {
  if (model === 'wan2.7-videoedit') {
    return {
      model, video_urls: [video], prompt, ...(refs.length && { image_urls: refs.slice(0, 4) }), resolution: res(resolution, ['720p', '1080p'], '1080p').toUpperCase(),
      duration: 0, prompt_extend: true, watermark: false, metadata: { audio_setting: keepAudio ? 'origin' : 'auto' }, ...(seed != null && { seed }),
    };
  }
  return {
    model: 'kling-v3-omni', prompt, mode: { '720p': 'std', '1080p': 'pro', '4k': '4k' }[res(resolution, ['720p', '1080p', '4k'], '1080p')],
    ...(refs.length && { image_urls: refs.slice(0, 4) }),
    video_list: [{ video_url: video, refer_type: 'base', keep_original_sound: keepAudio ? 'yes' : 'no' }],
  };
}

/** Native Veo 3.1 extension of a clip ApiMart rendered (POST /videos/{task}/remix, extension only). */
export async function apimartVeoExtend({ taskId, model, prompt, aspect, resolution }, ctx = {}) {
  const body = { model, prompt, raw: true, aspect_ratio: pick(aspect, ['16:9', '9:16'], '16:9'), resolution: res(resolution, ['720p', '1080p', '4k'], '720p') };
  const r = await apimartTask(`/videos/${encodeURIComponent(taskId)}/remix`, body, 'video', { ...ctx, label: `Extending with ${model}` });
  return { ...r, ref: { provider: 'apimart', taskId: r.taskId, model } };
}

/**
 * Seedance won't take real faces as raw URLs; they go through ApiMart's private avatar library first (free,
 * moderated once). Returns the approved asset://… id. Docs: /videos/seedance-2-0/private-avatar.
 */
export function apimartAvatarBody({ url, name }) {
  return { group: { name: 'studio-characters' }, project_name: 'default', asset_type: 'Image', assets: [{ url, name: String(name || 'reference').slice(0, 60) }] };
}

export async function apimartAvatarAsset({ url, name }, { signal, onStatus } = {}) {
  const body = JSON.stringify(apimartAvatarBody({ url, name }));
  let j;
  try {
    j = check(await fetchJSON('apimart', `${APIMART}/seedance2/private-avatar`, { method: 'POST', headers: H(), body, signal }));
  } catch (e) {
    if (e.status !== 404) throw e;
    j = check(await fetchJSON('apimart', `${APIMART}/seedance2/private-avatar/assets`, { method: 'POST', headers: H(), body, signal }));
  }
  const d = Array.isArray(j.data) ? j.data[0] : j.data || j;
  const taskId = d?.id || d?.task_id;
  if (!taskId) throw new ProviderError('apimart', 0, `avatar upload returned no task id: ${JSON.stringify(j).slice(0, 200)}`);
  onStatus?.({ message: 'Registering the character with Seedance (moderation)' });
  for (let i = 0; i < 120; i++) {
    await sleep(i < 5 ? 2000 : 5000, signal);
    const t = check(await fetchJSON('apimart', `${APIMART}/tasks/${encodeURIComponent(taskId)}`, { headers: H(false), signal }));
    const td = t.data && !Array.isArray(t.data) ? t.data : t;
    const st = String(td.status || '').toLowerCase();
    const r = td.result || {};
    const usable = r.usable_assets?.[0]?.asset_url || r.asset_url;
    if (usable) return usable;
    if (['failed', 'error', 'cancelled', 'canceled'].includes(st)) {
      const why = r.failed_assets?.[0]?.reason || r.failed_assets?.[0]?.message || td.error?.message || '';
      throw new ProviderError('apimart', 0, `Seedance moderation refused this reference photo${why ? `: ${why}` : ''}`);
    }
    if (['completed', 'succeeded', 'success'].includes(st)) throw new ProviderError('apimart', 0, 'avatar task finished without an asset');
  }
  throw new ProviderError('apimart', 0, 'avatar moderation timed out');
}
