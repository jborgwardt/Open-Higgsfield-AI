// Building blocks for one-click tools (engine/lib/tools.js): model resolution, media hosting, and every
// provider operation the Higgsfield-style apps need (upscale, avatars, lip-sync, motion control, edits, …).
// Each op returns a saved engine asset (or several).
import fsp from 'node:fs/promises';
import { generate, materialize, asInput, saveResult, getModel, publicCatalog } from './catalog.js';
import { getSettings, addAsset, assetPath, newAssetPath, accessToken } from './store.js';
import { falRun, falMedia } from './providers/fal.js';
import { apimartTask, motionBody, videoEditBody } from './providers/apimart.js';
import { elevenSpeech, elevenSfx, elevenMusic, elevenAvailable } from './providers/eleven.js';
import { googleChat, googleAvailable } from './providers/google.js';
import { makeVoice, makeMusic } from './sound.js';
import { directorJSON, directorBackend } from './director.js';
import { ProviderError } from './http.js';
import * as ff from './ffmpeg.js';

/* ---------------- models ---------------- */

const usable = (m, kind) => m && m.available && (m.kinds || []).includes(kind) && m.provider !== 'handoff' && m.provider !== 'local';

/**
 * Pick the model for a tool run: the user's choice if it is connected and fits, else the first connected
 * model in `prefer`, else any connected model of that kind. Throws a readable error when none is connected.
 */
export function resolveModel(value, kind, prefer = []) {
  const cat = publicCatalog();
  const byId = (id) => cat.find((m) => m.id === String(id || '').replace(/^engine:/, ''));
  if (value && usable(byId(value), kind)) return byId(value);
  for (const id of prefer) if (usable(byId(id), kind)) return byId(id);
  const any = cat.find((m) => usable(m, kind));
  if (any) return any;
  throw new ProviderError('tools', 0, `no connected ${kind} model — connect a provider in Providers`);
}

export function modelOptions(kind) {
  return publicCatalog().filter((m) => usable(m, kind)).map((m) => ({ value: m.id, label: m.label, provider: m.provider }));
}

/* ---------------- media ---------------- */

const falKey = () => getSettings().falKey;
/** Public https URL for any engine asset / URL (fal CDN, cached on the asset). */
export async function publicUrl(ref, signal) {
  const a = await materialize(ref, signal);
  if (!a) return null;
  return asInput('public', a, signal);
}

export async function saveUrl(url, kind, meta, signal) {
  if (!url) throw new ProviderError('tools', 0, `provider returned no ${kind}`);
  return saveResult({ url }, { kind, signal, meta: { source: 'tool', ...meta } });
}

/** Run a fal endpoint and save its main media output. */
export async function falOp(endpoint, input, kind, ctx, meta = {}) {
  ctx.onStatus?.({ message: `Running ${meta.label || endpoint}` });
  const out = await falRun({ key: falKey(), endpoint, input, onStatus: ctx.onStatus, signal: ctx.signal });
  const asset = await saveUrl(falMedia(out, kind), kind, { model: meta.model || endpoint, prompt: meta.prompt }, ctx.signal);
  return { asset, out };
}

const hidden = (meta) => ({ ...meta, hidden: true, source: meta.source || 'tool-step' });

/** Save a buffer as a hidden intermediate asset. */
export const saveBuffer = (buffer, mime, meta = {}) => addAsset({ buffer, mime, meta: hidden(meta) });

/** Last frame of a clip as an image asset (hidden). */
export async function lastFrame(video) {
  const out = newAssetPath('image/jpeg');
  await ff.lastFrame(assetPath(video), out.abs);
  return addAsset({ ...out, mime: 'image/jpeg', meta: hidden({ source: 'last-frame' }) });
}

