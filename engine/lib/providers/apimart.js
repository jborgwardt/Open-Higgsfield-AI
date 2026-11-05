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
      return { url, cost: d.cost ?? null };
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

const veo = ({ prompt, img, end, aspect, resolution }) => ({
  prompt, duration: 8, aspect_ratio: pick(aspect, ['16:9', '9:16'], '16:9'), resolution: res(resolution, ['720p', '1080p', '4k'], '720p'),
  ...(img && { image_urls: [img, end].filter(Boolean), generation_type: 'frame' }),
});
const seedance = (maxDur) => ({ prompt, img, end, aspect, resolution, dur, seed }) => ({
  prompt, duration: clamp(Math.round(dur), 4, maxDur), resolution: res(resolution, ['480p', '720p', '1080p'], '720p'),
  size: img ? 'adaptive' : pick(aspect, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], '16:9'),
  ...(img && { image_with_roles: roles(img, end) }), ...(seed != null && { seed }),
});

const BODY = {
  'veo3.1-quality': veo,
  'veo3.1-fast': veo,
  'kling-v3': ({ prompt, img, end, aspect, resolution, dur }) => ({
    prompt, duration: clamp(Math.round(dur), 3, 15), mode: { '720p': 'std', '1080p': 'pro', '4k': '4k' }[res(resolution, ['720p', '1080p', '4k'], '720p')],
    aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1'], '16:9'), watermark: false, ...(img && { image_urls: [img, end].filter(Boolean) }),
  }),
  'kling-v4': ({ prompt, img, end, aspect, resolution, dur }) => ({
    prompt, duration: clamp(Math.round(dur), 3, 30), resolution: res(resolution, ['720p', '1080p'], '720p'),
    ...(img ? { image_urls: [img, end].filter(Boolean) } : { aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1', '21:9'], '16:9') }),
  }),
  'seedance-2.0': seedance(15),
  'seedance-2.5': (a) => ({ ...seedance(30)(a), watermark: false }),
  'wan2.6': ({ prompt, img, aspect, resolution, dur, seed }) => ({
    prompt, duration: nearest([5, 10, 15], dur), resolution: res(resolution, ['720p', '1080p'], '720p'), watermark: false,
    ...(img ? { image_urls: [img] } : { aspect_ratio: pick(aspect, ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9') }), ...(seed != null && { seed }),
  }),
  'wan3.0-video': ({ prompt, img, end, aspect, resolution, dur, seed }) => ({
    prompt, duration: clamp(Math.round(dur), 2, 30), resolution: res(resolution, ['480p', '720p', '1080p'], '720p').toUpperCase(), watermark: false,
    size: img ? 'adaptive' : pick(aspect, ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9'),
    ...(img && { image_with_roles: roles(img, end) }), ...(seed != null && { seed }),
  }),
};

/** p: { model, prompt, image (URL), endImage (URL), aspect, resolution, duration, seed } */
export async function apimartVideo(p, ctx = {}) {
  const build = BODY[p.model];
  if (!build) throw new ProviderError('apimart', 0, `no request shape for ${p.model}`);
  const body = { model: p.model, ...build({ prompt: String(p.prompt || '').slice(0, 4000), img: p.image, end: p.endImage, aspect: p.aspect, resolution: p.resolution, dur: Number(p.duration) || 5, seed: p.seed }) };
  const j = check(await fetchJSON('apimart', `${APIMART}/videos/generations`, { method: 'POST', headers: H(), body: JSON.stringify(body), signal: ctx.signal }));
  const d = Array.isArray(j.data) ? j.data[0] : j.data || j;
  const taskId = d?.task_id || d?.id || j.task_id;
  if (!taskId) throw new ProviderError('apimart', 0, `no task id in reply: ${JSON.stringify(j).slice(0, 200)}`);
  ctx.onStatus?.({ message: `Queued on ApiMart · ${p.label || p.model}`, remoteId: taskId });
  return waitTask(taskId, 'video', { ...ctx, label: p.label || 'ApiMart' });
}
