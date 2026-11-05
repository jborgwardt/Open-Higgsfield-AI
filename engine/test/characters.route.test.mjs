// End-to-end routing through generate() with fetch mocked: proves the request each provider would receive
// when a character is attached (no network, no spend). Run: node --test engine/test/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'charroute-'));
Object.assign(process.env, { ENGINE_DATA: DATA, XAI_API_KEY: 'test-xai', APIMART_API_KEY: 'test-apimart', GEMINI_API_KEY: 'test-gemini' });
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const make = (id, src) => { execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', path.join(MEDIA, `${id}.jpg`)]); return { id, file: `${id}.jpg`, mime: 'image/jpeg', kind: 'image', url: `/engine/media/${id}.jpg`, createdAt: new Date().toISOString() }; };
const assets = { a_sheet: make('a_sheet', 'testsrc=s=1920x1080'), a_front: make('a_front', 'testsrc2=s=1080x1350'), a_side: make('a_side', 'smptebars=s=1080x1350') };
fs.writeFileSync(path.join(DATA, 'assets.json'), JSON.stringify(assets));
const q = (score) => ({ score, sharp: 0.9, issues: [], flags: [] });
const FICTION = {
  id: 'ch_f', name: 'Nova', description: 'AI-generated pilot', lookNotes: '', voice: null, videos: [], createdAt: 'x', updatedAt: 'x', realPerson: false, sheet: null,
  refs: [{ assetId: 'a_side', workId: 'a_side', kind: 'photo', status: 'ready', angle: 'front', expression: 'neutral', framing: 'head-and-shoulders', cameraHeight: 'eye-level', quality: { score: 80, sharp: 0.9, issues: [], flags: [] }, hash: '0000ffff0000ffff' }],
};
fs.writeFileSync(path.join(DATA, 'characters.json'), JSON.stringify({
  ch_f: FICTION,
  ch_j: {
    id: 'ch_j', name: 'Justin', description: 'full beard', lookNotes: '', voice: null, videos: [], createdAt: 'x', updatedAt: 'x',
    sheet: { assetId: 'a_sheet', approved: true },
    refs: [
      { assetId: 'a_sheet', workId: 'a_sheet', kind: 'sheet', status: 'ready', angle: 'turnaround', quality: q(100), hash: '0000000000000000' },
      { assetId: 'a_front', workId: 'a_front', kind: 'photo', status: 'ready', angle: 'front', expression: 'neutral', framing: 'head-and-shoulders', cameraHeight: 'eye-level', quality: q(85), hash: 'ffff000000000000' },
      { assetId: 'a_side', workId: 'a_side', kind: 'photo', status: 'ready', angle: 'profileLeft', expression: 'neutral', framing: 'head-and-shoulders', cameraHeight: 'eye-level', quality: q(75), hash: '0000ffff0000ffff' },
    ],
  },
}));
const MP4 = path.join(DATA, 'fake.mp4');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1', '-pix_fmt', 'yuv420p', MP4]);
const mp4 = fs.readFileSync(MP4);

// fetch mock: records every call, answers like the providers do.
const calls = [];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  let body = opts.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  calls.push({ url, method: opts.method || 'GET', body });
  if (url.endsWith('/fake.mp4')) return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
  if (url.includes('api.x.ai/v1/videos/generations')) return json({ request_id: 'xr1' });
  if (url.includes('api.x.ai/v1/videos/xr1')) return json({ status: 'done', video: { url: 'https://cdn.example/fake.mp4', duration: 1 } });
  if (url.includes('apimart.ai/v1/uploads/images')) return json({ url: `https://upload.apimart.example/${calls.length}.jpg` });
  if (url.includes('apimart.ai/v1/seedance2/private-avatar')) return json({ code: 200, data: { id: `av${calls.length}`, status: 'processing' } });
  if (url.includes('apimart.ai/v1/tasks/av')) return json({ code: 200, data: { status: 'completed', result: { usable_assets: [{ asset_url: `asset://${url.split('/tasks/')[1]}` }] } } });
  if (url.includes('apimart.ai/v1/videos/generations')) return json({ code: 200, data: [{ task_id: 't1', status: 'submitted' }] });
  if (url.includes('apimart.ai/v1/tasks/t1')) return json({ code: 200, data: { status: 'completed', result: { videos: [{ url: ['https://cdn.example/fake.mp4'] }] } } });
  throw new Error(`unexpected fetch ${url}`);
};

let cat;
before(async () => { cat = await import('../lib/catalog.js'); });
const lastPost = (frag) => calls.filter((c) => c.method === 'POST' && c.url.includes(frag)).at(-1)?.body;