/** Cut a clip to at most `max` seconds (stream copy) so edit models accept it. */
export async function trimVideo(video, max, signal) {
  const info = video.duration ? video : { ...video, ...(await ff.probe(assetPath(video)).catch(() => ({}))) };
  if (!info.duration || info.duration <= max + 0.05) return video;
  const out = newAssetPath('video/mp4');
  await ff.run(process.env.FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-i', assetPath(video), '-t', String(max), '-c', 'copy', '-movflags', '+faststart', out.abs], { signal });
  return addAsset({ ...out, mime: 'video/mp4', meta: hidden({ source: 'trim' }) });
}

/**
 * Audio for avatar / lip-sync providers: mp3 or wav only, optionally padded with silence to a minimum length
 * (OmniHuman wants ≥4 s, H3 lip-sync ≥5 s).
 */
export async function audioForUpload(audio, { minSeconds = 0, signal } = {}) {
  const info = await ff.probe(assetPath(audio)).catch(() => ({}));
  const okType = ['audio/mpeg', 'audio/wav'].includes(audio.mime);
  if (okType && (!minSeconds || (info.duration || 0) >= minSeconds)) return audio;
  const out = newAssetPath('audio/wav');
  const af = minSeconds ? ['-af', `apad=whole_dur=${minSeconds}`] : [];
  await ff.run(process.env.FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-i', assetPath(audio), '-vn', ...af, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', out.abs], { signal });
  return addAsset({ ...out, mime: 'audio/wav', meta: hidden({ source: 'audio-prep' }) });
}

/**
 * Speak a script: ElevenLabs voice ids (default, incl. cloned voices) or xai:/google:/local: prefixed voices
 * through sound.js. `keep` = a user-facing output (TTS tool) rather than an intermediate step.
 */
export async function speak({ text, voice, keep = false }, { signal, onStatus } = {}) {
  if (!String(text || '').trim()) throw new ProviderError('tools', 0, 'write a script or upload audio');
  onStatus?.({ message: 'Recording the voice line' });
  const v = String(voice || '');
  const m = v.match(/^(xai|google|local):(.+)$/);
  if (m) return makeVoice({ provider: m[1], voice: m[2], text }, { signal });
  if (elevenAvailable()) {
    const r = await elevenSpeech({ text, voice: v.replace(/^eleven:/, '') || undefined }, { signal });
    const meta = { source: keep ? 'tool' : 'narration', model: 'eleven/tts', prompt: text };
    return keep ? addAsset({ buffer: r.buffer, mime: 'audio/mpeg', meta }) : saveBuffer(r.buffer, 'audio/mpeg', meta);
  }
  return makeVoice({ text }, { signal });
}

/** Re-encode clips to one size/fps and join them (extend-by-continuation). */
export async function joinClips(clips, { signal } = {}) {
  const first = await ff.probe(assetPath(clips[0]));
  const W = Math.round((first.width || 1280) / 2) * 2;
  const H = Math.round((first.height || 720) / 2) * 2;
  const segs = [];
  try {
    for (const c of clips) {
      const info = await ff.probe(assetPath(c));
      const seg = newAssetPath('video/mp4');
      await ff.conform({ input: assetPath(c), out: seg.abs, W, H, hasAudio: info.hasAudio, signal });
      segs.push(seg.abs);
    }
    const out = newAssetPath('video/mp4');
    await ff.concat({ segments: segs, out: out.abs, signal });
    return { ...out, mime: 'video/mp4' };
  } finally {
    await Promise.all(segs.map((s) => fsp.rm(s, { force: true })));
  }
}

/* ---------------- characters (owned by the character agent) ---------------- */

/**
 * Reference photos (+ voice) of a saved character from GET /engine/api/characters/:id. Degrades to nothing when the
 * characters API is not installed. Accepts several field spellings so it keeps working as that API evolves.
 */
export async function characterInfo(id, signal) {
  if (!id) return null;
  try {
    const port = Number(process.env.ENGINE_PORT) || 4848;
    const r = await fetch(`http://127.0.0.1:${port}/engine/api/characters/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${accessToken()}` }, signal: signal || AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const c = j.character || j;
    const urls = [c.sheetUrl, c.sheet, c.portraitUrl, c.portrait, c.imageUrl, c.image, ...(c.refs || []), ...(c.references || []), ...(c.referenceImages || []), ...(c.images || []), ...(c.photos || [])]
      .map((x) => (typeof x === 'string' ? x : x?.url || x?.assetId || x?.id))
      .filter(Boolean);
    return { name: c.name || '', description: c.description || c.prompt || '', refs: [...new Set(urls)].slice(0, 4), voice: c.voiceId || c.voice?.id || c.voice || null };
  } catch { return null; }
}

/* ---------------- LLM helpers ---------------- */

export async function llmJSON(system, user, signal) {
  if (!(await directorBackend())) return null;
  try { return await directorJSON([{ role: 'system', content: system }, { role: 'user', content: user }], signal); } catch (e) { if (signal?.aborted) throw e; return null; }
}

