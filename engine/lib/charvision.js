// Character reference analysis: ffmpeg sharpness + perceptual hash, video frame extraction, and a vision-LLM
// grade of each photo (Gemini Flash through its OpenAI-compatible endpoint; ApiMart's Gemini as fallback).
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getSettings } from './store.js';
import { fetchJSON } from './http.js';
import { sharpFromBlur, dhash, normalizeVision } from './charref.js';
import { APIMART } from './providers/apimart.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

/** Run a binary; resolves { out: Buffer, err: string }. */
function exec(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${bin} not found — install ffmpeg`) : e));
    p.on('close', (code) => (code === 0 ? resolve({ out: Buffer.concat(out), err }) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`))));
  });
}

export async function dims(file) {
  const { out } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out.toString('utf8'));
  const s = j.streams?.[0] || {};
  const rot = Math.abs(Number(s.side_data_list?.find((d) => d.rotation != null)?.rotation) || 0);
  const [w, h] = rot === 90 || rot === 270 ? [s.height, s.width] : [s.width, s.height];
  return { width: w, height: h, duration: Number(j.format?.duration) || 0 };
}

// Sharpness is measured on the subject area: frame scaled to ≤640 px, then the centre-top 80 % × 75 %.
const MEASURE = 'scale=w=640:h=640:force_original_aspect_ratio=decrease,crop=iw*0.8:ih*0.75:iw*0.1:0';
const BLUR = 'blurdetect=block_width=32:block_height=32,metadata=mode=print';

const blursFrom = (log) => [...log.matchAll(/lavfi\.blur=([\d.]+)/g)].map((m) => Number(m[1]));

