// Single generation jobs for the Image / Video / Cinema studios.
import { uid, now } from './store.js';
import { generate } from './catalog.js';

const jobs = new Map();
const view = ({ ctrl, ...j }) => j;

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

export const getJob = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
export function cancelJob(id) {
  const j = jobs.get(id);
  if (j?.status === 'running') j.ctrl.abort();
  return j ? view(j) : null;
}
