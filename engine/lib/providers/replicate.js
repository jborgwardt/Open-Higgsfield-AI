// Replicate predictions API — https://replicate.com/docs/reference/http
import { httpError, sleep } from '../http.js';

const API = 'https://api.replicate.com/v1';

export async function replicateRun({ token, model, input, onStatus, signal }) {
  if (!token) throw new Error('Replicate token missing — add it in Settings or set REPLICATE_API_TOKEN');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let res = await fetch(`${API}/models/${model}/predictions`, { method: 'POST', headers, body: JSON.stringify({ input }), signal });
  if (res.status === 404) {
    // Community models have no "latest" route; pin the latest version instead.
    const mr = await fetch(`${API}/models/${model}`, { headers, signal });
    if (!mr.ok) throw await httpError('replicate', mr);
    const version = (await mr.json()).latest_version?.id;
    if (!version) throw new Error(`replicate: ${model} has no published version`);
    res = await fetch(`${API}/predictions`, { method: 'POST', headers, body: JSON.stringify({ version, input }), signal });
  }
  if (!res.ok) throw await httpError('replicate', res);
  let pred = await res.json();
  onStatus?.({ message: 'Starting on Replicate', remoteId: pred.id });

  const onAbort = () => pred.urls?.cancel && fetch(pred.urls.cancel, { method: 'POST', headers }).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
      await sleep(2000, signal);
      const pr = await fetch(pred.urls.get, { headers, signal });
      if (!pr.ok) throw await httpError('replicate', pr);
      pred = await pr.json();
      const pct = [...(pred.logs || '').matchAll(/(\d{1,3})%\|/g)].at(-1)?.[1];
      onStatus?.({
        message: pred.status === 'starting' ? 'Booting model on Replicate' : 'Rendering on Replicate',
        progress: pct ? Number(pct) / 100 : undefined,
      });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (pred.status !== 'succeeded') throw new Error(`replicate: ${pred.error || pred.status}`);
  return pred.output;
}

// Upload a local file so it can be passed as a model input; returns an API file URL.
export async function replicateUpload({ token, buffer, mime, filename, signal }) {
  const form = new FormData();
  form.append('content', new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${API}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal });
  if (!res.ok) throw await httpError('replicate upload', res);
  return (await res.json()).urls.get;
}
