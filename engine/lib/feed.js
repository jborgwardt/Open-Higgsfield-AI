// Server-defined Home feed for the Film Studio apps (Higgsfield-style: hero studios, model shelves, effect presets,
// app grid, characters, recent media). GET /engine/api/feed builds it from what is live right now — available
// models only, enabled tools only — so the app renders whatever the server says without an update.
//
// Public contract (GET /engine/api/feed):
// { version: 1, updatedAt, sections: [{ id, title, subtitle?, style: 'hero'|'shelf'|'grid'|'chips',
//     items: [{ id, kind: 'model'|'tool'|'preset'|'studio'|'character'|'media', title, subtitle,
//               previewUrl, previewPoster, previewKind: 'video'|'image'|null, aspect,
//               action: { type: 'create'|'tool'|'films'|'characters'|'library', model?, toolId?, presetId?, params? } }] }] }
// Item ids are stable: `studio:<id>`, `model:<model id>`, `tool:<tool id>`, `preset:<family>`, `character:<id>`,
// `media:<asset id>`. Preview media are engine assets (served from /engine/media with the usual auth).
//
// Editable server-side, persisted in DATA/feed.json (defaults below stay in code):
//   PATCH /engine/api/feed            { sections: [...] | { <sectionId>: {...} | null }, items: { <itemId>: { title?, subtitle?, hidden? } | null }, reset? }
//   PATCH /engine/api/feed/previews   { items: { <itemId>: { assetId } | null } } — transcodes each source for mobile
//                                     (H.264 ≤720p, no audio, faststart + poster JPEG) and records the mapping.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA, readJSON, writeJSON, now, getAsset, assetPath, addAsset, newAssetPath, updateAsset } from './store.js';
import * as ff from './ffmpeg.js';
import { VFX, VIRAL, PHOTO_STYLES, AD_SCENES, RESTYLES, HEADSHOTS } from './presets.js';

const FEED_FILE = path.join(DATA, 'feed.json');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

/* ------------------------------------------------------------------ defaults */

export const STUDIOS = [
  // The Home hero (Justin's film-reel still). Swap it server-side with POST /feed/previews { items: { 'studio:home': { assetId } } }.
  { id: 'home', title: 'Make a film', subtitle: 'Script to screen: every shot planned, rendered and cut on your studio', aspect: '16:9', action: { type: 'films', params: { new: true } } },
  { id: 'video', title: 'Video Studio', subtitle: 'Text or a start frame → cinematic video', aspect: '16:9', action: { type: 'create', params: { mode: 'video' } } },
  { id: 'cinema', title: 'Cinema Studio', subtitle: 'Camera, lens, moves, genre and grade', aspect: '16:9', action: { type: 'tool', toolId: 'cinema-shot' } },
  { id: 'films', title: 'Films', subtitle: 'Long-form films, scene by scene', aspect: '16:9', action: { type: 'films' } },
  { id: 'image', title: 'Image Studio', subtitle: 'Stills, keyframes and edits', aspect: '16:9', action: { type: 'create', params: { mode: 'image' } } },
  { id: 'characters', title: 'Characters', subtitle: 'Consistent cast across every shot', aspect: '16:9', action: { type: 'characters' } },
  { id: 'ads', title: 'Ads & Products', subtitle: 'Packshots, UGC and product scenes', aspect: '16:9', action: { type: 'tool', toolId: 'product-scenes' } },
  { id: 'audio', title: 'Voice & Sound', subtitle: 'Voiceover, sound effects and music', aspect: '16:9', action: { type: 'tool', toolId: 'tts' } },
];

// Preset families (presets.js) → the tool that runs them, its select input, and the preset the card opens with.
export const PRESET_FAMILIES = [
  { id: 'vfx', title: 'Visual Effects', subtitle: `${VFX.length} effects`, list: VFX, toolId: 'effects', input: 'effect', featured: 'turning-metal', aspect: '9:16' },
  { id: 'viral', title: 'Viral Templates', subtitle: `${VIRAL.length} trending templates`, list: VIRAL, toolId: 'effects', input: 'effect', featured: 'cloud-surf', aspect: '9:16' },
  { id: 'photo-styles', title: 'Photo Styles', subtitle: `${PHOTO_STYLES.length} looks`, list: PHOTO_STYLES, toolId: 'photo-styles', input: 'style', featured: '3d-figure', aspect: '9:16' },
  { id: 'ad-scenes', title: 'Product Scenes', subtitle: `${AD_SCENES.length} ad scenes`, list: AD_SCENES, toolId: 'product-scenes', input: 'scene', featured: 'giant-product', aspect: '9:16' },
  { id: 'restyles', title: 'Mixed Media', subtitle: `${RESTYLES.length} looks for footage`, list: RESTYLES, toolId: 'restyle', input: 'style', featured: 'vhs-1980s', aspect: '9:16' },
  { id: 'headshots', title: 'Headshots', subtitle: `${HEADSHOTS.length} studio looks`, list: HEADSHOTS, toolId: 'headshot', input: 'style', featured: 'creative-dark', aspect: '9:16' },
];

