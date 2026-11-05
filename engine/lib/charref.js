// Character reference logic with no I/O: quality scoring, coverage against the photo spec,
// video-frame selection, and picking/labelling the best references for a given model.
// Everything here is pure so it can be unit-tested with fixtures (engine/test/characters.test.mjs).

/* ------------------------------------------------------------------ photo spec */

export const SLOTS = ['front', 'threeQuarterLeft', 'threeQuarterRight', 'profileLeft', 'profileRight', 'smile', 'expression', 'lowAngle', 'fullBody'];

export const SLOT_LABEL = {
  front: 'Front, neutral, eye level',
  threeQuarterLeft: '¾ view — one side',
  threeQuarterRight: '¾ view — other side',
  profileLeft: 'Profile — one side',
  profileRight: 'Profile — other side',
  smile: 'Real smile with teeth',
  expression: 'A characteristic expression',
  lowAngle: 'Slightly below eye level',
  fullBody: 'Waist-up or full body',
};

export const SLOT_TIP = {
  front: 'Front, neutral expression, camera at eye level, in daylight — the anchor photo every model leans on.',
  threeQuarterLeft: 'Three-quarter view (~45°) with your nose pointing toward one side of the frame.',
  threeQuarterRight: 'Three-quarter view (~45°) toward the other side.',
  profileLeft: 'Full side profile facing one way (ear toward the camera).',
  profileRight: 'Full side profile facing the other way.',
  smile: 'A real smile with teeth — think of something funny rather than posing a grin.',
  expression: 'One expression that is typically you: laughing, a raised eyebrow, a frown, mid-sentence…',
  lowAngle: 'Head-and-shoulders from slightly below eye level (camera around chest height, tilted up a little).',
  fullBody: 'Waist-up or full body so models learn your build and posture.',
};

/** General guidance, shown once (what Justin was told). */
export const PHOTO_GUIDE = [
  'Use the rear camera from 1.5–2 m away on the 2× lens. Front-camera selfies distort the nose and forehead.',
  'Sharp, evenly lit (window daylight or open shade), plain background.',
  'No filters, Portrait-mode smoothing, beauty mode or colour grading.',
  'Keep the same current hair and beard in every photo of the set.',
  'Optional: a 10–15 s tripod video slowly turning your head left → front → right; the best frames are picked automatically.',
];

/* ------------------------------------------------------------------ issues */

// code → [message, score multiplier]
export const ISSUES = {
  'no-face': ['No clear face found', 0.05],
  blur: ['Soft or motion-blurred', 1], // handled through the sharpness factor
  'eyes-closed': ['Eyes closed', 0.55],
  'small-face': ['Face small in frame — move closer or use the 2× lens', 0.7],
  'selfie-distortion': ['Close selfie: wide-lens distortion — use the rear 2× lens at 1.5–2 m', 0.72],
  filter: ['Filter or skin smoothing', 0.6],
  grading: ['Colour grade or tint', 0.85],
  'harsh-light': ['Harsh or mixed light', 0.85],
  backlit: ['Backlit — face in shadow', 0.75],
  dim: ['Too dark / noisy', 0.75],
  sunglasses: ['Sunglasses hide the eyes', 0.45],
  hat: ['Hat hides the hairline', 0.8],
  glasses: ['Glasses — add some without', 0.92],
  hand: ['Hand covers the face', 0.7],
  hair: ['Hair covers the face', 0.88],
  mask: ['Face partly covered', 0.4],
  'multiple-people': ['More than one person', 0.7],
  'low-res': ['Low resolution — use the original file', 0.8],
  'busy-background': ['Busy background', 0.97],
};
export const issueText = (code) => ISSUES[code]?.[0] || code;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** ffmpeg blurdetect value (frame scaled to ≤640 px) → sharpness 0..1. Calibrated on phone photos and frames. */
export const sharpFromBlur = (blur) => (Number.isFinite(blur) ? +clamp((10.5 - blur) / 5, 0, 1).toFixed(3) : null);

const ANGLES = {
  front: 'front', 'three-quarter-left': 'threeQuarterLeft', 'three-quarter-right': 'threeQuarterRight',
  'profile-left': 'profileLeft', 'profile-right': 'profileRight', back: 'back',
};
const pickEnum = (v, list, fallback) => (list.includes(v) ? v : fallback);