/** Read hand-drawn arrows / notes on a frame (Draw-to-Video) with Gemini vision. */
export async function readAnnotations(image, signal) {
  if (!googleAvailable()) return '';
  const buf = await fsp.readFile(assetPath(image));
  const text = await googleChat({
    model: 'gemini-flash-latest',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'This frame has hand-drawn annotations (arrows, numbers, circles, handwritten notes) that direct an animation. Describe, in one short paragraph of plain directions for a video model, what each annotated element should do and in what order, and how the camera should move. Do not mention the annotations themselves.' },
      { type: 'image_url', image_url: { url: `data:${image.mime};base64,${buf.toString('base64')}` } },
    ] }],
    signal,
  }).catch(() => '');
  return String(text || '').trim().slice(0, 1200);
}

/* ---------------- generation wrappers ---------------- */

export async function genImage({ model, prompt, image, refs = [], aspect, resolution, mask, format }, ctx) {
  const m = getModel(model);
  const { asset } = await generate({ model, prompt, image, refs: refs.slice(0, m?.refs ?? 0), aspect: aspect || 'auto', resolution, mask, format }, ctx);
  return asset;
}

export async function genVideo({ model, prompt, image, endImage, refs = [], videos, audios, aspect, duration, resolution }, ctx) {
  const m = getModel(model);
  const dur = duration || m?.durations?.[Math.min(1, (m?.durations?.length || 1) - 1)] || 5;
  const { asset } = await generate({ model, prompt, image, endImage, refs, videos, audios, aspect: aspect || '16:9', duration: dur, resolution }, ctx);
  return asset;
}

/* ---------------- tool operations ---------------- */

const FACTOR = (v, max = 4) => Math.min(max, Math.max(1, Number(v) || 2));

export async function upscaleImage({ image, model, factor }, ctx) {
  const m = resolveModel(model, 'upscale-image', ['fal/topaz-image', 'fal/seedvr-image']);
  const url = await publicUrl(image, ctx.signal);
  const input = m.id === 'fal/topaz-image'
    ? { image_url: url, upscale_factor: FACTOR(factor), model: 'Wonder 3.5', face_enhancement: true, output_format: 'jpeg' }
    : { image_url: url, upscale_mode: 'factor', upscale_factor: FACTOR(factor, 10), output_format: 'png' };
  return (await falOp(m.endpoint, input, 'image', ctx, { model: m.id, label: m.label })).asset;
}

export async function upscaleVideo({ video, model, factor, fps }, ctx) {
  const m = resolveModel(model, 'upscale-video', ['fal/topaz-video', 'fal/seedvr-video']);
  const url = await publicUrl(video, ctx.signal);
  const input = m.id === 'fal/topaz-video'
    ? { video_url: url, upscale_factor: FACTOR(factor), model: 'Proteus', H264_output: true, ...(Number(fps) > 0 && { target_fps: Number(fps) }) }
    : { video_url: url, upscale_mode: 'factor', upscale_factor: FACTOR(factor), output_quality: 'high', output_format: 'X264 (.mp4)' };
  return (await falOp(m.endpoint, input, 'video', ctx, { model: m.id, label: m.label })).asset;
}

export async function removeBackground({ image, keep }, ctx) {
  const m = resolveModel(null, 'bg-remove', ['fal/bria-rmbg']);
  return (await falOp(m.endpoint, { image_url: await publicUrl(image, ctx.signal), ...(keep && { prompt: keep }) }, 'image', ctx, { model: m.id, label: m.label })).asset;
}

export async function removeVideoBackground({ video, model, color = 'Green' }, ctx) {
  const m = resolveModel(model, 'bg-remove-video', ['fal/bria-video-rmbg', 'fal/veed-video-rmbg']);
  const url = await publicUrl(video, ctx.signal);
  const input = m.id === 'fal/bria-video-rmbg'
    ? { video_url: url, background_color: color === 'Transparent' ? 'Transparent' : color, output_container_and_codec: color === 'Transparent' ? 'webm_vp9' : 'mp4_h264', preserve_audio: true }
    : { video_url: url, output_codec: 'vp9', refine_foreground_edges: true };
  return (await falOp(m.endpoint, input, 'video', ctx, { model: m.id, label: m.label })).asset;
}

