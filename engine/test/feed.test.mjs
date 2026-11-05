// Home feed (engine/lib/feed.js): sections from the live catalog / tools registry, server-side edits persisted in
// DATA/feed.json, and preview ingestion (mobile transcode + poster). No network. Run: node --test engine/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
// Only xAI is connected: every non-xAI cloud model must be absent from the feed.
for (const k of ['FAL_KEY', 'FAL_API_KEY', 'REPLICATE_API_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MUAPI_KEY', 'KIE_API_KEY', 'APIMART_API_KEY', 'VENICE_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVEN_API_KEY', 'QWEN_API_KEY']) delete process.env[k];
Object.assign(process.env, { ENGINE_DATA: DATA, XAI_API_KEY: 'test-xai' });
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
ff('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:d=2:r=24', '-f', 'lavfi', '-i', 'sine=d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(MEDIA, 'a_srcvid.mp4'));
ff('-f', 'lavfi', '-i', 'testsrc2=s=720x960:d=2:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(MEDIA, 'a_tallvid.mp4'));
ff('-f', 'lavfi', '-i', 'testsrc=s=2048x2048', '-frames:v', '1', path.join(MEDIA, 'a_srcimg.jpg'));
const t0 = '2026-01-01T00:00:00.000Z';
fs.writeFileSync(path.join(DATA, 'assets.json'), JSON.stringify({
  a_srcvid: { id: 'a_srcvid', file: 'a_srcvid.mp4', mime: 'video/mp4', kind: 'video', url: '/engine/media/a_srcvid.mp4', createdAt: t0, model: 'xai/grok-imagine-video-1.5', prompt: 'whale of clouds' },
  a_tallvid: { id: 'a_tallvid', file: 'a_tallvid.mp4', mime: 'video/mp4', kind: 'video', url: '/engine/media/a_tallvid.mp4', createdAt: '2026-01-02T00:00:00.000Z', model: 'xai/grok-imagine-video-1.5-lite', prompt: 'lanterns', width: 720, height: 960 },
  a_srcimg: { id: 'a_srcimg', file: 'a_srcimg.jpg', mime: 'image/jpeg', kind: 'image', url: '/engine/media/a_srcimg.jpg', createdAt: '2026-01-03T00:00:00.000Z', model: 'xai/grok-imagine-image-2.0', prompt: 'galaxy lion', width: 2048, height: 2048 },
  a_poster: { id: 'a_poster', file: 'a_srcimg.jpg', mime: 'image/jpeg', kind: 'image', url: '/engine/media/a_srcimg.jpg', createdAt: '2026-01-04T00:00:00.000Z', source: 'poster' },
}));

const feed = await import('../lib/feed.js');
const store = await import('../lib/store.js');
const { publicCatalog } = await import('../lib/catalog.js');
const tools = await import('../lib/tools.js');
const ctx = async () => ({ models: publicCatalog(), tools: await tools.listTools(), characters: [{ id: 'ch_1', name: 'Nova', description: 'android pilot', coverUrl: '/engine/media/a_srcimg.jpg' }], media: store.listAssets() });
const section = (f, id) => f.sections.find((s) => s.id === id);
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());

test('default feed: shape, only available models, only enabled tools', async () => {
  const f = feed.buildFeed(await ctx());
  assert.equal(f.version, 1);
  for (const s of f.sections) {
    assert.ok(['hero', 'shelf', 'grid', 'chips'].includes(s.style), s.id);
    assert.ok(s.items.length > 0, `${s.id} not empty`);
    for (const i of s.items) {
      assert.deepEqual(Object.keys(i).filter((k) => k !== 'subtitle').sort(), ['action', 'aspect', 'id', 'kind', 'previewKind', 'previewPoster', 'previewUrl', 'title'].sort(), i.id);
      assert.ok(['model', 'tool', 'preset', 'studio', 'character', 'media'].includes(i.kind));
      assert.ok(['create', 'tool', 'films', 'characters', 'library'].includes(i.action.type), i.id);
    }
  }
  assert.deepEqual(f.sections.map((s) => s.id), ['studios', 'quick', 'video-models', 'presets', 'apps', 'image-models', 'characters', 'recent']);
  const vm = section(f, 'video-models').items.map((i) => i.action.model);
  assert.deepEqual(vm, ['xai/grok-imagine-video-1.5', 'xai/grok-imagine-video-1.5-lite']);
  assert.deepEqual(section(f, 'image-models').items.map((i) => i.id), ['model:xai/grok-imagine-image-2.0']);
  const apps = section(f, 'apps').items.map((i) => i.action.toolId);
  assert.ok(apps.includes('effects') && apps.includes('cinema-shot'));
  for (const off of tools.TOOLS.filter((t) => t.enabled === false)) assert.ok(!apps.includes(off.id), `${off.id} disabled`);
  assert.equal(apps.length, tools.TOOLS.filter((t) => t.enabled !== false).length);
});

test('preset cards open their tool with a preset that exists', async () => {
  const f = feed.buildFeed(await ctx());
  const all = await tools.listTools();
  for (const i of section(f, 'presets').items) {
    const t = all.find((x) => x.id === i.action.toolId);
    assert.ok(t, i.id);
    const [key, value] = Object.entries(i.action.params)[0];
    assert.equal(value, i.action.presetId);
    const input = t.inputs.find((x) => x.key === key);
    assert.ok(input?.options.some((o) => o.value === value), `${i.id}: ${key}=${value} is a valid option`);
  }
  assert.equal(section(f, 'presets').items.find((i) => i.id === 'preset:vfx').action.presetId, 'turning-metal');
});

test('characters and recent media come from live data; posters and previews never show as recent', async () => {
  const f = feed.buildFeed(await ctx());
  assert.deepEqual(section(f, 'characters').items[0], { id: 'character:ch_1', kind: 'character', title: 'Nova', subtitle: 'android pilot', previewUrl: '/engine/media/a_srcimg.jpg', previewPoster: '/engine/media/a_srcimg.jpg', previewKind: 'image', aspect: '3:4', action: { type: 'characters', params: { id: 'ch_1' } } });
  const recent = section(f, 'recent').items.map((i) => i.id);
  assert.deepEqual(recent, ['media:a_srcimg', 'media:a_tallvid', 'media:a_srcvid']);
  assert.equal(section(f, 'recent').items[1].aspect, '3:4');
});

test('mobileSize caps at 720p and never upscales', () => {
  assert.deepEqual(feed.mobileSize(1920, 1080), { W: 1280, H: 720 });
  assert.deepEqual(feed.mobileSize(1080, 1920), { W: 720, H: 1280 });
  assert.deepEqual(feed.mobileSize(720, 960), { W: 720, H: 960 });
  assert.deepEqual(feed.mobileSize(1440, 1440), { W: 720, H: 720 });
  assert.deepEqual(feed.mobileSize(640, 360), { W: 640, H: 360 });
});

test('setPreviews: H.264 ≤720p, no audio, faststart, poster; raw source hidden; mapping persisted', async () => {
  const r = await feed.setPreviews({ items: { 'studio:video': { assetId: 'a_srcvid' }, 'model:xai/grok-imagine-image-2.0': { assetId: 'a_srcimg' }, 'tool:effects': { assetId: 'a_nope' } } });
  assert.equal(r.summary.ok, 2);
  assert.match(r.summary.failed['tool:effects'], /no asset/);
  const p = r.previews['studio:video'];
  const v = store.getAsset(p.assetId);
  assert.equal(v.source, 'preview');
  assert.equal(v.hidden, true);
  const info = probe(store.assetPath(v));
  assert.equal(info.streams.length, 1, 'audio stripped');
  assert.equal(info.streams[0].codec_name, 'h264');
  assert.equal(info.streams[0].pix_fmt, 'yuv420p');
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [1280, 720]);
  const buf = fs.readFileSync(store.assetPath(v));
  assert.ok(buf.indexOf('moov') < buf.indexOf('mdat'), 'faststart: moov before mdat');
  const poster = store.getAsset(p.posterId);
  assert.equal(poster.mime, 'image/jpeg');
  assert.ok(fs.statSync(store.assetPath(poster)).size > 1000);
  assert.equal(store.getAsset('a_srcvid').hidden, true, 'raw generation hidden from the library');
  assert.equal(p.sourceAssetId, 'a_srcvid');

  const img = store.getAsset(r.previews['model:xai/grok-imagine-image-2.0'].assetId);
  const ii = probe(store.assetPath(img)).streams[0];
  assert.ok(Math.max(ii.width, ii.height) <= 1280);

  assert.deepEqual(feed.previewFor('studio:video'), { previewUrl: v.url, previewPoster: poster.url, previewKind: 'video' });
  assert.equal(feed.previewFor('model:xai/grok-imagine-image-2.0').previewKind, 'image');
  assert.deepEqual(feed.previewFor('tool:nothing'), { previewUrl: null, previewPoster: null, previewKind: null });

  // Survives a restart: the mapping lives in DATA/feed.json.
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(JSON.parse(fs.readFileSync(path.join(DATA, 'feed.json'), 'utf8')).previews['studio:video']);
  feed.reload();
  assert.equal(feed.previewFor('studio:video').previewUrl, v.url);

  const f = feed.buildFeed(await ctx());
  const hero = section(f, 'studios').items.find((i) => i.id === 'studio:video');
  assert.equal(hero.previewUrl, v.url);
  assert.ok(!section(f, 'recent').items.some((i) => i.id === `media:${v.id}` || i.id === 'media:a_srcvid'), 'previews and their sources are not "recent"');
  assert.equal(feed.withModelPreview({ id: 'xai/grok-imagine-image-2.0' }).previewKind, 'image');
  assert.equal(feed.withToolPreview({ id: 'effects' }).previewUrl, null);
});