export const FEATURED_VIDEO_MODELS = [
  'xai/grok-imagine-video-1.5', 'apimart/veo3.1-quality', 'apimart/kling-v4', 'apimart/seedance-2.0', 'qwen/happyhorse-1.1', 'google/gemini-omni-1.1-flash',
  'apimart/veo3.1-fast', 'apimart/kling-v3-omni', 'apimart/kling-v3', 'apimart/wan3.0-video', 'apimart/MiniMax-H3', 'xai/grok-imagine-video-1.5-lite',
];
export const FEATURED_IMAGE_MODELS = [
  'google/gemini-nano-banana-2.1', 'apimart/gpt-image-2.6-flare', 'google/gemini-3-pro-image', 'xai/grok-imagine-image-2.0', 'apimart/seedream-5-0-pro', 'apimart/flux-2-max',
];

// source: where items come from. `items` (optional) pins an explicit order of item ids for that source.
// Higgsfield rhythm: media first (hero, models, a 9:16 effects grid), the text-chip cloud last.
export const DEFAULT_SECTIONS = [
  { id: 'studios', title: 'Studios', style: 'hero', source: 'studios' },
  { id: 'video-models', title: 'Video models', subtitle: 'Every top model, on your own studio', style: 'shelf', source: 'videoModels' },
  { id: 'presets', title: 'Effects & presets', style: 'grid', source: 'presets' },
  { id: 'apps', title: 'Apps', subtitle: 'One-tap tools', style: 'grid', source: 'tools' },
  { id: 'image-models', title: 'Image models', style: 'shelf', source: 'imageModels' },
  { id: 'characters', title: 'Your characters', style: 'shelf', source: 'characters', limit: 12 },
  { id: 'recent', title: 'Recent', style: 'grid', source: 'recent', limit: 12 },
  { id: 'quick', title: 'Explore more AI features', style: 'chips', source: 'quick' },
];
const STYLES = ['hero', 'shelf', 'grid', 'chips'];
const SOURCES = ['studios', 'quick', 'videoModels', 'imageModels', 'models', 'presets', 'tools', 'characters', 'recent', 'custom'];

/* ------------------------------------------------------------------ stored state */

let state = load();
function load() {
  const s = readJSON(FEED_FILE, {});
  return { sections: s.sections ?? null, items: s.items || {}, previews: s.previews || {}, updatedAt: s.updatedAt || null };
}
/** Re-read DATA/feed.json (tests; edits made on disk). */
export function reload() { state = load(); return state; }
let saving = Promise.resolve();
const save = () => (saving = saving.then(() => writeJSON(FEED_FILE, state)));

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (status, msg) => Object.assign(new Error(msg), { status });

export function sections() {
  return (state.sections || DEFAULT_SECTIONS).map((s) => ({ ...s }));
}

function checkSection(s) {
  if (!isObj(s) || !s.id) throw fail(400, 'each section needs an id');
  if (!STYLES.includes(s.style)) throw fail(400, `section ${s.id}: style must be one of ${STYLES.join(', ')}`);
  if (!SOURCES.includes(s.source)) throw fail(400, `section ${s.id}: source must be one of ${SOURCES.join(', ')}`);
  if (s.items !== undefined && !Array.isArray(s.items)) throw fail(400, `section ${s.id}: items must be an array of item ids`);
  return s;
}