export async function expandImage({ image, model, aspect = '16:9', prompt }, ctx) {
  const m = resolveModel(model, 'expand', ['fal/bria-expand', 'fal/flux2-outpaint']);
  const url = await publicUrl(image, ctx.signal);
  let input;
  if (m.id === 'fal/flux2-outpaint') {
    const a = await materialize(image, ctx.signal);
    const info = a.width ? a : await ff.probe(assetPath(a)).catch(() => ({ width: 1024, height: 1024 }));
    const [w, h] = String(aspect).split(':').map(Number);
    const W0 = info.width || 1024; const H0 = info.height || 1024;
    const target = w / h > W0 / H0 ? { W: Math.round((H0 * w) / h), H: H0 } : { W: W0, H: Math.round((W0 * h) / w) };
    const dx = Math.min(2048, Math.max(0, target.W - W0)); const dy = Math.min(2048, Math.max(0, target.H - H0));
    const pad = (n) => Math.max(0, Math.round(n));
    input = { image_url: url, expand_left: pad(dx / 2), expand_right: pad(dx - dx / 2), expand_top: pad(dy / 2), expand_bottom: pad(dy - dy / 2), mode: 'high', output_format: 'jpeg' };
    if (!dx && !dy) input.expand_left = input.expand_right = input.expand_top = input.expand_bottom = 256; // "zoom out"
  } else input = { image_url: url, aspect_ratio: aspect, retain_original_quality: true, ...(prompt && { prompt }) };
  return (await falOp(m.endpoint, input, 'image', ctx, { model: m.id, label: m.label, prompt })).asset;
}

/** Mask: white = change, black = keep (what the web brush paints). */
export async function inpaint({ image, mask, prompt, model }, ctx) {
  const m = resolveModel(model, 'inpaint', ['fal/flux-fill', 'apimart/gpt-image-2.6-inpaint']);
  const src = await materialize(image, ctx.signal);
  const mk = await materialize(mask, ctx.signal);
  const info = await ff.probe(assetPath(src));
  const W = info.width; const H = info.height;
  const FF = process.env.FFMPEG || 'ffmpeg';
  if (m.id === 'apimart/gpt-image-2.6-inpaint') {
    // GPT Image wants the source with an alpha hole where the edit goes.
    const holed = newAssetPath('image/png');
    await ff.run(FF, ['-y', '-v', 'error', '-i', assetPath(src), '-i', assetPath(mk), '-filter_complex', `[1:v]scale=${W}:${H},format=gray,negate[a];[0:v]format=rgba[s];[s][a]alphamerge`, '-frames:v', '1', holed.abs], { signal: ctx.signal });
    const holedA = await addAsset({ ...holed, mime: 'image/png', meta: hidden({}) });
    const { asset } = await generate({ model: 'apimart/gpt-image-2.6-flare', prompt, image: src, mask: holedA, aspect: 'auto' }, ctx);
    return asset;
  }
  const norm = newAssetPath('image/png');
  await ff.run(FF, ['-y', '-v', 'error', '-i', assetPath(mk), '-vf', `scale=${W}:${H},format=gray`, '-frames:v', '1', norm.abs], { signal: ctx.signal });
  const maskA = await addAsset({ ...norm, mime: 'image/png', meta: hidden({}) });
  return (await falOp(m.endpoint, { image_url: await publicUrl(src, ctx.signal), mask_url: await publicUrl(maskA, ctx.signal), prompt, output_format: 'jpeg', safety_tolerance: '2' }, 'image', ctx, { model: m.id, label: m.label, prompt })).asset;
}

export async function erase({ image, what }, ctx) {
  const m = resolveModel(null, 'erase', ['fal/finegrain-eraser']);
  return (await falOp(m.endpoint, { image_url: await publicUrl(image, ctx.signal), prompt: what, mode: 'premium' }, 'image', ctx, { model: m.id, label: m.label, prompt: what })).asset;
}

export async function falRelight({ image, direction, light }, ctx) {
  const m = resolveModel(null, 'relight', ['fal/bria-relight']);
  return (await falOp(m.endpoint, { image_url: await publicUrl(image, ctx.signal), light_direction: direction, light_type: light }, 'image', ctx, { model: m.id, label: m.label })).asset;
}