test('portrait source keeps its size; null removes a preview', async () => {
  const r = await feed.setPreviews({ items: { 'model:xai/grok-imagine-video-1.5-lite': { assetId: 'a_tallvid' } } });
  const s = probe(store.assetPath(store.getAsset(r.previews['model:xai/grok-imagine-video-1.5-lite'].assetId))).streams[0];
  assert.deepEqual([s.width, s.height], [720, 960]);
  await feed.setPreviews({ items: { 'model:xai/grok-imagine-video-1.5-lite': null } });
  assert.equal(feed.previewFor('model:xai/grok-imagine-video-1.5-lite').previewUrl, null);
});

test('patchFeed: retitle, hide, reorder, custom sections; validation; reset', async () => {
  await feed.patchFeed({ sections: { recent: null, studios: { title: 'Make something' }, picks: { title: 'Justin’s picks', style: 'grid', source: 'custom', items: ['tool:effects', 'preset:vfx', 'model:xai/grok-imagine-video-1.5', 'tool:nope'] } }, items: { 'tool:effects': { title: 'Viral Effects' }, 'studio:audio': { hidden: true } } });
  let f = feed.buildFeed(await ctx());
  assert.ok(!section(f, 'recent'));
  assert.equal(section(f, 'studios').title, 'Make something');
  assert.ok(!section(f, 'studios').items.some((i) => i.id === 'studio:audio'));
  assert.deepEqual(section(f, 'picks').items.map((i) => i.id), ['tool:effects', 'preset:vfx', 'model:xai/grok-imagine-video-1.5']);
  assert.equal(section(f, 'picks').items[0].title, 'Viral Effects');
  assert.equal(section(f, 'apps').items.find((i) => i.id === 'tool:effects').title, 'Viral Effects');

  await feed.patchFeed({ order: ['picks', 'studios'] });
  f = feed.buildFeed(await ctx());
  assert.deepEqual(f.sections.slice(0, 2).map((s) => s.id), ['picks', 'studios']);

  await assert.rejects(feed.patchFeed({ sections: { bad: { style: 'carousel', source: 'tools' } } }), /style must be/);
  await assert.rejects(feed.patchFeed({ sections: [{ id: 'x', style: 'grid', source: 'everything' }] }), /source must be/);

  feed.reload();
  assert.equal(feed.sections()[0].id, 'picks', 'layout persisted to feed.json');

  await feed.patchFeed({ reset: true });
  f = feed.buildFeed(await ctx());
  assert.equal(f.sections[0].id, 'studios');
  assert.equal(section(f, 'apps').items.find((i) => i.id === 'tool:effects').title, 'Effects');
  assert.ok(feed.previewFor('studio:video').previewUrl, 'reset keeps previews');
});
