// Isolated engine + fake Drive process: no real credentials, network provider calls or paid work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function engine(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-archive-http-'));
  await fs.mkdir(path.join(dir, 'archive'));
  const media = Buffer.from('A complete synthetic video for ranged downloads');
  const id = 'a_http123', remotePath = 'Film Studio/fixture/a_http123.mp4';
  await fs.writeFile(path.join(dir, 'source.mp4'), media);
  await fs.writeFile(path.join(dir, 'assets.json'), JSON.stringify({ [id]: { id, file: `${id}.mp4`, kind: 'video', mime: 'video/mp4', source: 'generated', createdAt: '2026-11-06T12:00:00Z' } }));
  await fs.writeFile(path.join(dir, 'archive/state.json'), JSON.stringify({ version: 1, policy: { enabled: false, uploadDelayHours: 0, removeLocalAfterHours: 48 }, projects: {}, videos: {}, assets: {
    [id]: { id, file: `${id}.mp4`, remotePath, size: media.length, md5: crypto.createHash('md5').update(media).digest('hex'), localEvictedAt: '2026-11-06T12:00:00Z' },
  } }));
  await fs.writeFile(path.join(dir, 'fake.conf'), '[gdrive]\ntype = drive\n');
  const cli = path.join(dir, 'fake-rclone');
  await fs.writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const a=process.argv.slice(2), i=a.indexOf('copyto');
if (i>=0) { fs.copyFileSync(process.env.SYNTHETIC_SOURCE, a[i+2]); process.exit(0); }
if(a.includes('about')) { console.log(JSON.stringify({free:100000})); process.exit(0); }
if(a.includes('lsjson')) { console.log(JSON.stringify(a.includes('--stat') ? {IsDir:true} : [{IsDir:true,Name:'Film Studio',ID:'private-fixture-folder'}])); process.exit(0); }
process.exit(2);
`, { mode: 0o755 });
  const holder = net.createServer(); await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = holder.address().port; await new Promise((resolve) => holder.close(resolve));
  const server = new URL('../server.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `globalThis.fetch = async () => { throw new Error('External providers disabled'); }; await import(${JSON.stringify(server)});`], {
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ENGINE_DATA: dir, ENGINE_DIST: path.join(dir, 'no-dist'), ENGINE_HOST: '127.0.0.1', ENGINE_PORT: String(port), ENGINE_REQUIRE_AUTH: '1', ENGINE_TOKEN: 'test-secret', ENGINE_ARCHIVE_RCLONE: cli, ENGINE_ARCHIVE_RCLONE_CONFIG: path.join(dir, 'fake.conf'), SYNTHETIC_SOURCE: path.join(dir, 'source.mp4') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', (b) => logs += b); child.stderr.on('data', (b) => logs += b);
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { child.kill('SIGTERM'); await closed; await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/engine/api/health')).ok) break; } catch {} await delay(30); }
  assert.equal(child.exitCode, null, logs);
  return { dir, media, base, request: (method, p, token = 'test-secret', extra = {}) => fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra.headers }, ...(extra.body ? { body: JSON.stringify(extra.body) } : {}) }) };
}

test('archive controls and remote media require normal studio authentication', async (t) => {
  const e = await engine(t);
  for (const [method, route] of [['GET', '/archive/status'], ['PATCH', '/archive/settings'], ['POST', '/archive/run'], ['GET', '/productions/prod_one/archive'], ['POST', '/productions/prod_one/archive'], ['POST', '/productions/prod_one/restore']]) {
    const r = await e.request(method, '/engine/api' + route, null, { body: method === 'GET' ? null : {} });
    assert.equal(r.status, 401, route);
  }
  assert.equal((await e.request('GET', '/engine/media/a_http123.mp4', null)).status, 401);
  await assert.rejects(fs.stat(path.join(e.dir, 'media/a_http123.mp4')), { code: 'ENOENT' });
  const r = await e.request('GET', '/engine/api/archive/status'); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.connected, true); assert.equal(j.policy.enabled, false);
  assert.equal(j.folderUrl, 'https://drive.google.com/drive/folders/private-fixture-folder');
  assert.ok(!JSON.stringify(j).includes('test-secret')); assert.ok(!JSON.stringify(j).includes(e.dir));
});

test('archived media transparently restores before authenticated Range and HEAD requests', async (t) => {
  const e = await engine(t);
  const r = await e.request('GET', '/engine/media/a_http123.mp4', 'test-secret', { headers: { Range: 'bytes=2-9' } });
  assert.equal(r.status, 206); assert.equal(await r.text(), e.media.subarray(2, 10).toString());
  assert.equal(r.headers.get('content-range'), `bytes 2-9/${e.media.length}`);
  assert.deepEqual(await fs.readFile(path.join(e.dir, 'media/a_http123.mp4')), e.media);
  const head = await e.request('HEAD', '/engine/media/a_http123.mp4');
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(e.media.length)); assert.equal(await head.text(), '');
  const persisted = JSON.parse(await fs.readFile(path.join(e.dir, 'archive/state.json')));
  assert.equal(persisted.assets.a_http123.localEvictedAt, null);
});
