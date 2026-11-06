// Single generation jobs for the Image / Video / Cinema studios.
import { uid, now } from './store.js';
import { generate } from './catalog.js';

const jobs = new Map();
const view = ({ ctrl, ...j }) => j;
export const hasActiveJobs = () => [...jobs.values()].some((j) => j.status === 'running');

export function startJob(params) {
  const job = { id: uid('j_'), status: 'running', message: 'Starting', progress: null, createdAt: now(), model: params.model, ctrl: new AbortController() };
  jobs.set(job.id, job);
  if (jobs.size > 500) jobs.delete(jobs.keys().next().value);
  generate(params, { signal: job.ctrl.signal, onStatus: ({ message, progress }) => Object.assign(job, message ? { message } : {}, progress != null ? { progress } : {}) })
    .then(({ asset, likeness }) => Object.assign(job, { status: 'done', message: 'Done', url: asset.url, assetId: asset.id, posterUrl: asset.posterUrl || null, duration: asset.duration || null, ...(likeness && { likeness }), ...(asset.characterNote && { note: asset.characterNote }), ...(asset.model !== params.model && { model: asset.model }) }))
    .catch((e) => Object.assign(job, { status: job.ctrl.signal.aborted ? 'cancelled' : 'error', error: e.message, message: e.message }))
    .finally(() => (job.finishedAt = now()));
  return view(job);
}

/** A job that runs any async task resolving { asset } (character sheets…); polled through the same /jobs/:id. */
export function startTask(model, run) {
  const job = { id: uid('j_'), status: 'running', message: 'Starting', progress: null, createdAt: now(), model, ctrl: new AbortController() };
  jobs.set(job.id, job);
  if (jobs.size > 500) jobs.delete(jobs.keys().next().value);
  Promise.resolve()
    .then(() => run({ signal: job.ctrl.signal, onStatus: ({ message, progress }) => Object.assign(job, message ? { message } : {}, progress != null ? { progress } : {}) }))
    .then(({ asset }) => Object.assign(job, { status: 'done', message: 'Done', url: asset.url, assetId: asset.id, posterUrl: asset.posterUrl || null, duration: asset.duration || null }))
    .catch((e) => Object.assign(job, { status: job.ctrl.signal.aborted ? 'cancelled' : 'error', error: e.message, message: e.message }))
    .finally(() => (job.finishedAt = now()));
  return view(job);
}

/**
 * Generic job for one-click tools: run(ctx) resolves { asset, assets? } (assets = every output, e.g. 9 shots).
 * Polled through the same GET /jobs/:id as studio generations.
 */
export function startRun({ label, tool, run }) {
  const job = { id: uid('j_'), status: 'running', message: 'Starting', progress: null, createdAt: now(), model: label, tool: tool || null, ctrl: new AbortController() };
  jobs.set(job.id, job);
  if (jobs.size > 500) jobs.delete(jobs.keys().next().value);
  const pub = (a) => ({ id: a.id, url: a.url, kind: a.kind, posterUrl: a.posterUrl || null, duration: a.duration || null, width: a.width || null, height: a.height || null });
  Promise.resolve()
    .then(() => run({ signal: job.ctrl.signal, onStatus: ({ message, progress }) => Object.assign(job, message ? { message } : {}, progress != null ? { progress } : {}),
      note: (msg) => { job.notes = [...(job.notes || []), String(msg)]; job.note = job.notes.join(' · '); } }))
    .then(({ asset, assets, text }) => Object.assign(job, {
      status: 'done', message: 'Done', url: asset.url, assetId: asset.id, kind: asset.kind, posterUrl: asset.posterUrl || null, duration: asset.duration || null,
      assets: (assets?.length ? assets : [asset]).map(pub), ...(text ? { text } : {}),
    }))
    .catch((e) => Object.assign(job, { status: job.ctrl.signal.aborted ? 'cancelled' : 'error', error: e.message, message: e.message }))
    .finally(() => (job.finishedAt = now()));
  return view(job);
}

export const getJob = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
export function cancelJob(id) {
  const j = jobs.get(id);
  if (j?.status === 'running') j.ctrl.abort();
  return j ? view(j) : null;
}
