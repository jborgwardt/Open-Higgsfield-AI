// kie.ai (server side) — same task API the browser client in src/lib/kie.js uses.
import { getSettings } from '../store.js';
import { fetchJSON, sleep, ProviderError } from '../http.js';

const API = 'https://api.kie.ai/api/v1';
const key = () => {
  const k = getSettings().kieKey;
  if (!k) throw new ProviderError('kie', 0, 'no kie.ai key — add one in Providers');
  return k;
};
const H = () => ({ Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' });

export async function kieUpload({ buffer, mime, filename }, signal) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  fd.append('uploadPath', 'open-higgsfield');
  fd.append('fileName', filename);
  const j = await fetchJSON('kie', `${API}/file-stream-upload`, { method: 'POST', headers: { Authorization: `Bearer ${key()}` }, body: fd, signal });
  const url = j.data?.fileUrl || j.data?.downloadUrl || j.data?.url || j.url;
  if (!url) throw new ProviderError('kie', 0, `upload failed: ${j.msg || 'no URL'}`);
  return url;
}

function check(j) {
  if (j.code && j.code !== 200) throw new ProviderError('kie', j.code, j.msg || 'error', { quota: j.code === 402 || j.code === 429, retryable: j.code === 429 || j.code >= 500 });
  return j;
}

export async function kieJob({ model, input }, { onStatus, signal } = {}) {
  const j = check(await fetchJSON('kie', `${API}/jobs/createTask`, { method: 'POST', headers: H(), body: JSON.stringify({ model, input }), signal }));
  const taskId = j.data?.taskId;
  onStatus?.({ message: 'Queued on kie.ai', remoteId: taskId });
  for (let i = 0; i < 900; i++) {
    await sleep(3000, signal);
    const r = check(await fetchJSON('kie', `${API}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: H(), signal }));
    const d = r.data || {};
    const st = String(d.state || '').toLowerCase();
    if (st === 'success') {
      let urls = d.resultUrls;
      if (!urls && d.resultJson) { try { urls = JSON.parse(d.resultJson).resultUrls; } catch {} }
      return { url: urls?.[0] };
    }
    if (st === 'fail' || st === 'error') throw new ProviderError('kie', 0, d.failMsg || 'generation failed');
    onStatus?.({ message: `kie.ai · ${st || 'waiting'}` });
  }
  throw new ProviderError('kie', 0, 'timed out');
}

export async function kieVeo({ model, prompt, image, aspect, resolution }, { onStatus, signal } = {}) {
  const body = { prompt, model, generationType: image ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO', aspect_ratio: aspect || '16:9', resolution: resolution || '720p', enableFallback: false };
  if (image) body.imageUrls = [image];
  const j = check(await fetchJSON('kie', `${API}/veo/generate`, { method: 'POST', headers: H(), body: JSON.stringify(body), signal }));
  const taskId = j.data?.taskId;
  onStatus?.({ message: 'Queued on kie.ai Veo', remoteId: taskId });
  for (let i = 0; i < 900; i++) {
    await sleep(4000, signal);
    const r = await fetchJSON('kie', `${API}/veo/record-info?taskId=${encodeURIComponent(taskId)}`, { headers: H(), signal });
    const d = r.data || {};
    if (d.successFlag === 1) return { url: d.response?.resultUrls?.[0] };
    if (d.successFlag === 2 || d.successFlag === 3) throw new ProviderError('kie', 0, d.errorMessage || 'Veo generation failed');
    onStatus?.({ message: 'kie.ai Veo rendering' });
  }
  throw new ProviderError('kie', 0, 'timed out');
}
