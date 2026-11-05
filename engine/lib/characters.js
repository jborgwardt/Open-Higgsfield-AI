// Characters: reusable people (photos, a head-turn video, an approved model sheet, look notes, a voice) that every
// studio and provider can reproduce. Stored in DATA/characters.json; media live in the normal asset store.
//
//  - refs are graded on arrival (ffmpeg sharpness + a vision LLM) and ranked; videos are cut into their best frames
//  - coverage compares the set against the photo spec and says what to shoot next
//  - a model sheet is generated with Nano Banana Pro and, once approved, becomes the first reference everywhere
//  - applyCharacters() routes the best refs into any generate() call according to what the model can take
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA, uid, now, readJSON, writeJSON, getAsset, assetPath, addAsset, newAssetPath, updateAsset, assetFromUrl } from './store.js';
import { generate, getModel, availableProviders, allModels } from './catalog.js';
import * as jobs from './jobs.js';
import * as cr from './charref.js';
import * as cv from './charvision.js';
import { checkLikeness } from './likeness.js';

const FILE = path.join(DATA, 'characters.json');
const TMP = path.join(DATA, 'tmp');

let db = readJSON(FILE, {});
let saveQ = Promise.resolve();
const save = () => (saveQ = saveQ.then(() => writeJSON(FILE, db)).catch((e) => console.error('characters save', e)));
const processing = new Map(); // characterId -> Map(assetId -> { assetId, kind, message, startedAt })
const pending = new Map(); // characterId -> Set(promise) for ?wait

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const touch = (c) => { c.updatedAt = now(); save(); };
export const getCharacter = (id) => (id && db[id]) || null;
function must(id) {
  const c = getCharacter(id);
  if (!c) throw fail(404, 'character not found');
  return c;
}

/* ------------------------------------------------------------------ shape for the API */

const url = (id) => getAsset(id)?.url || null;

function setProgress(cid, assetId, patch) {
  if (!processing.has(cid)) processing.set(cid, new Map());
  const m = processing.get(cid);
  if (patch === null) { m.delete(assetId); if (!m.size) processing.delete(cid); return; }
  m.set(assetId, { ...(m.get(assetId) || { assetId, startedAt: now() }), ...patch });
}

