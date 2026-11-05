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

async function smallJpeg(file, signal) {
  const { out } = await exec(FFMPEG, ['-v', 'error', '-i', file, '-vf', "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease,format=yuvj420p", '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { signal });
  return out.toString('base64');
}

/**
 * Grade one image with the vision model. Returns { vision (normalised), raw, backend, model } or throws.
 */
export async function gradeImage(file, { signal } = {}) {
  const backend = visionBackend();
  if (!backend) throw new Error('no vision model — add a Gemini API key (or ApiMart) in Providers');
  const s = getSettings();
  const b64 = await smallJpeg(file, signal);
  const model = backend === 'google' ? process.env.CHAR_VISION_MODEL || 'gemini-flash-latest' : process.env.CHAR_VISION_MODEL_APIMART || 'gemini-3.8-flash';
  const url = backend === 'google' ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' : `${APIMART}/chat/completions`;
  const body = {
    model,
    temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }],
    ...(backend === 'google' ? { response_format: { type: 'json_object' } } : {}),
  };
  const r = await fetchJSON(backend, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${backend === 'google' ? s.googleKey : s.apimartKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(90000),
  });
  const raw = parseJSON(r.choices?.[0]?.message?.content);
  return { vision: normalizeVision(raw), raw, backend, model };
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
