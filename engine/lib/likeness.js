// Likeness QA: does a rendered clip still show the character? Frames are sampled every ~0.5 s; a fast vision model
// finds the head in every frame and reference, and a stronger one judges the face crops against the references on
// bone structure (generated faces keep the hair, beard and clothes while turning into someone else — exactly the
// drift whole-frame scoring misses). One character per shot uses crops; ensembles fall back to whole frames.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA, uid, now, getAsset, assetPath } from './store.js';
import * as cv from './charvision.js';
import { pickRefs } from './charref.js';

export const LIKENESS_THRESHOLD = 6;
const JUDGE = () => process.env.LIKENESS_MODEL || 'gemini-3.1-pro-preview';
const DETECT = () => process.env.LIKENESS_DETECT_MODEL || 'gemini-flash-latest';

const RUBRIC = `Generated faces often keep the person's hair, beard and clothes but turn into a different person. Ignore hair styling, beard grooming, clothes, lighting, expression, skin smoothing and image quality.
Judge bone structure and features: face length vs width, forehead, brow ridge, eye shape and spacing, nose bridge and tip, cheekbones, mouth, jaw and chin, ears.
Score 0-10: 10 = certainly the same person, 7 = probably them, 5 = cannot tell, 3 = probably a different person, 0 = certainly someone else.`;

const CROP_PROMPT = (name, n) => `Face-identity check for an AI film. R-images are real references of ${name}. F1-F${n} are face crops from an AI-generated clip that should show the SAME person.
${RUBRIC}
For each crop give "verdict": "same" | "different" | "unsure", and "score".
Reply ONLY JSON: {"frames":[{"frame":1,"verdict":"same","score":8,"why":"max 8 words"}]}`;

const FRAME_PROMPT = (names, first) => `Face-identity check for an AI film. The reference photos show the real ${names.length > 1 ? 'people' : 'person'} ${names.join(' and ')}.
For EVERY frame and EVERY listed person: ${RUBRIC}
If the person's face is not in the frame, turned fully away, or too small or blurred to judge, set "visible": false and "score": null.
Reply ONLY JSON: {"frames":[{"frame":1,"faces":[{"character":"${first}","visible":true,"score":8,"note":"max 8 words"}]}]}`;

const round = (n) => Math.round(n * 10) / 10;

/** Pure: per-frame faces → summary. frames: [{ t, faces: [{ character, visible, score, note }] }] */
export function summarize(frames, { threshold = LIKENESS_THRESHOLD } = {}) {
  const per = {};
  const rows = frames.map((f) => {
    const seen = (f.faces || []).filter((x) => x.visible && Number.isFinite(x.score));
    for (const x of seen) {
      const p = (per[x.character] ||= { scores: [], min: Infinity, minAt: null });
      p.scores.push(x.score);
      if (x.score < p.min) { p.min = x.score; p.minAt = f.t; }
    }
    const worst = seen.reduce((a, x) => (!a || x.score < a.score ? x : a), null);
    return { t: f.t, score: worst ? worst.score : null, visible: !!worst, character: worst?.character || null, verdict: worst?.verdict || null, note: worst?.note || '' };
  });
  const vis = rows.filter((r) => r.visible);
  const min = vis.reduce((a, r) => (a == null || r.score < a.score ? r : a), null);
  const perCharacter = Object.fromEntries(Object.entries(per).map(([k, p]) => [k, { avg: round(p.scores.reduce((a, b) => a + b, 0) / p.scores.length), min: p.min, minAt: p.minAt, frames: p.scores.length }]));
  return {
    score: vis.length ? round(vis.reduce((a, r) => a + r.score, 0) / vis.length) : null,
    min: min ? min.score : null,
    minAt: min ? min.t : null,
    pass: vis.length ? min.score >= threshold : null,
    threshold,
    flagged: vis.filter((r) => r.score < threshold).map((r) => ({ t: r.t, score: r.score, character: r.character, note: r.note })),
    visibleFrames: vis.length,
    perCharacter,
    frames: rows,
  };
}

/** Normalise detector output to [ymin, xmin, ymax, xmax] (0–1000) or null. */
export function normBox(b) {
  let v = Array.isArray(b) ? b : b?.box_2d || b?.box || null;
  while (Array.isArray(v) && v.length === 1 && Array.isArray(v[0])) v = v[0];
  return Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) && v[2] > v[0] && v[3] > v[1] ? v : null;
}