/** Normalise the vision model's JSON into the engine's ref analysis (tolerant of missing/odd fields). */
export function normalizeVision(v) {
  if (!v || typeof v !== 'object') return null;
  const str = (x) => String(x ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-');
  let angle = ANGLES[str(v.angle)] || null;
  const yaw = Number(v.yaw_degrees ?? v.yaw);
  if (!angle && Number.isFinite(yaw)) {
    const a = Math.abs(yaw);
    angle = a < 20 ? 'front' : a < 65 ? (yaw < 0 ? 'threeQuarterLeft' : 'threeQuarterRight') : (yaw < 0 ? 'profileLeft' : 'profileRight');
  }
  const occ = (Array.isArray(v.occlusion) ? v.occlusion : String(v.occlusion || '').split(',')).map(str).filter((o) => o && o !== 'none');
  return {
    faceVisible: v.face_visible !== false && v.faceVisible !== false,
    people: Number(v.people_count ?? v.people) || 1,
    angle: angle || 'unknown',
    yaw: Number.isFinite(yaw) ? Math.round(yaw) : null,
    cameraHeight: pickEnum(str(v.camera_height), ['eye-level', 'below-eye-level', 'above-eye-level'], 'eye-level'),
    framing: pickEnum(str(v.framing), ['face-closeup', 'head-and-shoulders', 'waist-up', 'full-body'], 'head-and-shoulders'),
    faceFraction: Number.isFinite(Number(v.face_height_fraction)) ? clamp(Number(v.face_height_fraction), 0, 1) : null,
    expression: pickEnum(str(v.expression), ['neutral', 'smile-teeth', 'smile-closed', 'laugh', 'other'], 'neutral'),
    expressionLabel: String(v.expression_label || '').slice(0, 60),
    eyesClosed: !!v.eyes_closed,
    sharpness: pickEnum(str(v.sharpness), ['sharp', 'slightly-soft', 'blurry'], 'sharp'),
    filter: !!(v.beauty_filter ?? v.filter),
    grading: !!(v.colour_grading ?? v.color_grading),
    distortion: !!(v.wide_lens_distortion ?? v.distortion),
    selfie: !!v.selfie,
    occlusion: [...new Set(occ.map((o) => (o === 'cap' ? 'hat' : o === 'mouth-cover' ? 'mask' : o)))].filter((o) => ['sunglasses', 'glasses', 'hat', 'hand', 'hair', 'mask'].includes(o)),
    lighting: pickEnum(str(v.lighting), ['even', 'harsh', 'backlit', 'dim', 'mixed-colour'], 'even'),
    background: pickEnum(str(v.background), ['plain', 'busy'], 'plain'),
    hair: String(v.hair || '').slice(0, 80),
    facialHair: pickEnum(str(v.facial_hair), ['clean-shaven', 'stubble', 'short-beard', 'full-beard', 'moustache', 'n/a'], 'n/a'),
    notes: String(v.notes || '').slice(0, 200),
  };
}

/**
 * Combine the ffmpeg sharpness and the vision analysis into { score 0–100, sharp 0–1, issues[], flags[] }.
 * m: { sharp (ffmpeg 0..1 | null), width, height, vision (normalizeVision output | null) }
 */
export function qualityScore({ sharp = null, width, height, vision = null } = {}) {
  const flags = [];
  const v = vision;
  const vSharp = v ? { sharp: 1, 'slightly-soft': 0.6, blurry: 0.2 }[v.sharpness] : null;
  const s = sharp != null && vSharp != null ? sharp * 0.55 + vSharp * 0.45 : (sharp ?? vSharp ?? 0.7);
  let score = 100 * (0.3 + 0.7 * s);
  if (s < 0.45) flags.push('blur');
  const short = Math.min(width || 0, height || 0);
  if (short && short < 700) flags.push('low-res');
  if (v) {
    if (!v.faceVisible) flags.push('no-face');
    if (v.people > 1) flags.push('multiple-people');
    if (v.eyesClosed) flags.push('eyes-closed');
    const faceSmall = v.faceFraction != null
      ? (v.framing === 'full-body' ? v.faceFraction < 0.06 : v.framing === 'waist-up' ? v.faceFraction < 0.12 : v.faceFraction < 0.2)
      : false;
    if (faceSmall) flags.push('small-face');
    if (v.distortion) flags.push('selfie-distortion');
    if (v.filter) flags.push('filter');
    if (v.grading) flags.push('grading');
    if (v.lighting === 'harsh' || v.lighting === 'mixed-colour') flags.push('harsh-light');
    if (v.lighting === 'backlit') flags.push('backlit');
    if (v.lighting === 'dim') flags.push('dim');
    for (const o of v.occlusion) flags.push(o);
    if (v.background === 'busy') flags.push('busy-background');
  }
  for (const f of flags) score *= ISSUES[f]?.[1] ?? 1;
  return { score: Math.round(clamp(score, 0, 100)), sharp: +s.toFixed(3), issues: flags.map(issueText), flags };
}

/* ------------------------------------------------------------------ coverage */

const expressionClass = (r) => (['smile-teeth', 'laugh'].includes(r.expression) ? 'smile' : r.expression === 'other' ? 'expression' : r.expression === 'smile-closed' ? 'smile-closed' : 'neutral');

/** Which spec slots a single analysed photo fills. */
export function slotsFor(r) {
  if (r.kind === 'sheet' || r.status !== 'ready' || (r.quality?.flags || []).includes('no-face')) return [];
  const out = [];
  const face = ['face-closeup', 'head-and-shoulders'].includes(r.framing);
  if (r.angle === 'front' && expressionClass(r) === 'neutral' && r.cameraHeight !== 'below-eye-level') out.push('front');
  if (['threeQuarterLeft', 'threeQuarterRight', 'profileLeft', 'profileRight'].includes(r.angle)) out.push(r.angle);
  if (['smile-teeth', 'laugh'].includes(r.expression)) out.push('smile');
  if (r.expression === 'other' || r.expression === 'laugh') out.push('expression');
  if (r.cameraHeight === 'below-eye-level' && (face || r.framing === 'waist-up')) out.push('lowAngle');
  if (['waist-up', 'full-body'].includes(r.framing)) out.push('fullBody');
  return out;
}

const USABLE = 35; // a ref below this score doesn't count toward coverage

/** { have:{slot:bool}, missing:[slot], tips:[string], slots:{slot:{assetId,score}|null}, percent } */
export function coverage(refs = []) {
  const slots = Object.fromEntries(SLOTS.map((k) => [k, null]));
  for (const r of refs) {
    const score = r.quality?.score ?? 0;
    if (score < USABLE) continue;
    for (const k of slotsFor(r)) if (!slots[k] || slots[k].score < score) slots[k] = { assetId: r.assetId, score };
  }
  const have = Object.fromEntries(SLOTS.map((k) => [k, !!slots[k]]));
  const missing = SLOTS.filter((k) => !have[k]);
  const tips = missing.map((k) => `${SLOT_LABEL[k]}: ${SLOT_TIP[k]}`);
  const photos = refs.filter((r) => r.kind !== 'sheet' && r.status === 'ready');
  const count = (f) => photos.filter((r) => (r.quality?.flags || []).includes(f)).length;
  if (count('selfie-distortion')) tips.push(`${count('selfie-distortion')} photo(s) look like front-camera selfies — retake with the rear camera from 1.5–2 m on the 2× lens; close selfies make the nose and forehead bigger.`);
  if (count('filter')) tips.push(`${count('filter')} photo(s) look filtered or smoothed — turn off beauty mode, filters and Portrait mode.`);
  if (count('blur')) tips.push(`${count('blur')} photo(s) are soft — hold still or lean on something; tap to focus on your eyes.`);
  if (count('harsh-light') + count('backlit') + count('dim')) tips.push('Use even light: face a window or stand in open shade; avoid overhead spotlights, backlight and mixed colours.');
  if (count('sunglasses') + count('hat')) tips.push('Take off sunglasses and hats for reference photos — models need your eyes and hairline.');
  const beards = new Set(photos.map((r) => r.facialHair).filter((f) => f && f !== 'n/a'));
  if (beards.size > 1) tips.push(`Your photos show different facial hair (${[...beards].join(' vs ')}) — keep one current look across the whole set.`);
  if (photos.length && photos.length < 4) tips.push('Aim for 6–10 good photos; a 10–15 s tripod head-turn video fills the angles quickly.');
  return { have, missing, tips, slots, percent: Math.round(((SLOTS.length - missing.length) / SLOTS.length) * 100) };
}

/* ------------------------------------------------------------------ dedupe + video frames */

/** Hamming distance between two 64-bit dHash hex strings (Infinity if either is missing). */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) { d += x & 1; x >>>= 1; }
  }
  return d;
}

