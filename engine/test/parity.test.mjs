// Offline tests for the Higgsfield-parity tools: request shapes (checked against docs.apimart.ai and fal OpenAPI
// schemas), the tool registry contract served to the apps, and end-to-end tool runs with every network call stubbed.
// Run: node --test engine/test/   (needs ffmpeg for fixtures; makes no paid calls)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));
process.env.ENGINE_DATA = DATA;
process.env.FAL_KEY = 'test-fal';
process.env.APIMART_API_KEY = 'test-apimart';
process.env.ELEVENLABS_API_KEY = 'test-eleven';
delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY; delete process.env.XAI_API_KEY;

const FIX = path.join(DATA, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });
const ffm = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
ffm('-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', path.join(FIX, 'img.png'));
ffm('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(FIX, 'clip.mp4'));
ffm('-f', 'lavfi', '-i', 'sine=f=300:r=44100', '-t', '2', path.join(FIX, 'line.wav'));

/* ---------------- fetch stub ---------------- */
const calls = [];
const realFetch = globalThis.fetch;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const file = (p, type) => new Response(fs.readFileSync(p), { status: 200, headers: { 'Content-Type': type } });
let falOutput = {};
let amTask = {};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  calls.push({ url: u, method: opts.method || 'GET', body });
  if (u.startsWith('https://rest.fal.ai/storage/upload/initiate')) return json({ upload_url: `https://upload.test/${calls.length}`, file_url: `https://cdn.test/in-${calls.length}-${body.file_name}` });
  if (u.startsWith('https://upload.test/')) return new Response('', { status: 200 });
  if (u.startsWith('https://queue.fal.run/') && opts.method === 'POST') return json({ request_id: 'r1', status_url: 'https://queue.fal.run/app/requests/r1/status', response_url: 'https://queue.fal.run/app/requests/r1' });
  if (u.startsWith('https://queue.fal.run/app/requests/r1/status')) return json({ status: 'COMPLETED' });
  if (u === 'https://queue.fal.run/app/requests/r1') return json(falOutput);
  if (u === 'https://cdn.test/out.png') return file(path.join(FIX, 'img.png'), 'image/png');
  if (u === 'https://cdn.test/out.mp4') return file(path.join(FIX, 'clip.mp4'), 'video/mp4');
  if (u === 'https://api.apimart.ai/v1/uploads/images') return json({ code: 200, data: { url: `https://upload.apimart.test/${calls.length}.png` } });
  if (u.startsWith('https://api.apimart.ai/v1/') && opts.method === 'POST') return json({ code: 200, data: [{ status: 'submitted', task_id: 't1' }] });
  if (u.startsWith('https://api.apimart.ai/v1/tasks/t1')) return json({ code: 200, data: { status: 'completed', ...amTask } });
  if (u.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) return file(path.join(FIX, 'line.wav'), 'audio/mpeg');
  if (u.startsWith('http://127.0.0.1:')) return json({ error: 'no such route' }, 404);
  throw new Error(`unexpected fetch ${u}`);
};

let am, cinema, tools, store, ops, jobs;
before(async () => {
  am = await import('../lib/providers/apimart.js');
  cinema = await import('../lib/cinema.js');
  tools = await import('../lib/tools.js');
  store = await import('../lib/store.js');
  ops = await import('../lib/ops.js');
  jobs = await import('../lib/jobs.js');
});
after(() => { globalThis.fetch = realFetch; fs.rmSync(DATA, { recursive: true, force: true }); });