/** Edit the feed layout / item copy. Arrays replace; objects keyed by id merge (null removes / resets). */
export async function patchFeed(patch = {}) {
  if (!isObj(patch)) throw fail(400, 'expected a JSON object');
  if (patch.reset === true) { state.sections = null; state.items = {}; }
  if (patch.sections === null) state.sections = null;
  else if (Array.isArray(patch.sections)) state.sections = patch.sections.map(checkSection);
  else if (isObj(patch.sections)) {
    const list = sections();
    for (const [id, v] of Object.entries(patch.sections)) {
      const i = list.findIndex((s) => s.id === id);
      if (v === null) { if (i >= 0) list.splice(i, 1); continue; }
      if (!isObj(v)) throw fail(400, `section ${id}: expected an object`);
      if (i >= 0) list[i] = checkSection({ ...list[i], ...v, id });
      else list.push(checkSection({ style: 'shelf', title: id, ...v, id }));
    }
    if (patch.order && Array.isArray(patch.order)) list.sort((a, b) => rank(patch.order, a.id) - rank(patch.order, b.id));
    state.sections = list;
  } else if (Array.isArray(patch.order)) {
    state.sections = sections().sort((a, b) => rank(patch.order, a.id) - rank(patch.order, b.id));
  }
  if (isObj(patch.items)) {
    for (const [id, v] of Object.entries(patch.items)) {
      if (v === null) delete state.items[id];
      else if (isObj(v)) state.items[id] = { ...(state.items[id] || {}), ...pick(v, ['title', 'subtitle', 'hidden', 'aspect']) };
    }
  }
  state.updatedAt = now();
  await save();
  return feedConfig();
}
const rank = (order, id) => { const i = order.indexOf(id); return i < 0 ? 1e6 : i; };
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export function feedConfig() {
  return { sections: sections(), items: state.items, previews: state.previews, updatedAt: state.updatedAt, defaults: { sections: DEFAULT_SECTIONS } };
}

/* ------------------------------------------------------------------ previews */

/** Preview fields for an item id: { previewUrl, previewPoster, previewKind } (nulls when none is recorded). */
/** Built-in preview assets, used until a preview is set for the item (and only if the asset exists). */
export const DEFAULT_PREVIEWS = { 'studio:home': 'a_c60339c0e153' };

/** Assets that are feed artwork (hero / tile previews and their sources) — never "Recent". */
function previewAssetIds() {
  const ids = new Set(Object.values(DEFAULT_PREVIEWS));
  for (const p of Object.values(state.previews)) for (const k of ['assetId', 'posterId', 'sourceAssetId']) if (p?.[k]) ids.add(p[k]);
  return ids;
}

export function previewFor(id) {
  const p = state.previews[id] || (DEFAULT_PREVIEWS[id] && { assetId: DEFAULT_PREVIEWS[id] });
  const a = p && getAsset(p.assetId);
  if (!a) return { previewUrl: null, previewPoster: null, previewKind: null };
  const poster = p.posterId && getAsset(p.posterId);
  return { previewUrl: a.url, previewPoster: poster?.url || (a.kind === 'image' ? a.url : a.posterUrl || null), previewKind: a.kind === 'video' ? 'video' : 'image' };
}
export const previewsMap = () => ({ ...state.previews });

/** Long side ≤1280 and short side ≤720 (720p max), even dimensions, never upscaled. */
export function mobileSize(w, h) {
  if (!w || !h) return { W: 720, H: 720 };
  const s = Math.min(1, 1280 / Math.max(w, h), 720 / Math.min(w, h));
  const even = (n) => Math.max(2, Math.floor((n * s) / 2) * 2);
  return { W: even(w), H: even(h) };
}

/** ffmpeg args for the mobile preview clip: H.264 High, yuv420p, no audio, faststart, ~4 Mbit/s cap. */
export function previewArgs(input, out, { W, H }) {
  return ['-y', '-v', 'error', '-i', input, '-an', '-sn', '-map_metadata', '-1', '-vf', `scale=${W}:${H}:flags=lanczos,fps=30`,
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '23', '-maxrate', '4M', '-bufsize', '8M',
    '-g', '60', '-movflags', '+faststart', out];
}

/** Transcode one source asset into a mobile preview (+ poster) and register both as hidden engine assets. */
export async function makePreview(source, { signal } = {}) {
  const src = assetPath(source);
  if (source.kind === 'video') {
    const info = await ff.probe(src);
    const size = mobileSize(info.width, info.height);
    const v = newAssetPath('video/mp4');
    await ff.run(FFMPEG, previewArgs(src, v.abs, size), { signal });
    const outInfo = await ff.probe(v.abs);
    const pv = await addAsset({ ...v, mime: 'video/mp4', meta: { source: 'preview', hidden: true, previewOf: source.id, ...outInfo } });
    const p = newAssetPath('image/jpeg');
    await ff.run(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.min(1, (outInfo.duration || 2) / 3)), '-i', v.abs, '-frames:v', '1', '-q:v', '3', p.abs], { signal });
    const poster = await addAsset({ ...p, mime: 'image/jpeg', meta: { source: 'preview-poster', hidden: true, previewOf: source.id, width: size.W, height: size.H } });
    updateAsset(pv.id, { posterUrl: poster.url, posterId: poster.id });
    const { size: bytes } = await fsp.stat(v.abs);
    return { assetId: pv.id, posterId: poster.id, bytes, width: outInfo.width, height: outInfo.height, duration: outInfo.duration };
  }
  if (source.kind === 'image') {
    const info = await ff.probe(src).catch(() => ({}));
    const s = Math.min(1, 1280 / Math.max(info.width || 1, info.height || 1));
    const p = newAssetPath('image/jpeg');
    const vf = info.width ? ['-vf', `scale=${Math.max(2, Math.round(info.width * s))}:-2:flags=lanczos`] : [];
    await ff.run(FFMPEG, ['-y', '-v', 'error', '-i', src, ...vf, '-frames:v', '1', '-q:v', '3', p.abs], { signal });
    const img = await addAsset({ ...p, mime: 'image/jpeg', meta: { source: 'preview', hidden: true, previewOf: source.id } });
    const { size: bytes } = await fsp.stat(p.abs);
    return { assetId: img.id, posterId: img.id, bytes };
  }
  throw fail(400, `asset ${source.id} is ${source.kind}, previews must be video or image`);
}

