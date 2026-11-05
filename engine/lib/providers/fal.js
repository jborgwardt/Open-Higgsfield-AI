// fal.ai queue API — https://docs.fal.ai/model-endpoints/queue
import { httpError, sleep } from '../http.js';

const QUEUE = 'https://queue.fal.run';

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
        if (st.error) throw new Error(`fal: ${st.error}`);
        break;
      }
    }
    const rr = await fetch(responseUrl, { headers, signal });
    if (!rr.ok) throw await httpError('fal', rr);
    return await rr.json();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