export async function virtualTryOn({ person, garment }, ctx) {
  const m = resolveModel(null, 'tryon', ['fal/google-vto']);
  return (await falOp(m.endpoint, { person_image_url: await publicUrl(person, ctx.signal), product_image_url: await publicUrl(garment, ctx.signal), num_images: 1 }, 'image', ctx, { model: m.id, label: m.label })).asset;
}

export async function layerize({ image, prompt }, ctx) {
  const m = resolveModel(null, 'layers', ['fal/seedream-layerize']);
  ctx.onStatus?.({ message: `Running ${m.label}` });
  const out = await falRun({ key: falKey(), endpoint: m.endpoint, input: { image_url: await publicUrl(image, ctx.signal), prompt: prompt || '', image_size: 'auto_2K' }, onStatus: ctx.onStatus, signal: ctx.signal });
  const urls = [...(out.images || []), ...(out.layers || [])].map((x) => x?.url || x).filter((u) => typeof u === 'string');
  const assets = [];
  for (const u of urls.slice(0, 17)) assets.push(await saveUrl(u, 'image', { model: m.id }, ctx.signal));
  return { asset: assets[0], assets };
}

/** Kling motion control: the character in `image` performs the motion in `video`. */
export async function motionControl({ image, video, model, orientation = 'video', prompt, quality = 'pro', keepSound = true }, ctx) {
  const m = resolveModel(model, 'motion', ['apimart/kling-v3-motion-control', 'fal/kling-v3-motion', 'apimart/kling-v2-6-motion-control']);
  const v = await trimVideo(await materialize(video, ctx.signal), orientation === 'image' ? 10 : 30, ctx.signal);
  const img = await publicUrl(image, ctx.signal);
  const vid = await publicUrl(v, ctx.signal);
  if (m.provider === 'apimart') {
    const r = await apimartTask('/videos/generations', motionBody({ model: m.endpoint, prompt, image: img, video: vid, orientation, quality, keepSound }), 'video', { ...ctx, label: m.label });
    return saveUrl(r.url, 'video', { model: m.id, prompt }, ctx.signal);
  }
  return (await falOp(m.endpoint, { image_url: img, video_url: vid, character_orientation: orientation, keep_original_sound: !!keepSound, ...(prompt && { prompt }) }, 'video', ctx, { model: m.id, label: m.label, prompt })).asset;
}

/** Reference-image token each video-edit model understands in its prompt. */
export const refToken = (modelId, n = 1) => (modelId.startsWith('apimart/kling') ? `<<<image_${n}>>>` : modelId.startsWith('fal/kling') ? `@Image${n}` : `image ${n}`);
const srcToken = (modelId) => (modelId.startsWith('fal/kling') ? '@Video1' : 'the video');

/** Instruction edit of a clip (Genjutsu / Edit video / Recast / Mixed media). `prompt` may contain {ref1} {ref2} {video}. */
export async function videoEdit({ video, prompt, refs = [], model, resolution, keepAudio = true }, ctx) {
  const m = resolveModel(model, 'video-edit', ['apimart/kling-v3-omni-edit', 'fal/kling-v4-edit', 'apimart/wan2.7-videoedit', 'fal/kling-o3-edit']);
  const max = { 'apimart/kling-v3-omni-edit': 10, 'apimart/wan2.7-videoedit': 10, 'fal/kling-o3-edit': 15, 'fal/kling-v4-edit': 30 }[m.id] || 10;
  const v = await trimVideo(await materialize(video, ctx.signal), max, ctx.signal);
  const vid = await publicUrl(v, ctx.signal);
  const refUrls = [];
  for (const r of refs.filter(Boolean).slice(0, 4)) refUrls.push(m.provider === 'apimart' ? await asInput('apimart', await materialize(r, ctx.signal), ctx.signal) : await publicUrl(r, ctx.signal));
  const text = String(prompt || '').replace(/\{ref(\d)\}/g, (_, n) => refToken(m.id, Number(n))).replace(/\{video\}/g, srcToken(m.id));
  if (m.provider === 'apimart') {
    const r = await apimartTask('/videos/generations', videoEditBody({ model: m.endpoint === 'kling-v3-omni' ? 'kling-v3-omni' : m.endpoint, prompt: text, video: vid, refs: refUrls, resolution, keepAudio }), 'video', { ...ctx, label: m.label });
    return saveUrl(r.url, 'video', { model: m.id, prompt: text }, ctx.signal);
  }
  const input = m.id === 'fal/kling-v4-edit'
    ? { video_url: vid, prompt: /@Video1/.test(text) ? text : `@Video1: ${text}`, resolution: resolution === '720p' ? '720p' : '1080p', ...(refUrls.length && { image_urls: refUrls }) }
    : { video_url: vid, prompt: /@Video1/.test(text) ? text : `@Video1: ${text}`, keep_audio: !!keepAudio, ...(refUrls.length && { image_urls: refUrls }) };
  return (await falOp(m.endpoint, input, 'video', ctx, { model: m.id, label: m.label, prompt: text })).asset;
}