export function hydrate(c) {
  const sheet = c.sheet ? { assetId: c.sheet.assetId, url: url(c.sheet.assetId), approved: !!c.sheet.approved, createdAt: c.sheet.createdAt, model: c.sheet.model || null } : null;
  const best = cr.pickRefs(c, 1, { includeSheet: false })[0];
  const cov = cr.coverage(c.refs);
  const inForce = c.refs.find((r) => r.kind === 'sheet');
  return {
    id: c.id,
    name: c.name,
    description: c.description || '',
    lookNotes: c.lookNotes || '',
    voice: c.voice || null,
    realPerson: c.realPerson !== false,
    refs: c.refs.map((r) => ({
      assetId: r.assetId,
      url: url(r.workId || r.assetId),
      originalUrl: url(r.assetId),
      kind: r.kind,
      angle: r.angle || 'unknown',
      expression: r.expression || null,
      expressionLabel: r.expressionLabel || '',
      framing: r.framing || null,
      cameraHeight: r.cameraHeight || null,
      facialHair: r.facialHair || null,
      status: r.status,
      quality: { score: r.quality?.score ?? null, sharp: r.quality?.sharp ?? null, issues: r.quality?.flags ? r.quality.flags.map(cr.issueText) : r.quality?.issues || [], flags: r.quality?.flags || [] },
      graded: !!r.graded,
      manual: !!r.manual,
      error: r.error || null,
      sourceAssetId: r.sourceAssetId || null,
      t: r.t ?? null,
      addedAt: r.addedAt,
    })),
    sheet,
    // The approved sheet that leads generation (can be an older one while a new sheet awaits review).
    approvedSheet: inForce ? { assetId: inForce.assetId, url: url(inForce.assetId) } : null,
    sheetJob: c.sheetJob || null,
    sheetError: c.sheetError || null,
    coverUrl: url(best?.workId || best?.assetId) || sheet?.url || null,
    coverage: { percent: cov.percent, missing: cov.missing },
    processing: [...(processing.get(c.id)?.values() || [])],
    videos: c.videos || [],
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export const list = () => Object.values(db).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).map(hydrate);

/* ------------------------------------------------------------------ CRUD */

function voiceOf(v) {
  if (v === null || v === '' || v === false) return null;
  if (typeof v === 'string') return { provider: 'eleven', voiceId: v.replace(/^el:/, '') };
  if (v && typeof v === 'object' && v.voiceId) return { provider: v.provider || 'eleven', voiceId: String(v.voiceId), ...(v.name ? { name: String(v.name).slice(0, 80) } : {}) };
  throw fail(400, 'voice must be { provider: "eleven", voiceId } or null');
}

export async function create(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw fail(400, 'name required');
  const c = {
    id: uid('ch_'), name: name.slice(0, 80), description: String(body.description || '').slice(0, 2000), lookNotes: String(body.lookNotes || '').slice(0, 1000),
    voice: body.voice !== undefined ? voiceOf(body.voice) : null, realPerson: body.realPerson !== false, refs: [], sheet: null, videos: [], createdAt: now(), updatedAt: now(),
  };
  db[c.id] = c;
  await save();
  return hydrate(c);
}

export async function update(id, body = {}) {
  const c = must(id);
  if ('name' in body) { const n = String(body.name || '').trim(); if (!n) throw fail(400, 'name cannot be empty'); c.name = n.slice(0, 80); }
  if ('description' in body) c.description = String(body.description || '').slice(0, 2000);
  if ('lookNotes' in body) c.lookNotes = String(body.lookNotes || '').slice(0, 1000);
  if ('voice' in body) c.voice = voiceOf(body.voice);
  if ('realPerson' in body) c.realPerson = body.realPerson !== false; // false = fictional / AI-generated person
  touch(c);
  await saveQ;
  return hydrate(c);
}

export async function remove(id) {
  must(id);
  delete db[id];
  processing.delete(id);
  await save();
  return { ok: true };
}

/* ------------------------------------------------------------------ references */

function applyGrade(r, vision) {
  if (vision) {
    Object.assign(r, {
      angle: r.manual && r.angle !== 'unknown' ? r.angle : vision.angle, expression: r.manualExpression ? r.expression : vision.expression,
      expressionLabel: vision.expressionLabel, framing: vision.framing, cameraHeight: vision.cameraHeight, facialHair: vision.facialHair,
      vision, graded: true,
    });
  }
  r.quality = cr.qualityScore({ sharp: r.sharp, width: r.width, height: r.height, vision: r.vision || null });
}

async function gradeRef(cid, assetId) {
  const c = getCharacter(cid);
  const r = c?.refs.find((x) => x.assetId === assetId);
  if (!r) return;
  try {
    if (!cv.visionBackend()) throw Object.assign(new Error('Angle and expression not detected — add a Gemini API key in Providers (or set the angle yourself)'), { soft: true });
    const g = await cv.gradeImage(assetPath(getAsset(r.workId || r.assetId)));
    const cur = getCharacter(cid)?.refs.find((x) => x.assetId === assetId);
    if (!cur) return;
    applyGrade(cur, g.vision);
    Object.assign(cur, { status: 'ready', error: null, gradedBy: `${g.backend}:${g.model}` });
  } catch (e) {
    const cur = getCharacter(cid)?.refs.find((x) => x.assetId === assetId);
    if (!cur) return;
    applyGrade(cur, null);
    Object.assign(cur, { status: 'ready', error: e.soft ? e.message : `Grading failed: ${e.message.slice(0, 200)}` });
  }
  const cc = getCharacter(cid);
  if (cc) touch(cc);
}

/** Normalise + measure one still and attach it. Returns the ref, or { skipped } for a duplicate. */
async function addPhoto(c, a, { kind = 'photo', extra = {}, vision = null } = {}) {
  let workId = a.id;
  if (kind === 'photo') {
    const out = newAssetPath('image/jpeg');
    await cv.normalizeImage(assetPath(a), out.abs);
    workId = (await addAsset({ ...out, mime: 'image/jpeg', meta: { source: 'character-ref', hidden: true, characterId: c.id, originalId: a.id } })).id;
  }
  const m = await cv.measureImage(assetPath(getAsset(workId)));
  const dup = c.refs.find((r) => r.kind !== 'sheet' && cr.hamming(r.hash, m.hash) <= cr.DUPLICATE);
  if (dup) return { skipped: { assetId: a.id, reason: `duplicate of ${dup.assetId}` } };
  const r = { assetId: a.id, workId, kind, angle: 'unknown', expression: null, status: vision || kind === 'video-frame' ? 'ready' : 'analyzing', sharp: m.sharp, blur: m.blur, hash: m.hash, width: m.width, height: m.height, addedAt: now(), ...extra };
  applyGrade(r, vision);
  c.refs.push(r);
  touch(c);
  return r;
}

/** Cut a head-turn / phone video into its best distinct frames (≈6 fps → sharpness → dedupe → vision → best per angle). */
async function addVideo(cid, a) {
  const dir = path.join(TMP, uid('frames_'));
  const step = (message) => setProgress(cid, a.id, { kind: 'video', message });
  try {
    step('Extracting frames');
    const frames = await cv.extractFrames(assetPath(a), dir, { fps: 6, maxSeconds: 60 });
    if (!frames.length) throw new Error('no frames could be read from this video');
    const graded = !!cv.visionBackend();
    const cands = cr.selectFrameCandidates(frames, { max: graded ? 12 : 8, minGap: graded ? 0.6 : 1.5 });
    step(`Grading ${cands.length} of ${frames.length} frames`);
    let done = 0;
    const results = await cv.pool(cands, 4, async (f) => {
      const { width, height } = await cv.dims(f.file);
      let vision = null;
      if (graded) {
        try { vision = (await cv.gradeImage(f.file)).vision; } catch (e) { console.warn('frame grade', e.message); }
        step(`Grading frames ${++done}/${cands.length}`);
      }
      const r = { ...f, width, height, vision, angle: vision?.angle || 'unknown', expression: vision?.expression || 'neutral' };
      r.quality = cr.qualityScore({ sharp: f.sharp, width, height, vision });
      return r;
    });
    const keep = graded ? cr.finalizeFrames(results, { max: 6 }) : results.filter((r) => r.quality.score >= 45).sort((x, y) => y.quality.score - x.quality.score).slice(0, 4);
    step(`Keeping ${keep.length} frames`);
    let kept = 0;
    for (const f of keep) {
      const c = getCharacter(cid);
      if (!c) return;
      const fa = await addAsset({ buffer: await fsp.readFile(f.file), mime: 'image/jpeg', meta: { source: 'character-frame', hidden: true, characterId: cid, sourceAssetId: a.id, t: f.t } });
      const r = await addPhoto(c, fa, { kind: 'video-frame', vision: f.vision, extra: { sourceAssetId: a.id, t: f.t, graded: !!f.vision, error: graded ? null : 'Angle not detected — add a Gemini API key in Providers (or set the angle yourself)' } });
      if (!r.skipped) kept++;
    }
    const c = getCharacter(cid);
    if (c) { c.videos = [...(c.videos || []), { assetId: a.id, url: a.url, frames: frames.length, graded: results.length, kept, at: now() }].slice(-20); touch(c); }
  } catch (e) {
    const c = getCharacter(cid);
    if (c) { c.videos = [...(c.videos || []), { assetId: a.id, url: a.url, error: e.message.slice(0, 300), at: now() }].slice(-20); touch(c); }
  } finally {
    setProgress(cid, a.id, null);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const track = (cid, p) => {
  if (!pending.has(cid)) pending.set(cid, new Set());
  const s = pending.get(cid);
  s.add(p);
  p.finally(() => s.delete(p));
  return p;
};

/** POST /characters/:id/refs { assetIds, wait } — photos are graded in the background, videos cut into frames. */
export async function addRefs(id, { assetIds, wait } = {}) {
  const c = must(id);
  const ids = [...new Set([].concat(assetIds || []).filter(Boolean).map(String))].slice(0, 40);
  if (!ids.length) throw fail(400, 'assetIds required');
  const assets = ids.map((aid) => {
    const a = getAsset(aid);
    if (!a) throw fail(400, `asset ${aid} not found — upload it first (POST /upload)`);
    if (!['image', 'video'].includes(a.kind)) throw fail(400, `asset ${aid} is ${a.kind}; send photos or videos`);
    return a;
  });
  const skipped = [];
  for (const a of assets) {
    if (c.refs.some((r) => r.assetId === a.id) || processing.get(id)?.has(a.id)) { skipped.push({ assetId: a.id, reason: 'already added' }); continue; }
    if (a.kind === 'video') {
      setProgress(id, a.id, { kind: 'video', message: 'Queued' });
      track(id, addVideo(id, a));
      continue;
    }
    try {
      const r = await addPhoto(c, a);
      if (r.skipped) { skipped.push(r.skipped); continue; }
      track(id, gradeRef(id, a.id));
    } catch (e) {
      skipped.push({ assetId: a.id, reason: `could not read image: ${e.message.slice(0, 160)}` });
    }
  }
  if (wait) await Promise.allSettled([...(pending.get(id) || [])]);
  await saveQ;
  return { ...hydrate(must(id)), skipped };
}

export async function removeRef(id, assetId) {
  const c = must(id);
  const r = c.refs.find((x) => x.assetId === assetId);
  if (!r) throw fail(404, 'reference not found');
  c.refs = c.refs.filter((x) => x !== r);
  if (r.kind === 'sheet' && c.sheet?.assetId === assetId) c.sheet.approved = false;
  touch(c);
  await saveQ;
  return hydrate(c);
}

const ANGLE_SET = ['front', 'threeQuarterLeft', 'threeQuarterRight', 'profileLeft', 'profileRight', 'back', 'unknown'];
const EXPR_SET = ['neutral', 'smile-teeth', 'smile-closed', 'laugh', 'other'];

/** Correct the detected angle / expression / framing by hand. */
export async function updateRef(id, assetId, body = {}) {
  const c = must(id);
  const r = c.refs.find((x) => x.assetId === assetId);
  if (!r) throw fail(404, 'reference not found');
  if ('angle' in body) { if (!ANGLE_SET.includes(body.angle)) throw fail(400, `angle must be one of ${ANGLE_SET.join(', ')}`); r.angle = body.angle; r.manual = true; }
  if ('expression' in body) { if (!EXPR_SET.includes(body.expression)) throw fail(400, `expression must be one of ${EXPR_SET.join(', ')}`); r.expression = body.expression; r.manualExpression = true; }
  if ('framing' in body && ['face-closeup', 'head-and-shoulders', 'waist-up', 'full-body'].includes(body.framing)) r.framing = body.framing;
  if ('cameraHeight' in body && ['eye-level', 'below-eye-level', 'above-eye-level'].includes(body.cameraHeight)) r.cameraHeight = body.cameraHeight;
  if (r.status === 'analyzing' && r.manual) r.status = 'ready';
  touch(c);
  await saveQ;
  return hydrate(c);
}

/** Re-run the vision grade on refs that never got one (e.g. a key was added later). */
export async function regrade(id, { all = false, wait = false } = {}) {
  const c = must(id);
  for (const r of c.refs) {
    if (r.kind === 'sheet' || (!all && r.graded)) continue;
    r.status = 'analyzing';
    track(id, gradeRef(id, r.assetId));
  }
  touch(c);
  if (wait) await Promise.allSettled([...(pending.get(id) || [])]);
  return hydrate(must(id));
}

export function coverageOf(id) {
  const c = must(id);
  const cov = cr.coverage(c.refs);
  return { ...cov, labels: cr.SLOT_LABEL, slotTips: cr.SLOT_TIP, guide: cr.PHOTO_GUIDE };
}

/* ------------------------------------------------------------------ model sheet */

const SHEET_MODELS = ['google/gemini-3-pro-image', 'google/gemini-nano-banana-2.1', 'xai/grok-imagine-image-2.0', 'kie/nano-banana-2'];
const KEYFRAME_MODELS = ['google/gemini-nano-banana-2.1', 'google/gemini-3-pro-image', 'xai/grok-imagine-image-2.0', 'kie/nano-banana-2', 'fal/kontext-dev'];

function firstAvailable(ids, wanted) {
  const avail = availableProviders();
  if (wanted) {
    const m = getModel(String(wanted).replace(/^engine:/, ''));
    if (!m || m.kind !== 'image') throw fail(400, `unknown image model ${wanted}`);
    if (!avail[m.provider]) throw fail(400, `${m.label} is not connected — open Providers`);
    return m;
  }
  return ids.map(getModel).find((m) => m && avail[m.provider]) || null;
}

export function sheetPrompt(c, refs) {
  const photos = refs.filter((r) => r.kind !== 'sheet');
  const sheetIdx = refs.findIndex((r) => r.kind === 'sheet');
  const label = photos.map((r, i) => `image ${refs.indexOf(r) + 1}${(() => { const d = [{ front: 'front', threeQuarterLeft: 'three-quarter', threeQuarterRight: 'three-quarter', profileLeft: 'profile', profileRight: 'profile' }[r.angle], ['smile-teeth', 'laugh'].includes(r.expression) ? 'smiling' : null, r.framing === 'full-body' || r.framing === 'waist-up' ? r.framing.replace('-', ' ') : null].filter(Boolean).join(', '); return d ? ` (${d})` : ''; })()}`).join('; ');
  return [
    `Create a professional character turnaround / model sheet of ${c.name}, the real person shown in the reference photos: ${label}.`,
    sheetIdx >= 0 ? ` Image ${sheetIdx + 1} is a model sheet of ${c.name} that was approved earlier — match its likeness and layout.` : '',
    `\nLayout: one wide image, plain light-grey seamless studio background, four views of the same person side by side at the same scale: `,
    '1) head-and-shoulders front view, neutral expression, looking straight into the lens at eye level; 2) head-and-shoulders three-quarter view (about 45°); 3) head-and-shoulders side profile (90°); 4) full-body front view, standing relaxed, arms at the sides, feet visible.',
    ' Each head-and-shoulders view is a normal photographic crop that runs off the bottom edge of the frame at mid-chest — no floating cut-out busts.',
    '\nLighting: soft, even, neutral-white studio light; no colour grading, no dramatic shadows, no rim light.',
    `\nIdentity: this must be unmistakably the same real person as in the photos — keep face shape, eyes and eye colour, eyebrows, nose, mouth, ears, hairline, hairstyle, beard/stubble pattern, skin tone and texture, marks and natural asymmetries. Photorealistic, natural skin texture with pores, real proportions. Do NOT beautify, airbrush, smooth the skin, slim, de-age, idealise or change ethnicity. Do not copy lens distortion from close selfies — show true proportions as an 85 mm portrait lens would.`,
    c.lookNotes ? `\nRequested look adjustment (apply subtly, identity stays the same): ${c.lookNotes}.` : '',
    c.description ? `\nCharacter notes: ${c.description}.` : '',
    '\nWardrobe: simple, plain, well-fitting everyday clothes, identical in all four views.',
    '\nNo text, labels, captions, numbers, borders or watermarks.',
  ].join('');
}

/** POST /characters/:id/sheet → { jobId }. Poll /jobs/:id; the sheet lands on the character unapproved. */
export function startSheet(id, body = {}) {
  const c = must(id);
  const m = firstAvailable(SHEET_MODELS, body.model);
  if (!m) throw fail(400, 'no image model with reference support is connected — add a Gemini API key (Nano Banana Pro)');
  const photos = cr.pickRefs(c, Math.min(m.refs ?? 6, 6), { includeSheet: false });
  if (!photos.length) throw fail(400, 'add at least one usable photo first');
  if (c.sheetJob && jobs.getJob(c.sheetJob.jobId)?.status === 'running') return { jobId: c.sheetJob.jobId };
  const approved = c.refs.find((r) => r.kind === 'sheet');
  const refs = approved && body.useApproved !== false ? [...photos.slice(0, Math.min(m.refs ?? 6, 6) - 1), { ...approved, id: approved.assetId }] : photos;
  const prompt = sheetPrompt(c, refs);
  const job = jobs.startTask(m.id, async (ctx) => {
    try {
      ctx.onStatus({ message: `Model sheet · ${m.label}` });
      const r = await generate({ model: m.id, prompt, refs: refs.map((x) => x.id), aspect: body.aspect || '16:9' }, ctx);
      updateAsset(r.asset.id, { source: 'character-sheet', characterId: id });
      const cur = getCharacter(id);
      if (cur) {
        cur.sheet = { assetId: r.asset.id, approved: false, createdAt: now(), model: m.id, prompt, refs: refs.map((x) => x.assetId) };
        cur.sheetJob = null;
        cur.sheetError = null;
        touch(cur);
      }
      return { asset: getAsset(r.asset.id) };
    } catch (e) {
      const cur = getCharacter(id);
      if (cur) { cur.sheetJob = null; cur.sheetError = e.message.slice(0, 400); touch(cur); }
      throw e;
    }
  });
  c.sheetJob = { jobId: job.id, model: m.id, startedAt: now() };
  c.sheetError = null;
  touch(c);
  return { jobId: job.id };
}

/** POST /characters/:id/sheet/approve { approved = true } — an approved sheet is the first reference everywhere. */
export async function approveSheet(id, body = {}) {
  const c = must(id);
  if (!c.sheet) throw fail(400, 'generate a sheet first');
  const approved = body.approved !== false;
  c.refs = c.refs.filter((r) => r.kind !== 'sheet');
  c.sheet.approved = approved;
  if (approved) {
    const a = getAsset(c.sheet.assetId);
    if (!a) throw fail(410, 'the sheet image is gone — generate a new one');
    const m = await cv.measureImage(assetPath(a)).catch(() => ({}));
    c.refs.unshift({ assetId: a.id, workId: a.id, kind: 'sheet', angle: 'turnaround', expression: 'neutral', status: 'ready', sharp: m.sharp ?? 1, hash: m.hash || null, width: m.width, height: m.height, quality: { score: 100, sharp: m.sharp ?? 1, issues: [], flags: [] }, graded: true, addedAt: now() });
  }
  touch(c);
  await saveQ;
  return hydrate(c);
}

/* ------------------------------------------------------------------ resolving + routing */

const refIdsOf = (c) => [...new Set([...(c.refAssetIds || []), c.refAssetId].filter(Boolean))];

/** Characters given as ids, { characterId } entries, or inline { name, description, refAssetId(s) }. */
export function resolveCharacters(list, { strict = true } = {}) {
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  const out = [];
  for (const x of arr) {
    const id = typeof x === 'string' ? x : x?.characterId || (x?.id && db[x.id] ? x.id : null);
    if (id) {
      const c = getCharacter(id);
      if (!c) {
        if (strict && typeof x === 'string') throw fail(400, `character ${id} not found`);
        if (x && typeof x === 'object' && (x.name || refIdsOf(x).length)) out.push({ name: x.name, description: x.description, refAssetIds: refIdsOf(x) });
        continue;
      }
      out.push({ characterId: c.id, name: (typeof x === 'object' && x.name) || c.name, description: (typeof x === 'object' && x.description) || c.description, lookNotes: c.lookNotes, refs: c.refs, sheet: c.sheet, voice: c.voice, realPerson: c.realPerson !== false });
    } else if (x && typeof x === 'object') {
      out.push({ name: x.name, description: x.description, refAssetIds: refIdsOf(x) });
    }
  }
  return out;
}

/** Long-form: resolve brief.characters (old inline entries keep working) for the director and keyframes. */
export function resolveBriefCharacters(list) {
  return resolveCharacters(list, { strict: false }).map((c) => ({
    ...c,
    refAssetIds: c.refs ? cr.pickRefs(c, 6).map((r) => r.id) : c.refAssetIds,
  }));
}

/** A character voice reference → ElevenLabs voice id ('char:<id>' strings, { characterId }, or a character id). */
export function characterVoice(ref) {
  const id = typeof ref === 'string' ? ref.replace(/^char:/, '') : ref?.characterId;
  const v = getCharacter(id)?.voice;
  return v?.voiceId ? v : null;
}

// Identity lock. A first-frame-only model (one still → video) has to invent the face whenever the head turns or the
// take runs on, so a real person drifts into a stranger. For people built from real photos, prefer models that keep
// the references in view for the whole clip. Any catalog video model with caps.refs (its reference-to-video mode)
// qualifies, so new providers light up by themselves; this list only sets the order (catalog ids — HappyHorse and
// Wan 3.0 are single entries the provider switches to r2v when refs come without a start frame). Measured on one
// real-person test shot (profile → turn to camera): Veo 3.1 Fast ref 7.0/10 ($0.13 / 8 s), Kling 3.0 Omni ref 7.0
// ($0.32 / 5 s), Kling V4 ref 5.6 ($0.67 / 5 s), while first-frame Veo Fast / Quality drifted into another man (4.4 / 4.0).
export const IDENTITY_RANK = ['apimart/veo3.1-fast', 'qwen/happyhorse-1.1', 'apimart/kling-v3-omni', 'apimart/kling-v4', 'xai/grok-imagine-video-1.5', 'fal/wan-3.0', 'apimart/wan2.7-r2v', 'xai/grok-imagine-video'];
// Gemini Omni refuses real people's likeness outright (INVALID_ARGUMENT); anything else is better than failing.
const REAL_FACE_FALLBACK = ['apimart/veo3.1-quality', 'apimart/kling-v3', 'apimart/seedance-2.5', 'apimart/seedance-2.0'];
// Gemini Omni under any provider (Gemini API, Venice, ApiMart…) — refused real likeness on the Gemini API; assume the same.
const refusesReal = (m) => !!m?.caps?.noRealPeople || /gemini-omni|omni-flash/.test(m?.id || '');

/** True when any character is a real person with photo references (fictional characters can opt out). */
// Only refs that pickRefs would actually send count — a cast whose photos were all graded unusable has nothing to lock to.
const usableRef = (r) => r.kind !== 'sheet' && r.status !== 'error' && !(r.quality?.flags || []).includes('no-face');
export const isRealCast = (chars) => chars.some((c) => c.realPerson !== false && ((c.refs || []).some(usableRef) || (c.refAssetIds || []).length));
/** Can model m hold these characters' identity through reference images? (Seedance blocks real faces as refs.) */
export const refsOk = (m, chars) => !!m?.caps?.refs && !(isRealCast(chars) && (m.caps.refsRealPeople === false || refusesReal(m)));

/** Connected video models that take the cast's references, best first. withImage: must also accept a first frame. */
export function identityModels(chars, { withImage = false } = {}) {
  const avail = availableProviders();
  const rank = (x) => { const i = IDENTITY_RANK.indexOf(x.id); return i < 0 ? IDENTITY_RANK.length : i; };
  return allModels().filter((x) => x.kind === 'video' && avail[x.provider] && refsOk(x, chars) && (!withImage || x.caps.refsWithImage)).sort((a, b) => rank(a) - rank(b));
}

/** The model to use instead of m for these characters + why, or null when m is fine. */
export function characterFallback(m, chars, { identityLock = true, hasImage = false } = {}) {
  if (m?.kind !== 'video' || !isRealCast(chars)) return null;
  const holds = refsOk(m, chars) && (!hasImage || m.caps.refsWithImage);
  if (refusesReal(m)) {
    const avail = availableProviders();
    const alt = [...identityModels(chars, { withImage: hasImage }), ...identityModels(chars), ...REAL_FACE_FALLBACK.map(getModel).filter((x) => x && avail[x.provider])][0] || null;
    const reason = `${m.label} refuses to animate real people's likeness`;
    return { model: alt, reason: alt ? `${reason} — using ${alt.label} instead` : `${reason} — connect ApiMart (Veo 3.1, Kling) or xAI for character shots` };
  }
  if (identityLock && !holds) {
    const alt = identityModels(chars, { withImage: hasImage })[0];
    if (alt && alt.id !== m.id) return { model: alt, reason: `Identity lock: ${m.label} ${m.caps?.refs ? 'cannot use these references' : 'only animates a still, so the face drifts when the head turns'} — using ${alt.label} with ${hasImage ? 'your frame + ' : ''}character references` };
  }
  return null;
}

const names = (chars) => chars.map((c) => c.name).filter(Boolean).join(' and ') || 'the character';
// No staging rules are injected into prompts: anything prepended pulls the whole shot toward it. The keyframe already
// shows the face; identity lock routes real people to reference-mode models so they can move naturally.

/**
 * Rewrite a generate() job that names characters into what the model can actually take:
 *   identity lock → swap a first-frame-only model for a reference-to-video model when the cast is real;
 *   image models → labelled reference images; video models with a reference mode → reference-to-video
 *   (plus the start frame where the model takes both); first-frame models → a keyframe from the refs, then animate
 *   it; anything else → a description line.
 * The returned job carries qaChars so generate() can run the likeness check on the result.
 */
export async function applyCharacters(job, m, { onStatus, signal } = {}) {
  const chars = resolveCharacters(job.characters);
  const ids = chars.map((c) => c.characterId).filter(Boolean);
  const base = { ...job, characters: undefined, characterIds: ids, qaChars: chars };
  if (!chars.length) return base;
  const prompt = String(job.prompt || '');
  if (m.kind === 'video') {
    const fb = characterFallback(m, chars, { identityLock: job.identityLock !== false, hasImage: !!job.image });
    if (fb) {
      if (!fb.model) throw fail(400, fb.reason);
      onStatus?.({ message: fb.reason });
      return { ...job, model: fb.model.id, characterNote: fb.reason };
    }
  }
  const route = cr.routeFor(m.kind === 'image' || refsOk(m, chars) ? m : { ...m, caps: { ...m.caps, refs: 0 } }, { hasImage: !!job.image });
  if (route === 'image-refs') {
    const slots = Math.max(0, (m.refs ?? 0) - (job.image ? 1 : 0));
    const user = job.refs || [];
    const limit = Math.max(Math.min(chars.length, slots), slots - user.length);
    const plan = cr.planRefs(chars, { limit, offset: job.image ? 1 : 0, tag: 'plain' });
    return { ...base, refs: [...plan.refs, ...user].slice(0, slots), prompt: plan.guide + prompt, routeNote: `${plan.refs.length} character reference${plan.refs.length === 1 ? '' : 's'}` };
  }
  if (route === 'video-refs') {
    const c = m.caps;
    const plan = cr.planRefs(chars, { limit: c.refs - (job.image && m.id === 'apimart/wan2.7-r2v' ? 1 : 0), offset: job.image && c.refTag === 'xai' ? 1 : 0, tag: cr.tagFor(m) });
    if (plan.refs.length) {
      onStatus?.({ message: `Reference-to-video · ${plan.refs.length} refs${job.image ? ' + start frame' : ''}` });
      return { ...base, refs: plan.refs, refMode: true, prompt: plan.guide + prompt, routeNote: `reference mode, ${plan.refs.length} refs${job.image ? ' + frame' : ''}` };
    }
  }
  if (route === 'keyframe' || (route === 'video-refs' && !job.image && m.caps?.i2v)) {
    const im = firstAvailable(KEYFRAME_MODELS, job.keyframeModel);
    const anyRefs = chars.some((c) => (c.refs || []).length || (c.refAssetIds || []).length);
    if (im && anyRefs) {
      onStatus?.({ message: `Keyframe from character refs · ${im.label}` });
      const aspect = job.aspect || '16:9';
      const kf = await generate({ model: im.id, prompt: `Cinematic film still, ${aspect} frame, photorealistic. Show ${names(chars)}'s face clearly and in focus, from the angle the shot mostly holds. ${prompt}`, characters: job.characters, aspect }, { onStatus, signal });
      updateAsset(kf.asset.id, { source: 'character-keyframe' });
      return { ...base, image: kf.asset.id, keyframeId: kf.asset.id, prompt: cr.textGuide(chars) + prompt, routeNote: `keyframe ${kf.asset.id}` };
    }
  }
  return { ...base, prompt: cr.textGuide(chars) + prompt, routeNote: 'description only' };
}

/** POST /likeness { assetId, characters: [id], every, threshold } — score any clip against characters. */
export async function likenessOf(body = {}) {
  const a = getAsset(body.assetId) || assetFromUrl(body.url);
  if (!a || a.kind !== 'video') throw fail(400, 'assetId of a video required');
  const chars = resolveCharacters(body.characters?.length ? body.characters : a.characters || []);
  if (!chars.length) throw fail(400, 'characters required');
  const r = await checkLikeness({ video: assetPath(a), characters: chars, every: Number(body.every) || 0.5, threshold: Number(body.threshold) || undefined });
  updateAsset(a.id, { likeness: r });
  return r;
}

/* ------------------------------------------------------------------ HTTP */

export function characterRoutes(route) {
  route('GET', '/characters', () => list());
  route('POST', '/characters', ({ body }) => create(body));
  route('GET', '/characters/:id', ({ params }) => hydrate(must(params.id)));
  route('PATCH', '/characters/:id', ({ params, body }) => update(params.id, body));
  route('DELETE', '/characters/:id', ({ params }) => remove(params.id));
  route('POST', '/characters/:id/refs', ({ params, body, url: u }) => addRefs(params.id, { ...body, wait: body.wait || u.searchParams.has('wait') }));
  route('PATCH', '/characters/:id/refs/:assetId', ({ params, body }) => updateRef(params.id, params.assetId, body));
  route('DELETE', '/characters/:id/refs/:assetId', ({ params }) => removeRef(params.id, params.assetId));
  route('POST', '/characters/:id/analyze', ({ params, body, url: u }) => regrade(params.id, { all: !!body.all, wait: body.wait || u.searchParams.has('wait') }));
  route('GET', '/characters/:id/coverage', ({ params }) => coverageOf(params.id));
  route('POST', '/characters/:id/sheet', ({ params, body }) => startSheet(params.id, body));
  route('POST', '/characters/:id/sheet/approve', ({ params, body }) => approveSheet(params.id, body));
  route('POST', '/likeness', ({ body }) => likenessOf(body));
}
