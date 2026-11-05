// muapi.ai — the original Open-Higgsfield backend, kept as one provider among many.
import { getSettings } from '../store.js';
import { fetchJSON, sleep, ProviderError } from '../http.js';

const API = 'https://api.muapi.ai/api/v1';
const key = () => {
  const k = getSettings().muapiKey;
  if (!k) throw new ProviderError('muapi', 0, 'no muapi key — add one in Providers');
  return k;
};

export async function muapiUpload({ buffer, mime, filename }, signal) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  const j = await fetchJSON('muapi', `${API}/upload_file`, { method: 'POST', headers: { 'x-api-key': key() }, body: fd, signal });
  const url = j.url || j.file_url || j.data?.url;
  if (!url) throw new ProviderError('muapi', 0, 'upload returned no URL');
  return url;
}

/** endpoint: muapi slug (e.g. "veo3.1-fast-image-to-video"); input: model payload. */
export async function muapiRun({ endpoint, input }, { onStatus, signal } = {}) {
  const sub = await fetchJSON('muapi', `${API}/${endpoint}`, {
    method: 'POST',
    headers: { 'x-api-key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  const id = sub.request_id || sub.id;
  if (!id) return sub;
  onStatus?.({ message: 'Queued on muapi', remoteId: id });
  for (let i = 0; i < 900; i++) {
    await sleep(3000, signal);
    const r = await fetchJSON('muapi', `${API}/predictions/${id}/result`, { headers: { 'x-api-key': key() }, signal }).catch((e) => {
      if (e.status >= 500) return { status: 'processing' };
      throw e;
    });
    const st = String(r.status || '').toLowerCase();
    if (['completed', 'succeeded', 'success'].includes(st)) return r;
    if (['failed', 'error'].includes(st)) throw new ProviderError('muapi', 0, r.error || 'generation failed');
    onStatus?.({ message: `muapi · ${st || 'processing'}` });
  }
  throw new ProviderError('muapi', 0, 'timed out');
}

export const muapiUrl = (r) => r.outputs?.[0] || r.url || r.output?.url || r.video?.url;