const fixture = (name, mime) => store.addAsset({ buffer: fs.readFileSync(path.join(FIX, name)), mime });
async function waitJob(id) {
  for (let i = 0; i < 200; i++) {
    const j = jobs.getJob(id);
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('job timeout');
}
const falSubmits = () => calls.filter((c) => c.url.startsWith('https://queue.fal.run/') && c.method === 'POST');
const amSubmits = () => calls.filter((c) => /api\.apimart\.ai\/v1\/(videos|images)\//.test(c.url) && c.method === 'POST');

/* ---------------- ApiMart request shapes (docs.apimart.ai) ---------------- */

test('ApiMart video bodies for the new models follow the docs', () => {
  const omni = am.videoBody({ model: 'kling-v3-omni', prompt: 'p', image: 'https://i/1', endImage: 'https://i/2', refs: ['https://i/3'], resolution: '1080p', duration: 8, aspect: '9:16' });
  assert.equal(omni.mode, 'pro');
  assert.deepEqual(omni.image_with_roles.map((r) => r.role), ['first_frame', 'last_frame', 'reference']);
  assert.equal(omni.image_urls, undefined, 'image_urls and image_with_roles are mutually exclusive');
  assert.equal(omni.duration, 8);

  const lite = am.videoBody({ model: 'veo3.1-lite', prompt: 'p', image: 'https://i/1', resolution: '4k' });
  assert.equal(lite.generation_type, undefined, 'veo3.1-lite must not send generation_type');
  assert.equal(lite.resolution, '720p');
  assert.equal(lite.duration, 8);

  const h3 = am.videoBody({ model: 'MiniMax-H3', prompt: 'p', refs: ['https://i/1'], audios: ['https://a/1'], resolution: '1080p', duration: 20 });
  assert.equal(h3.resolution, '2K');
  assert.equal(h3.duration, 15);
  assert.deepEqual(h3.image_urls, ['https://i/1']);
  assert.deepEqual(h3.audio_urls, ['https://a/1']);

  const hailuo = am.videoBody({ model: 'MiniMax-Hailuo-2.3', prompt: 'p', resolution: '1080p', duration: 10 });
  assert.equal(hailuo.duration, 6, '1080p Hailuo only supports 6 s');

  const sd = am.videoBody({ model: 'seedance-2.0', prompt: 'p', refs: ['https://i/1'], audios: ['https://a/1'] });
  assert.deepEqual(sd.image_with_roles, [{ url: 'https://i/1', role: 'reference_image' }], 'reference images ride in image_with_roles');
  assert.equal(sd.image_urls, undefined);
  assert.deepEqual(sd.audio_urls, ['https://a/1']);
  const sdFrame = am.videoBody({ model: 'seedance-2.0', prompt: 'p', image: 'https://i/1', refs: ['https://i/9'] });
  assert.equal(sdFrame.image_urls, undefined, 'reference media is not allowed with first/last frame');
  assert.equal(sdFrame.image_with_roles[0].role, 'first_frame');
});

test('ApiMart image bodies follow the docs', () => {
  const g = am.imageBody({ model: 'gpt-image-2', prompt: 'p', aspect: '16:9', resolution: '4K' });
  assert.deepEqual({ size: g.size, resolution: g.resolution, n: g.n }, { size: '16:9', resolution: '4k', n: 1 });
  const svg = am.imageBody({ model: 'gpt-image-2.6-flare', prompt: 'logo', format: 'svg', aspect: '1:1' });
  assert.equal(svg.output_format, 'svg');
  assert.ok(svg.svg?.model, 'svg output needs svg.model');
  assert.equal(svg.image_urls, undefined);
  const mask = am.imageBody({ model: 'gpt-image-2.6-flare', prompt: 'p', image: 'https://i/1', mask: 'https://m/1' });
  assert.equal(mask.mask_url, 'https://m/1');
  const sd = am.imageBody({ model: 'seedream-5-0-pro', prompt: 'p', image: 'https://i/1' });
  assert.equal(sd.resolution, '2K');
  assert.deepEqual(sd.image_urls, ['https://i/1']);
  const fx = am.imageBody({ model: 'flux-2-max', prompt: 'p' });
  assert.equal(fx.resolution, '4MP');
  assert.equal(fx.steps, undefined, 'steps/guidance are flux-2-flex only');
});

test('motion control and video edit bodies', () => {
  const m = am.motionBody({ image: 'https://i', video: 'https://v', orientation: 'image', quality: 'std', keepSound: false });
  assert.deepEqual([m.model, m.character_orientation, m.mode, m.keep_original_sound], ['kling-v3-motion-control', 'image', 'std', 'no']);
  assert.deepEqual(m.watermark_info, { enabled: false });
  const k = am.videoEditBody({ model: 'kling-v3-omni', prompt: 'p', video: 'https://v', refs: ['https://i'] });
  assert.deepEqual(k.video_list, [{ video_url: 'https://v', refer_type: 'base', keep_original_sound: 'yes' }]);
  assert.equal(k.duration, undefined, 'base edits follow the source duration');
  const w = am.videoEditBody({ model: 'wan2.7-videoedit', prompt: 'p', video: 'https://v', keepAudio: true });
  assert.deepEqual(w.video_urls, ['https://v']);
  assert.equal(w.resolution, '1080P');
  assert.equal(w.metadata.audio_setting, 'origin');
});

test('Qwen Token Plan bodies: HappyHorse routes to t2v / i2v / r2v, images use the messages envelope', async () => {
  const q = await import('../lib/providers/qwen.js');
  const t2v = q.qwenVideoBody({ prompt: 'p', aspect: '9:16', resolution: '480p', duration: 3 });
  assert.deepEqual([t2v.model, t2v.parameters.ratio, t2v.parameters.resolution, t2v.parameters.duration, t2v.parameters.watermark], ['happyhorse-1.1-t2v', '9:16', '480P', 3, false]);
  assert.equal(t2v.input.media, undefined);
  const i2v = q.qwenVideoBody({ prompt: 'p', image: 'data:image/png;base64,AA', aspect: '9:16', duration: 99 });
  assert.equal(i2v.model, 'happyhorse-1.1-i2v');
  assert.deepEqual(i2v.input.media, [{ type: 'first_frame', url: 'data:image/png;base64,AA' }]);
  assert.equal(i2v.parameters.ratio, undefined, 'no ratio for i2v');
  assert.equal(i2v.parameters.duration, 15);
  const r2v = q.qwenVideoBody({ prompt: 'walks into the cafe', refs: Array.from({ length: 12 }, (_, i) => `https://r/${i}`) });
  assert.equal(r2v.model, 'happyhorse-1.1-r2v');
  assert.equal(r2v.input.media.length, 9);
  assert.ok(r2v.input.media.every((m) => m.type === 'reference_image'));
  assert.match(r2v.input.prompt, /^\[Image 1\] .*\[Image 9\] walks into the cafe$/);
  const im = q.qwenImageBody({ model: 'wan2.7-image-pro', prompt: 'p', images: ['https://i/1'], aspect: '16:9' });
  assert.deepEqual(im.input.messages[0].content, [{ image: 'https://i/1' }, { text: 'p' }]);
  assert.equal(im.parameters.size, '1664*928');
});

test('fal Wan 3.0 routes text / image / reference-to-video with the documented fields', async () => {
  const { wan3Request } = await import('../lib/providers/fal.js');
  const t = wan3Request({ prompt: 'p', aspect: '9:16', resolution: '480p', duration: 2 });
  assert.equal(t.endpoint, 'alibaba/wan-3.0/text-to-video');
  assert.deepEqual([t.input.aspect_ratio, t.input.resolution, t.input.duration, t.input.audio], ['9:16', '480p', 2, true]);
  const i = wan3Request({ prompt: 'p', image: 'https://i/1', endImage: 'https://i/2', duration: 40 });
  assert.equal(i.endpoint, 'alibaba/wan-3.0/image-to-video');
  assert.equal(i.input.start_image_url, 'https://i/1');
  assert.equal(i.input.end_image_url, 'https://i/2');
  assert.equal(i.input.duration, 15);
  const r = wan3Request({ prompt: 'walks in', refs: ['https://i/1', 'https://i/2'] });
  assert.equal(r.endpoint, 'alibaba/wan-3.0/reference-to-video');
  assert.deepEqual(r.input.reference_image_urls, ['https://i/1', 'https://i/2']);
  assert.match(r.input.prompt, /^Image 1, Image 2: walks in$/);
});

/* ---------------- Cinema ---------------- */

test('cinema prompt stacks camera moves in order and adds look + genre', () => {
  const p = cinema.buildCinemaPrompt({ prompt: 'A detective in the rain', mode: 'video', camera: 'Classic 16mm Film', lens: 'Classic Anamorphic', focal: '35', aperture: 'f/1.4', moves: ['Dolly In', 'Whip Pan', '360 Orbit'], genre: 'Noir', grade: 'Monochrome', pacing: 'Single Shot' });
  assert.match(p, /first smooth dolly push-in.*then fast whip pan.*finally full 360-degree orbit/);
  assert.match(p, /16mm film camera/);
  assert.match(p, /film noir/);
  const still = cinema.buildCinemaPrompt({ prompt: 'x', mode: 'photo', moves: ['Dolly In'] });
  assert.doesNotMatch(still, /dolly/i, 'stills carry no camera moves');
  const pre = cinema.cinemaPresets();
  assert.ok(pre.moves.length >= 60);
});

/* ---------------- registry contract ---------------- */

const TYPES = ['text', 'longtext', 'image', 'video', 'audio', 'select', 'number', 'toggle', 'character', 'voice', 'model'];
test('every tool matches the schema the Apple app renders', async () => {
  const list = await tools.listTools({ all: true });
  assert.ok(list.length >= 30);
  const ids = new Set();
  for (const t of list) {
    assert.ok(!ids.has(t.id), `duplicate ${t.id}`); ids.add(t.id);
    for (const k of ['id', 'title', 'sfSymbol', 'category', 'description']) assert.equal(typeof t[k], 'string', `${t.id}.${k}`);
    assert.ok(['image', 'video', 'audio'].includes(t.output), `${t.id}.output`);
    assert.deepEqual(t.run, { method: 'POST', path: `/engine/api/tools/${t.id}/run` });
    const keys = new Set();
    for (const i of t.inputs) {
      assert.ok(TYPES.includes(i.type), `${t.id}.${i.key} type ${i.type}`);
      assert.ok(!keys.has(i.key), `${t.id} duplicate input ${i.key}`); keys.add(i.key);
      assert.equal(typeof i.label, 'string');
      assert.equal(i.prefer, undefined, 'internal fields are not served');
      if (i.type === 'select') assert.ok(i.options.some((o) => o.value === i.default), `${t.id}.${i.key} default ${i.default} not in options`);
      if (i.type === 'model') { assert.equal(typeof i.modelKind, 'string'); assert.ok(Array.isArray(i.options)); }
      if (i.type === 'number') assert.ok(i.min <= i.default && i.default <= i.max, `${t.id}.${i.key} range`);
    }
  }
  assert.ok(JSON.stringify(list).length < 400000);
});

test('input normalisation: required, clamps, toggles, unknown selects', () => {
  const t = tools.getTool('storyboard');
  assert.throws(() => tools.normalize(t, {}), /Story is required/);
  const v = tools.normalize(t, { prompt: 'x', frames: 99 });
  assert.equal(v.frames, 8);
  const s = tools.normalize(tools.getTool('sfx'), { prompt: 'boom', loop: 'true', seconds: '-3' });
  assert.equal(s.loop, true);
  assert.equal(s.seconds, 1);
  const fx = tools.normalize(tools.getTool('effects'), { image: 'a', effect: 'not-real' });
  assert.equal(fx.effect, 'bullet-time');
});

test('disabled tools are hidden and refuse to run', async () => {
  const visible = (await tools.listTools()).map((t) => t.id);
  const all = await tools.listTools({ all: true });
  for (const t of all.filter((x) => !x.enabled)) {
    assert.ok(!visible.includes(t.id), `${t.id} should be hidden`);
    assert.throws(() => tools.runTool(t.id, {}), /not enabled/);
  }
  // one tool per job: no model pickers except Cinema Studio
  for (const t of await tools.listTools()) if (t.id !== 'cinema-shot') assert.ok(!t.inputs.some((i) => i.type === 'model'), `${t.id} exposes a model picker`);
});

/* ---------------- end-to-end runs (stubbed providers) ---------------- */

test('Background Remover → fal Bria with a CDN-hosted input', async () => {
  const a = await fixture('img.png', 'image/png');
  falOutput = { image: { url: 'https://cdn.test/out.png' } };
  const n = falSubmits().length;
  const { jobId } = { jobId: tools.runTool('bg-remove', { image: a.id }).id };
  const j = await waitJob(jobId);
  assert.equal(j.status, 'done', j.error);
  const sub = falSubmits().slice(n)[0];
  assert.equal(sub.url, 'https://queue.fal.run/fal-ai/bria/background/remove');
  assert.match(sub.body.image_url, /^https:\/\/cdn\.test\//);
  assert.equal(j.kind, 'image');
});

test('Talking avatar → audio padded to the model minimum, OmniHuman request shape', async () => {
  const a = await fixture('img.png', 'image/png');
  const line = await fixture('line.wav', 'audio/wav');
  falOutput = { video: { url: 'https://cdn.test/out.mp4' } };
  const n = falSubmits().length;
  const j = await waitJob(tools.runTool('talking-avatar', { image: a.id, audio: line.id, prompt: 'warm smile' }).id);
  assert.equal(j.status, 'done', j.error);
  const sub = falSubmits().slice(n)[0];
  assert.equal(sub.url, 'https://queue.fal.run/bytedance/omnihuman/v2');
  assert.deepEqual(Object.keys(sub.body).sort(), ['audio_url', 'image_url', 'prompt']);
  // 2 s line was padded to OmniHuman's 4 s minimum before upload
  const uploads = calls.filter((c) => c.url.includes('/storage/upload/initiate'));
  assert.ok(uploads.some((u) => u.body.content_type === 'audio/wav'));
  assert.equal(j.kind, 'video');
});

test('Talking avatar from a script uses ElevenLabs then the avatar model', async () => {
  const a = await fixture('img.png', 'image/png');
  falOutput = { video: { url: 'https://cdn.test/out.mp4' } };
  const j = await waitJob(tools.runTool('talking-avatar', { image: a.id, text: 'Hello there', voice: 'abc123' }).id);
  assert.equal(j.status, 'done', j.error);
  assert.ok(calls.some((c) => c.url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/abc123')));
  assert.equal(falSubmits().at(-1).url, 'https://queue.fal.run/bytedance/omnihuman/v2');
});

test('Motion control → ApiMart Kling with fal-hosted reference video', async () => {
  const a = await fixture('img.png', 'image/png');
  const v = await fixture('clip.mp4', 'video/mp4');
  amTask = { result: { videos: [{ url: ['https://cdn.test/out.mp4'] }] } };
  const n = amSubmits().length;
  const j = await waitJob(tools.runTool('motion-control', { image: a.id, video: v.id }).id);
  assert.equal(j.status, 'done', j.error);
  const sub = amSubmits().slice(n)[0];
  assert.equal(sub.body.model, 'kling-v3-motion-control');
  assert.match(sub.body.video_url, /^https:\/\/cdn\.test\/.*\.mp4$/);
  assert.match(sub.body.image_url, /^https:\/\/cdn\.test\//);
});

test('Recast → PixVerse Swap (person) with CDN-hosted clip and photo', async () => {
  const a = await fixture('img.png', 'image/png');
  const v = await fixture('clip.mp4', 'video/mp4');
  falOutput = { video: { url: 'https://cdn.test/out.mp4' } };
  const n = falSubmits().length;
  const j = await waitJob(tools.runTool('recast', { video: v.id, person: a.id }).id);
  assert.equal(j.status, 'done', j.error);
  const sub = falSubmits().slice(n)[0];
  assert.equal(sub.url, 'https://queue.fal.run/fal-ai/pixverse/swap');
  assert.deepEqual([sub.body.mode, sub.body.original_sound_switch], ['person', true]);
  assert.match(sub.body.video_url, /^https:\/\/cdn\.test\/.*\.mp4$/);
});

test('Edit Video → Wan 2.7 VideoEdit, keeps original audio', async () => {
  const v = await fixture('clip.mp4', 'video/mp4');
  amTask = { result: { videos: [{ url: ['https://cdn.test/out.mp4'] }] } };
  const n = amSubmits().length;
  const j = await waitJob(tools.runTool('video-edit', { video: v.id, prompt: 'make it snow' }).id);
  assert.equal(j.status, 'done', j.error);
  const sub = amSubmits().slice(n)[0];
  assert.equal(sub.body.model, 'wan2.7-videoedit');
  assert.match(sub.body.video_urls[0], /^https:\/\/cdn\.test\//);
  assert.equal(sub.body.metadata.audio_setting, 'origin');
  assert.equal(sub.body.image_urls, undefined);
});

test('Product ad scene → keyframe on an image model, then image-to-video', async () => {
  const p = await fixture('img.png', 'image/png');
  amTask = { result: { images: [{ url: ['https://cdn.test/out.png'] }], videos: [{ url: ['https://cdn.test/out.mp4'] }] } };
  const n = amSubmits().length;
  const j = await waitJob(tools.runTool('product-scenes', { product: p.id, name: 'Glow Serum', scene: 'billboard-ad' }).id);
  assert.equal(j.status, 'done', j.error);
  const [img, vid] = amSubmits().slice(n);
  assert.equal(img.url, 'https://api.apimart.ai/v1/images/generations');
  assert.match(img.body.prompt, /Glow Serum/);
  assert.equal(vid.url, 'https://api.apimart.ai/v1/videos/generations');
  assert.equal(vid.body.model, 'kling-v3', 'real-product/person defaults avoid Gemini Omni');
  assert.equal(j.assets.length, 2);
});

test('Extend video: Grok extension on fal, joined with the source', async () => {
  const v = await fixture('clip.mp4', 'video/mp4');
  falOutput = { video: { url: 'https://cdn.test/out.mp4' } };
  const n = falSubmits().length;
  const j = await waitJob(tools.runTool('extend', { video: v.id, prompt: 'the camera keeps moving', seconds: 5 }).id);
  assert.equal(j.status, 'done', j.error);
  const sub = falSubmits().slice(n)[0];
  assert.equal(sub.url, 'https://queue.fal.run/xai/grok-imagine-video/extend-video');
  assert.equal(sub.body.duration, 5);
  assert.ok(j.duration > 7, `joined clip should be ~8 s, got ${j.duration}`);
});

test('Transitions: start + end frame on Kling 3.0', async () => {
  const a = await fixture('img.png', 'image/png');
  const b = await fixture('img.png', 'image/png');
  amTask = { result: { videos: [{ url: ['https://cdn.test/out.mp4'] }] } };
  const n = amSubmits().length;
  const j = await waitJob(tools.runTool('transitions', { start: a.id, end: b.id, style: 'whip-pan' }).id);
  assert.equal(j.status, 'done', j.error);
  const sub = amSubmits().slice(n)[0];
  assert.equal(sub.body.model, 'kling-v3');
  assert.equal(sub.body.image_urls.length, 2, 'first + last frame');
  assert.match(sub.body.prompt, /whip pan/);
});

test('Inpaint builds a full-size grayscale mask for FLUX Fill', async () => {
  const a = await fixture('img.png', 'image/png');
  const m = await fixture('img.png', 'image/png');
  falOutput = { images: [{ url: 'https://cdn.test/out.png' }] };
  const n = falSubmits().length;
  const j = await waitJob(tools.runTool('inpaint', { image: a.id, mask: m.id, prompt: 'a red balloon' }).id);
  assert.equal(j.status, 'done', j.error);
  const sub = falSubmits().slice(n)[0];
  assert.equal(sub.url, 'https://queue.fal.run/fal-ai/flux-pro/v1/fill');
  assert.ok(sub.body.mask_url && sub.body.image_url && sub.body.prompt);
});

test('Missing inputs fail the job with a readable message', async () => {
  const j = await waitJob(tools.runTool('face-swap', { image: (await fixture('img.png', 'image/png')).id }).id);
  assert.equal(j.status, 'error');
  assert.match(j.error, /upload a photo or pick a saved character/);
});