/**
 * Record previews: { items: { <itemId>: { assetId, transcode?: false } | null } }. Each source is transcoded for
 * mobile (unless transcode: false, i.e. the asset already is a preview) and the raw source is hidden from the
 * library. Returns { previews, summary: { ok, failed: { id: error } } }.
 */
export async function setPreviews(body = {}, { transcode = makePreview } = {}) {
  if (!isObj(body.items)) throw fail(400, 'expected { items: { <itemId>: { assetId } } }');
  const failed = {};
  let ok = 0;
  for (const [id, v] of Object.entries(body.items)) {
    if (v === null) { delete state.previews[id]; continue; }
    try {
      const source = getAsset(v?.assetId);
      if (!source) throw fail(404, `no asset ${v?.assetId}`);
      const made = v.transcode === false || source.source === 'preview' ? { assetId: source.id, posterId: source.posterId || null } : await transcode(source);
      if (made.assetId !== source.id && !source.hidden) updateAsset(source.id, { hidden: true, feedPreviewSource: true });
      state.previews[id] = { ...made, sourceAssetId: source.id, model: source.model || null, prompt: source.prompt || null, updatedAt: now() };
      ok++;
    } catch (e) {
      failed[id] = e.message;
    }
  }
  state.updatedAt = now();
  await save();
  return { previews: previewsMap(), summary: { ok, failed } };
}

/* ------------------------------------------------------------------ items */

function item(id, kind, base, aspect) {
  const o = state.items[id] || {};
  return { id, kind, title: o.title ?? base.title, subtitle: o.subtitle ?? base.subtitle ?? '', ...previewFor(id), aspect: o.aspect || aspect, action: base.action, ...(o.hidden ? { hidden: true } : {}) };
}

const modelItem = (m) => item(`model:${m.id}`, 'model', {
  title: m.label.replace(/\s*\((ApiMart|Gemini|Qwen plan|fal|kie\.ai|Replicate|muapi)\)\s*$/, ''),
  subtitle: m.blurb || (m.kind === 'video' ? 'Video model' : 'Image model'),
  action: { type: 'create', model: m.id, params: { mode: m.kind } },
}, '3:4');

function presetItem(f) {
  const preset = f.list.find((p) => p.value === f.featured) || f.list[0];
  return item(`preset:${f.id}`, 'preset', { title: f.title, subtitle: f.subtitle, action: { type: 'tool', toolId: f.toolId, presetId: preset?.value, params: preset ? { [f.input]: preset.value } : {} } }, f.aspect);
}

const toolItem = (t) => item(`tool:${t.id}`, 'tool', { title: t.title, subtitle: t.description, action: { type: 'tool', toolId: t.id } }, '1:1');
const studioItem = (s) => item(`studio:${s.id}`, 'studio', s, s.aspect);

