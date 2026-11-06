import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createArchiveManager, sanitizedSnapshot, remoteMD5, rcloneFailure } from '../lib/archive.js';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
test('normalizes actual rclone lowercase hashes and uppercase legacy examples', () => {
  const liveShape = { Path: 'a_64b885e77835.mp4', Name: 'a_64b885e77835.mp4', Size: 1865649, IsDir: false, Hashes: { md5: '01d28204cffaaa46f5f3c6ea3179938b' }, ID: 'synthetic-drive-id' };
  assert.equal(remoteMD5(liveShape), '01d28204cffaaa46f5f3c6ea3179938b');
  assert.equal(remoteMD5({ Hashes: { MD5: '01D28204CFFAAA46F5F3C6EA3179938B' } }), remoteMD5(liveShape));
  assert.equal(remoteMD5({ Hashes: { SHA256: 'unrelated' } }), '');
  assert.equal(remoteMD5(null), '');
});
async function fixture(t) {
  const data = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-archive-')), media = path.join(data, 'media');
  await fsp.mkdir(media);
  let time = Date.parse('2026-11-06T12:00:00Z'), active = false, offline = false, failUpload = false, corruptDownload = false, rateLimited = false;
  const assets = {}, projects = {}, chars = {}, remote = new Map();
  const calls = { uploads: 0, downloads: 0, probes: 0 };
  const adapter = {
    configured: () => true,
    async probe() { calls.probes++; if (offline) throw new Error('Drive is offline'); if (rateLimited) throw rcloneFailure('RATE_LIMIT_EXCEEDED'); },
    async upload(file, key) { calls.uploads++; if (failUpload) throw new Error('upload failed'); remote.set(key, await fsp.readFile(file)); },
    async stat(key) {
      if (offline) throw new Error('Drive is offline');
      if (!remote.has(key)) { if ([...remote.keys()].some((k) => k.startsWith(key + '/'))) return { IsDir: true, ID: 'private-folder-id' }; throw new Error('not found'); }
      const b = remote.get(key); return { Size: b.length, Hashes: { md5: md5(b) }, ID: 'file-id', IsDir: false };
    },
    async download(key, file) { calls.downloads++; await fsp.writeFile(file, corruptDownload ? 'corrupt' : remote.get(key)); },
  };
  const opts = { data, media, adapter, clock: () => time, isBusy: () => active,
    getAsset: (id) => assets[id], listAssets: () => Object.values(assets), getProduction: (id) => projects[id], listProductions: () => Object.values(projects), getCharacter: (id) => chars[id], listCharacters: () => Object.values(chars) };
  let manager = createArchiveManager(opts);
  t.after(async () => { manager.stop(); await fsp.rm(data, { recursive: true, force: true }); });
  async function asset(id, { source = 'generated', kind = 'video', ...extra } = {}) {
    const a = assets[id] = { id, file: `${id}.mp4`, url: `/engine/media/${id}.mp4`, createdAt: new Date(time - 72 * 3600_000).toISOString(), source, kind, ...extra };
    await fsp.writeFile(path.join(media, a.file), `synthetic-media-${id}`); return a;
  }
  async function project(id = 'prod_one') {
    await asset('a_master', { source: 'master' }); await asset('a_clip'); await asset('a_song', { source: 'upload', kind: 'audio' }); await asset('a_ref', { source: 'upload', kind: 'image' });
    chars.ch_dog = { id: 'ch_dog', name: 'Dog', refs: [{ assetId: 'a_ref' }] };
    return projects[id] = { id, title: '../A / film', status: 'done', updatedAt: new Date(time - 72 * 3600_000).toISOString(), brief: { characters: [{ characterId: 'ch_dog' }], musicAssetId: 'a_song' },
      shots: [{ id: 'sh_one', status: 'done', videoId: 'a_clip' }], master: { assetId: 'a_master', createdAt: new Date(time - 72 * 3600_000).toISOString() } };
  }
  return { data, media, assets, projects, chars, remote, calls, asset, project,
    get m() { return manager; },
    async enable() { await manager.settings({ enabled: true }); manager.stop(); },
    advance(hours) { time += hours * 3600_000; },
    active(v) { active = v; }, offline(v) { offline = v; }, failUpload(v) { failUpload = v; }, corruptDownload(v) { corruptDownload = v; }, rateLimit(v) { rateLimited = v; },
    restart() { manager.stop(); manager = createArchiveManager(opts); return manager; },
    exists(id) { return fs.existsSync(path.join(media, assets[id].file)); },
  };
}

