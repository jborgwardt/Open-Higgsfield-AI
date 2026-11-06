// Private Google Drive backups. Only verified finished videos are eligible for local eviction.
// Source clips, uploaded references, music, thumbnails and project metadata remain on the studio.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HOUR = 3600_000;
const RATE_LIMIT_BACKOFF = 15 * 60_000;
const fail = (status, message) => Object.assign(new Error(message), { status });
export function rcloneFailure(stderr = '') {
  if (/RATE_LIMIT_EXCEEDED|rateLimitExceeded|userRateLimitExceeded|Quota exceeded/i.test(stderr)) {
    return Object.assign(fail(503, 'Google Drive connection is rate-limited. Retry later or use a private Google connection.'), { retryable: true, rateLimited: true });
  }
  return fail(502, 'Google Drive could not complete the request; local files were kept');
}
// Current rclone emits Hashes.md5; older examples use Hashes.MD5. Both name the same digest.
export const remoteMD5 = (metadata) => String(Object.entries(metadata?.Hashes || {}).find(([name]) => name.toLowerCase() === 'md5')?.[1] || '').toLowerCase();
const digest = async (file) => {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const safeId = (id) => /^(?:a|prod)_[a-zA-Z0-9]+$/.test(String(id));
const cleanName = (s) => String(s || 'Untitled').normalize('NFKC').replace(/[\x00-\x1f/\\:*?"<>|]/g, '-').replace(/\.{2,}/g, '-').trim().slice(0, 100) || 'Untitled';
const SECRET = /^(?:access_?token|refresh_?token|id_?token|token|api_?key|client_?secret|password|credentials|authorization|headers|remote)$/i;
export function sanitizedSnapshot(value) {
  if (Array.isArray(value)) return value.map(sanitizedSnapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET.test(k)).map(([k, v]) => [k, sanitizedSnapshot(v)]));
  return value;
}
export function referencedAssetIds(value, ids = new Set()) {
  if (typeof value === 'string') {
    if (/^a_[a-zA-Z0-9]+$/.test(value)) ids.add(value);
    const m = value.match(/\/engine\/media\/(a_[a-zA-Z0-9]+)\.[a-zA-Z0-9]+(?:[?#]|$)/);
    if (m) ids.add(m[1]);
  } else if (Array.isArray(value)) value.forEach((v) => referencedAssetIds(v, ids));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => referencedAssetIds(v, ids));
  return ids;
}

/** Argv-only adapter: credentials remain in a server-only rclone config, never in API responses. */
export function rcloneAdapter({ data, env = process.env } = {}) {
  const binary = env.ENGINE_ARCHIVE_RCLONE || 'rclone';
  const config = env.ENGINE_ARCHIVE_RCLONE_CONFIG || path.join(data, 'rclone', 'rclone.conf');
  const remote = env.ENGINE_ARCHIVE_REMOTE || 'gdrive';
  const valid = /^[a-zA-Z0-9_-]+$/.test(remote);
  const configured = () => valid && fs.existsSync(config);
  const full = (p) => {
    if (!valid || typeof p !== 'string' || p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '.') || /[\x00-\x1f]/.test(p)) throw fail(400, 'Invalid archive path');
    return `${remote}:${p}`;
  };
  const run = (args, timeout = 30 * 60_000) => new Promise((resolve, reject) => {
    if (!configured()) return reject(fail(503, 'Google Drive is not configured on this studio'));
    const child = spawn(binary, ['--config', config, '--contimeout', '15s', '--timeout', '2m', '--retries', '2', '--low-level-retries', '3', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail(504, 'Google Drive transfer timed out; the local file was kept')); }, timeout);
    timer.unref();
    child.stdout.on('data', (s) => { output += s; if (output.length > 2_000_000) { child.kill('SIGKILL'); finish(fail(502, 'Google Drive returned too much metadata')); } });
    // Keep a bounded diagnostic only for classification; never forward raw provider logs or tokens.
    child.stderr.on('data', (s) => { stderr = (stderr + s).slice(-16_000); });
    child.on('error', () => finish(fail(503, 'Google Drive transfer tool is unavailable on this studio')));
    child.on('close', (code) => finish(code === 0 ? null : rcloneFailure(stderr), output));
  });
  return {
    configured,
    async probe() { await run(['about', full(''), '--json'], 45_000); },
    async stat(p) { return JSON.parse(await run(['lsjson', full(p), '--stat', '--hash', '--hash-type', 'MD5'], 45_000)); },
    async folderStat(p) {
      // --stat on a directory treats it as the remote root and fabricates a directory without ID.
      // A one-level parent listing preserves the actual Drive folder ID; no share link is created.
      full(p); // Validate before splitting.
      const parent = path.posix.dirname(p), name = path.posix.basename(p);
      const entries = JSON.parse(await run(['lsjson', full(parent === '.' ? '' : parent), '--dirs-only', '--max-depth', '1'], 45_000));
      const matches = entries.filter((entry) => entry.IsDir && entry.Name === name);
      if (matches.length !== 1) throw fail(502, 'The Google Drive backup folder could not be identified uniquely');
      return matches[0];
    },
    async upload(local, p) { await run(['copyto', local, full(p), '--checksum', '--transfers', '1', '--checkers', '1', '--drive-chunk-size', '8M', '--buffer-size', '1M']); },
    async download(p, local) { await run(['copyto', full(p), local, '--checksum', '--transfers', '1', '--checkers', '1', '--buffer-size', '1M']); },
  };
}

export function createArchiveManager({ data, media, getAsset, listAssets, listProductions, getProduction, getCharacter = () => null, listCharacters = () => [], isBusy = () => false, adapter, clock = Date.now }) {
  const dir = path.join(data, 'archive');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dir, 'state.json');
  let saved = {}, stateError = null;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!saved || Array.isArray(saved) || typeof saved !== 'object' || (saved.version != null && saved.version !== 1)) throw new Error('Invalid archive history');
    for (const key of ['policy', 'assets', 'projects', 'videos']) if (saved[key] != null && (typeof saved[key] !== 'object' || Array.isArray(saved[key]))) throw new Error('Invalid archive history');
    for (const key of ['assets', 'projects', 'videos']) if (key in saved && saved[key] === null) throw new Error('Invalid archive history');
    for (const key of ['assets', 'projects', 'videos']) for (const record of Object.values(saved[key] || {})) if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid archive history');
    const policy = saved.policy || {};
    if ('enabled' in policy && typeof policy.enabled !== 'boolean') throw new Error('Invalid archive history');
    if ('uploadDelayHours' in policy && ![0, 24, 48].includes(policy.uploadDelayHours)) throw new Error('Invalid archive history');
    if ('removeLocalAfterHours' in policy && ![null, 24, 48].includes(policy.removeLocalAfterHours)) throw new Error('Invalid archive history');
  } catch (e) {
    saved = {};
    if (e.code !== 'ENOENT') stateError = 'Backup history is unreadable. Automatic backup and cleanup are disabled until it is repaired.';
  }
  const state = { version: 1, policy: { enabled: false, uploadDelayHours: 0, removeLocalAfterHours: 48, ...saved.policy }, projects: {}, assets: {}, videos: {}, localBytesFreed: 0, ...saved };
  state.policy = { enabled: false, uploadDelayHours: 0, removeLocalAfterHours: 48, ...saved.policy };
  const drive = adapter || rcloneAdapter({ data });
  let busy = false, saveQueue = Promise.resolve(), connected = false, checkedAt = 0, connectionError = null, probeError = null, timer, pendingRun = null;
  const restores = new Map();
  const stamp = () => new Date(clock()).toISOString();
  const save = () => {
    if (stateError) return Promise.reject(fail(503, stateError));
    const content = JSON.stringify(state, null, 2);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const tmp = `${stateFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, content, { mode: 0o600 });
      await fsp.rename(tmp, stateFile);
    });
    return saveQueue;
  };
  function localPath(asset) {
    if (!asset || !safeId(asset.id) || !/^a_[a-zA-Z0-9]+\.[a-zA-Z0-9]+$/.test(asset.file || '') || !asset.file.startsWith(`${asset.id}.`)) throw fail(400, 'Invalid media file path');
    const abs = path.join(media, asset.file);
    if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw fail(400, 'Archive media may not be a symbolic link');
    return abs;
  }
  const allProductions = () => listProductions().map((p) => getProduction(p.id)).filter(Boolean);
  const complete = (p) => p?.status === 'done' && !p.assembling && p.screening?.status !== 'running' && p.master?.assetId && !(p.shots || []).some((s) => s.status === 'running');
  function assetReferenceClosure(value) {
    const ids = referencedAssetIds(value);
    // Cached inputs such as Topaz upscales live on source asset metadata, not on the shot.
    // Set iteration visits newly discovered IDs and terminates for parent/child cycles.
    for (const id of ids) { const asset = getAsset(id); if (asset) referencedAssetIds(asset, ids); }
    return ids;
  }
  function projectSnapshot(p) {
    const chars = (p.brief?.characters || []).map((c) => c.characterId ? getCharacter(c.characterId) : c).filter(Boolean);
    // Include poster / subtitle / derived-asset links stored on assets themselves.
    const ids = assetReferenceClosure([p, chars]);
    const assets = [...ids].map((id) => {
      const asset = getAsset(id);
      if (!asset) throw fail(409, `Project references missing media ${id}; backup is incomplete`);
      return asset;
    });
    return sanitizedSnapshot({ format: 'film-studio-project-v1', production: p, characters: chars, assets });
  }
  const fingerprint = (s) => crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex');
  function statusView() {
    const projects = Object.values(state.projects), videos = Object.values(state.videos);
    return { provider: 'google-drive', configured: drive.configured(), connected, rootFolder: 'Film Studio', folderUrl: state.folderUrl || null,
      policy: { ...state.policy }, busy, stats: { projects: projects.filter((p) => p.status === 'verified').length, videos: videos.filter((v) => v.status === 'verified').length,
        verifiedBytes: Object.values(state.assets).reduce((n, a) => n + (a.size || 0), 0), localBytesFreed: state.localBytesFreed || 0,
        pending: [...projects, ...videos].filter((p) => p.status !== 'verified').length },
      lastRunAt: state.lastRunAt || null, nextRetryAt: state.nextRetryAt || null, lastError: stateError || connectionError || state.lastError || null };
  }
  async function probe(fresh = false) {
    if (stateError) return false;
    if (!fresh && checkedAt && clock() - checkedAt < 60_000) return connected;
    checkedAt = clock();
    try { await drive.probe(); connected = true; connectionError = null; probeError = null; state.folderUrl ||= await folderUrl('Film Studio'); }
    catch (e) { connected = false; connectionError = e.message; probeError = e; }
    return connected;
  }
  async function status({ fresh = false } = {}) { await probe(fresh); return statusView(); }
  async function settings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail(400, 'Invalid backup settings');
    const allowed = new Set(['enabled', 'uploadDelayHours', 'removeLocalAfterHours']);
    for (const k of Object.keys(patch)) if (!allowed.has(k)) throw fail(400, `Unknown backup setting: ${k}`);
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw fail(400, 'enabled must be true or false');
    if ('uploadDelayHours' in patch && ![0, 24, 48].includes(patch.uploadDelayHours)) throw fail(400, 'Choose immediate, one day, or two days');
    if ('removeLocalAfterHours' in patch && ![null, 24, 48].includes(patch.removeLocalAfterHours)) throw fail(400, 'Choose keep local, one day, or two days');
    if (patch.enabled && !await probe(true)) throw fail(503, connectionError || 'Google Drive is not connected');
    state.policy = { ...state.policy, ...patch };
    await save();
    if (state.policy.enabled) requestRun();
    return statusView();
  }
  async function verifiedUpload(asset, remotePath, projectId) {
    const abs = localPath(asset);
    if (!fs.existsSync(abs)) await ensureLocal(asset.id);
    const before = await fsp.stat(abs), md5 = await digest(abs);
    await drive.upload(abs, remotePath);
    const remote = await drive.stat(remotePath), after = await fsp.stat(abs);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || remote.IsDir || remote.Size !== before.size || remoteMD5(remote) !== md5) throw fail(502, 'Google Drive verification failed; the local video was kept');
    const previous = state.assets[asset.id];
    state.assets[asset.id] = { id: asset.id, file: asset.file, remotePath, driveId: remote.ID || null, size: before.size, md5,
      verifiedAt: stamp(), firstVerifiedAt: previous?.md5 === md5 ? previous.firstVerifiedAt || stamp() : stamp(), lastAccessAt: previous?.lastAccessAt || null,
      projectIds: [...new Set([...(previous?.projectIds || []), ...(projectId ? [projectId] : [])])] };
    await save();
    return { id: asset.id, file: asset.file, size: before.size, md5, driveId: remote.ID || null, remotePath };
  }
  async function saveManifest(key, body, remotePath) {
    const local = path.join(dir, `${key}.json`);
    await fsp.writeFile(local, JSON.stringify(body, null, 2), { mode: 0o600 });
    const md5 = await digest(local), size = (await fsp.stat(local)).size;
    await drive.upload(local, remotePath);
    const remote = await drive.stat(remotePath);
    if (remote.Size !== size || remoteMD5(remote) !== md5) throw fail(502, 'Project metadata verification failed; local files were kept');
  }
  async function folderUrl(folder) {
    try { const s = await (drive.folderStat ? drive.folderStat(folder) : drive.stat(folder)); return s.IsDir && s.ID ? `https://drive.google.com/drive/folders/${encodeURIComponent(s.ID)}` : null; } catch { return null; }
  }
  async function archiveProject(id, verifyExisting = false) {
    if (!safeId(id) || !id.startsWith('prod_')) throw fail(400, 'Invalid project ID');
    const p = getProduction(id);
    if (!p) throw fail(404, 'Project not found');
    if (!complete(p)) throw fail(409, 'Finish this project before archiving it');
    const snapshot = projectSnapshot(p), revision = fingerprint(snapshot), old = state.projects[id];
    if (!verifyExisting && old?.status === 'verified' && old.revision === revision) return old;
    const record = state.projects[id] = { ...old, id, title: p.title, folder: old?.folder || `Film Studio/${cleanName(p.title)}--${id}`, status: 'uploading', error: null };
    await save();
    try {
      const uploaded = [];
      for (const asset of snapshot.assets) uploaded.push(await verifiedUpload(asset, `${record.folder}/media/${asset.file}`, id));
      if (!complete(getProduction(id)) || fingerprint(projectSnapshot(getProduction(id))) !== revision) throw fail(409, 'Project changed during backup; local files were kept and backup will retry');
      await saveManifest(id, { ...snapshot, archivedAt: stamp(), files: uploaded }, `${record.folder}/project.json`);
      Object.assign(record, { status: 'verified', revision, assetIds: uploaded.map((a) => a.id), verifiedAt: stamp(), folderUrl: await folderUrl(record.folder), error: null });
      state.folderUrl ||= await folderUrl('Film Studio');
      await save();
      return record;
    } catch (e) { Object.assign(record, { status: 'error', error: e.message }); await save(); throw e; }
  }
  function standaloneVideos() {
    const referenced = assetReferenceClosure([allProductions(), listCharacters()]);
    return listAssets().filter((a) => a.kind === 'video' && !a.hidden && !['upload', 'handoff', 'poster', 'last-frame', 'continuity', 'preview', 'upscaled'].includes(a.source) && !referenced.has(a.id));
  }
  async function archiveVideo(a, verifyExisting = false) {
    const old = state.videos[a.id];
    if (!verifyExisting && old?.status === 'verified' && state.assets[a.id]) return old;
    const record = state.videos[a.id] = { id: a.id, status: 'uploading', folder: old?.folder || `Film Studio/Videos/${cleanName(a.name || a.prompt || 'Video')}--${a.id}` };
    await save();
    try {
      const file = await verifiedUpload(a, `${record.folder}/${a.file}`);
      await saveManifest(a.id, { format: 'film-studio-video-v1', asset: sanitizedSnapshot(a), files: [file] }, `${record.folder}/video.json`);
      Object.assign(record, { status: 'verified', verifiedAt: stamp(), folderUrl: await folderUrl(record.folder), error: null });
      state.folderUrl ||= await folderUrl('Film Studio');
      await save();
    } catch (e) { Object.assign(record, { status: 'error', error: e.message }); await save(); throw e; }
    return record;
  }
  function evictionCandidates() {
    const projects = allProductions();
    // A master used as a reference/music/input anywhere else must remain local.
    const protectedIds = assetReferenceClosure(listCharacters());
    for (const p of projects) {
      const copy = { ...p, master: null,
        // Completed review metadata points to its own master, but does not consume it as an input.
        screening: p.screening ? { ...p.screening, masterAssetId: p.screening.masterAssetId === p.master?.assetId ? null : p.screening.masterAssetId } : null };
      for (const id of assetReferenceClosure(copy)) protectedIds.add(id);
      if (!complete(p)) for (const id of assetReferenceClosure(p)) protectedIds.add(id);
    }
    const ids = new Set();
    for (const p of projects) if (complete(p) && state.projects[p.id]?.status === 'verified' && state.projects[p.id].revision === fingerprint(projectSnapshot(p))) ids.add(p.master.assetId);
    for (const a of standaloneVideos()) if (state.videos[a.id]?.status === 'verified') ids.add(a.id);
    return [...ids].filter((id) => !protectedIds.has(id));
  }
  async function cleanup() {
    if (!state.policy.enabled || state.policy.removeLocalAfterHours == null || isBusy() || restores.size) return;
    for (const id of evictionCandidates()) {
      const a = getAsset(id), r = state.assets[id];
      if (!a || !r || r.localEvictedAt) continue;
      const since = Math.max(Date.parse(r.firstVerifiedAt || r.verifiedAt) || clock(), Date.parse(r.lastAccessAt) || 0);
      if (clock() - since < state.policy.removeLocalAfterHours * HOUR) continue;
      const abs = localPath(a);
      if (!fs.existsSync(abs)) continue;
      const before = await fsp.stat(abs), localHash = await digest(abs), remote = await drive.stat(r.remotePath);
      if (remote.IsDir || remote.Size !== r.size || remoteMD5(remote) !== r.md5 || localHash !== r.md5) throw fail(502, 'Backup verification failed during cleanup; local files were kept');
      // No await between the final activity/identity check and unlink, so a newly started job wins.
      if (!state.policy.enabled || state.policy.removeLocalAfterHours == null || isBusy() || restores.size || !evictionCandidates().includes(id)) continue;
      if (clock() - Math.max(Date.parse(r.firstVerifiedAt || r.verifiedAt) || clock(), Date.parse(r.lastAccessAt) || 0) < state.policy.removeLocalAfterHours * HOUR) continue;
      const after = fs.statSync(abs);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue;
      fs.unlinkSync(abs);
      r.localEvictedAt = stamp();
      state.localBytesFreed += r.size;
      await save();
    }
  }
  async function ensureLocal(id) {
    const a = getAsset(id);
    if (!a) throw fail(404, 'Media not found');
    const abs = localPath(a), r = state.assets[id];
    if (fs.existsSync(abs)) {
      if (r) { r.lastAccessAt = stamp(); await save(); }
      return abs;
    }
    if (!r) throw fail(404, 'Media file is missing and has no verified Drive backup');
    if (restores.has(id)) return restores.get(id);
    const task = (async () => {
      const tmp = `${abs}.restore-${crypto.randomBytes(6).toString('hex')}`;
      try {
        await drive.download(r.remotePath, tmp);
        const size = (await fsp.stat(tmp)).size;
        if (size !== r.size || await digest(tmp) !== r.md5) throw fail(502, 'Google Drive restore verification failed');
        await fsp.rename(tmp, abs);
        r.localEvictedAt = null; r.lastAccessAt = stamp();
        await save();
        return abs;
      } finally { await fsp.rm(tmp, { force: true }); }
    })();
    restores.set(id, task);
    try { return await task; } finally { restores.delete(id); }
  }
  async function restoreReferences(value) {
    for (const id of assetReferenceClosure(value)) if (getAsset(id) && state.assets[id]) await ensureLocal(id);
  }
  async function restoreProject(id) {
    const p = getProduction(id);
    if (!p) throw fail(404, 'Project not found');
    await restoreReferences(projectSnapshot(p));
    return { restored: true, projectId: id };
  }
  async function run({ manual = false, projectId } = {}) {
    if (stateError) return statusView();
    if (busy) return statusView();
    if (!manual && !state.policy.enabled) return statusView();
    if (!manual && Date.parse(state.nextRetryAt || '') > clock()) return statusView();
    busy = true; state.lastError = null;
    let rateLimited = false;
    try {
      if (!await probe(true)) throw probeError || fail(503, connectionError || 'Google Drive is not connected');
      if (projectId) await archiveProject(projectId, manual);
      else {
        const delay = manual ? 0 : state.policy.uploadDelayHours * HOUR;
        for (const p of allProductions()) if (complete(p) && clock() - Date.parse(p.master.createdAt || p.updatedAt) >= delay) {
          try { await archiveProject(p.id, manual); } catch (e) { if (e.rateLimited) throw e; state.lastError = e.message; }
        }
        // Don't mistake an in-progress job result for a finished standalone video.
        if (!isBusy()) for (const a of standaloneVideos()) if (clock() - Date.parse(a.createdAt) >= delay) {
          try { await archiveVideo(a, manual); } catch (e) { if (e.rateLimited) throw e; state.lastError = e.message; }
        }
      }
      await cleanup();
    } catch (e) {
      state.lastError = e.message;
      if (e.rateLimited) { rateLimited = true; state.nextRetryAt = new Date(clock() + RATE_LIMIT_BACKOFF).toISOString(); }
    }
    finally { if (!rateLimited) state.nextRetryAt = null; busy = false; state.lastRunAt = stamp(); await save(); }
    return statusView();
  }
  function requestRun(opts = {}) {
    if (stateError) throw fail(503, stateError);
    if (opts.projectId) {
      const p = getProduction(opts.projectId);
      if (!p) throw fail(404, 'Project not found');
      if (!complete(p)) throw fail(409, 'Finish this project before archiving it');
    }
    if (busy || pendingRun) {
      if (opts.manual) throw fail(409, 'Another Google Drive backup is running. Try again when it finishes.');
      return { ...statusView(), busy: true, queued: false };
    }
    pendingRun = setTimeout(() => { pendingRun = null; run(opts).catch(() => {}); }, 0);
    return { ...statusView(), busy: true, queued: true };
  }
  function start() {
    if (stateError) return;
    timer ||= setInterval(() => requestRun(), 30_000); timer.unref();
    if (state.policy.enabled) requestRun();
    else if ([...Object.values(state.projects), ...Object.values(state.videos)].some((r) => r.status === 'uploading')) requestRun({ manual: true });
  }
  function stop() { clearInterval(timer); clearTimeout(pendingRun); timer = pendingRun = null; }
  return { status, settings, run, requestRun, start, stop, ensureLocal, restoreReferences, restoreProject,
    projectStatus(id) {
      const p = getProduction(id);
      if (!p) throw fail(404, 'Project not found');
      let r = state.projects[id];
      if (r?.status === 'verified') {
        try { if (!complete(p) || r.revision !== fingerprint(projectSnapshot(p))) r = { ...r, status: 'not_archived', error: 'Project changed since its last backup' }; }
        catch { r = { ...r, status: 'not_archived', error: 'Project references changed since its last backup' }; }
      }
      // The finished film itself (its backed-up master file), so people can open/download the movie directly
      // instead of digging through a project folder full of source clips.
      const masterId = p.master?.assetId;
      const masterDrive = masterId && state.assets[masterId]?.driveId;
      return { ...(r || { id, title: p.title, status: 'not_archived', folderUrl: null }),
        localOffloaded: !!state.assets[masterId]?.localEvictedAt,
        filmUrl: masterDrive && /^[\w-]{5,200}$/.test(masterDrive) ? `https://drive.google.com/file/d/${masterDrive}/view` : null };
    } };
}
