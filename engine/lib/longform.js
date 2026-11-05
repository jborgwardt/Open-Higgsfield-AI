// Long-form productions (5–10+ minute films): plan → generate shots with continuity → assemble.
// State is persisted after every change so a run survives restarts and can be resumed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PRODUCTIONS, DATA, uid, now, readJSON, writeJSON, getSettings, getAsset, assetPath, addAsset, newAssetPath } from './store.js';
import { generate, getModel } from './catalog.js';
import { planProduction, shotCountFor } from './director.js';
import * as ff from './ffmpeg.js';
import { sleep } from './http.js';
import { makeMusic, makeVoice, pickVoiceProvider } from './sound.js';

const SEGMENTS = path.join(DATA, 'segments');
fs.mkdirSync(SEGMENTS, { recursive: true });

const file = (id) => path.join(PRODUCTIONS, `${String(id).replace(/[^\w]/g, '')}.json`);
const cache = new Map();
const locks = new Map();
const runners = new Map(); // id -> { ctrl, active:Set }

export function getProduction(id) {
  if (!cache.has(id)) {
    const p = readJSON(file(id), null);
    if (!p) return null;
    cache.set(id, p);
  }
  return cache.get(id);
}

export function listProductions() {
  return fs.readdirSync(PRODUCTIONS).filter((f) => f.endsWith('.json')).map((f) => getProduction(f.slice(0, -5))).filter(Boolean)
    .map((p) => ({ id: p.id, title: p.title, status: p.status, shots: p.shots.length, done: p.shots.filter((s) => s.status === 'done').length, updatedAt: p.updatedAt, cover: getAsset(p.shots.find((s) => s.posterId)?.posterId)?.url || null }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function mutate(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let result;
  const next = prev.then(async () => {
    const p = getProduction(id);
    if (!p) throw Object.assign(new Error('production not found'), { status: 404 });
    result = await fn(p);
    p.updatedAt = now();
    await writeJSON(file(id), p);
  });
  locks.set(id, next.catch(() => {}));
  await next;
  return result;
}

const DEFAULT_BRIEF = {
  title: 'Untitled film',
  script: '',
  style: '',
  targetMinutes: 5,
  clipSeconds: 8,
  aspect: '16:9',
  resolution: '720p',
  videoModel: 'xai/grok-imagine-video-1.5',
  imageModel: 'google/gemini-nano-banana-2.1',
  continuity: 'extend', // extend | lastframe | cut
  keyframes: true, // generate a keyframe for every "cut" shot
  characters: [], // { name, description, refAssetId, refAssetIds: [] } — several photos per character sharpen likeness
  sceneFades: true,
  autoAssemble: true,
  // sound
  music: 'off', // off | ai | upload
  musicModel: 'google/lyria-3.5',
  musicPrompt: '',
  musicAssetId: null,
  musicVolume: 0.35,
  narration: false,
  narratorStyle: 'a warm, unhurried documentary narrator',
  voiceProvider: 'auto', // auto | eleven | xai | google | local
  voice: '',
  clipVolume: 1,
};
const briefOf = (p) => ({ ...DEFAULT_BRIEF, ...(p.brief || {}) });

export async function createProduction(brief = {}) {
  const p = {
    id: uid('prod_'),
    title: brief.title || DEFAULT_BRIEF.title,
    brief: { ...DEFAULT_BRIEF, ...brief },
    status: 'draft',
    message: '',
    plan: null,
    scenes: [],
    shots: [],
    master: null,
    handoff: { autoImport: false, since: null, seen: {} },
    log: [],
    createdAt: now(),
    updatedAt: now(),
  };
  cache.set(p.id, p);
  await writeJSON(file(p.id), p);
  return p;
}

export async function deleteProduction(id) {
  pause(id);
  cache.delete(id);
  await fsp.rm(file(id), { force: true });
}

const log = (p, msg) => { p.log = [...(p.log || []).slice(-199), { at: now(), msg }]; p.message = msg; };

export async function updateBrief(id, patch) {
  return mutate(id, (p) => {
    p.brief = { ...p.brief, ...patch };
    if (patch.title) p.title = patch.title;
  });
}

/* ---------------- planning ---------------- */

export async function plan(id) {
  const p = getProduction(id);
  if (!p) throw Object.assign(new Error('production not found'), { status: 404 });
  if (p.status === 'running') throw Object.assign(new Error('pause the production before re-planning'), { status: 409 });
  await mutate(id, (x) => { x.status = 'planning'; log(x, `Planning ${shotCountFor(x.brief)} shots`); });
  (async () => {
    try {
      const result = await planProduction(briefOf(p), { onStatus: ({ message }) => mutate(id, (x) => { x.message = message; }).catch(() => {}) });
      await mutate(id, (x) => {
        x.plan = { title: result.title, logline: result.logline, style: result.style, director: result.director };
        if (result.title && x.title === DEFAULT_BRIEF.title) x.title = result.title;
        x.scenes = result.scenes.map((s) => ({ id: uid('sc_'), title: s.title, summary: s.summary, music: s.music || '', musicId: null }));
        x.shots = [];
        result.scenes.forEach((s, si) => s.shots.forEach((sh) => x.shots.push(newShot(x, { ...sh, sceneId: x.scenes[si].id }))));
        x.shots.forEach((s, i) => { s.index = i; if (i === 0) s.continuity = 'cut'; });
        x.status = 'planned';
        x.master = null;
        log(x, `Planned ${x.shots.length} shots in ${x.scenes.length} scenes (${result.director === 'local' ? 'local splitter' : `director: ${result.director}`})`);
      });
    } catch (e) {
      await mutate(id, (x) => { x.status = 'error'; log(x, `Planning failed: ${e.message}`); }).catch(() => {});
    }
  })();
  return getProduction(id);
}

function newShot(p, sh = {}) {
  return {
    id: uid('sh_'),
    index: 0,
    sceneId: sh.sceneId || p.scenes.at(-1)?.id || null,
    title: sh.title || '',
    action: sh.action || '',
    camera: sh.camera || '',
    prompt: sh.prompt || [sh.action, sh.camera && `Camera: ${sh.camera}`].filter(Boolean).join('. '),
    continuity: sh.continuity === 'continue' ? 'continue' : 'cut',
    narration: sh.narration || '',
    voiceId: null,
    voiceKey: null,
    duration: sh.duration || null,
    model: sh.model || null, // per-shot override
    status: 'pending',
    attempts: 0,
    error: null,
    keyframeId: null,
    startFrameId: null,
    videoId: null,
    posterId: null,
    ref: null,
    trimStart: 0,
    clipDuration: null,
    message: '',
  };
}

export async function addShot(id, afterId, init = {}) {
  return mutate(id, (p) => {
    const at = afterId ? p.shots.findIndex((s) => s.id === afterId) + 1 : p.shots.length;
    const s = newShot(p, { ...init, sceneId: init.sceneId || p.shots[at - 1]?.sceneId });
    p.shots.splice(at, 0, s);
    p.shots.forEach((x, i) => (x.index = i));
    return s;
  });
}

export async function updateShot(id, sid, patch) {
  return mutate(id, (p) => {
    const s = p.shots.find((x) => x.id === sid);
    if (!s) throw Object.assign(new Error('shot not found'), { status: 404 });
    for (const k of ['title', 'prompt', 'action', 'camera', 'continuity', 'duration', 'model', 'narration']) if (k in patch) s[k] = patch[k];
    // Pin an approved still (an engine asset) as this shot's keyframe, or clear it with null.
    if ('keyframeId' in patch) {
      if (patch.keyframeId && !getAsset(patch.keyframeId)) throw Object.assign(new Error('keyframe asset not found'), { status: 400 });
      s.keyframeId = patch.keyframeId || null;
    }
    if (patch.reset) Object.assign(s, { status: 'pending', attempts: 0, error: null, videoId: null, posterId: null, ref: null, trimStart: 0, clipDuration: null, keyframeId: patch.keepKeyframe ? s.keyframeId : null, startFrameId: null, message: '' });
    if (patch.skip) s.status = 'skipped';
  });
}

export async function updateScene(id, scid, patch) {
  return mutate(id, (p) => {
    const sc = p.scenes.find((x) => x.id === scid);
    if (!sc) throw Object.assign(new Error('scene not found'), { status: 404 });
    if ('music' in patch) { sc.music = patch.music; sc.musicId = null; }
    if ('title' in patch) sc.title = patch.title;
    if (patch.regenerateMusic) sc.musicId = null;
  });
}

export async function deleteShot(id, sid) {
  return mutate(id, (p) => {
    p.shots = p.shots.filter((s) => s.id !== sid);
    p.shots.forEach((x, i) => (x.index = i));
  });
}

/* ---------------- running ---------------- */

const TERMINAL = ['done', 'error', 'skipped'];

export async function start(id) {
  const p = getProduction(id);
  if (!p?.shots.length) throw Object.assign(new Error('plan the production first'), { status: 400 });
  if (runners.has(id)) return p;
  await mutate(id, (x) => {
    x.status = 'running';
    for (const s of x.shots) if (s.status === 'running') s.status = 'pending'; // resume after restart
    log(x, 'Production started');
  });
  const runner = { ctrl: new AbortController(), active: new Set() };
  runners.set(id, runner);
  loop(id, runner).catch((e) => mutate(id, (x) => { x.status = 'error'; log(x, `Runner crashed: ${e.message}`); }));
  return getProduction(id);
}

export async function pause(id, reason) {
  const r = runners.get(id);
  if (r) { r.ctrl.abort(); runners.delete(id); }
  if (getProduction(id)) {
    await mutate(id, (x) => {
      for (const s of x.shots) if (s.status === 'running') { s.status = 'pending'; s.message = 'paused'; }
      if (x.status === 'running') x.status = 'paused';
      log(x, reason || 'Paused');
    });
  }
}

function modelFor(p, s) { return getModel(s.model || p.brief.videoModel); }
function prevShot(p, s) { return p.shots[s.index - 1]; }

function ready(p, s) {
  if (s.status !== 'pending') return false;
  if (s.retryAt && Date.now() < s.retryAt) return false;
  if (s.continuity !== 'continue' || p.brief.continuity === 'cut' || s.index === 0) return true;
  const prev = prevShot(p, s);
  return !prev || TERMINAL.includes(prev.status);
}

async function loop(id, runner) {
  const { signal } = runner.ctrl;
  while (!signal.aborted) {
    const p = getProduction(id);
    if (!p || p.status !== 'running') break;
    const limits = getSettings().concurrency || {};
    const busy = {};
    for (const sid of runner.active) {
      const s = p.shots.find((x) => x.id === sid);
      const prov = s && modelFor(p, s)?.provider;
      if (prov) busy[prov] = (busy[prov] || 0) + 1;
    }
    for (const s of p.shots) {
      if (!ready(p, s) || runner.active.has(s.id)) continue;
      const m = modelFor(p, s);
      if (!m) { await mutate(id, (x) => { const t = x.shots.find((y) => y.id === s.id); t.status = 'error'; t.error = `unknown model ${s.model || p.brief.videoModel}`; }); continue; }
      if (m.provider === 'handoff') { await prepareHandoff(id, s.id, signal).catch(() => {}); continue; }
      if ((busy[m.provider] || 0) >= (limits[m.provider] || 2)) continue;
      busy[m.provider] = (busy[m.provider] || 0) + 1;
      runner.active.add(s.id);
      runShot(id, s.id, signal).finally(() => runner.active.delete(s.id));
    }
    const cur = getProduction(id);
    if (cur.shots.every((s) => TERMINAL.includes(s.status)) && !runner.active.size) {
      runners.delete(id);
      const ok = cur.shots.filter((s) => s.status === 'done').length;
      await mutate(id, (x) => { x.status = 'review'; log(x, `All shots finished (${ok}/${x.shots.length} rendered)`); });
      if (cur.brief.autoAssemble && ok) assemble(id).catch(() => {});
      return;
    }
    await sleep(1000, signal).catch(() => {});
  }
}

async function setShot(id, sid, patch) {
  return mutate(id, (p) => { const s = p.shots.find((x) => x.id === sid); if (s) Object.assign(s, patch); });
}

async function lastFrameOf(shot, signal) {
  const a = getAsset(shot.videoId);
  if (!a) return null;
  const out = newAssetPath('image/jpeg');
  await ff.lastFrame(assetPath(a), out.abs);
  void signal;
  return (await addAsset({ ...out, mime: 'image/jpeg', meta: { source: 'last-frame' } })).id;
}

const refIdsOf = (c) => [...new Set([...(c.refAssetIds || []), c.refAssetId].filter(Boolean))];

/** Reference photos for keyframes (up to the image model's limit) plus a line telling it which photo shows whom. */
export function characterRefs(characters = [], max = 6) {
  const refs = [];
  const parts = [];
  for (const c of characters) {
    const ids = refIdsOf(c).slice(0, Math.max(0, max - refs.length));
    if (!ids.length) continue;
    const a = refs.length + 1;
    refs.push(...ids);
    parts.push(`${ids.length > 1 ? `images ${a}-${refs.length} show` : `image ${a} shows`} ${c.name || 'a character'}`);
  }
  const guide = parts.length ? `Reference photos: ${parts.join('; ')}. Keep every referenced person's face, hairline, beard and build exactly as in their photos. ` : '';
  return { refs, guide };
}

/** Work out the start frame / extension source for a shot. */
async function inputsFor(p, s, m, signal, onStatus) {
  const prev = prevShot(p, s);
  const chained = s.continuity === 'continue' && p.brief.continuity !== 'cut' && prev?.status === 'done';
  if (chained && p.brief.continuity === 'extend' && m.caps?.extend && prev.ref?.provider === m.provider) {
    return { extend: { ref: prev.ref, sourceDuration: getAsset(prev.videoId)?.duration } };
  }
  if (chained) {
    const frame = await lastFrameOf(prev, signal);
    if (frame) return { image: frame, startFrameId: frame };
  }
  // A cut (or the chain broke): keyframe first when asked, or when the model can't do text-to-video.
  if (s.keyframeId) return { image: s.keyframeId, startFrameId: s.keyframeId };
  if (p.brief.keyframes || !m.caps?.t2v) {
    const im = getModel(p.brief.imageModel);
    if (!im) throw new Error(`image model ${p.brief.imageModel} not found`);
    onStatus({ message: `Keyframe · ${im.label}` });
    const { refs, guide } = characterRefs(p.brief.characters, im.refs ?? 0);
    const kf = await generate({ model: im.id, prompt: `Cinematic film still, ${p.brief.aspect} frame. ${guide}${s.prompt}`, refs, aspect: p.brief.aspect }, { onStatus, signal });
    await setShot(p.id, s.id, { keyframeId: kf.asset.id });
    return { image: kf.asset.id, startFrameId: kf.asset.id };
  }
  return {};
}

async function runShot(id, sid, signal) {
  const p = getProduction(id);
  const s = p.shots.find((x) => x.id === sid);
  const m = modelFor(p, s);
  let lastMsg = 0;
  const onStatus = ({ message }) => {
    if (!message || Date.now() - lastMsg < 1500) return;
    lastMsg = Date.now();
    setShot(id, sid, { message }).catch(() => {});
  };
  await setShot(id, sid, { status: 'running', error: null, message: 'Starting', startedAt: now() });
  try {
    const inputs = await inputsFor(p, s, m, signal, onStatus);
    const duration = Number(s.duration) || Number(p.brief.clipSeconds) || 8;
    const r = await generate({ model: m.id, prompt: s.prompt, aspect: p.brief.aspect, resolution: p.brief.resolution, duration, ...inputs }, { onStatus, signal });
    const total = r.asset.duration || duration;
    await setShot(id, sid, {
      status: 'done', videoId: r.asset.id, posterId: r.asset.posterId || null, ref: r.ref, trimStart: r.trimStart || 0,
      clipDuration: Math.max(0.5, total - (r.trimStart || 0)), startFrameId: inputs.startFrameId || null, message: inputs.extend ? 'Extended from previous shot' : '', finishedAt: now(),
    });
  } catch (e) {
    if (signal.aborted) return;
    const cur = getProduction(id).shots.find((x) => x.id === sid);
    const attempts = (cur?.attempts || 0) + 1;
    if (e.quota) {
      await setShot(id, sid, { status: 'pending', attempts, error: e.message, message: 'Quota/limit reached' });
      await pause(id, `Paused: ${e.message}. Resume when your quota resets, or switch this production's video model.`);
      return;
    }
    const retry = attempts < 3 && (e.retryable || /timeout|ECONN|socket|network|503|502/i.test(e.message));
    await setShot(id, sid, retry
      ? { status: 'pending', attempts, error: e.message, retryAt: Date.now() + attempts * 20000, message: `Retrying (${attempts}/3): ${e.message.slice(0, 120)}` }
      : { status: 'error', attempts, error: e.message, message: '' });
    await mutate(id, (x) => log(x, `Shot ${s.index + 1} ${retry ? 'will retry' : 'failed'}: ${e.message.slice(0, 200)}`));
  }
}

/* ---------------- subscription hand-off ---------------- */

async function prepareHandoff(id, sid, signal) {
  const p = getProduction(id);
  const s = p.shots.find((x) => x.id === sid);
  let startFrameId = null;
  const prev = prevShot(p, s);
  if (s.continuity === 'continue' && prev?.status === 'done') startFrameId = await lastFrameOf(prev, signal);
  await setShot(id, sid, { status: 'handoff', startFrameId, message: 'Waiting for your clip' });
  await mutate(id, (x) => { if (!x.handoff.since) x.handoff.since = Date.now(); });
}

export async function importClip(id, sid, assetId) {
  const a = getAsset(assetId);
  if (!a || a.kind !== 'video') throw Object.assign(new Error('expected a video file'), { status: 400 });
  const info = await ff.probe(assetPath(a)).catch(() => ({}));
  const posterOut = newAssetPath('image/jpeg');
  let posterId = null;
  try { await ff.poster(assetPath(a), posterOut.abs); posterId = (await addAsset({ ...posterOut, mime: 'image/jpeg', meta: { source: 'poster' } })).id; } catch {}
  await setShot(id, sid, { status: 'done', videoId: a.id, posterId, ref: null, trimStart: 0, clipDuration: info.duration || 8, error: null, message: 'Imported clip', finishedAt: now() });
  const p = getProduction(id);
  if (p.status === 'review' || (p.status !== 'running' && p.shots.every((s) => TERMINAL.includes(s.status)))) {
    await mutate(id, (x) => { x.status = 'review'; });
  }
  return getProduction(id);
}

export async function setAutoImport(id, on) {
  await mutate(id, (p) => { p.handoff.autoImport = !!on; p.handoff.since = on ? Date.now() : p.handoff.since; });
  return getProduction(id);
}

// Watch the hand-off folder (default ~/Downloads) and attach new clips to waiting shots in order.
const sizes = new Map();
setInterval(async () => {
  const dir = getSettings().handoffDir;
  for (const meta of listProductions()) {
    const p = getProduction(meta.id);
    if (!p?.handoff?.autoImport) continue;
    const waiting = p.shots.filter((s) => s.status === 'handoff');
    if (!waiting.length) continue;
    let files;
    try { files = await fsp.readdir(dir); } catch { continue; }
    const cands = [];
    for (const f of files) {
      if (!/\.(mp4|mov|webm)$/i.test(f)) continue;
      const abs = path.join(dir, f);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || st.mtimeMs < (p.handoff.since || 0) || p.handoff.seen?.[abs]) continue;
      const prevSize = sizes.get(abs);
      sizes.set(abs, st.size);
      if (prevSize !== st.size || st.size < 10000) continue; // still downloading
      cands.push({ abs, mtime: st.mtimeMs });
    }
    cands.sort((a, b) => a.mtime - b.mtime);
    for (const c of cands) {
      const shot = getProduction(p.id).shots.find((s) => s.status === 'handoff');
      if (!shot) break;
      const buffer = await fsp.readFile(c.abs);
      const asset = await addAsset({ buffer, mime: 'video/mp4', meta: { source: 'handoff', name: path.basename(c.abs) } });
      await mutate(p.id, (x) => { x.handoff.seen = { ...(x.handoff.seen || {}), [c.abs]: true }; log(x, `Imported ${path.basename(c.abs)} into shot ${shot.index + 1}`); });
      await importClip(p.id, shot.id, asset.id);
    }
  }
}, 4000).unref();

/* ---------------- assembly ---------------- */

/* ---------------- soundtrack ---------------- */

/** Make any missing narration lines and music cues, then return mix instructions. */
async function buildSoundtrack(id, shots, starts, durs, total) {
  const p = getProduction(id);
  const b = briefOf(p);
  const voice = [];
  const music = [];
  if (b.narration) {
    // Key on the resolved provider so one film never mixes narrators when "auto" changes its pick.
    const key = `${pickVoiceProvider(b.voiceProvider)}|${b.voice}|${b.narratorStyle}`;
    let n = 0;
    for (const [k, s] of shots.entries()) {
      const text = (s.narration || '').trim();
      if (!text) continue;
      let a = s.voiceKey === `${key}|${text}` ? getAsset(s.voiceId) : null;
      if (!a) {
        await mutate(id, (x) => { x.message = `Recording narration ${++n}`; });
        try {
          a = await makeVoice({ provider: b.voiceProvider, voice: b.voice, text, style: b.narratorStyle });
          await mutate(id, (x) => { const t = x.shots.find((y) => y.id === s.id); if (t) { t.voiceId = a.id; t.voiceKey = `${key}|${text}`; } });
        } catch (e) {
          await mutate(id, (x) => log(x, `Narration for shot ${s.index + 1} failed: ${e.message}`));
          continue;
        }
      }
      voice.push({ file: assetPath(a), start: starts[k] + 0.3 });
    }
  }
  if (b.music === 'upload' && getAsset(b.musicAssetId)) {
    music.push({ file: assetPath(getAsset(b.musicAssetId)), start: 0, duration: total });
  } else if (b.music === 'ai') {
    // One cue per scene, sized to the scene's cut length.
    const scenes = [];
    shots.forEach((s, k) => {
      const last = scenes.at(-1);
      if (last && last.sceneId === s.sceneId) last.duration += durs[k];
      else scenes.push({ sceneId: s.sceneId, start: starts[k], duration: durs[k] });
    });
    for (const sc of scenes) {
      const scene = p.scenes.find((x) => x.id === sc.sceneId);
      let a = getAsset(scene?.musicId);
      if (!a) {
        const prompt = [scene?.music || b.musicPrompt || 'Understated cinematic instrumental score', b.style && `Film look: ${b.style}`].filter(Boolean).join('. ');
        await mutate(id, (x) => { x.message = `Composing music for “${scene?.title || 'scene'}”`; });
        try {
          a = await makeMusic({ model: b.musicModel, prompt, seconds: sc.duration });
          await mutate(id, (x) => { const t = x.scenes.find((y) => y.id === sc.sceneId); if (t) t.musicId = a.id; });
        } catch (e) {
          await mutate(id, (x) => log(x, `Music for “${scene?.title || 'scene'}” failed: ${e.message}`));
          continue;
        }
      }
      music.push({ file: assetPath(a), start: sc.start, duration: sc.duration });
    }
  }
  return { voice, music };
}

const assembling = new Set();

export async function assemble(id) {
  if (assembling.has(id)) return getProduction(id);
  assembling.add(id);
  await mutate(id, (x) => { x.assembling = true; log(x, 'Assembling master'); });
  try {
    const p = getProduction(id);
    const base = { '1080p': 1920, '4k': 1920, '480p': 854, '360p': 640 }[p.brief.resolution] || 1280;
    const { W, H } = ff.frameSize(p.brief.aspect, base);
    const shots = p.shots.filter((s) => s.status === 'done' && getAsset(s.videoId));
    if (!shots.length) throw new Error('no rendered shots yet');
    const segs = [];
    const durs = [];
    let i = 0;
    const work = shots.map((s, k) => ({ s, k }));
    const worker = async () => {
      while (work.length) {
        const { s, k } = work.shift();
        const a = getAsset(s.videoId);
        const info = a.duration ? a : { ...a, ...(await ff.probe(assetPath(a)).catch(() => ({}))) };
        const trim = s.trimStart || 0;
        const dur = Math.max(0.5, (info.duration || s.clipDuration || 8) - trim);
        const sceneStart = p.brief.sceneFades && (k === 0 || shots[k - 1].sceneId !== s.sceneId);
        const sceneEnd = p.brief.sceneFades && (k === shots.length - 1 || shots[k + 1].sceneId !== s.sceneId);
        const key = `${a.id}_${trim.toFixed(2)}_${W}x${H}_${sceneStart ? 1 : 0}${sceneEnd ? 1 : 0}`;
        const out = path.join(SEGMENTS, `${key}.mp4`);
        if (!fs.existsSync(out)) {
          const tmp = `${out}.tmp.mp4`;
          await ff.conform({ input: assetPath(a), out: tmp, W, H, start: trim, duration: dur, fadeIn: sceneStart ? 0.4 : 0, fadeOut: sceneEnd ? 0.4 : 0, hasAudio: info.hasAudio ?? (await ff.probe(assetPath(a)).catch(() => ({}))).hasAudio });
          await fsp.rename(tmp, out);
        }
        segs[k] = out;
        durs[k] = dur;
        i++;
        await mutate(id, (x) => { x.message = `Conformed ${i}/${shots.length} clips`; });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    let out = newAssetPath('video/mp4');
    await ff.concat({ segments: segs, out: out.abs });
    const b = briefOf(p);
    if (b.music !== 'off' || b.narration) {
      const starts = [];
      durs.reduce((t, d, k) => { starts[k] = t; return t + d; }, 0);
      const total = durs.reduce((t, d) => t + d, 0);
      const sound = await buildSoundtrack(id, shots, starts, durs, total);
      if (sound.music.length || sound.voice.length) {
        await mutate(id, (x) => { x.message = 'Mixing music and narration'; });
        const mixed = newAssetPath('video/mp4');
        await ff.mixSoundtrack({ video: out.abs, out: mixed.abs, music: sound.music, voice: sound.voice, musicVolume: Number(b.musicVolume) || 0.35, clipVolume: b.narration ? Math.min(Number(b.clipVolume) || 1, 0.6) : Number(b.clipVolume) || 1 });
        await fsp.rm(out.abs, { force: true });
        out = mixed;
      }
    }
    const info = await ff.probe(out.abs).catch(() => ({}));
    const asset = await addAsset({ ...out, mime: 'video/mp4', meta: { source: 'master', ...info } });
    await mutate(id, (x) => {
      x.master = { assetId: asset.id, url: asset.url, duration: info.duration, shots: shots.length, createdAt: now() };
      x.assembling = false;
      if (x.status !== 'running' && x.shots.every((s) => TERMINAL.includes(s.status))) x.status = 'done';
      log(x, `Master ready: ${shots.length} shots, ${Math.round(info.duration || 0)}s`);
    });
  } catch (e) {
    await mutate(id, (x) => { x.assembling = false; log(x, `Assembly failed: ${e.message}`); });
  } finally {
    assembling.delete(id);
  }
  return getProduction(id);
}

/** Resolve asset ids → URLs for the UI. */
export function hydrate(p) {
  if (!p) return p;
  const u = (id) => getAsset(id)?.url || null;
  return {
    ...p,
    running: runners.has(p.id),
    shotCount: shotCountFor(p.brief),
    brief: { ...briefOf(p), musicUrl: u(p.brief.musicAssetId), characters: (p.brief.characters || []).map((c) => ({ ...c, refUrl: u(c.refAssetId || c.refAssetIds?.[0]), refUrls: refIdsOf(c).map(u) })) },
    scenes: (p.scenes || []).map((sc) => ({ ...sc, musicUrl: u(sc.musicId) })),
    shots: p.shots.map((s) => ({ ...s, videoUrl: u(s.videoId), posterUrl: u(s.posterId), keyframeUrl: u(s.keyframeId), startFrameUrl: u(s.startFrameId), voiceUrl: u(s.voiceId) })),
  };
}

// Resume productions that were running when the engine stopped.
export function resumeAll() {
  for (const meta of listProductions()) {
    const p = getProduction(meta.id);
    if (p?.status === 'running') start(p.id).catch(() => {});
    if (p?.status === 'planning') mutate(p.id, (x) => { x.status = x.shots.length ? 'paused' : 'draft'; log(x, 'Planning interrupted by engine restart'); }).catch(() => {});
    if (p?.assembling) mutate(p.id, (x) => { x.assembling = false; }).catch(() => {});
  }
}
