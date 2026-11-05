// Character ranking / coverage / routing / request-shape tests. Run: node --test engine/test/
// Offline: no provider is called (fake keys only make providers "available" for routing decisions).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'chartest-'));
Object.assign(process.env, { ENGINE_DATA: DATA, XAI_API_KEY: 'test-xai', APIMART_API_KEY: 'test-apimart' });
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'KIE_API_KEY', 'FAL_KEY', 'FAL_API_KEY']) delete process.env[k];

// Fixture media + store files are written before the engine modules load.
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const img = (id, src) => { execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', path.join(MEDIA, `${id}.jpg`)]); return { id, file: `${id}.jpg`, mime: 'image/jpeg', kind: 'image', url: `/engine/media/${id}.jpg`, createdAt: '2026-11-05T00:00:00Z' }; };
const assets = {};
for (const [id, src] of [['a_front', 'testsrc2=s=1080x1350'], ['a_tql', 'smptebars=s=1080x1350'], ['a_smile', 'mandelbrot=s=1080x1350'], ['a_blurry', 'color=c=gray:s=1080x1350'], ['a_sheet', 'testsrc=s=1920x1080'], ['a_mara', 'rgbtestsrc=s=1080x1350']]) assets[id] = img(id, src);
fs.writeFileSync(path.join(DATA, 'assets.json'), JSON.stringify(assets));

const ref = (assetId, o = {}) => ({ assetId, workId: assetId, kind: 'photo', status: 'ready', angle: 'front', expression: 'neutral', framing: 'head-and-shoulders', cameraHeight: 'eye-level', hash: Math.random().toString(16).slice(2, 10).padEnd(8, '0') + '00000000', quality: { score: 80, sharp: 0.9, issues: [], flags: [] }, ...o });
const JUSTIN = {
  id: 'ch_justin', name: 'Justin', description: 'Late 30s, short dark-blond hair, full beard', lookNotes: 'a little slimmer than the photos', voice: { provider: 'eleven', voiceId: 'v_justin' },
  refs: [
    ref('a_sheet', { kind: 'sheet', angle: 'turnaround', quality: { score: 100, sharp: 1, issues: [], flags: [] } }),
    ref('a_front', { quality: { score: 88, sharp: 0.95, issues: [], flags: [] }, facialHair: 'full-beard' }),
    ref('a_tql', { angle: 'threeQuarterLeft', quality: { score: 74, sharp: 0.8, issues: [], flags: [] }, facialHair: 'full-beard' }),
    ref('a_smile', { expression: 'smile-teeth', quality: { score: 70, sharp: 0.8, issues: [], flags: [] }, facialHair: 'stubble' }),
    ref('a_blurry', { quality: { score: 22, sharp: 0.1, issues: ['Soft'], flags: ['blur'] } }),
  ],
  sheet: { assetId: 'a_sheet', approved: true, createdAt: '2026-11-05T00:00:00Z' }, videos: [], createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
};
const MARA = { id: 'ch_mara', name: 'Mara', description: 'botanist, red curls', lookNotes: '', voice: null, refs: [ref('a_mara')], sheet: null, videos: [], createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' };
fs.writeFileSync(path.join(DATA, 'characters.json'), JSON.stringify({ ch_justin: JUSTIN, ch_mara: MARA }));

let cr, ch, cat, xai, am;
before(async () => {
  cr = await import('../lib/charref.js');
  ch = await import('../lib/characters.js');
  cat = await import('../lib/catalog.js');
  xai = await import('../lib/providers/xai.js');
  am = await import('../lib/providers/apimart.js');
});

/* ---------------- grading ---------------- */

test('normalizeVision maps angles, falls back to yaw, cleans occlusion', () => {
  const v = cr.normalizeVision({ angle: 'three-quarter-left', expression: 'smile-teeth', occlusion: ['Sunglasses', 'cap', 'earring'], lighting: 'backlit', facial_hair: 'full beard' });
  assert.equal(v.angle, 'threeQuarterLeft');
  assert.deepEqual(v.occlusion, ['sunglasses', 'hat']);
  assert.equal(v.facialHair, 'full-beard');
  assert.equal(cr.normalizeVision({ yaw_degrees: 80 }).angle, 'profileRight');
  assert.equal(cr.normalizeVision({ yaw_degrees: -40 }).angle, 'threeQuarterLeft');
  assert.equal(cr.normalizeVision({ yaw_degrees: 5 }).angle, 'front');
  assert.equal(cr.normalizeVision(null), null);
});

test('qualityScore: clean rear-camera photo beats a filtered close selfie', () => {
  const clean = cr.qualityScore({ sharp: 0.95, width: 1536, height: 2048, vision: cr.normalizeVision({ angle: 'front', sharpness: 'sharp', face_height_fraction: 0.35 }) });
  const selfie = cr.qualityScore({ sharp: 0.48, width: 1170, height: 1841, vision: cr.normalizeVision({ angle: 'front', sharpness: 'slightly-soft', beauty_filter: true, wide_lens_distortion: true, face_height_fraction: 0.6 }) });
  assert.ok(clean.score >= 85, `clean ${clean.score}`);
  assert.ok(selfie.score < 40, `selfie ${selfie.score}`);
  assert.deepEqual(selfie.flags.sort(), ['filter', 'selfie-distortion']);
  assert.ok(selfie.issues.some((t) => /2× lens/.test(t)));
  const shades = cr.qualityScore({ sharp: 0.9, width: 1500, height: 2000, vision: cr.normalizeVision({ occlusion: ['sunglasses'] }) });
  assert.ok(shades.flags.includes('sunglasses') && shades.score < clean.score * 0.6);
  assert.equal(cr.sharpFromBlur(5.5), 1);
  assert.equal(cr.sharpFromBlur(12), 0);
  assert.equal(cr.qualityScore({ sharp: 0.9, width: 600, height: 800 }).flags.includes('low-res'), true);
});

/* ---------------- coverage ---------------- */

test('coverage reports filled slots, missing ones with tips, and inconsistent facial hair', () => {
  const cov = cr.coverage(JUSTIN.refs);
  assert.equal(cov.have.front, true);
  assert.equal(cov.have.threeQuarterLeft, true);
  assert.equal(cov.have.smile, true);
  assert.equal(cov.have.profileLeft, false);
  assert.equal(cov.slots.front.assetId, 'a_front'); // the blurry front (score 22) never wins
  assert.deepEqual(cov.missing, ['threeQuarterRight', 'profileLeft', 'profileRight', 'expression', 'lowAngle', 'fullBody']);
  assert.ok(cov.tips.some((t) => /below eye level/i.test(t)));
  assert.ok(cov.tips.some((t) => /different facial hair/.test(t)));
  assert.equal(cov.percent, 33);
  const low = cr.coverage([{ assetId: 'x', kind: 'photo', status: 'ready', angle: 'profileLeft', expression: 'neutral', framing: 'full-body', cameraHeight: 'below-eye-level', quality: { score: 70, flags: [] } }]);
  assert.equal(low.have.profileLeft, true);
  assert.equal(low.have.fullBody, true);
  assert.equal(low.have.lowAngle, false, 'full-body shots do not count as the low-angle head-and-shoulders');
});

/* ---------------- picking ---------------- */

test('pickRefs: approved sheet first, then distinct angles, blurry dropped, limit respected', () => {
  const four = cr.pickRefs(JUSTIN, 4).map((r) => r.assetId);
  assert.deepEqual(four, ['a_sheet', 'a_front', 'a_tql', 'a_smile']);
  assert.deepEqual(cr.pickRefs(JUSTIN, 2).map((r) => r.assetId), ['a_sheet', 'a_front']);
  assert.ok(!cr.pickRefs(JUSTIN, 6).some((r) => r.assetId === 'a_blurry'));
  // no approved sheet (no sheet ref) → photos only; a newer sheet awaiting review doesn't revoke the approved one
  assert.deepEqual(cr.pickRefs({ ...JUSTIN, refs: JUSTIN.refs.filter((r) => r.kind !== 'sheet') }, 2).map((r) => r.assetId), ['a_front', 'a_tql']);
  assert.equal(cr.pickRefs({ ...JUSTIN, sheet: { assetId: 'a_newer', approved: false } }, 2)[0].assetId, 'a_sheet');
  assert.deepEqual(cr.pickRefs(JUSTIN, 3, { includeSheet: false }).map((r) => r.assetId), ['a_front', 'a_tql', 'a_smile']);
  // near-duplicate of the front photo is skipped when filling the remainder
  const dup = { ...JUSTIN, refs: [...JUSTIN.refs, ref('a_dup', { hash: JUSTIN.refs[1].hash, quality: { score: 87, flags: [] } })] };
  assert.ok(!cr.pickRefs(dup, 6).some((r) => r.assetId === 'a_dup'));
});

test('budget shares references fairly between characters', () => {
  assert.deepEqual(cr.budget([5, 1], 6), [5, 1]);
  assert.deepEqual(cr.budget([5, 5], 6), [3, 3]);
  assert.deepEqual(cr.budget([5, 5, 5], 3), [1, 1, 1]);
  assert.deepEqual(cr.budget([2, 0], 6), [2, 0]);
});

test('planRefs labels images per provider syntax and says who is who', () => {
  const plain = cr.planRefs([JUSTIN, MARA], { limit: 6 });
  assert.equal(plain.refs.length, 5);
  assert.deepEqual(plain.refs.slice(-1), ['a_mara']);
  assert.match(plain.guide, /image 1 is the approved character sheet of Justin/);
  assert.match(plain.guide, /images 2–4 are real photos of Justin/);
  assert.match(plain.guide, /image 5 is a real photo of Mara/);
  assert.match(plain.guide, /different people/);
  assert.match(plain.guide, /Do not beautify/);
  assert.match(plain.guide, /slimmer than the photos/);
  const x = cr.planRefs([JUSTIN], { limit: 3, offset: 1, tag: 'xai' });
  assert.match(x.guide, /<IMAGE_1> is the approved character sheet/);
  assert.match(x.guide, /<IMAGE_2>, <IMAGE_3> are real photos/);
  assert.match(cr.planRefs([MARA], { tag: 'kling' }).guide, /@Image1 is a real photo of Mara/);
  assert.match(cr.planRefs([MARA], { tag: 'omni' }).guide, /<<<image_1>>>/);
  assert.equal(cr.planRefs([{ name: 'Nobody' }]).refs.length, 0);
  // inline long-form characters keep working
  assert.deepEqual(cr.planRefs([{ name: 'Old', refAssetIds: ['a_1', 'a_2'] }], { limit: 6 }).refs, ['a_1', 'a_2']);
});

/* ---------------- video frames ---------------- */

test('video frame selection: sharp first, no near-duplicates, spread in time, best per angle × expression', () => {
  const h = (n) => n.toString(16).padStart(16, '0');
  const frames = [
    { i: 0, t: 0, sharp: 0.9, hash: h(0) }, { i: 1, t: 0.17, sharp: 0.95, hash: h(1) }, // too close in time
    { i: 2, t: 2, sharp: 0.8, hash: h(0xffff0000) }, { i: 3, t: 4, sharp: 0.1, hash: h(0xff) }, // blurry
    { i: 4, t: 6, sharp: 0.85, hash: h(3) }, // same picture as frame 1
    { i: 5, t: 8, sharp: 0.7, hash: 'ffffffffffffffff' },
  ];
  const c = cr.selectFrameCandidates(frames, { max: 12, minGap: 0.6 });
  assert.deepEqual(c.map((f) => f.i), [1, 2, 5]);
  const q = (score, flags = []) => ({ score, flags });
  const graded = [
    { i: 1, angle: 'front', expression: 'neutral', quality: q(80) }, { i: 2, angle: 'front', expression: 'neutral', quality: q(85) },
    { i: 5, angle: 'threeQuarterLeft', expression: 'neutral', quality: q(70) }, { i: 6, angle: 'front', expression: 'laugh', quality: q(60) },
    { i: 7, angle: 'profileLeft', expression: 'neutral', quality: q(90, ['eyes-closed']) }, { i: 8, angle: 'profileRight', expression: 'neutral', quality: q(30) },
  ];
  assert.deepEqual(cr.finalizeFrames(graded, { max: 6 }).map((g) => g.i), [2, 5, 6]);
});

test('dhash / hamming', () => {
  const g = Buffer.alloc(72);
  for (let i = 0; i < 72; i++) g[i] = (i * 37) % 256;
  const a = cr.dhash(g);
  assert.equal(a.length, 16);
  assert.equal(cr.hamming(a, a), 0);
  assert.equal(cr.hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(cr.hamming(null, a), Infinity);
});

/* ---------------- routing ---------------- */

test('routeFor follows each model\'s inputs', () => {
  const r = (id, o) => cr.routeFor(cat.getModel(id), o);
  assert.equal(r('google/gemini-3-pro-image'), 'image-refs');
  assert.equal(r('xai/grok-imagine-image-2.0'), 'image-refs');
  assert.equal(r('fal/kontext-dev'), 'image-refs');
  assert.equal(r('fal/flux-dev'), 'text');
  assert.equal(r('xai/grok-imagine-video-1.5'), 'video-refs');
  assert.equal(r('xai/grok-imagine-video-1.5', { hasImage: true }), 'video-refs', '1.5 combines a first frame with refs');
  assert.equal(r('xai/grok-imagine-video', { hasImage: true }), 'text');
  assert.equal(r('apimart/veo3.1-fast'), 'video-refs');
  assert.equal(r('apimart/veo3.1-quality'), 'keyframe');
  assert.equal(r('apimart/kling-v4'), 'video-refs');
  assert.equal(r('apimart/kling-v4', { hasImage: true }), 'text');
  assert.equal(r('apimart/wan2.7-r2v', { hasImage: true }), 'video-refs');
  assert.equal(r('apimart/wan2.6'), 'keyframe');
  assert.equal(r('google/gemini-omni-1.1-flash'), 'keyframe');
  assert.equal(r('xai/grok-imagine-video-1.5-lite'), 'keyframe');
  const refModels = cat.allModels().filter((m) => m.kind === 'video' && m.caps?.refs).map((m) => `${m.id}:${m.caps.refs}`);
  assert.deepEqual(refModels.sort(), ['apimart/kling-v3-omni:7', 'apimart/kling-v4:10', 'apimart/seedance-2.0:9', 'apimart/seedance-2.5:30', 'apimart/veo3.1-fast:3', 'apimart/wan2.7-r2v:5', 'xai/grok-imagine-video-1.5:14', 'xai/grok-imagine-video:7'].sort());
});

test('applyCharacters: image model gets labelled refs (sheet first) ahead of user refs', async () => {
  const m = cat.getModel('xai/grok-imagine-image-2.0'); // 5 refs
  const j = await ch.applyCharacters({ model: m.id, prompt: 'Justin and Mara on a pier at dawn', characters: ['ch_justin', 'ch_mara'], refs: ['a_user'], aspect: '16:9' }, m);
  assert.deepEqual(j.refs, ['a_sheet', 'a_front', 'a_tql', 'a_mara', 'a_user']);
  assert.match(j.prompt, /^Reference images: image 1 is the approved character sheet of Justin/);
  assert.match(j.prompt, /Justin and Mara on a pier at dawn$/);
  assert.deepEqual(j.characterIds, ['ch_justin', 'ch_mara']);
  assert.equal(j.characters, undefined);
  // with a start image the refs number from image 2
  const k = await ch.applyCharacters({ model: m.id, prompt: 'p', characters: ['ch_mara'], image: 'a_start' }, m);
  assert.match(k.prompt, /image 2 is a real photo of Mara/);
  await assert.rejects(ch.applyCharacters({ model: m.id, prompt: 'p', characters: ['ch_nope'] }, m), /not found/);
});

test('applyCharacters: Grok video 1.5 goes reference-to-video with <IMAGE_n> tags', async () => {
  const m = cat.getModel('xai/grok-imagine-video-1.5');
  const j = await ch.applyCharacters({ model: m.id, prompt: 'Justin walks in.', characters: ['ch_justin'], aspect: '16:9' }, m);
  assert.equal(j.refMode, true);
  assert.deepEqual(j.refs, ['a_sheet', 'a_front', 'a_tql', 'a_smile']);
  assert.match(j.prompt, /<IMAGE_0> is the approved character sheet of Justin/);
  const withFrame = await ch.applyCharacters({ model: m.id, prompt: 'x', characters: ['ch_justin'], image: 'a_kf' }, m);
  assert.match(withFrame.prompt, /<IMAGE_1> is the approved character sheet/);
});

test('applyCharacters: Gemini Omni switches to a model that accepts real people', async () => {
  const m = cat.getModel('google/gemini-omni-1.1-flash');
  const j = await ch.applyCharacters({ model: m.id, prompt: 'x', characters: ['ch_justin'] }, m);
  assert.equal(j.model, ch.identityModels([JUSTIN])[0].id);
  assert.match(j.characterNote, /refuses to animate real people.*using/);
  assert.deepEqual(j.characters, ['ch_justin'], 'characters stay on the job for the new model');
  // even with identity lock off, Omni is never used for a real person
  const off = await ch.applyCharacters({ model: m.id, prompt: 'x', characters: ['ch_justin'], identityLock: false }, m);
  assert.notEqual(off.model, m.id);
});

test('identity lock: real people go to reference-to-video models, ahead of first-frame-only ones', async () => {
  const q = cat.getModel('apimart/veo3.1-quality'); // first-frame only
  const j = await ch.applyCharacters({ model: q.id, prompt: 'Justin turns to camera', characters: ['ch_justin'] }, q);
  assert.equal(j.model, ch.identityModels([JUSTIN])[0].id);
  assert.match(j.characterNote, /^Identity lock: Veo 3\.1 Quality \(ApiMart\) only animates a still/);
  // with a start frame only models taking frame + refs qualify (Grok 1.5 here; Wan 2.7 R2V also would)
  const f = await ch.applyCharacters({ model: q.id, prompt: 'x', characters: ['ch_justin'], image: 'a_kf' }, q);
  assert.ok(cat.getModel(f.model).caps.refsWithImage, f.model);
  // opt out keeps the chosen model: keyframe route with staging guidance
  const k = cat.getModel('apimart/kling-v4');
  const t = await ch.applyCharacters({ model: k.id, prompt: 'Justin waves', characters: ['ch_justin'], image: 'a_kf', identityLock: false }, k);
  assert.equal(t.refMode, undefined);
  assert.match(t.prompt, /^Characters \(keep their look consistent\): Justin: Late 30s.*Staging: open with Justin's face clearly visible/);
  // Seedance never gets a real person's photos as references; a fictional character is fine
  const sd = cat.getModel('apimart/seedance-2.0');
  assert.equal(ch.refsOk(sd, [JUSTIN]), false);
  assert.equal(ch.refsOk(sd, [{ ...JUSTIN, realPerson: false }]), true);
  const s2 = await ch.applyCharacters({ model: sd.id, prompt: 'x', characters: ['ch_justin'] }, sd);
  assert.notEqual(s2.model, sd.id);
  // fictional characters are left alone on a first-frame model
  assert.equal(ch.characterFallback(q, [{ ...JUSTIN, realPerson: false }]), null);
});

test('generate(): first-frame model makes a keyframe from the refs, then animates it (offline models)', async () => {
  const r = await cat.generate({ model: 'local/animatic', prompt: 'Justin looks out to sea', characters: ['ch_justin'], keyframeModel: 'local/plate', aspect: '16:9', duration: 1, identityLock: false, likeness: false });
  assert.equal(r.asset.kind, 'video');
  assert.deepEqual(r.asset.characters, ['ch_justin']);
  assert.match(r.asset.prompt, /^Characters \(keep their look consistent\): Justin.*Staging: open with Justin's face clearly visible/);
});

test('likeness summary: average, worst second, flags below threshold, ignores frames without the face', async () => {
  const { summarize } = await import('../lib/likeness.js');
  const f = (t, score, visible = true, character = 'Justin') => ({ t, faces: [{ character, visible, score: visible ? score : null }] });
  const s = summarize([f(0.25, 9), f(0.75, 8), f(1.25, null, false), f(1.75, 4), f(2.25, 7)], { threshold: 6 });
  assert.equal(s.score, 7);
  assert.equal(s.min, 4);
  assert.equal(s.minAt, 1.75);
  assert.equal(s.pass, false);
  assert.deepEqual(s.flagged.map((x) => x.t), [1.75]);
  assert.equal(s.visibleFrames, 4);
  assert.equal(s.perCharacter.Justin.min, 4);
  assert.equal(summarize([f(0.5, null, false)]).pass, null, 'no face visible → no verdict');
  const two = summarize([{ t: 0.5, faces: [{ character: 'Justin', visible: true, score: 9 }, { character: 'Mara', visible: true, score: 5 }] }]);
  assert.equal(two.frames[0].score, 5);
  assert.equal(two.frames[0].character, 'Mara');
});

test('long-form: { characterId } entries resolve; inline entries still work', () => {
  const res = ch.resolveBriefCharacters([{ characterId: 'ch_justin' }, { name: 'Old style', description: 'd', refAssetId: 'a_x', refAssetIds: ['a_y'] }, { characterId: 'ch_gone' }]);
  assert.equal(res.length, 2);
  assert.equal(res[0].name, 'Justin');
  assert.deepEqual(res[0].refAssetIds, ['a_sheet', 'a_front', 'a_tql', 'a_smile']);
  assert.deepEqual(res[1].refAssetIds, ['a_y', 'a_x']);
  assert.deepEqual(ch.characterVoice('char:ch_justin'), { provider: 'eleven', voiceId: 'v_justin' });
  assert.equal(ch.characterVoice('char:ch_mara'), null);
});

/* ---------------- request shapes (offline, from the providers' docs) ---------------- */

test('xAI reference-to-video request body', () => {
  const b = xai.xaiVideoBody({ model: 'grok-imagine-video-1.5', prompt: '<IMAGE_0> walks', aspect: '16:9', duration: 8, resolution: '1080p', refs: ['data:image/jpeg;base64,AAA', 'https://x/y.jpg'] });
  assert.deepEqual(b.reference_images, [{ url: 'data:image/jpeg;base64,AAA' }, { url: 'https://x/y.jpg' }]);
  assert.equal(b.resolution, '720p');
  assert.equal(b.aspect_ratio, '16:9');
  assert.equal(b.image, undefined);
  const withFrame = xai.xaiVideoBody({ model: 'grok-imagine-video-1.5', prompt: 'p', image: 'https://f', refs: ['https://r'], duration: 15 });
  assert.deepEqual(withFrame.image, { url: 'https://f' });
  assert.equal(withFrame.duration, 15);
  const classic = xai.xaiVideoBody({ model: 'grok-imagine-video', prompt: 'p', duration: 15, refs: Array(9).fill('https://r') });
  assert.equal(classic.reference_images.length, 7);
  assert.equal(classic.duration, 10);
  assert.equal(xai.xaiVideoBody({ model: 'grok-imagine-video-1.5', prompt: 'p', resolution: '1080p' }).reference_images, undefined);
});

test('ApiMart reference-mode request bodies', () => {
  const refs = ['https://u/1.jpg', 'https://u/2.jpg', 'https://u/3.jpg', 'https://u/4.jpg'];
  const veo = am.apimartVideoBody({ model: 'veo3.1-fast', prompt: 'p', aspect: '9:16', refs });
  assert.equal(veo.generation_type, 'reference');
  assert.deepEqual(veo.image_urls, refs.slice(0, 3));
  assert.equal(am.apimartVideoBody({ model: 'veo3.1-fast', prompt: 'p', image: 'https://f' }).generation_type, 'frame');
  const sd = am.apimartVideoBody({ model: 'seedance-2.0', prompt: 'p', aspect: '16:9', refs: ['asset://a1', 'asset://a2'] });
  assert.deepEqual(sd.image_with_roles, [{ url: 'asset://a1', role: 'reference_image' }, { url: 'asset://a2', role: 'reference_image' }]);
  assert.equal(sd.size, '16:9');
  assert.equal(sd.image_urls, undefined, 'image_urls and image_with_roles are mutually exclusive');
  const sd25 = am.apimartVideoBody({ model: 'seedance-2.5', prompt: 'p', refs: ['asset://a1'] });
  assert.equal(sd25.omni_reference_task_type, 'reference');
  assert.equal(am.apimartVideoBody({ model: 'seedance-2.5', prompt: 'p', image: 'https://f' }).omni_reference_task_type, undefined);
  const k4 = am.apimartVideoBody({ model: 'kling-v4', prompt: '@Image1 runs', aspect: '21:9', refs });
  assert.equal(k4.omni_reference_task_type, 'reference');
  assert.deepEqual(k4.image_with_roles.map((x) => x.role), ['reference_image', 'reference_image', 'reference_image', 'reference_image']);
  assert.equal(k4.image_urls, undefined);
  const omni = am.apimartVideoBody({ model: 'kling-v3-omni', prompt: '<<<image_1>>> waves', resolution: '1080p', refs: Array(9).fill('https://r') });
  assert.equal(omni.image_urls.length, 7);
  assert.equal(omni.mode, 'pro');
  assert.equal(omni.image_with_roles, undefined);
  const omniFrame = am.apimartVideoBody({ model: 'kling-v3-omni', prompt: 'p', image: 'https://f', endImage: 'https://l' });
  assert.deepEqual(omniFrame.image_with_roles, [{ url: 'https://f', role: 'first_frame' }, { url: 'https://l', role: 'last_frame' }]);
  const wan = am.apimartVideoBody({ model: 'wan2.7-r2v', prompt: 'image 1 walks', aspect: '9:16', duration: 8, resolution: '720p', refs: refs.concat('https://u/5.jpg', 'https://u/6.jpg') });
  assert.equal(wan.image_with_roles.length, 5);
  assert.equal(wan.size, '9:16');
  assert.equal(wan.resolution, '720P');
  assert.equal(wan.prompt_extend, false);
  const wanFrame = am.apimartVideoBody({ model: 'wan2.7-r2v', prompt: 'p', image: 'https://f', refs });
  assert.equal(wanFrame.image_with_roles.length, 5);
  assert.deepEqual(wanFrame.image_with_roles.at(-1), { url: 'https://f', role: 'first_frame' });
  assert.equal(wanFrame.size, undefined);
  assert.deepEqual(am.apimartAvatarBody({ url: 'https://u/1.jpg', name: 'a_1' }), { group: { name: 'studio-characters' }, project_name: 'default', asset_type: 'Image', assets: [{ url: 'https://u/1.jpg', name: 'a_1' }] });
});
