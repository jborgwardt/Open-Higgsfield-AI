// Long-form identity lock: a real-person shot routes to a reference-to-video model, the likeness check runs on the
// result, and a drifting clip is re-rendered once with the next strategy (the better render is kept).
// Providers and the vision model are mocked — no network, no spend. Run: node --test engine/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'charlf-'));
Object.assign(process.env, { ENGINE_DATA: DATA, APIMART_API_KEY: 'test-apimart', GEMINI_API_KEY: 'test-gemini' });
delete process.env.XAI_API_KEY;
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const make = (id, src) => { execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', path.join(MEDIA, `${id}.jpg`)]); return { id, file: `${id}.jpg`, mime: 'image/jpeg', kind: 'image', url: `/engine/media/${id}.jpg`, createdAt: new Date().toISOString() }; };
fs.writeFileSync(path.join(DATA, 'assets.json'), JSON.stringify({ a_front: make('a_front', 'testsrc2=s=1080x1350'), a_side: make('a_side', 'smptebars=s=1080x1350') }));
const q = (score) => ({ score, sharp: 0.9, issues: [], flags: [] });
fs.writeFileSync(path.join(DATA, 'characters.json'), JSON.stringify({
  ch_j: {
    id: 'ch_j', name: 'Justin', description: 'full beard', lookNotes: '', voice: null, videos: [], createdAt: 'x', updatedAt: 'x', sheet: null,
    refs: [
      { assetId: 'a_front', workId: 'a_front', kind: 'photo', status: 'ready', angle: 'front', expression: 'neutral', framing: 'head-and-shoulders', cameraHeight: 'eye-level', quality: q(85), hash: 'ffff000000000000' },
      { assetId: 'a_side', workId: 'a_side', kind: 'photo', status: 'ready', angle: 'profileLeft', expression: 'neutral', framing: 'head-and-shoulders', cameraHeight: 'eye-level', quality: q(75), hash: '0000ffff0000ffff' },
    ],
  },
}));
const MP4 = path.join(DATA, 'fake.mp4');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2', '-pix_fmt', 'yuv420p', MP4]);
const mp4 = fs.readFileSync(MP4);

const calls = [];
let qa = 0;
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  let body = opts.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  calls.push({ url, method: opts.method || 'GET', body });
  if (url.endsWith('/fake.mp4')) return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
  if (url.includes('apimart.ai/v1/uploads/images')) return json({ url: `https://upload.example/${calls.length}.jpg` });
  if (url.includes('apimart.ai/v1/videos/generations')) return json({ code: 200, data: [{ task_id: `t${calls.length}` }] });
  if (url.includes('apimart.ai/v1/tasks/t')) return json({ code: 200, data: { status: 'completed', cost: 0.14, result: { videos: [{ url: ['https://cdn.example/fake.mp4'] }] } } });
  if (url.includes('generativelanguage.googleapis.com/v1beta/openai/chat/completions')) {
    const parts = body.messages[0].content;
    const reply = (o) => json({ choices: [{ message: { content: JSON.stringify(o) } }] });
    // head detection: a box for every image
    if (/bounding box/.test(parts[0].text)) return reply({ boxes: parts.filter((c) => c.type === 'image_url').map(() => [[120, 300, 700, 680]]) });
    // likeness judge on face crops: the first render drifts to 3/10 at the 4th frame, the re-render holds 8/10
    const n = parts.filter((c) => c.type === 'text' && /^F\d+ /.test(c.text)).length;
    const score = qa++ === 0 ? (k) => (k === 3 ? 3 : 8) : () => 8;
    return reply({ frames: Array.from({ length: n }, (_, k) => ({ frame: k + 1, verdict: score(k) >= 6 ? 'same' : 'different', score: score(k), why: '' })) });
  }
  throw new Error(`unexpected fetch ${url}`);
};

test('long-form: identity lock + likeness QA re-renders a drifting shot once and keeps the better render', { timeout: 120000 }, async () => {
  const lf = await import('../lib/longform.js');
  const ch = await import('../lib/characters.js');
  const plan = ch.identityModels(ch.resolveCharacters(['ch_j']));
  assert.ok(plan.length >= 2, 'needs two reference models connected');
  let p = await lf.createProduction({ title: 'Test', videoModel: 'apimart/veo3.1-quality', imageModel: 'local/plate', characters: [{ characterId: 'ch_j' }], clipSeconds: 5, autoAssemble: false });
  await lf.addShot(p.id, null, { title: 'Turn', prompt: 'Justin, in profile at a window, turns to the camera and smiles.' });
  await lf.start(p.id);
  for (let i = 0; i < 100; i++) {
    p = lf.getProduction(p.id);
    if (['review', 'done', 'error'].includes(p.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const s = p.shots[0];
  assert.equal(s.status, 'done', s.error || s.message);
  assert.equal(s.identityTries.length, 2, 'rendered twice');
  assert.equal(s.identityTries[0].identity.model, plan[0].id, 'attempt 1: best reference model, not the first-frame-only Veo Quality');
  assert.equal(s.identityTries[1].identity.model, plan[1].id, 'attempt 2: the next reference model');
  assert.equal(s.identityTries[0].likeness.min, 3);
  assert.equal(s.identityTries[0].likeness.pass, false);
  assert.ok(s.identityTries[0].likeness.minAt > 0);
  assert.equal(s.likeness.min, 8, 'kept the better render');
  assert.equal(s.videoId, s.identityTries[1].videoId);
  assert.equal(s.identity.mode, 'refs');
  const gens = calls.filter((c) => c.url.includes('/videos/generations'));
  assert.equal(gens.length, 2);
  assert.ok(gens.every((g) => !g.body.model.startsWith('veo3.1-quality')));
  assert.ok(p.log.some((l) => /likeness 3\/10 at .*re-rendering once/.test(l.msg)), p.log.map((l) => l.msg).join('\n'));
  const h = lf.hydrate(p);
  assert.equal(h.shots[0].likeness.min, 8);
  assert.equal(h.brief.characters[0].resolvedName, 'Justin');
});