/** PixVerse Swap: replace the person / an object / the background of a clip with one photo. */
export async function videoSwap({ video, image, mode = 'person', resolution = '720p' }, ctx) {
  const m = resolveModel(null, 'video-swap', ['fal/pixverse-swap']);
  return (await falOp(m.endpoint, { video_url: await publicUrl(video, ctx.signal), image_url: await publicUrl(image, ctx.signal), mode, resolution, original_sound_switch: true }, 'video', ctx, { model: m.id, label: m.label })).asset;
}

/** Talking avatar: photo + (audio | script in a voice) → speaking video. */
export async function talkingAvatar({ image, audio, text, voice, model, prompt, resolution = '720p' }, ctx) {
  const m = resolveModel(model, 'avatar', ['fal/omnihuman-v2', 'fal/kling-avatar', 'fal/h3-lipsync', 'fal/fabric']);
  let a = audio ? await materialize(audio, ctx.signal) : await speak({ text, voice }, ctx);
  a = await audioForUpload(a, { minSeconds: m.minAudio || 0, signal: ctx.signal });
  const img = await publicUrl(image, ctx.signal);
  const aud = await publicUrl(a, ctx.signal);
  const input = {
    'fal/omnihuman-v2': { image_url: img, audio_url: aud, ...(prompt && { prompt }) },
    'fal/kling-avatar': { image_url: img, audio_url: aud, prompt: prompt || '.' },
    'fal/h3-lipsync': { image_url: img, audio_url: aud, resolution: /1080|2k/i.test(resolution) ? '1080P' : '768P' },
    'fal/fabric': { image_url: img, audio_url: aud, resolution: resolution === '480p' ? '480p' : '720p' },
  }[m.id];
  return (await falOp(m.endpoint, input, 'video', ctx, { model: m.id, label: m.label, prompt: text || prompt })).asset;
}

/** Lip-sync existing footage to new audio (or a script in a voice). */
export async function lipsyncVideo({ video, audio, text, voice, model }, ctx) {
  const m = resolveModel(model, 'lipsync', ['fal/sync-v3', 'fal/veed-lipsync']);
  let a = audio ? await materialize(audio, ctx.signal) : await speak({ text, voice }, ctx);
  a = await audioForUpload(a, { signal: ctx.signal });
  const input = { video_url: await publicUrl(video, ctx.signal), audio_url: await publicUrl(a, ctx.signal), ...(m.id === 'fal/sync-v3' && { sync_mode: 'cut_off' }) };
  return (await falOp(m.endpoint, input, 'video', ctx, { model: m.id, label: m.label, prompt: text })).asset;
}

