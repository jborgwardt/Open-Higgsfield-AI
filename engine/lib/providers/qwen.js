// Qwen Cloud Token Plan (DashScope-style API, subscription credits): HappyHorse 1.1 video (t2v / i2v / r2v) and
// Qwen-Image / Wan 2.7 images. The plan's model list is not a reliable entitlement list (it shows wan3.0-video, which
// the plan does not include) — only models proven on the plan are in the catalog. Base URL via QWEN_BASE (default token-plan.maas.qwencloudapi.com; the Alibaba Cloud
// token-plan.ap-southeast-1.maas.aliyuncs.com host takes the same key). The plan is meant for interactive use —
// keep batch sizes modest; its error messages are passed through verbatim.
import { getSettings } from '../store.js';
import { fetchJSON, sleep, ProviderError } from '../http.js';

export const qwenBase = () => (process.env.QWEN_BASE || 'https://token-plan.maas.qwencloudapi.com').replace(/\/+$/, '');
export const qwenAvailable = () => !!getSettings().qwenKey;
const key = () => {
  const k = getSettings().qwenKey;
  if (!k) throw new ProviderError('qwen', 0, 'no Qwen Token Plan key — add one in Providers');
  return k;
};
const H = (async) => ({ Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', ...(async ? { 'X-DashScope-Async': 'enable' } : {}) });
const fail = (j) => new ProviderError('qwen', 0, `${j.code || 'error'}: ${j.message || JSON.stringify(j).slice(0, 300)}`, { quota: /quota|limit|exceed|throttl|insufficient/i.test(`${j.code} ${j.message}`) });

export async function qwenModels(signal) {
  const j = await fetchJSON('qwen', `${qwenBase()}/compatible-mode/v1/models`, { headers: H(), signal: signal || AbortSignal.timeout(15000) });
  return (j.data || []).map((m) => m.id);
}

/** Free credential check: looking up a non-existent task answers 200 with status UNKNOWN only for a valid key. */
export async function qwenTaskPing(signal) {
  const j = await fetchJSON('qwen', `${qwenBase()}/api/v1/tasks/00000000-0000-0000-0000-000000000000`, { headers: H(), signal: signal || AbortSignal.timeout(15000) });
  if (!j.output) throw fail(j);
  return true;
}

/* ---------------- images (sync) ---------------- */

const SIZES = { '16:9': '1664*928', '9:16': '928*1664', '1:1': '1328*1328', '4:3': '1472*1104', '3:4': '1104*1472', '21:9': '1984*848' };

export function qwenImageBody({ model, prompt, images = [], aspect }) {
  return {
    model,
    input: { messages: [{ role: 'user', content: [...images.slice(0, 4).map((image) => ({ image })), { text: String(prompt).slice(0, 3000) }] }] },
    parameters: { watermark: false, ...(SIZES[aspect] ? { size: SIZES[aspect] } : !images.length ? { size: SIZES['16:9'] } : {}) },
  };
}

/** p: { model, prompt, images: [url|dataURI], aspect } → { url } */
export async function qwenImage(p, { onStatus, signal } = {}) {
  onStatus?.({ message: `Rendering with ${p.model} (Qwen)` });
  // Sync endpoint: cap the wait so a stalled plan request fails the job instead of hanging it.
  const capped = AbortSignal.any([signal, AbortSignal.timeout(240000)].filter(Boolean));
  let j;
  try {
    j = await fetchJSON('qwen', `${qwenBase()}/api/v1/services/aigc/multimodal-generation/generation`, { method: 'POST', headers: H(), body: JSON.stringify(qwenImageBody(p)), signal: capped });
  } catch (e) {
    if (!signal?.aborted && capped.aborted) throw new ProviderError('qwen', 0, `${p.model} did not answer within 4 minutes`, { retryable: true });
    throw e;
  }
  if (j.code && !j.output) throw fail(j);
  const url = (j.output?.choices || []).flatMap((c) => c.message?.content || []).find((c) => c.image)?.image;
  if (!url) throw new ProviderError('qwen', 0, `no image returned: ${JSON.stringify(j).slice(0, 300)}`);
  return { url };
}

/* ---------------- video (async task) ---------------- */

const R = (r) => ({ '480p': '480P', '720p': '720P', '1080p': '1080P' }[String(r || '').toLowerCase()] || '720P');
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];

/**
 * HappyHorse 1.1 (the only video model on the Token Plan) is three endpoints in one catalog entry: start frame → i2v,
 * reference images → r2v (identity-preserving, up to 9, the prompt names them "[Image N]"), neither → t2v.
 */
export function qwenVideoBody({ prompt, image, refs = [], aspect, resolution, duration, seed }) {
  let model = 'happyhorse-1.1-t2v';
  const media = [];
  let text = String(prompt || '').slice(0, 2500);
  if (image) { model = 'happyhorse-1.1-i2v'; media.push({ type: 'first_frame', url: image }); }
  else if (refs.length) {
    model = 'happyhorse-1.1-r2v';
    media.push(...refs.slice(0, 9).map((url) => ({ type: 'reference_image', url })));
    if (!/\[Image \d\]/.test(text)) text = `${refs.slice(0, 9).map((_, i) => `[Image ${i + 1}]`).join(' ')} ${text}`;
  }
  return {
    model,
    input: { prompt: text, ...(media.length && { media }) },
    parameters: {
      resolution: R(resolution), duration: Math.min(15, Math.max(3, Math.round(Number(duration) || 5))), watermark: false,
      ...(!image && RATIOS.includes(aspect) && { ratio: aspect }), ...(Number.isInteger(seed) && { seed }),
    },
  };
}

/** p: { model, prompt, image, endImage, refs, aspect, resolution, duration, seed } → { url, ref } */
export async function qwenVideo(p, { onStatus, signal } = {}) {
  const body = qwenVideoBody(p);
  const j = await fetchJSON('qwen', `${qwenBase()}/api/v1/services/aigc/video-generation/video-synthesis`, { method: 'POST', headers: H(true), body: JSON.stringify(body), signal });
  const id = j.output?.task_id;
  if (!id) throw fail(j);
  onStatus?.({ message: `Queued on Qwen · ${body.model}`, remoteId: id });
  for (let i = 0; i < 720; i++) {
    await sleep(i < 5 ? 4000 : 6000, signal);
    let t;
    try { t = await fetchJSON('qwen', `${qwenBase()}/api/v1/tasks/${id}`, { headers: H(), signal }); } catch (e) { if (e.retryable && !signal?.aborted) continue; throw e; }
    const o = t.output || {};
    if (o.task_status === 'SUCCEEDED') {
      if (!o.video_url) throw new ProviderError('qwen', 0, 'task finished without a video URL');
      return { url: o.video_url, ref: { provider: 'qwen', taskId: id } };
    }
    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(o.task_status) && (o.task_status !== 'UNKNOWN' || i > 3)) throw fail(o);
    onStatus?.({ message: `${body.model} · ${String(o.task_status || 'queued').toLowerCase()}` });
  }
  throw new ProviderError('qwen', 0, 'timed out');
}