const img = async (file, side, signal) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await cv.smallJpeg(file, signal, side)}` } });

async function detectHeads(files, signal) {
  const content = [{ type: 'text', text: 'For each image, give the bounding box of the main person\'s HEAD (hair to chin, ears included) as [ymin, xmin, ymax, xmax] on a 0-1000 scale, or null if no face is visible. Reply ONLY JSON {"boxes":[...]} with one entry per image, in order.' }];
  for (const f of files) content.push(await img(f, 768, signal));
  const { json } = await cv.visionJSON(content, { signal, model: DETECT() });
  const list = json.boxes || [];
  return files.map((_, i) => normBox(list[i]));
}

/** Reference images for a character: approved sheet's front panel first, then the best real photos. */
async function refFiles(c, dir, signal) {
  if (!c.refs) return (c.refAssetIds || []).map(getAsset).filter(Boolean).slice(0, 3).map(assetPath);
  const out = [];
  const sheet = c.refs.find((r) => r.kind === 'sheet');
  if (sheet && getAsset(sheet.assetId)) out.push(await cv.cropFraction(assetPath(getAsset(sheet.assetId)), path.join(dir, 'sheet_front.jpg'), { x0: 0, w: 0.25, signal }));
  for (const r of pickRefs(c, 3, { includeSheet: false })) if (getAsset(r.id) && out.length < 3) out.push(assetPath(getAsset(r.id)));
  return out;
}

/**
 * Score a clip against resolved characters ({ name, refs } from the store, or inline { name, refAssetIds }).
 * Returns summarize() output + { every, model, method, checkedAt }; throws if no vision model or no references.
 */
export async function checkLikeness({ video, characters, every = 0.5, maxFrames = 12, threshold = LIKENESS_THRESHOLD, signal }) {
  const cast = (characters || []).filter((c) => (c.refs || []).length || (c.refAssetIds || []).some((id) => getAsset(id)));
  if (!cast.length) throw new Error('no character references to compare against');
  const dir = path.join(DATA, 'tmp', uid('qa_'));
  await fsp.mkdir(dir, { recursive: true });
  try {
    const frames = await cv.sampleFrames(video, dir, { every, maxFrames, signal });
    if (!frames.length) throw new Error('could not read frames from the clip');
    const refs = await Promise.all(cast.map((c) => refFiles(c, dir, signal)));
    let rows;
    let method = 'frames';
    if (cast.length === 1) {
      // One character: judge head crops (references cropped the same way).
      const boxes = await detectHeads([...refs[0], ...frames.map((f) => f.file)], signal);
      const refCrops = [];
      for (const [i, f] of refs[0].entries()) if (boxes[i]) refCrops.push(await cv.cropBox(f, boxes[i], path.join(dir, `r${i}.jpg`), { signal }));
      const crops = [];
      for (const [k, f] of frames.entries()) { const b = boxes[refs[0].length + k]; crops.push(b ? await cv.cropBox(f.file, b, path.join(dir, `c${k}.jpg`), { signal }) : null); }
      const kept = crops.map((file, k) => ({ file, k })).filter((x) => x.file);
      if (refCrops.length && kept.length) {
        method = 'face-crops';
        const name = cast[0].name || 'the person';
        const content = [{ type: 'text', text: CROP_PROMPT(name, kept.length) }];
        for (const [i, r] of refCrops.entries()) { content.push({ type: 'text', text: `R${i + 1}:` }); content.push(await img(r, 384, signal)); }
        for (const [j, x] of kept.entries()) { content.push({ type: 'text', text: `F${j + 1} (t=${frames[x.k].t}s):` }); content.push(await img(x.file, 384, signal)); }
        const { json } = await cv.visionJSON(content, { signal, timeout: 240000, model: JUDGE() });
        const got = new Map((json.frames || []).map((f) => [Number(f.frame), f]));
        rows = frames.map((f, k) => {
          const j = kept.findIndex((x) => x.k === k);
          const g = j >= 0 ? got.get(j + 1) : null;
          const score = g && Number.isFinite(Number(g.score)) ? Math.max(0, Math.min(10, Number(g.score))) : null;
          return { t: f.t, faces: [{ character: name, visible: score != null, score, verdict: g?.verdict || null, note: String(g?.why || g?.note || '').slice(0, 80) }] };
        });
      }
    }
    if (!rows) {
      const names = cast.map((c) => c.name || 'the character');
      const content = [{ type: 'text', text: FRAME_PROMPT(names, names[0]) }];
      for (const [i, c] of cast.entries()) {
        content.push({ type: 'text', text: `REFERENCE photos of ${names[i]}:` });
        for (const f of refs[i]) content.push(await img(f, 768, signal));
      }
      content.push({ type: 'text', text: `FRAMES to check (${frames.length}, in time order):` });
      for (const [k, f] of frames.entries()) { content.push({ type: 'text', text: `Frame ${k + 1} (t=${f.t}s):` }); content.push(await img(f.file, 640, signal)); }
      const { json } = await cv.visionJSON(content, { signal, timeout: 240000, model: JUDGE() });
      const byFrame = new Map((json.frames || []).map((f) => [Number(f.frame), f]));
      rows = frames.map((f, k) => ({
        t: f.t,
        faces: (byFrame.get(k + 1)?.faces || []).map((x) => ({ character: String(x.character || names[0]), visible: x.visible !== false && x.score != null, score: x.score == null ? null : Math.max(0, Math.min(10, Number(x.score))), note: String(x.note || '').slice(0, 80) })),
      }));
    }
    return { ...summarize(rows, { threshold }), every: frames.length > 1 ? round(frames[1].t - frames[0].t) : every, method, model: `${JUDGE()} (heads: ${DETECT()})`, checkedAt: now() };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