test('Grok Imagine Video 1.5 + character → reference_images in the request, 720p', async () => {
  const r = await cat.generate({ model: 'xai/grok-imagine-video-1.5', prompt: 'Justin walks to the window.', characters: ['ch_j'], aspect: '16:9', duration: 8, resolution: '1080p', likeness: false });
  const b = lastPost('api.x.ai/v1/videos/generations');
  assert.equal(b.model, 'grok-imagine-video-1.5');
  assert.equal(b.reference_images.length, 3);
  assert.ok(b.reference_images.every((x) => /^data:image\/jpeg;base64,/.test(x.url)));
  assert.equal(b.resolution, '720p');
  assert.match(b.prompt, /^Reference images: <IMAGE_0> is the approved character sheet of Justin, and <IMAGE_1>, <IMAGE_2> are real photos of Justin \(front; profile\)/);
  assert.equal(r.asset.kind, 'video');
  assert.deepEqual(r.asset.characters, ['ch_j']);
});

test('Veo 3.1 Fast + character → generation_type reference with uploaded URLs (≤ 3)', async () => {
  await cat.generate({ model: 'apimart/veo3.1-fast', prompt: 'Justin smiles.', characters: ['ch_j'], aspect: '9:16', likeness: false });
  const b = lastPost('apimart.ai/v1/videos/generations');
  assert.equal(b.model, 'veo3.1-fast');
  assert.equal(b.generation_type, 'reference');
  assert.equal(b.image_urls.length, 3);
  assert.ok(b.image_urls.every((u) => u.startsWith('https://upload.apimart.example/')));
});

test('Seedance 2.0 + fictional character → refs registered as virtual-avatar assets, sent as reference_image roles', async () => {
  await cat.generate({ model: 'apimart/seedance-2.0', prompt: 'Nova runs.', characters: ['ch_f'], aspect: '16:9', duration: 5, likeness: false });
  const b = lastPost('apimart.ai/v1/videos/generations');
  assert.equal(b.model, 'seedance-2.0');
  assert.equal(b.image_with_roles.length, 1);
  assert.ok(b.image_with_roles.every((x) => x.role === 'reference_image' && x.url.startsWith('asset://')));
  assert.equal(b.size, '16:9');
  const avatar = lastPost('seedance2/private-avatar');
  assert.equal(avatar.asset_type, 'Image');
  // cached: a second render doesn't re-register
  const before = calls.filter((c) => c.url.includes('private-avatar')).length;
  await cat.generate({ model: 'apimart/seedance-2.0', prompt: 'again', characters: ['ch_f'], aspect: '16:9', duration: 5, likeness: false });
  assert.equal(calls.filter((c) => c.url.includes('private-avatar')).length, before);
});

test('Seedance + a real person → never sent to the avatar library; identity lock picks a reference model', async () => {
  const before = calls.filter((c) => c.url.includes('private-avatar')).length;
  const r = await cat.generate({ model: 'apimart/seedance-2.0', prompt: 'Justin runs.', characters: ['ch_j'], aspect: '16:9', duration: 5, likeness: false });
  assert.equal(calls.filter((c) => c.url.includes('private-avatar')).length, before);
  assert.notEqual(r.asset.model, 'apimart/seedance-2.0');
  assert.match(r.asset.characterNote, /Identity lock/);
});

test('Kling V4 + character → image_with_roles reference + omni_reference_task_type', async () => {
  await cat.generate({ model: 'apimart/kling-v4', prompt: 'Justin turns.', characters: ['ch_j'], aspect: '16:9', duration: 5, likeness: false });
  const b = lastPost('apimart.ai/v1/videos/generations');
  assert.equal(b.omni_reference_task_type, 'reference');
  assert.match(b.prompt, /@Image1 is the approved character sheet/);
});

test('Wan 2.7 R2V with no start frame and no character fails clearly', async () => {
  await assert.rejects(cat.generate({ model: 'apimart/wan2.7-r2v', prompt: 'x' }), /needs a start frame or a character/);
});

test('Gemini Omni + real-photo character → reroutes to a reference-to-video model; Omni is never called', async () => {
  const r = await cat.generate({ model: 'google/gemini-omni-1.1-flash', prompt: 'Justin at the window.', characters: ['ch_j'], aspect: '16:9', likeness: false });
  assert.ok(!calls.some((c) => c.url.includes('generativelanguage.googleapis.com/v1beta/interactions')), 'Omni was never called');
  assert.ok(cat.getModel(r.asset.model).caps.refs, r.asset.model);
  assert.match(r.asset.characterNote, /refuses to animate real people/);
});

test('Veo 3.1 Quality first-frame + real person with identity lock off → keyframe + staging, frame mode', async () => {
  const r = await cat.generate({ model: 'apimart/veo3.1-quality', prompt: 'Justin at the window.', characters: ['ch_j'], keyframeModel: 'local/plate', aspect: '16:9', identityLock: false, likeness: false });
  const b = lastPost('apimart.ai/v1/videos/generations');
  assert.equal(b.model, 'veo3.1-quality');
  assert.equal(b.generation_type, 'frame');
  assert.match(b.prompt, /Staging: keep Justin's face visible/);
  assert.equal(r.asset.model, 'apimart/veo3.1-quality');
});
