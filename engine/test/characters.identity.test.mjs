// Identity lock with the real catalog ids: a real-person character job routes to reference-to-video models in the
// measured order, and the refs land in each provider's request shape (fetch mocked — no network, no spend).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'charident-'));
Object.assign(process.env, { ENGINE_DATA: DATA, XAI_API_KEY: 'test-xai', APIMART_API_KEY: 'test-apimart', QWEN_API_KEY: 'test-qwen', FAL_KEY: 'test-fal' });
delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const make = (id, src) => { execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', path.join(MEDIA, `${id}.jpg`)]); return { id, file: `${id}.jpg`, mime: 'image/jpeg', kind: 'image', url: `/engine/media/${id}.jpg`, createdAt: new Date().toISOString() }; };
const assets = { a_front: make('a_front', 'testsrc2=s=1080x1350'), a_side: make('a_side', 'smptebars=s=1080x1350') };
fs.writeFileSync(path.join(DATA, 'assets.json'), JSON.stringify(assets));
const q = (score) => ({ score, sharp: 0.9, issues: [], flags: [] });
const ref = (assetId, angle, score, hash) => ({ assetId, workId: assetId, kind: 'photo', status: 'ready', angle, expression: 'neutral', framing: 'head-and-shoulders', cameraHeight: 'eye-level', quality: q(score), hash });
fs.writeFileSync(path.join(DATA, 'characters.json'), JSON.stringify({
  ch_j: { id: 'ch_j', name: 'Justin', description: 'full beard', lookNotes: '', voice: null, videos: [], createdAt: 'x', updatedAt: 'x', sheet: null, refs: [ref('a_front', 'front', 85, 'ffff000000000000'), ref('a_side', 'profileLeft', 75, '0000ffff0000ffff')] },
  ch_f: { id: 'ch_f', name: 'Nova', description: 'AI pilot', lookNotes: '', voice: null, videos: [], createdAt: 'x', updatedAt: 'x', sheet: null, realPerson: false, refs: [ref('a_side', 'front', 80, '0000ffff0000ffff')] },
}));
const MP4 = path.join(DATA, 'fake.mp4');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1', '-pix_fmt', 'yuv420p', MP4]);
const mp4 = fs.readFileSync(MP4);

const calls = [];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  let body = opts.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  calls.push({ url, method: opts.method || 'GET', body });
  if (url.endsWith('/fake.mp4')) return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
  if (url.includes('/video-generation/video-synthesis')) return json({ output: { task_id: 'q1', task_status: 'PENDING' } });
  if (url.includes('/api/v1/tasks/q1')) return json({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/fake.mp4' } });
  if (url === 'https://queue.fal.run/alibaba/wan-3.0/reference-to-video') return json({ request_id: 'f1', status_url: 'https://queue.fal.run/alibaba/wan-3.0/requests/f1/status', response_url: 'https://queue.fal.run/alibaba/wan-3.0/requests/f1' });
  if (url.startsWith('https://queue.fal.run/alibaba/wan-3.0/requests/f1/status')) return json({ status: 'COMPLETED' });
  if (url === 'https://queue.fal.run/alibaba/wan-3.0/requests/f1') return json({ video: { url: 'https://cdn.example/fake.mp4' } });
  if (url.includes('apimart.ai/v1/uploads/images')) return json({ url: `https://upload.apimart.example/${calls.length}.jpg` });
  if (url.includes('apimart.ai/v1/videos/generations')) return json({ code: 200, data: [{ task_id: 't1', status: 'submitted' }] });
  if (url.includes('apimart.ai/v1/tasks/t1')) return json({ code: 200, data: { status: 'completed', result: { videos: [{ url: ['https://cdn.example/fake.mp4'] }] } } });
  throw new Error(`unexpected fetch ${url}`);
};

let cat, ch;
before(async () => { cat = await import('../lib/catalog.js'); ch = await import('../lib/characters.js'); });
const lastPost = (frag) => calls.filter((c) => c.method === 'POST' && c.url.includes(frag)).at(-1)?.body;

test('IDENTITY_RANK names real catalog entries that all have a reference-to-video mode (caps.refs)', () => {
  for (const id of ch.IDENTITY_RANK) {
    const m = cat.getModel(id);
    assert.ok(m, `${id} is in the catalog`);
    assert.equal(m.kind, 'video');
    assert.ok(m.caps?.refs > 0, `${id} has caps.refs`);
  }
});

test('a real person ranks Veo 3.1 Fast ref → HappyHorse → Kling 3.0 Omni → Kling V4 → Grok 1.5 → Wan 3.0 → Wan 2.7 R2V', () => {
  const real = ch.resolveCharacters(['ch_j']);
  const ids = ch.identityModels(real).map((m) => m.id);
  assert.deepEqual(ids.slice(0, 7), ['apimart/veo3.1-fast', 'qwen/happyhorse-1.1', 'apimart/kling-v3-omni', 'apimart/kling-v4', 'xai/grok-imagine-video-1.5', 'fal/wan-3.0', 'apimart/wan2.7-r2v']);
  // Seedance never takes a real face as a reference (liveness-verified flow needed); fictional characters still can.
  assert.ok(!ids.some((id) => /seedance/.test(id)));
  assert.ok(ch.identityModels(ch.resolveCharacters(['ch_f'])).some((m) => m.id === 'apimart/seedance-2.0-fast'));
  assert.equal(ch.refsOk(cat.getModel('apimart/seedance-2.0-fast'), real), false);
});

test('first-frame model + real person → identity lock picks Veo 3.1 Fast in reference mode', async () => {
  const r = await cat.generate({ model: 'apimart/veo3.1-quality', prompt: 'Justin turns to camera.', characters: ['ch_j'], aspect: '16:9', likeness: false });
  assert.equal(r.asset.model, 'apimart/veo3.1-fast');
  assert.match(r.asset.characterNote, /^Identity lock: Veo 3\.1 Quality/);
  const b = lastPost('apimart.ai/v1/videos/generations');
  assert.equal(b.model, 'veo3.1-fast');
  assert.equal(b.generation_type, 'reference');
  assert.equal(b.image_urls.length, 2);
});

test('HappyHorse 1.1 + real person → happyhorse-1.1-r2v with reference_image media and [Image n] tags', async () => {
  const r = await cat.generate({ model: 'qwen/happyhorse-1.1', prompt: 'Justin walks into the cafe.', characters: ['ch_j'], aspect: '16:9', duration: 5, likeness: false });
  assert.equal(r.asset.model, 'qwen/happyhorse-1.1');
  const b = lastPost('/video-generation/video-synthesis');
  assert.equal(b.model, 'happyhorse-1.1-r2v');
  assert.equal(b.input.media.length, 2);
  assert.ok(b.input.media.every((x) => x.type === 'reference_image' && /^data:image\/jpeg;base64,/.test(x.url)));
  assert.match(b.input.prompt, /^Reference images: \[Image 1\]/);
  assert.match(b.input.prompt, /Justin walks into the cafe\.$/);
});

test('fal Wan 3.0 + real person → alibaba/wan-3.0/reference-to-video with reference_image_urls', async () => {
  const r = await cat.generate({ model: 'fal/wan-3.0', prompt: 'Justin looks over his shoulder.', characters: ['ch_j'], aspect: '16:9', duration: 5, likeness: false });
  assert.equal(r.asset.model, 'fal/wan-3.0');
  const b = calls.filter((c) => c.method === 'POST' && c.url === 'https://queue.fal.run/alibaba/wan-3.0/reference-to-video').at(-1)?.body;
  assert.ok(b, 'reference-to-video endpoint called');
  assert.equal(b.reference_image_urls.length, 2);
  assert.match(b.prompt, /^Reference images: Image 1, Image 2 are real photos of Justin/, 'the planner tags are kept, not doubled with "Image 1, Image 2:"');
});

test('Seedance 2.0 Fast + real person → rerouted by identity lock, never sent as a reference', async () => {
  const r = await cat.generate({ model: 'apimart/seedance-2.0-fast', prompt: 'Justin runs.', characters: ['ch_j'], aspect: '16:9', duration: 5, likeness: false });
  assert.notEqual(r.asset.model, 'apimart/seedance-2.0-fast');
  assert.match(r.asset.characterNote, /Identity lock/);
});

test('identity lock does not fire when every real-person ref is unusable (no-face)', async () => {
  const { isRealCast } = await import('../lib/characters.js');
  const bad = [{ name: 'X', realPerson: true, refs: [{ kind: 'photo', status: 'ready', quality: { flags: ['no-face'] } }, { kind: 'photo', status: 'ready', quality: { flags: ['no-face'] } }] }];
  const good = [{ name: 'Y', realPerson: true, refs: [{ kind: 'photo', status: 'ready', quality: { flags: [] } }] }];
  assert.equal(isRealCast(bad), false);
  assert.equal(isRealCast(good), true);
});