/** dHash from a 9×8 grayscale buffer (72 bytes) → 16 hex chars. */
export function dhash(gray, offset = 0) {
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[offset + y * 9 + x] > gray[offset + y * 9 + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export const DUPLICATE = 5; // ≤ this many differing bits = same picture

/**
 * First pass over extracted video frames (before any vision call): sharpest first, skipping near-duplicates
 * and frames too close in time. frames: [{ i, t, sharp, hash }] → up to `max` candidates.
 */
export function selectFrameCandidates(frames, { max = 12, minGap = 0.6, minSharp = 0.25, dupBits = 10 } = {}) {
  const pool = frames.filter((f) => (f.sharp ?? 0) >= minSharp).sort((a, b) => b.sharp - a.sharp);
  const out = [];
  for (const f of pool) {
    if (out.length >= max) break;
    if (out.some((o) => Math.abs(o.t - f.t) < minGap || hamming(o.hash, f.hash) <= dupBits)) continue;
    out.push(f);
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Second pass after grading: keep the best frame per distinct angle × expression, unusable frames dropped.
 * graded: [{ ...frame, angle, expression, quality }] → up to `max`, best first.
 */
export function finalizeFrames(graded, { max = 6, minScore = 40 } = {}) {
  const ok = graded.filter((g) => (g.quality?.score ?? 0) >= minScore && !['no-face', 'eyes-closed', 'multiple-people'].some((f) => (g.quality?.flags || []).includes(f)));
  const best = new Map();
  for (const g of ok) {
    const key = `${g.angle || 'unknown'}|${expressionClass(g)}`;
    if (!best.has(key) || best.get(key).quality.score < g.quality.score) best.set(key, g);
  }
  return [...best.values()].sort((a, b) => b.quality.score - a.quality.score).slice(0, max);
}

/* ------------------------------------------------------------------ picking references */

const PRIORITY = ['front', 'threeQuarterLeft', 'threeQuarterRight', 'profileLeft', 'profileRight', 'smile', 'fullBody', 'expression', 'lowAngle'];
const refScore = (r) => (r.status === 'ready' ? r.quality?.score ?? 0 : Math.round(100 * (0.3 + 0.7 * (r.quality?.sharp ?? 0.6))) - 10);

/**
 * Best references for one character, up to `limit`: the approved sheet first, then the highest-quality photos
 * covering different angles/expressions, then the rest by score (near-duplicates skipped).
 * Returns ref objects (with .id = the asset to send: the normalised working copy when there is one).
 */
export function pickRefs(character, limit = 6, { includeSheet = true, sheetLast = false } = {}) {
  if (limit <= 0) return [];
  const refs = character?.refs || [];
  const sheet = includeSheet ? refs.find((r) => r.kind === 'sheet' && character.sheet?.approved && character.sheet.assetId === r.assetId) : null;
  const usable = refs.filter((r) => r.kind !== 'sheet' && r.status !== 'error' && !(r.quality?.flags || []).includes('no-face'))
    .sort((a, b) => refScore(b) - refScore(a));
  // Weak photos (< 30) only count when nothing better exists — one poor reference beats none.
  const photos = usable.filter((r) => refScore(r) >= 30).length ? usable.filter((r) => refScore(r) >= 30) : usable.slice(0, 1);
  const chosen = [];
  const take = (r) => { if (r && !chosen.includes(r)) chosen.push(r); };
  for (const slot of PRIORITY) take(photos.find((r) => !chosen.includes(r) && slotsFor(r).includes(slot)));
  for (const r of photos) if (!chosen.some((c) => hamming(c.hash, r.hash) <= DUPLICATE)) take(r);
  // Keep the slot picks in priority order but put clearly better photos ahead of weak slot fillers.
  const ordered = chosen.slice(0, Math.max(limit, 1)).sort((a, b) => (slotRank(a) - slotRank(b)) || (refScore(b) - refScore(a)));
  const photosOut = ordered.slice(0, sheet ? limit - 1 : limit);
  const out = sheet ? (sheetLast ? [...photosOut, sheet] : [sheet, ...photosOut]) : photosOut;
  return out.slice(0, limit).map((r) => ({ ...r, id: r.workId || r.assetId }));
}
function slotRank(r) {
  const s = slotsFor(r);
  const i = Math.min(...s.map((k) => PRIORITY.indexOf(k)).filter((x) => x >= 0));
  return Number.isFinite(i) && (r.quality?.score ?? 0) >= USABLE ? i : PRIORITY.length;
}

/** Split a reference budget fairly across characters (each gets at least one when the budget allows). */
export function budget(counts, limit) {
  const out = counts.map(() => 0);
  let left = limit;
  for (let round = 0; left > 0; round++) {
    let gave = false;
    for (let i = 0; i < counts.length && left > 0; i++) if (out[i] < counts[i]) { out[i]++; left--; gave = true; }
    if (!gave) break;
  }
  return out;
}

const ANGLE_WORDS = { front: 'front', threeQuarterLeft: 'three-quarter', threeQuarterRight: 'three-quarter', profileLeft: 'profile', profileRight: 'profile', back: 'back' };
const describeRef = (r) => {
  if (r.kind === 'sheet') return 'approved character sheet';
  const bits = [ANGLE_WORDS[r.angle], ['smile-teeth', 'laugh'].includes(r.expression) ? 'smiling' : r.expression === 'other' && r.expressionLabel ? r.expressionLabel : null, r.framing === 'full-body' ? 'full body' : r.framing === 'waist-up' ? 'waist-up' : null].filter(Boolean);
  return bits.join(', ');
};

/** How a provider wants reference images named inside the prompt. n is 0-based within the request's image list. */
export const TAG = {
  plain: (n) => `image ${n + 1}`,
  xai: (n) => `<IMAGE_${n}>`,
  kling: (n) => `@Image${n + 1}`,
  omni: (n) => `<<<image_${n + 1}>>>`,
};
const tagRange = (tag, a, b) => (a === b ? TAG[tag](a) : tag === 'plain' ? `images ${a + 1}–${b + 1}` : Array.from({ length: b - a + 1 }, (_, k) => TAG[tag](a + k)).join(', '));

/**
 * Plan references for a set of characters within one request.
 * chars: resolved characters [{ name, description, lookNotes, refs (character refs) | refAssetIds (inline) }]
 * opts: { limit, offset (images before the refs, e.g. a pinned start frame), tag }
 * Returns { refs: [assetId], guide: 'Reference images: …', perCharacter: [{ name, ids }] }
 */
export function planRefs(chars, { limit = 6, offset = 0, tag = 'plain' } = {}) {
  const lists = chars.map((c) => (c.refs ? pickRefs(c, Math.min(limit, 6)) : (c.refAssetIds || []).map((id) => ({ id, kind: 'photo' }))));
  const shares = budget(lists.map((l) => l.length), limit);
  const refs = [];
  const parts = [];
  const per = [];
  chars.forEach((c, i) => {
    const mine = lists[i].slice(0, shares[i]);
    if (!mine.length) return;
    const start = offset + refs.length;
    refs.push(...mine.map((r) => r.id));
    const name = c.name || 'the character';
    const sheetFirst = mine[0].kind === 'sheet';
    const photos = sheetFirst ? mine.slice(1) : mine;
    const bits = [];
    if (sheetFirst) bits.push(`${TAG[tag](start)} is the approved character sheet of ${name}`);
    if (photos.length) {
      const a = start + (sheetFirst ? 1 : 0);
      const desc = photos.map(describeRef).filter(Boolean);
      bits.push(`${tagRange(tag, a, a + photos.length - 1)} ${photos.length > 1 ? 'are real photos' : 'is a real photo'} of ${name}${desc.length && desc.length === photos.length ? ` (${desc.join('; ')})` : ''}`);
    }
    parts.push(bits.join(', and '));
    per.push({ name, ids: mine.map((r) => r.id) });
  });
  if (!parts.length) return { refs: [], guide: '', perCharacter: [] };
  const many = per.length > 1;
  const notes = chars.map((c) => {
    const t = [c.description, c.lookNotes && `look: ${c.lookNotes}`].filter(Boolean).join('; ');
    return t ? `${c.name || 'Character'} — ${t}` : '';
  }).filter(Boolean);
  const guide = `Reference images: ${parts.join('. ')}. ${many ? 'These are different people — never blend their features. ' : ''}`
    + `Keep ${many ? "each person's" : 'the person\'s'} identity exactly as in ${many ? 'their' : 'the'} references: face shape, eyes, nose, mouth, ears, hairline, hair, beard, skin texture and build. `
    + 'Do not beautify, smooth, slim, de-age or otherwise alter them; references only fix identity, not pose or setting. '
    + (notes.length ? `Character notes: ${notes.join(' | ')}. ` : '');
  return { refs, guide, perCharacter: per };
}

/** Plain-text identity line for models that take no reference images. */
export function textGuide(chars) {
  const notes = chars.filter((c) => c.name || c.description).map((c) => `${c.name || 'Character'}: ${[c.description, c.lookNotes].filter(Boolean).join('; ') || 'as established'}`);
  return notes.length ? `Characters (keep their look consistent): ${notes.join(' | ')}. ` : '';
}

/**
 * How a model consumes characters.
 *  image-refs — image model with reference inputs
 *  video-refs — video model with a true reference mode
 *  keyframe   — first-frame video model: make a keyframe from the refs, then animate it
 *  text       — no image input at all: description only
 */
export function routeFor(model, { hasImage = false } = {}) {
  if (!model) return 'text';
  if (model.kind === 'image') return (model.refs ?? 0) > 0 ? 'image-refs' : 'text';
  const c = model.caps || {};
  if (c.refs && (!hasImage || c.refsWithImage)) return 'video-refs';
  if (hasImage) return 'text';
  if (c.i2v) return 'keyframe';
  return 'text';
}