test('archives a self-contained private project including original song and character references', async (t) => {
  const f = await fixture(t); await f.project();
  await f.m.run({ manual: true });
  const state = f.m.projectStatus('prod_one');
  assert.equal(state.status, 'verified'); assert.match(state.folderUrl, /^https:\/\/drive.google.com\/drive\/folders\//);
  assert.ok(!state.folder.includes('..')); assert.ok(state.folder.endsWith('--prod_one'));
  const manifest = JSON.parse(f.remote.get(`${state.folder}/project.json`));
  assert.deepEqual(manifest.assets.map((a) => a.id).sort(), ['a_clip', 'a_master', 'a_ref', 'a_song']);
  assert.equal(manifest.characters[0].name, 'Dog');
  const count = f.calls.uploads;
  await f.enable(); await f.m.run(); assert.equal(f.calls.uploads, count, 'unchanged scheduled project is idempotent');
  for (const id of Object.keys(f.assets)) assert.equal(f.exists(id), true, 'archiving alone does not delete files');
});

test('fresh backups are retained for 48 hours; only completed masters and standalone videos are offloaded', async (t) => {
  const f = await fixture(t); await f.project(); await f.asset('a_single'); await f.enable();
  f.projects.prod_one.screening = { status: 'done', masterAssetId: 'a_master', score: 8 };
  await f.m.run({ manual: true });
  assert.equal(f.exists('a_master'), true); assert.equal(f.exists('a_single'), true);
  f.advance(47); await f.m.run(); assert.equal(f.exists('a_master'), true);
  f.advance(2); await f.m.run();
  assert.equal(f.exists('a_master'), false); assert.equal(f.exists('a_single'), false);
  for (const id of ['a_clip', 'a_song', 'a_ref']) assert.equal(f.exists(id), true);
  assert.equal(f.m.projectStatus('prod_one').localOffloaded, true);
});

test('corrupt remote data, failed uploads and lost Drive connection never cause local deletion', async (t) => {
  const f = await fixture(t); await f.project(); await f.enable();
  f.failUpload(true); await f.m.run(); f.advance(72); await f.m.run(); assert.equal(f.exists('a_master'), true);
  f.failUpload(false); await f.m.run(); f.advance(49);
  const key = [...f.remote.keys()].find((k) => k.endsWith('/a_master.mp4'));
  const good = f.remote.get(key); f.remote.set(key, Buffer.from('CORRUPTED'));
  const status = await f.m.run(); assert.match(status.lastError, /verification failed/); assert.equal(f.exists('a_master'), true);
  f.remote.set(key, good); f.offline(true); await f.m.run(); assert.equal(f.exists('a_master'), true);
});

test('active work and masters shared by unfinished projects prevent offloading', async (t) => {
  const f = await fixture(t); await f.project(); await f.enable(); await f.m.run(); f.advance(49);
  f.active(true); await f.m.run(); assert.equal(f.exists('a_master'), true); f.active(false);
  f.projects.prod_other = { id: 'prod_other', status: 'paused', brief: { refAssetIds: ['a_master'] }, shots: [] };
  await f.m.run(); assert.equal(f.exists('a_master'), true);
  delete f.projects.prod_other;
  f.projects.prod_one.status = 'running'; await f.m.run(); assert.equal(f.exists('a_master'), true);
});

test('cached Topaz inputs stay local and automatic input restore follows asset metadata', async (t) => {
  const f = await fixture(t); await f.project();
  await f.asset('a_topaz', { source: 'upscaled', hidden: true, parentId: 'a_clip' });
  f.assets.a_clip.upscaled = { '3840x2160': 'a_topaz' };
  await f.asset('a_orphanCache', { source: 'upscaled' });
  await f.asset('a_hiddenCache', { hidden: true });
  await f.enable(); await f.m.run(); f.advance(49); await f.m.run();
  assert.equal(f.exists('a_master'), false, 'finished master remains eligible for offloading');
  assert.equal(f.exists('a_topaz'), true, 'a hidden derived shot input is not a standalone finished video');
  assert.equal(f.exists('a_orphanCache'), true, 'unreferenced upscale caches are conservatively retained');
  assert.equal(f.exists('a_hiddenCache'), true, 'hidden intermediate videos are conservatively retained');

  // Recover a cache evicted by a prior version. This is the production object passed by the
  // POST /productions/:id/assemble interceptor, not the expanded archive manifest.
  await fsp.unlink(path.join(f.media, f.assets.a_topaz.file));
  await f.m.restoreReferences(f.projects.prod_one);
  assert.equal(f.exists('a_topaz'), true, 'restores the transitive cached input before FFmpeg reuses it');
  assert.equal(f.exists('a_master'), true);
  assert.equal(f.calls.downloads, 2, 'the source/cache parent cycle does not duplicate transfers');
});

test('archived video restores after restart with a single checksum-verified transfer and resets retention', async (t) => {
  const f = await fixture(t); await f.project(); await f.enable(); await f.m.run(); f.advance(49); await f.m.run();
  f.restart(); assert.equal(f.m.projectStatus('prod_one').localOffloaded, true);
  const [a, b] = await Promise.all([f.m.ensureLocal('a_master'), f.m.ensureLocal('a_master')]);
  assert.equal(a, b); assert.equal(f.calls.downloads, 1); assert.equal(f.exists('a_master'), true);
  assert.equal(f.m.projectStatus('prod_one').localOffloaded, false);
  f.advance(47); await f.m.run(); assert.equal(f.exists('a_master'), true);
  f.advance(2); await f.m.run(); assert.equal(f.exists('a_master'), false);
});

test('bad restore leaves no corrupt final file or partial temp file', async (t) => {
  const f = await fixture(t); await f.project(); await f.enable(); await f.m.run(); f.advance(49); await f.m.run();
  f.corruptDownload(true);
  await assert.rejects(f.m.ensureLocal('a_master'), /restore verification failed/);
  assert.equal(f.exists('a_master'), false);
  assert.equal((await fsp.readdir(f.media)).some((n) => n.includes('.restore-')), false);
  f.corruptDownload(false); await f.m.ensureLocal('a_master'); assert.equal(f.exists('a_master'), true);
});

test('project edits during backup prevent marking its snapshot verified', async (t) => {
  const f = await fixture(t); await f.project();
  // Mutate on the event-loop turn while file upload is reading local data.
  setImmediate(() => { f.projects.prod_one.title = 'New title'; });
  await f.m.run({ manual: true }); assert.equal(f.m.projectStatus('prod_one').status, 'error');
  assert.equal(f.exists('a_master'), true);
  await f.m.run({ manual: true }); assert.equal(f.m.projectStatus('prod_one').status, 'verified');
});

test('rejects traversal and symlinks, invalid policies, and credential fields in manifests', async (t) => {
  const f = await fixture(t); await f.project();
  f.assets.a_master.file = '../outside.mp4';
  await assert.rejects(f.m.ensureLocal('a_master'), /Invalid media file path/);
  f.assets.a_master.file = 'a_master.mp4';
  await fsp.unlink(path.join(f.media, 'a_master.mp4')); await fsp.symlink(path.join(f.media, 'a_song.mp4'), path.join(f.media, 'a_master.mp4'));
  await assert.rejects(f.m.ensureLocal('a_master'), /symbolic link/);
  await assert.rejects(f.m.settings({ uploadDelayHours: -1 }), /Choose immediate/);
  await assert.rejects(f.m.settings({ enabled: 'yes' }), /true or false/);
  await assert.rejects(f.m.settings({ rootFolder: '../../bad' }), /Unknown backup/);
  assert.deepEqual(sanitizedSnapshot({ brief: { title: 'Keep', apiKey: 'secret', nested: { access_token: 'secret', remote: 'signed-url' } }, credentials: 'secret' }), { brief: { title: 'Keep', nested: {} } });
});

test('delayed auto backup waits; manual backup bypasses upload delay but never retention', async (t) => {
  const f = await fixture(t); await f.project();
  f.projects.prod_one.master.createdAt = new Date('2026-11-06T12:00:00Z').toISOString();
  await f.m.settings({ enabled: true, uploadDelayHours: 24 }); f.m.stop();
  await f.m.run(); assert.equal(f.m.projectStatus('prod_one').status, 'not_archived');
  await f.m.run({ manual: true }); assert.equal(f.m.projectStatus('prod_one').status, 'verified'); assert.equal(f.exists('a_master'), true);
});

test('manual backup repairs a missing remote copy and busy manual requests report a conflict', async (t) => {
  const f = await fixture(t); await f.project(); await f.m.run({ manual: true });
  const key = [...f.remote.keys()].find((k) => k.endsWith('/a_master.mp4')); f.remote.delete(key);
  await f.m.run({ manual: true }); assert.ok(f.remote.has(key));
  f.m.requestRun({ manual: true });
  assert.throws(() => f.m.requestRun({ manual: true, projectId: 'prod_one' }), (e) => e.status === 409);
  f.m.stop();
});

test('changed project status is visibly stale and corrupt archive history never resets or deletes data', async (t) => {
  const f = await fixture(t); await f.project(); await f.m.run({ manual: true });
  f.projects.prod_one.title = 'Changed'; assert.equal(f.m.projectStatus('prod_one').status, 'not_archived');
  const history = path.join(f.data, 'archive/state.json');
  for (const bad of ['{broken', 'null', '[]', '{"projects":null}', '{"assets":{"a_master":null}}', '{"policy":{"enabled":"yes"}}']) {
    await fsp.writeFile(history, bad);
    f.restart(); assert.match((await f.m.status()).lastError, /history is unreadable/);
    await f.m.run({ manual: true }); assert.equal(f.exists('a_master'), true);
    assert.equal(await fsp.readFile(history, 'utf8'), bad);
  }
});

test('rate-limit diagnostics disclose no stderr and scheduled retries back off for fifteen minutes', async (t) => {
  const error = rcloneFailure('access_token=synthetic-secret googleapi: Error403 RATE_LIMIT_EXCEEDED project=private-value');
  assert.equal(error.rateLimited, true); assert.equal(error.retryable, true);
  assert.match(error.message, /connection is rate-limited/); assert.ok(!error.message.includes('synthetic-secret')); assert.ok(!error.message.includes('private-value'));
  const f = await fixture(t); await f.project(); await f.enable(); f.rateLimit(true);
  const failed = await f.m.run(); assert.ok(failed.nextRetryAt); assert.match(failed.lastError, /rate-limited/); assert.equal(f.exists('a_master'), true);
  const probes = f.calls.probes;
  f.advance(0.1); await f.m.run(); assert.equal(f.calls.probes, probes, 'background does not retry inside backoff');
  await f.m.run({ manual: true }); assert.equal(f.calls.probes, probes + 1, 'explicit retry bypasses backoff');
  f.restart(); await f.m.run(); assert.equal(f.calls.probes, probes + 1, 'backoff survives restart');
  f.advance(0.3); f.rateLimit(false); const success = await f.m.run(); assert.equal(success.nextRetryAt, null); assert.equal(f.m.projectStatus('prod_one').status, 'verified');
});