/** ctx: { models: publicCatalog(), tools: listTools(), characters: characters.list(), media: listAssets(), partIds: Set of film-part asset ids } */
function sourceItems(source, ctx) {
  const avail = (ctx.models || []).filter((m) => m.available && ['image', 'video'].includes(m.kind) && m.provider !== 'handoff' && m.provider !== 'local');
  const byId = (ids, list) => ids.map((id) => list.find((m) => m.id === id)).filter(Boolean);
  const toolIds = new Set((ctx.tools || []).map((t) => t.id));
  switch (source) {
    case 'studios': return STUDIOS.filter((s) => s.action.type !== 'tool' || toolIds.has(s.action.toolId)).map(studioItem);
    case 'quick': return [
      { id: 'quick:video', title: 'Video', action: { type: 'create', params: { mode: 'video' } } },
      { id: 'quick:image', title: 'Image', action: { type: 'create', params: { mode: 'image' } } },
      { id: 'quick:film', title: 'New film', action: { type: 'films', params: { new: true } } },
      { id: 'quick:character', title: 'New character', action: { type: 'characters', params: { new: true } } },
      { id: 'quick:library', title: 'Library', action: { type: 'library' } },
    ].map((q) => item(q.id, 'studio', q, '1:1'))
      // …then every one-tap tool as a chip ("Explore more AI features").
      .concat((ctx.tools || []).map((t) => item(`quick:tool:${t.id}`, 'tool', { title: t.title, action: { type: 'tool', toolId: t.id } }, '1:1')));
    case 'videoModels': return byId(FEATURED_VIDEO_MODELS, avail.filter((m) => m.kind === 'video')).map(modelItem);
    case 'imageModels': return byId(FEATURED_IMAGE_MODELS, avail.filter((m) => m.kind === 'image')).map(modelItem);
    case 'models': return avail.map(modelItem);
    case 'presets': return PRESET_FAMILIES.filter((f) => toolIds.has(f.toolId)).map(presetItem);
    case 'tools': return (ctx.tools || []).map(toolItem);
    case 'characters': return (ctx.characters || []).map((c) => ({
      id: `character:${c.id}`, kind: 'character', title: c.name, subtitle: c.description || '',
      previewUrl: c.coverUrl || null, previewPoster: c.coverUrl || null, previewKind: c.coverUrl ? 'image' : null, aspect: '3:4',
      action: { type: 'characters', params: { id: c.id } },
    }));
    // Real creations only: no uploads (start-frame picks), hand-offs or film parts (shot clips, keyframes) — QA-09.
    case 'recent': return (ctx.media || [])
      .filter((a) => !a.hidden && ['image', 'video'].includes(a.kind) && !NOT_RECENT.has(a.source) && !ctx.partIds?.has(a.id) && !previewAssetIds().has(a.id))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((a) => ({
        id: `media:${a.id}`, kind: 'media', title: a.prompt ? String(a.prompt).slice(0, 80) : ctx.masterTitles?.get(a.id) || (a.source === 'master' ? 'Film' : a.name || 'Untitled'), subtitle: a.model || '',
        previewUrl: a.url, previewPoster: a.kind === 'video' ? a.posterUrl || null : a.url, previewKind: a.kind, aspect: a.width && a.height ? ratio(a.width, a.height) : '1:1',
        action: { type: 'library', params: { assetId: a.id } },
      }));
    default: return [];
  }
}

const NOT_RECENT = new Set(['poster', 'last-frame', 'continuity', 'preview', 'preview-poster', 'upload', 'handoff']);
const ALL_SOURCES = ['studios', 'quick', 'models', 'presets', 'tools'];
/** Every addressable item (for `custom` sections that pin ids from any source). */
function allItems(ctx) {
  const m = new Map();
  for (const s of [...ALL_SOURCES, 'characters', 'recent']) for (const i of sourceItems(s, ctx)) if (!m.has(i.id)) m.set(i.id, i);
  return m;
}

function ratio(w, h) {
  const r = w / h;
  return [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['21:9', 21 / 9]].sort((a, b) => Math.abs(Math.log(a[1] / r)) - Math.abs(Math.log(b[1] / r)))[0][0];
}

/** Build the public feed. ctx = { models, tools, characters, media }. */
export function buildFeed(ctx = {}) {
  let pool;
  const out = [];
  for (const s of sections()) {
    if (s.hidden) continue;
    let items;
    if (s.source === 'custom') {
      pool ||= allItems(ctx);
      items = (s.items || []).map((id) => pool.get(id)).filter(Boolean);
    } else {
      items = sourceItems(s.source, ctx);
      if (s.items?.length) items.sort((a, b) => rank(s.items, a.id) - rank(s.items, b.id));
    }
    items = items.filter((i) => !i.hidden);
    if (s.limit) items = items.slice(0, s.limit);
    if (!items.length) continue;
    out.push({ id: s.id, title: s.title, ...(s.subtitle ? { subtitle: s.subtitle } : {}), style: s.style, items });
  }
  return { version: 1, updatedAt: state.updatedAt, sections: out };
}

/** Add preview fields to /catalog models and /tools items. */
export const withModelPreview = (m) => ({ ...m, ...previewFor(`model:${m.id}`) });
export const withToolPreview = (t) => ({ ...t, ...previewFor(`tool:${t.id}`) });

