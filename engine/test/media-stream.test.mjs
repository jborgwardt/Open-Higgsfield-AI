// Media serving: full, ranged and HEAD responses stay correct, and aborted downloads / quick seeks never leave
// file descriptors open (a 147 MB master once held 30 descriptors after a phone seeked and dropped requests).
// Starts the real engine on a free loopback port with a throwaway data dir. Linux (/proc) for the fd checks.
// Run on the VPS: node --test engine/test/media-stream.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'media-stream-'));
const FILE = 'a_streamtest01.mp4';
const SIZE = 32 * 1024 * 1024;
let engine, PORT, BYTES;

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open descriptors of the engine process that point at the test media file (Linux /proc). */
function openOnFile() {
  const dir = `/proc/${engine.pid}/fd`;
  let n = 0;
  for (const fd of fs.readdirSync(dir)) { try { if (fs.readlinkSync(path.join(dir, fd)).endsWith(FILE)) n++; } catch {} }
  return n;
}
async function settledFds(ms = 4000) {
  const end = Date.now() + ms;
  let n = openOnFile();
  while (n > 0 && Date.now() < end) { await sleep(100); n = openOnFile(); }
  return n;
}

function request({ method = 'GET', range, abortAfter, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/engine/media/${FILE}`, method, headers: { ...(range ? { Range: range } : {}), ...extra } }, (res) => {
      const chunks = []; let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (abortAfter != null && got >= abortAfter) { req.destroy(); resolve({ status: res.statusCode, aborted: true, got }); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => resolve({ status: res.statusCode, aborted: true, got }));
    });
    req.on('error', (e) => (abortAfter != null ? resolve({ aborted: true }) : reject(e)));
    req.end();
  });
}

before(async () => {
  fs.mkdirSync(path.join(DATA, 'media'), { recursive: true });
  BYTES = crypto.randomBytes(SIZE);
  fs.writeFileSync(path.join(DATA, 'media', FILE), BYTES);
  PORT = await freePort();
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: DATA, ENGINE_DATA: DATA, ENGINE_DIST: path.join(DATA, 'no-dist'), ENGINE_HOST: '127.0.0.1', ENGINE_PORT: String(PORT) };
  engine = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('engine did not start')), 15000);
    engine.stdout.on('data', (d) => { if (String(d).includes('engine →')) { clearTimeout(t); resolve(); } });
    engine.on('exit', (c) => reject(new Error(`engine exited ${c}`)));
  });
});
after(() => { engine?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('full download is complete and byte-exact', async () => {
  const r = await request();
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers['content-length']), SIZE);
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.ok(r.body.equals(BYTES));
});

test('ranges (start-end, open-ended, suffix) are exact; bad ranges are 416', async () => {
  const a = await request({ range: 'bytes=100-199' });
  assert.equal(a.status, 206);
  assert.equal(a.headers['content-range'], `bytes 100-199/${SIZE}`);
  assert.ok(a.body.equals(BYTES.subarray(100, 200)));
  const b = await request({ range: `bytes=${SIZE - 10}-` });
  assert.ok(b.body.equals(BYTES.subarray(SIZE - 10)));
  const c = await request({ range: 'bytes=-16' });
  assert.ok(c.body.equals(BYTES.subarray(SIZE - 16)));
  assert.equal((await request({ range: `bytes=${SIZE + 5}-` })).status, 416);
});

test('HEAD (plain and ranged) sends headers only', async () => {
  const h = await request({ method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(Number(h.headers['content-length']), SIZE);
  assert.equal(h.body.length, 0);
  const hr = await request({ method: 'HEAD', range: 'bytes=0-1023' });
  assert.equal(hr.status, 206);
  assert.equal(hr.body.length, 0);
});

test('aborted downloads and rapid seeks leave no open file descriptors', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  // A phone that gives up mid-download, several times.
  await Promise.all(Array.from({ length: 6 }, () => request({ abortAfter: 256 * 1024 })));
  // A player seeking: each new range request is dropped quickly.
  for (let i = 0; i < 12; i++) await request({ range: `bytes=${i * 1024 * 1024}-`, abortAfter: 64 * 1024 });
  assert.equal(await settledFds(), 0, 'every aborted stream released its file descriptor');
  // And serving still works afterwards.
  const r = await request({ range: 'bytes=0-9' });
  assert.ok(r.body.equals(BYTES.subarray(0, 10)));
  assert.equal(await settledFds(), 0);
});

test('validators + If-Range let an interrupted download resume (and restart if the file changed)', async () => {
  const h = await request({ method: 'HEAD' });
  assert.match(h.headers.etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok(h.headers['last-modified']);
  const resumed = await request({ range: 'bytes=1000-1999', headers: { 'If-Range': h.headers.etag } });
  assert.equal(resumed.status, 206);
  assert.ok(resumed.body.equals(BYTES.subarray(1000, 2000)));
  const byDate = await request({ range: 'bytes=0-9', headers: { 'If-Range': h.headers['last-modified'] } });
  assert.equal(byDate.status, 206);
  const stale = await request({ range: 'bytes=1000-1999', headers: { 'If-Range': '"stale-etag"' } });
  assert.equal(stale.status, 200, 'a different file version gets the whole file, not a mismatched piece');
  assert.equal(stale.body.length, SIZE);
});