export async function dubVideo({ video, language, keyterms }, ctx) {
  const m = resolveModel(null, 'dub', ['fal/veed-dubbing']);
  const terms = String(keyterms || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (await falOp(m.endpoint, { video_url: await publicUrl(video, ctx.signal), target_language: language, source_language: 'auto', keyterms: terms }, 'video', ctx, { model: m.id, label: m.label })).asset;
}

/**
 * Extend a clip. Native extenders (Grok / FLUX 3 on fal) continue the actual footage; any image-to-video model
 * continues from the last frame and the engine joins the two parts.
 */
export async function extendVideo({ video, prompt, model, seconds = 6, aspect, resolution }, ctx) {
  const src = await materialize(video, ctx.signal);
  const cat = publicCatalog();
  const chosen = cat.find((m) => m.id === model && m.available);
  const native = chosen?.kind === 'extend' ? chosen : !chosen ? cat.find((m) => m.kind === 'extend' && m.available && m.id === 'fal/grok-extend') : null;
  let part;
  if (native) {
    const v = await trimVideo(src, 15, ctx.signal);
    const input = native.id === 'fal/grok-extend'
      ? { video_url: await publicUrl(v, ctx.signal), prompt, duration: Math.min(10, Math.max(2, Math.round(seconds))) }
      : { video_url: await publicUrl(v, ctx.signal), prompt, duration: String(Math.min(20, Math.max(5, Math.round(seconds)))), resolution: resolution || '720p', generate_audio: true };
    ({ asset: part } = await falOp(native.endpoint, input, 'video', ctx, { model: native.id, label: native.label, prompt }));
    // Some extenders return source + continuation — keep that whole; otherwise join below.
    const srcDur = src.duration || (await ff.probe(assetPath(src)).catch(() => ({}))).duration || 0;
    if ((part.duration || 0) > srcDur + 1) return part;
  } else {
    const m = resolveModel(model, 'i2v', ['apimart/kling-v3', 'apimart/seedance-2.0', 'apimart/veo3.1-fast', 'xai/grok-imagine-video-1.5']);
    const frame = await lastFrame(src);
    const info = await ff.probe(assetPath(src)).catch(() => ({}));
    const ar = aspect || (info.width && info.height ? (info.width >= info.height ? '16:9' : '9:16') : '16:9');
    part = await genVideo({ model: m.id, prompt: `Continue seamlessly from this exact frame: ${prompt}. Same characters, wardrobe, location, lighting and camera style.`, image: frame, aspect: ar, duration: seconds, resolution }, ctx);
  }
  ctx.onStatus?.({ message: 'Joining the clips' });
  const joined = await joinClips([src, part], { signal: ctx.signal });
  return saveResult(joined, { kind: 'video', signal: ctx.signal, meta: { source: 'tool', model: 'extend', prompt } });
}

export async function videoSfx({ video, prompt, keepSpeech = true }, ctx) {
  const m = resolveModel(null, 'sfx-video', ['fal/mirelo-sfx']);
  const a = await materialize(video, ctx.signal);
  const info = await ff.probe(assetPath(a)).catch(() => ({}));
  return (await falOp(m.endpoint, { video_url: await publicUrl(a, ctx.signal), num_samples: 1, preserve_speech: !!keepSpeech, duration: Math.min(600, Math.ceil(info.duration || 10)), ...(prompt && { text_prompt: prompt }) }, 'video', ctx, { model: m.id, label: m.label, prompt })).asset;
}

export async function soundEffect({ prompt, seconds, loop }, ctx) {
  const r = await elevenSfx({ text: prompt, seconds, loop }, ctx);
  return addAsset({ buffer: r.buffer, mime: 'audio/mpeg', meta: { source: 'tool', model: 'eleven/sfx', prompt } });
}

export async function music({ prompt, seconds, model, instrumental = true }, ctx) {
  const m = resolveModel(model, 'music', ['eleven/music', 'google/lyria-3.5']);
  if (m.id === 'eleven/music') {
    const r = await elevenMusic({ prompt, seconds, instrumental }, ctx);
    return addAsset({ buffer: r.buffer, mime: 'audio/mpeg', meta: { source: 'tool', model: m.id, prompt } });
  }
  return makeMusic({ model: m.id, prompt, seconds }, ctx);
}

export const textToSpeech = ({ text, voice }, ctx) => speak({ text, voice, keep: true }, ctx);

/** Product page → { title, description, image } from Open Graph tags (Click to Ad). */
export async function readProductPage(url, signal) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605', Accept: 'text/html' }, signal: signal || AbortSignal.timeout(12000), redirect: 'follow' });
    const html = (await r.text()).slice(0, 600000);
    const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']+)`, 'i'))?.[1] || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${p}["']`, 'i'))?.[1];
    const dec = (s) => s && s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const img = meta('og:image') || meta('twitter:image');
    return { title: dec(meta('og:title') || html.match(/<title[^>]*>([^<]+)/i)?.[1] || '').trim(), description: dec(meta('og:description') || meta('description') || '').trim(), image: img ? new URL(dec(img), url).href : null };
  } catch { return null; }
}

/** Strip anything executable from a generated SVG before it is served from our origin. */
export async function sanitizeSvg(asset) {
  if (asset?.mime !== 'image/svg+xml') return asset;
  const p = assetPath(asset);
  const s = await fsp.readFile(p, 'utf8');
  await fsp.writeFile(p, s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/(href|xlink:href)\s*=\s*["']\s*javascript:[^"']*["']/gi, ''));
  return asset;
}
