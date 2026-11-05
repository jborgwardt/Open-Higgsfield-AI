// Self-hosted ComfyUI — runs API-format workflow templates from ./comfy with {{placeholders}}.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENGINE_ROOT } from '../store.js';
import { httpError, sleep, download } from '../http.js';

const DIR = path.join(ENGINE_ROOT, 'comfy');

export function listTemplates() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        if (!t.workflow) return null;
        return { id: f.replace(/\.json$/, ''), file: f, ...t };
      } catch (e) {
        console.warn(`comfy template ${f} skipped: ${e.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

// "{{seed}}" as a whole string keeps the variable's type (numbers stay numbers).
function fill(node, vars) {
  if (typeof node === 'string') {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]] ?? node;
    return node.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] ?? m));
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  return node;
}

async function upload(base, { buffer, mime, filename }, signal) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mime }), filename);
  form.append('overwrite', 'true');
  const res = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal });
  if (!res.ok) throw await httpError('comfy upload', res);
  const j = await res.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

export async function comfyPing(base) {
  const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw await httpError('comfy', res);
  return res.json();
}

export async function comfyRun({ base, template, vars, files = {}, kind, onStatus, signal }) {
  base = base.replace(/\/$/, '');
  const v = { ...vars };
  for (const [name, f] of Object.entries(files)) if (f) v[name] = await upload(base, f, signal);
  const workflow = fill(template.workflow, v);
  const left = JSON.stringify(workflow).match(/\{\{(\w+)\}\}/);
  if (left) throw new Error(`Template "${template.label}" needs {{${left[1]}}} — ${left[1].includes('image') ? 'add a start frame first' : 'missing value'}`);

  const clientId = crypto.randomUUID();
  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal,
  });
  if (!res.ok) throw await httpError('comfy', res);
  const { prompt_id: id, node_errors: nodeErrors } = await res.json();
  if (nodeErrors && Object.keys(nodeErrors).length) throw new Error(`comfy node errors: ${JSON.stringify(nodeErrors).slice(0, 400)}`);
  onStatus?.({ message: 'Queued in ComfyUI', remoteId: id });

  const onAbort = () => fetch(`${base}/interrupt`, { method: 'POST' }).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  let entry;
  try {
    for (;;) {
      await sleep(2000, signal);
      const hr = await fetch(`${base}/history/${id}`, { signal });
      if (!hr.ok) throw await httpError('comfy', hr);
      entry = (await hr.json())[id];
      if (entry?.status?.completed || entry?.status?.status_str === 'error') break;
      const qr = await fetch(`${base}/queue`, { signal }).then((r) => r.json()).catch(() => null);
      const running = qr?.queue_running?.some((q) => q[1] === id);
      const pending = qr?.queue_pending?.findIndex((q) => q[1] === id);
      onStatus?.({ message: running ? 'Rendering in ComfyUI' : pending >= 0 ? `In ComfyUI queue · position ${pending + 1}` : 'Waiting for ComfyUI' });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (entry.status?.status_str === 'error') {
    const msg = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1];
    throw new Error(`comfy: ${msg ? `${msg.node_type}: ${msg.exception_message}` : 'execution failed'}`);
  }

  const outputs = Object.entries(entry.outputs || {})
    .filter(([node]) => !template.output || node === String(template.output))
    .flatMap(([, o]) => [...(o.videos || []), ...(o.gifs || []), ...(o.images || [])])
    .filter((f) => f.type !== 'temp');
  const isVideo = (f) => /\.(mp4|webm|mov|gif)$/i.test(f.filename);
  const pick = kind === 'video' ? outputs.find(isVideo) : outputs.find((f) => !isVideo(f));
  if (!pick) throw new Error('comfy: workflow finished but produced no output file');
  const q = new URLSearchParams({ filename: pick.filename, subfolder: pick.subfolder || '', type: pick.type || 'output' });
  return download(`${base}/view?${q}`, { signal });
}
