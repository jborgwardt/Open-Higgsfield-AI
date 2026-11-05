// fal.ai queue API — https://docs.fal.ai/model-endpoints/queue
import { httpError, sleep, ProviderError } from '../http.js';

const QUEUE = 'https://queue.fal.run';
const REST = 'https://rest.fal.ai';

/**
 * Upload a file to fal's CDN; returns a public https URL. Used for every video / audio input
 * (fal and ApiMart both need public URLs for those) and for large images.
 */
export async function falUpload({ key, buffer, mime, filename = 'upload.bin', signal }) {
  if (!key) throw new ProviderError('fal', 0, 'a fal.ai key is needed to host video/audio inputs — add one in Providers');
  const init = await fetch(`${REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: mime || 'application/octet-stream', file_name: filename }),
    signal,
  });
  if (!init.ok) throw await httpError('fal upload', init);
  const { upload_url: put, file_url: url } = await init.json();
  const res = await fetch(put, { method: 'PUT', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: buffer, signal });
  if (!res.ok) throw await httpError('fal upload', res);
  return url;
}

/**
 * Wan 3.0 on fal (alibaba/wan-3.0/*): start frame → image-to-video (+ end frame), reference images / clips / voices →
 * reference-to-video (identity; the prompt names them "Image 1", "Video 1", "Audio 1"), otherwise text-to-video.
 * Returns { endpoint, input }.
 */
export function wan3Request({ prompt, image, endImage, refs = [], videos = [], audios = [], aspect, resolution, duration, seed }) {
  const ar = ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(aspect) ? aspect : 'adaptive';
  const common = { resolution: ['480p', '720p', '1080p'].includes(resolution) ? resolution : '1080p', duration: Math.min(15, Math.max(2, Math.round(Number(duration) || 5))), audio: true, enable_prompt_expansion: true, ...(Number.isInteger(seed) && { seed }) };
  if (image) return { endpoint: 'alibaba/wan-3.0/image-to-video', input: { ...common, prompt, start_image_url: image, ...(endImage && { end_image_url: endImage }), aspect_ratio: 'adaptive' } };
  if (refs.length || videos.length) {
    const names = [...refs.slice(0, 10).map((_, i) => `Image ${i + 1}`), ...videos.slice(0, 5).map((_, i) => `Video ${i + 1}`)];
    const text = /\b(Image|Video) \d/.test(prompt || '') ? prompt : `${names.join(', ')}: ${prompt || ''}`;
    return { endpoint: 'alibaba/wan-3.0/reference-to-video', input: { ...common, prompt: text, aspect_ratio: ar, reference_image_urls: refs.slice(0, 10), reference_video_urls: videos.slice(0, 5), reference_audio_urls: audios.slice(0, 5) } };
  }
  return { endpoint: 'alibaba/wan-3.0/text-to-video', input: { ...common, prompt, aspect_ratio: ar === 'adaptive' ? '16:9' : ar } };
}

/** First media URL in a fal result, preferring `kind` ('video' | 'image' | 'audio'). */
export function falMedia(out, kind) {
  const pick = (v) => (Array.isArray(v) ? pick(v[0]) : typeof v === 'string' ? v : v?.url || null);
  const order = { video: ['video', 'videos', 'output', 'image', 'images'], image: ['image', 'images', 'output'], audio: ['audio', 'audio_file', 'audio_url', 'output', 'video'] }[kind] || ['video', 'image', 'images', 'audio'];
  for (const k of order) { const u = pick(out?.[k]); if (u) return u; }
  return null;
}

export async function falRun({ key, endpoint, input, onStatus, signal }) {
  if (!key) throw new Error('fal.ai key missing — add it in Settings or set FAL_KEY');
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${QUEUE}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(input), signal });
  if (!res.ok) throw await httpError('fal', res);
  const q = await res.json();
  const app = endpoint.split('/').slice(0, 2).join('/');
  const statusUrl = q.status_url || `${QUEUE}/${app}/requests/${q.request_id}/status`;
  const responseUrl = q.response_url || `${QUEUE}/${app}/requests/${q.request_id}`;
  const cancelUrl = q.cancel_url || `${statusUrl.replace(/\/status$/, '')}/cancel`;
  onStatus?.({ message: 'Queued on fal.ai', remoteId: q.request_id });

  const onAbort = () => fetch(cancelUrl, { method: 'PUT', headers }).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      await sleep(2000, signal);
      const sr = await fetch(`${statusUrl}?logs=1`, { headers, signal });
      if (!sr.ok) throw await httpError('fal status', sr);
      const st = await sr.json();
      if (st.status === 'IN_QUEUE') onStatus?.({ message: `In queue${st.queue_position != null ? ` · position ${st.queue_position}` : ''}` });
      else if (st.status === 'IN_PROGRESS') {
        const log = st.logs?.filter((l) => l.message).at(-1)?.message;
        const pct = log?.match(/(\d{1,3})%/)?.[1];
        onStatus?.({ message: log ? `Rendering · ${log.slice(0, 80)}` : 'Rendering on fal.ai', progress: pct ? Number(pct) / 100 : undefined });
      } else if (st.status === 'COMPLETED') {
        if (st.error) throw new ProviderError('fal', 0, typeof st.error === 'string' ? st.error : JSON.stringify(st.error));
        break;
      }
    }
    const rr = await fetch(responseUrl, { headers, signal });
    // fal reports validation / content-policy failures on the result URL — surface the provider's own words.
    if (!rr.ok) throw await httpError(`fal ${endpoint}`, rr);
    return await rr.json();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