/** { sharp 0..1, blur, hash, width, height } for one still. */
export async function measureImage(file, { signal } = {}) {
  const [{ width, height }, { out, err }] = await Promise.all([
    dims(file),
    exec(FFMPEG, ['-hide_banner', '-nostats', '-v', 'info', '-i', file, '-filter_complex', `[0:v]${MEASURE},split[a][b];[a]${BLUR},nullsink;[b]scale=9:8:flags=area,format=gray[h]`, '-map', '[h]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { signal }),
  ]);
  const blur = blursFrom(err)[0];
  return { sharp: sharpFromBlur(blur), blur: blur ?? null, hash: out.length >= 72 ? dhash(out) : null, width, height };
}

/** Auto-rotated, metadata-stripped JPEG, long side ≤ maxSide (the copy that is sent to providers). */
export async function normalizeImage(file, out, { maxSide = 2048, signal } = {}) {
  await exec(FFMPEG, ['-y', '-v', 'error', '-i', file, '-map_metadata', '-1', '-vf', `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos,format=yuvj420p`, '-frames:v', '1', '-q:v', '2', out], { signal });
}

/**
 * Extract frames from a video at `fps` and measure each: [{ i, t, file, blur, sharp, hash }].
 * Frames are written full-size into `dir` (caller cleans up).
 */
export async function extractFrames(video, dir, { fps = 6, maxSeconds = 60, signal } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const { out, err } = await exec(FFMPEG, ['-hide_banner', '-nostats', '-v', 'info', '-t', String(maxSeconds), '-i', video,
    '-filter_complex', `[0:v]fps=${fps},split=3[full][m][h];[m]${MEASURE},${BLUR},nullsink;[h]${MEASURE},scale=9:8:flags=area,format=gray[hh]`,
    '-map', '[full]', '-q:v', '2', '-map_metadata', '-1', path.join(dir, 'f_%04d.jpg'),
    '-map', '[hh]', '-f', 'rawvideo', 'pipe:1'], { signal });
  const blurs = blursFrom(err);
  const files = (await fsp.readdir(dir)).filter((f) => /^f_\d+\.jpg$/.test(f)).sort();
  return files.map((f, i) => ({
    i, t: +(i / fps).toFixed(3), file: path.join(dir, f), blur: blurs[i] ?? null, sharp: sharpFromBlur(blurs[i]),
    hash: out.length >= (i + 1) * 72 ? dhash(out, i * 72) : null,
  }));
}

/* ---------------------------------------------------------------- vision grading */

const PROMPT = `You grade reference photos of ONE person for an AI film studio that must reproduce this person's identity exactly.
Look at the photo and reply with ONLY a JSON object, no prose:
{
 "face_visible": true|false,               // is one human face clearly visible?
 "people_count": integer,                  // how many people are visible
 "angle": "front"|"three-quarter-left"|"three-quarter-right"|"profile-left"|"profile-right"|"back",
 "yaw_degrees": number,                    // head turn: 0 = facing the camera, negative = nose points toward the LEFT edge of the image, positive = toward the RIGHT edge, ±90 = full profile
 "camera_height": "eye-level"|"below-eye-level"|"above-eye-level",
 "framing": "face-closeup"|"head-and-shoulders"|"waist-up"|"full-body",
 "face_height_fraction": number,           // chin-to-hairline height divided by the image height (0..1)
 "expression": "neutral"|"smile-teeth"|"smile-closed"|"laugh"|"other",
 "expression_label": "2-4 words, e.g. 'raised eyebrow', 'squinting'",
 "eyes_closed": true|false,
 "sharpness": "sharp"|"slightly-soft"|"blurry",   // judge the face: focus and motion blur
 "beauty_filter": true|false,              // skin smoothing, beauty mode, AR/face filter, Portrait-mode smoothing, plastic-looking skin
 "colour_grading": true|false,             // strong tint, heavy grade or stylised filter
 "wide_lens_distortion": true|false,       // close front-camera selfie perspective: enlarged nose/forehead, receding ears, arm's-length framing
 "selfie": true|false,
 "occlusion": ["sunglasses"|"glasses"|"hat"|"hand"|"hair"|"mask"],   // empty array if none
 "lighting": "even"|"harsh"|"backlit"|"dim"|"mixed-colour",
 "background": "plain"|"busy",
 "hair": "short description of hair colour/length/style",
 "facial_hair": "clean-shaven"|"stubble"|"short-beard"|"full-beard"|"moustache"|"n/a",
 "notes": "one short sentence about anything else that would hurt likeness"
}
Angle uses the direction the NOSE points in the image: "three-quarter-left" = turned roughly 30–60° so the nose points toward the left edge of the picture; "profile-left" = about 90°, nose pointing to the left edge. Be strict about blur, filters and selfie distortion.`;

function parseJSON(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('vision model returned no JSON');
  return JSON.parse(t.slice(a, b + 1).replace(/\/\/[^\n"]*$/gm, ''));
}

/** Which vision backend is configured: 'google' | 'apimart' | null. */
export function visionBackend() {
  const s = getSettings();
  if (s.googleKey) return 'google';
  if (s.apimartKey) return 'apimart';
  return null;
}

/** Base64 JPEG, long side ≤ maxSide (what vision calls receive). */
export async function smallJpeg(file, signal, maxSide = 1024) {
  const { out } = await exec(FFMPEG, ['-v', 'error', '-i', file, '-vf', `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease,format=yuvj420p`, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { signal });
  return out.toString('base64');
}

/** One multimodal JSON call to the configured vision model. content: OpenAI-style parts. */
export async function visionJSON(content, { signal, timeout = 120000, model: want } = {}) {
  const backend = visionBackend();
  if (!backend) throw new Error('no vision model — add a Gemini API key (or ApiMart) in Providers');
  const s = getSettings();
  const model = backend === 'google' ? want || process.env.CHAR_VISION_MODEL || 'gemini-flash-latest' : process.env.CHAR_VISION_MODEL_APIMART || 'gemini-3.8-flash';
  const url = backend === 'google' ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' : `${APIMART}/chat/completions`;
  const r = await fetchJSON(backend, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${backend === 'google' ? s.googleKey : s.apimartKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content }], ...(backend === 'google' ? { response_format: { type: 'json_object' } } : {}) }),
    signal: signal || AbortSignal.timeout(timeout),
  });
  return { json: parseJSON(r.choices?.[0]?.message?.content), backend, model };
}

/**
 * Grade one image with the vision model. Returns { vision (normalised), raw, backend, model } or throws.
 */
export async function gradeImage(file, { signal } = {}) {
  const b64 = await smallJpeg(file, signal);
  const { json: raw, backend, model } = await visionJSON([{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }], { signal, timeout: 90000 });
  return { vision: normalizeVision(raw), raw, backend, model };
}

/** Square crop around a [ymin, xmin, ymax, xmax] 0–1000 box (+30 % margin), scaled to size px. */
export async function cropBox(file, box, out, { size = 384, signal } = {}) {
  const { width: W, height: H } = await dims(file);
  const [y0, x0, y1, x1] = box.map((v) => v / 1000);
  const cx = ((x0 + x1) / 2) * W;
  const cy = ((y0 + y1) / 2) * H;
  const side = Math.round(Math.min(Math.max((x1 - x0) * W, (y1 - y0) * H) * 1.3, W, H));
  const x = Math.round(Math.max(0, Math.min(W - side, cx - side / 2)));
  const y = Math.round(Math.max(0, Math.min(H - side, cy - side / 2)));
  await exec(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', `crop=${side}:${side}:${x}:${y},scale=${size}:${size}`, '-frames:v', '1', '-q:v', '3', out], { signal });
  return out;
}

/** Crop a fraction of an image (e.g. the front panel of a model sheet) into a new file. */
export async function cropFraction(file, out, { x0 = 0, w = 1, signal } = {}) {
  await exec(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', `crop=iw*${w}:ih:iw*${x0}:0`, '-frames:v', '1', '-q:v', '3', out], { signal });
  return out;
}

/** Frames every `every` seconds (≤ maxFrames, spread over the clip) as small JPEG files: [{ t, file }]. */
export async function sampleFrames(video, dir, { every = 0.5, maxFrames = 24, maxSide = 640, signal } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const { duration } = await dims(video);
  const step = Math.max(every, duration ? duration / maxFrames : every);
  await exec(FFMPEG, ['-v', 'error', '-i', video, '-vf', `fps=1/${step.toFixed(4)},scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`, '-q:v', '4', path.join(dir, 'q_%03d.jpg')], { signal });
  const files = (await fsp.readdir(dir)).filter((f) => /^q_\d+\.jpg$/.test(f)).sort();
  // fps=1/step emits frame k at ≈ (k + 0.5) · step
  return files.slice(0, maxFrames).map((f, k) => ({ t: +Math.min(duration || Infinity, (k + 0.5) * step).toFixed(2), file: path.join(dir, f) }));
}

/** Run async fn over items with at most n in flight. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
