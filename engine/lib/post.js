// Server-side post-production for finished clips and long-form masters.
//   • subtitles: whisper.cpp on the CPU → word timestamps → SRT / WebVTT / styled ASS, soft track or burned in
//   • two-pass loudness mastering; opt-in dialogue cleanup (RNNoise) or ElevenLabs voice isolation (cloud)
//   • picture: shot-to-shot colour matching, opt-in denoise, motion interpolation for sub-23 fps clips,
//     and Topaz upscaling on fal.ai (CPU upscalers measured no better than the Lanczos conform already uses)
// Heavy CPU work runs in a small worker pool at lowered priority with capped threads, so renders and
// the web server stay responsive. See docs/post-production.md for the benchmarks behind each default.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, uid, now, getSettings, getAsset, assetPath, addAsset, newAssetPath, updateAsset } from './store.js';
import { parseWhisperJson, dropHallucinations, buildCues, clampCues, toSrt, toVtt, toAss, transcriptText, iso639_2 } from './subtitles.js';
import { falRun } from './providers/fal.js';
import { httpError, ProviderError } from './http.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const WHISPER = process.env.WHISPER_BIN || 'whisper-cli';
const MODELS = process.env.POST_MODELS || '/opt/post/models';
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(MODELS, 'ggml-large-v3-turbo-q8_0.bin');
/** whisper.cpp DTW alignment-head preset for a ggml model file name (token-level timestamps), or ''. */
export function dtwPreset(file) {
  const m = path.basename(String(file)).match(/ggml-(tiny|base|small|medium|large-v[123](?:-turbo)?)(\.en)?[-.]/);
  return m ? `${m[1].replace(/-/g, '.')}${m[2] || ''}` : '';
}
const WHISPER_DTW = process.env.WHISPER_DTW ?? dtwPreset(WHISPER_MODEL); // '' disables
const VAD_MODEL = process.env.WHISPER_VAD_MODEL || path.join(MODELS, 'ggml-silero-v6.2.0.bin');
const RNN_DIR = process.env.RNNOISE_DIR || path.join(MODELS, 'rnnoise');
const SUB_FONT = process.env.SUBTITLE_FONT || 'Inter';
const TMP = path.join(DATA, 'tmp', 'post');
fs.mkdirSync(TMP, { recursive: true });

const CORES = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const int = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo ? Math.min(hi, Math.floor(Number(v))) : null);
/** Threads one heavy step may use: leave a quarter of the machine (≥ 2 cores) for the server and renders. */
export const THREADS = int(process.env.POST_THREADS, 1, 256) || Math.max(1, CORES - Math.max(2, Math.round(CORES / 4)));
/** Heavy steps that may run at the same time (encode, transcribe, interpolate). */
export const WORKERS = int(process.env.POST_WORKERS, 1, 16) || 1;
const NICE = int(process.env.POST_NICE, 0, 19) ?? 10;
// medium: 1.35× realtime at 1080p on 9 threads vs 0.82× for slow; at CRF 17 a second generation is visually transparent.
const X264_PRESET = process.env.POST_X264_PRESET || 'medium';
export const LOUDNESS = { I: -16, TP: -1.5, LRA: 11 };

/* ---------------- processes + worker pool ---------------- */

/**
 * Spawn a tool at lowered CPU priority. Collects stdout, keeps the stderr tail, and reports
 * progress from ffmpeg's `-progress pipe:2` (out_time_us) or whisper's `progress = N%`.
 */
// Linux niceness is per thread: start tools through `nice` so every worker thread they create inherits it.
const NICE_BIN = ['/usr/bin/nice', '/bin/nice'].find((f) => fs.existsSync(f));
export function exec(bin, args, { signal, duration, onProgress, keepStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = NICE_BIN && NICE ? spawn(NICE_BIN, ['-n', String(NICE), bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal }) : spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (e) { return reject(e); }
    if (!NICE_BIN && p.pid) { try { os.setPriority(p.pid, NICE); } catch {} }
    let out = '';
    let err = '';
    let last = 0;
    const tick = (frac) => {
      if (!onProgress || !Number.isFinite(frac)) return;
      if (Date.now() - last < 700 && frac < 1) return;
      last = Date.now();
      onProgress(Math.max(0, Math.min(1, frac)));
    };
    p.stdout.on('data', (d) => { if (keepStdout) out += d; });
    p.stderr.on('data', (d) => {
      const s = String(d);
      err = (err + s).slice(-16000);
      if (duration) { const m = s.match(/out_time_us=(\d+)/g)?.at(-1); if (m) tick(Number(m.split('=')[1]) / 1e6 / duration); }
      const w = s.match(/progress\s*=\s*(\d+)%/g)?.at(-1);
      if (w) tick(Number(w.match(/(\d+)%/)[1]) / 100);
    });
    p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${path.basename(bin)} is not installed on the engine host`) : signal?.aborted ? new Error('cancelled') : e));
    p.on('close', (code) => {
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code === 0) return resolve({ stdout: out, stderr: err });
      if (code === 127 && NICE_BIN) return reject(new Error(`${path.basename(bin)} is not installed on the engine host`));
      reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').filter((l) => !/^\w+=/.test(l)).slice(-3).join(' | ')}`));
    });
  });
}

const waiting = [];
let busy = 0;
/** Run fn while holding one of WORKERS slots; `onWait(n)` is told how many jobs are ahead. */
export function withSlot(fn, { signal, onWait } = {}) {
  return new Promise((resolve, reject) => {
    const go = () => {
      busy++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { busy--; pump(); });
    };
    const entry = { go, signal, reject };
    if (busy < WORKERS && !waiting.length) return go();
    waiting.push(entry);
    onWait?.(waiting.length);
    signal?.addEventListener('abort', () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) { waiting.splice(i, 1); reject(new Error('cancelled')); }
    }, { once: true });
  });
}
function pump() {
  while (busy < WORKERS && waiting.length) waiting.shift().go();
}
export const poolState = () => ({ workers: WORKERS, busy, waiting: waiting.length, threads: THREADS, cores: CORES });

/* ---------------- probing ---------------- */

const ratio = (r) => { const [a, b] = String(r || '').split('/').map(Number); return a && b ? a / b : a || 0; };
export async function probe(file) {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const rot = Number(v?.side_data_list?.find((d) => d.rotation != null)?.rotation || v?.tags?.rotate || 0);
  const swap = Math.abs(rot) % 180 === 90;
  return {
    width: swap ? v?.height : v?.width, height: swap ? v?.width : v?.height,
    duration: Number(j.format?.duration) || Number(v?.duration) || 0,
    fps: ratio(v?.avg_frame_rate) || ratio(v?.r_frame_rate) || 0,
    vcodec: v?.codec_name || null, pixFmt: v?.pix_fmt || null,
    hasAudio: !!a, audioRate: Number(a?.sample_rate) || 0, channels: a?.channels || 0,
    subtitles: (j.streams || []).filter((s) => s.codec_type === 'subtitle').length,
  };
}

/* ---------------- audio: cleanup + loudness ---------------- */

// Opt-in only: on already-clean generated audio any denoiser removes ambience (benchmarks in docs/post-production.md).
export const AUDIO_MODES = {
  off: 'Leave the audio as it is',
  clean: 'Remove background noise from speech — hiss, hum, rumble, crowd (RNNoise, CPU). Also thins out music and ambience.',
  isolate: 'ElevenLabs voice isolation (cloud): voices only, everything else removed',
};

const safeArg = (p) => { if (!/^[\w/.\-]+$/.test(p)) throw new Error(`unsupported path for filter: ${p}`); return p; };
/** ffmpeg audio filters for a cleanup mode (input must be 48 kHz — arnndn's native rate). */
export function audioChain(mode, { rnnDir = RNN_DIR } = {}) {
  switch (mode) {
    case 'clean':
      // Xiph's original RNNoise model with 15 % of the input mixed back: best measured on noisy speech
      // (+5.1 / +3.0 dB SI-SDR, WER 10–12 % → 0 %) and the least damage to clean speech of the models tried.
      return [`arnndn=m=${safeArg(path.join(rnnDir, 'std.rnnn'))}:mix=0.85`];
    default:
      return [];
  }
}

/** Parse the JSON block ffmpeg's loudnorm prints in measurement mode. */
export function parseLoudnorm(stderr) {
  const m = String(stderr).match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const n = (k) => Number(j[k]);
    const out = { I: n('input_i'), TP: n('input_tp'), LRA: n('input_lra'), thresh: n('input_thresh'), offset: n('target_offset') };
    return Object.values(out).every(Number.isFinite) ? out : null;
  } catch { return null; }
}

/**
 * Second loudnorm pass from pass-one measurements: linear gain (no pumping) when it fits under the
 * true-peak ceiling, otherwise loudnorm's dynamic mode. Silence (−70 LUFS) is left alone.
 */
export function loudnormFilter(m, t = LOUDNESS) {
  const base = `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}`;
  const core = !m ? base : m.I < -69 ? 'anull' : `${base}:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary`;
  // loudnorm works at 192 kHz internally; pin the output format explicitly — ffmpeg 5.1 (the Docker
  // image) otherwise fails to negotiate a channel layout after it.
  return `${core},${PIN_48K}`;
}
export const PIN_48K = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

export async function measureLoudness(file, { af = [], signal, duration, onProgress } = {}) {
  const { stderr } = await exec(FFMPEG, ['-hide_banner', '-nostats', '-progress', 'pipe:2', '-i', file, '-vn', '-af', [...af, 'aresample=48000', `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:print_format=json`].join(','), '-f', 'null', '-'], { signal, duration, onProgress, keepStdout: false });
  return parseLoudnorm(stderr);
}

/** EBU R128 report of a finished file (integrated LUFS, LRA, true peak). */
export async function loudnessReport(file, { signal } = {}) {
  const { stderr } = await exec(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { signal, keepStdout: false });
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'));
  const g = (re) => Number(tail.match(re)?.[1]);
  return { I: g(/I:\s+(-?[\d.]+) LUFS/), LRA: g(/LRA:\s+(-?[\d.]+) LU/), TP: g(/Peak:\s+(-?[\d.]+) dBFS/) };
}

/* ---------------- picture ---------------- */

// Only what measurably helped on the VPS (docs/post-production.md). Rejected there: CPU upscaling (Lanczos is
// already the conform scaler; others tie it), CAS/unsharp sharpening (lowers SSIM), hqdn3d (weak), deflicker.
export const PICTURE = {
  // Non-local means, tuned for speed: synthetic-noise SSIM 0.823 → 0.986 on 1080p. Opt-in: ~0.08× realtime at 1080p.
  denoise: 'nlmeans=s=2.5:p=5:pc=3:r=7:rc=5',
};
// Motion-compensated interpolation; only worth its cost for genuinely low frame rates (e.g. Wan's 16 fps).
export const interpFilter = (fps) => `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:vsbmc=1:scd=fdiff:scd_threshold=8`;

/** Target frame size for an upscale choice, keeping aspect, even dimensions, never shrinking. */
export function upscaleSize({ width, height }, target) {
  const short = { '1080p': 1080, '1440p': 1440, '2160p': 2160, '4k': 2160 }[target];
  if (!short || !width || !height) return null;
  const s = Math.min(width, height);
  if (s >= short) return null;
  const k = short / s;
  const even = (x) => Math.round(x / 2) * 2;
  return { width: even(width * k), height: even(height * k), factor: k };
}

/**
 * Filters for one clip. Returns { pre, fps, post } so the long-form conform can splice them around its
 * own scale/pad/fps step; `enhanceArgs` joins them for a standalone pass.
 */
export function pictureChain(o = {}, info = {}) {
  const pre = [];
  if (o.denoise) pre.push(PICTURE.denoise);
  // smoothMotion 'auto': only clips below 23 fps (16 fps Wan) get interpolated to 24; everything else is untouched.
  const fps = o.smoothMotion === 'auto' && info.fps && info.fps < 23 ? interpFilter(24) : null;
  return { pre, fps, post: [] };
}

/* ---------------- colour matching across shots ---------------- */

/** Average signalstats over sampled frames: luma 10th/50th/90th percentile proxies and chroma means. */
export function parseSignalstats(text) {
  const acc = { YLOW: [], YAVG: [], YHIGH: [], UAVG: [], VAVG: [], SATAVG: [] };
  for (const m of String(text).matchAll(/lavfi\.signalstats\.(YLOW|YAVG|YHIGH|UAVG|VAVG|SATAVG)=([\d.]+)/g)) acc[m[1]].push(Number(m[2]));
  if (!acc.YAVG.length) return null;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return { yLow: med(acc.YLOW), yAvg: med(acc.YAVG), yHigh: med(acc.YHIGH), u: med(acc.UAVG), v: med(acc.VAVG), sat: med(acc.SATAVG), n: acc.YAVG.length };
}

export async function colourStats(file, { signal, duration } = {}) {
  const fps = duration && duration > 20 ? (12 / duration).toFixed(3) : 2;
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-an', '-vf', `fps=${fps},scale=480:-2:flags=bilinear,format=yuv420p,signalstats,metadata=print:file=-`, '-f', 'null', '-'], { signal });
  return parseSignalstats(stdout);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Per-shot corrections pulling each shot toward its scene's median look. Only shots that share a
 * scene are matched (scene changes are usually deliberate), corrections are partial and capped so a
 * shot that is meant to be darker stays darker.
 * Luma is a three-point levels match: the mid-tone moves toward the scene's, and shadows / highlights
 * get their own gain around it (one global gain can't fix a shot with normal blacks but dull highlights).
 * Returns [{ m, m2, lo, hi, du, dv } | null]: y' = m2 + (y < m ? lo : hi)·(y − m), u' = u + du, v' = v + dv.
 */
export function colourPlan(stats, groups, { strength = 0.7, maxGain = 0.25, maxShift = 18, maxChroma = 7 } = {}) {
  const out = stats.map(() => null);
  const byGroup = new Map();
  stats.forEach((s, i) => { if (s) { const g = groups[i] ?? 'all'; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(i); } });
  const r = (x, k = 3) => Math.round(x * 10 ** k) / 10 ** k;
  for (const idx of byGroup.values()) {
    if (idx.length < 2) continue;
    const ref = { yLow: median(idx.map((i) => stats[i].yLow)), yHigh: median(idx.map((i) => stats[i].yHigh)), yAvg: median(idx.map((i) => stats[i].yAvg)), u: median(idx.map((i) => stats[i].u)), v: median(idx.map((i) => stats[i].v)) };
    for (const i of idx) {
      const s = stats[i];
      const gain = (want, have) => clamp(1 + strength * (want / Math.max(4, have) - 1), 1 - maxGain, 1 + maxGain);
      const lo = gain(ref.yAvg - ref.yLow, s.yAvg - s.yLow);
      const hi = gain(ref.yHigh - ref.yAvg, s.yHigh - s.yAvg);
      const m2 = s.yAvg + clamp(strength * (ref.yAvg - s.yAvg), -maxShift, maxShift);
      const du = clamp(strength * (ref.u - s.u), -maxChroma, maxChroma);
      const dv = clamp(strength * (ref.v - s.v), -maxChroma, maxChroma);
      const c = { m: r(s.yAvg, 2), m2: r(m2, 2), lo: r(lo), hi: r(hi), du: r(du, 2), dv: r(dv, 2) };
      const still = Math.abs(c.lo - 1) < 0.02 && Math.abs(c.hi - 1) < 0.02 && Math.abs(c.m2 - c.m) < 1.5 && Math.abs(c.du) < 0.75 && Math.abs(c.dv) < 0.75;
      out[i] = still ? null : c;
    }
  }
  return out;
}

/** lutyuv filter for a correction (8-bit limited range). */
export const colourFilter = (c) => (c ? `lutyuv=y='clip(${c.m2}+if(lt(val,${c.m}),${c.lo},${c.hi})*(val-${c.m}),16,235)':u='clip(val+${c.du},16,240)':v='clip(val+${c.dv},16,240)'` : null);

/* ---------------- whisper.cpp transcription ---------------- */

let whisperOk = null;
export async function capabilities() {
  if (whisperOk === null) {
    whisperOk = await exec(WHISPER, ['-h']).then(() => true, (e) => !/not installed/.test(e.message));
  }
  const s = getSettings();
  const has = (f) => { try { return fs.statSync(f).size > 0; } catch { return false; } };
  return {
    whisper: whisperOk && has(WHISPER_MODEL), whisperModel: path.basename(WHISPER_MODEL), vad: has(VAD_MODEL),
    rnnoise: has(path.join(RNN_DIR, 'std.rnnn')),
    falUpscale: !!s.falKey, elevenIsolation: !!s.elevenKey,
    pool: poolState(),
    options: {
      subtitles: ['off', 'soft', 'burn'], audio: Object.keys(AUDIO_MODES), audioModes: AUDIO_MODES,
      denoise: [false, true], smoothMotion: ['off', 'auto'], upscale: ['off', '1080p', '1440p', '2160p'], // upscale = Topaz on fal.ai
    },
    pricing: { topazPerSecond: { upTo720p: 0.01, upTo1080p: 0.02, above1080p: 0.08 }, elevenIsolationCreditsPerMinute: 1000 },
  };
}

/**
 * Transcribe any media file. Returns { language, words, segments, text, cues, model, seconds }.
 * 16 kHz mono WAV → whisper-cli with Silero VAD (fewer hallucinations over music), DTW token times.
 */
export async function transcribe(file, { language = 'auto', translate = false, vad = true, signal, onProgress, cueOptions } = {}) {
  const dir = await fsp.mkdtemp(path.join(TMP, 'asr-'));
  const t0 = Date.now();
  try {
    const wav = path.join(dir, 'a.wav');
    await exec(FFMPEG, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal });
    const base = path.join(dir, 'out');
    const lang = /^[a-z]{2,3}$/.test(language) ? language : 'auto';
    const args = ['-m', WHISPER_MODEL, '-f', wav, '-t', String(THREADS), '-l', lang, '-ojf', '-of', base, '-np', '-pp', '-sns', '-nth', '0.6'];
    if (translate) args.push('-tr');
    // Silero VAD skips music / silence (no "thank you for watching" over the score) and halves CPU time;
    // vad: false also transcribes sung lyrics, which VAD classes as non-speech.
    if (vad && process.env.WHISPER_VAD !== '0' && fs.existsSync(VAD_MODEL)) args.push('--vad', '-vm', VAD_MODEL, '--vad-min-silence-duration-ms', '300', '--vad-speech-pad-ms', '200');
    if (WHISPER_DTW) args.push('-dtw', WHISPER_DTW);
    await exec(WHISPER, args, { signal, onProgress });
    const raw = await fsp.readFile(`${base}.json`, 'utf8');
    let json;
    try { json = JSON.parse(raw); } catch { json = JSON.parse(raw.replace(/[\u0000-\u001f]/g, ' ')); }
    const parsed = dropHallucinations(parseWhisperJson(json));
    const cues = clampCues(buildCues(parsed.words, cueOptions), (await probe(wav).catch(() => ({}))).duration);
    return { language: translate ? 'en' : parsed.language, words: parsed.words, segments: parsed.segments, text: transcriptText(parsed.segments), cues, dropped: parsed.dropped || [], model: path.basename(WHISPER_MODEL), seconds: (Date.now() - t0) / 1000 };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Store a transcript next to its video: .vtt (web), .srt (editors / MP4 track), .json (words + segments). */
export async function saveTranscript(videoAsset, t, { W, H } = {}) {
  const base = { hidden: true, source: 'subtitles', parentId: videoAsset.id, language: t.language };
  const write = async (mime, ext, body) => {
    const out = newAssetPath(mime);
    const abs = out.abs.replace(/\.[^.]+$/, `.${ext}`);
    await fsp.writeFile(abs, body);
    return addAsset({ id: out.id, file: path.basename(abs), abs, mime, meta: { ...base, kind: 'text' } });
  };
  const vtt = await write('text/vtt', 'vtt', toVtt(t.cues));
  const srt = await write('application/x-subrip', 'srt', toSrt(t.cues));
  const json = await write('application/json', 'json', JSON.stringify({ language: t.language, model: t.model, text: t.text, segments: t.segments, words: t.words, cues: t.cues }));
  const transcript = { language: t.language, model: t.model, vttId: vtt.id, srtId: srt.id, jsonId: json.id, vttUrl: vtt.url, srtUrl: srt.url, jsonUrl: json.url, cues: t.cues.length, words: t.words.length, at: now() };
  updateAsset(videoAsset.id, { transcript });
  void W; void H;
  return transcript;
}

export async function readTranscript(assetId) {
  const a = getAsset(assetId);
  if (!a?.transcript) return null;
  const j = getAsset(a.transcript.jsonId);
  const body = j ? JSON.parse(await fsp.readFile(assetPath(j), 'utf8').catch(() => '{}')) : {};
  return { ...a.transcript, text: body.text || '', segments: body.segments || [], words: body.words || [] };
}

/* ---------------- cloud: fal Topaz upscale, ElevenLabs isolation ---------------- */

/** fal Topaz price per second of output (fal.ai pricing, Nov 2026): ≤720p $0.01, ≤1080p $0.02, above $0.08; 60 fps doubles. */
export function topazCost({ width, height }, seconds, fps) {
  const px = width * height;
  const rate = px <= 1280 * 720 ? 0.01 : px <= 1920 * 1080 ? 0.02 : 0.08;
  return Math.round(rate * (fps && fps > 30 ? 2 : 1) * seconds * 1000) / 1000;
}

async function falUpload(file, mime, key, signal) {
  let last;
  for (const base of ['https://rest.alpha.fal.ai', 'https://rest.fal.ai']) {
    const r = await fetch(`${base}/storage/upload/initiate?storage_type=fal-cdn-v3`, { method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: mime, file_name: path.basename(file) }), signal }).catch((e) => ({ ok: false, err: e }));
    if (!r.ok) { last = r.err || await httpError('fal upload', r); continue; }
    const { upload_url: put, file_url: url } = await r.json();
    const up = await fetch(put, { method: 'PUT', headers: { 'Content-Type': mime }, body: await fsp.readFile(file), signal });
    if (!up.ok) throw await httpError('fal upload', up);
    return url;
  }
  throw last || new Error('fal upload failed');
}

/** Upscale (and optionally interpolate) a clip with Topaz on fal. Returns a local file path. */
export async function topazUpscale({ file, factor, targetFps, model = 'Proteus', signal, onStatus, outDir }) {
  const key = getSettings().falKey;
  if (!key) throw new ProviderError('fal', 0, 'no fal.ai key — add one in Providers to use cloud upscaling');
  onStatus?.({ message: 'Uploading to fal.ai' });
  const url = await falUpload(file, 'video/mp4', key, signal);
  const input = { video_url: url, model, upscale_factor: Math.round(factor * 100) / 100, H264_output: true, ...(targetFps ? { target_fps: targetFps } : {}) };
  const r = await falRun({ key, endpoint: 'fal-ai/topaz/upscale/video', input, onStatus, signal });
  const src = r.video?.url;
  if (!src) throw new Error('fal Topaz returned no video');
  const res = await fetch(src, { signal });
  if (!res.ok) throw await httpError('fal download', res);
  const out = path.join(outDir || TMP, `topaz_${uid()}.mp4`);
  await fsp.writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

/** ElevenLabs voice isolation: speech in, speech out (music / ambience / noise removed). Returns a file path. */
export async function elevenIsolate({ file, signal, outDir }) {
  const key = getSettings().elevenKey;
  if (!key) throw new ProviderError('elevenlabs', 0, 'no ElevenLabs key — add one in Providers to use voice isolation');
  const fd = new FormData();
  fd.append('audio', new Blob([await fsp.readFile(file)], { type: 'audio/wav' }), 'audio.wav');
  let res;
  try {
    res = await fetch('https://api.elevenlabs.io/v1/audio-isolation', { method: 'POST', headers: { 'xi-api-key': key }, body: fd, signal: signal || AbortSignal.timeout(600000) });
  } catch (e) {
    if (signal?.aborted) throw new Error('cancelled');
    throw new ProviderError('elevenlabs', 0, e.cause?.code || e.message, { retryable: true });
  }
  if (!res.ok) throw await httpError('elevenlabs', res);
  const type = res.headers.get('content-type') || '';
  const out = path.join(outDir || TMP, `iso_${uid()}.${/wav/.test(type) ? 'wav' : 'mp3'}`);
  await fsp.writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

/* ---------------- jobs ---------------- */

const jobs = new Map();
const view = ({ ctrl, ...j }) => j;
function newJob(kind, sourceId, options) {
  const job = { id: uid('pj_'), kind, sourceId, options, status: 'queued', message: 'Queued', progress: 0, createdAt: now(), ctrl: new AbortController(), timings: {} };
  jobs.set(job.id, job);
  if (jobs.size > 300) jobs.delete(jobs.keys().next().value);
  return job;
}
export const getJob = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
export const listJobs = (sourceId) => [...jobs.values()].filter((j) => !sourceId || j.sourceId === sourceId || j.assetId === sourceId).map(view).reverse();
export function cancelJob(id) {
  const j = jobs.get(id);
  if (j && ['queued', 'running'].includes(j.status)) j.ctrl.abort();
  return j ? view(j) : null;
}

/** Heavy step of a job: shows `queued` (with the queue position) while waiting for a worker, then the step again. */
function jobSlot(job, signal, fn) {
  const label = job.message;
  return withSlot(() => { job.status = 'running'; job.message = label; return fn(); }, { signal, onWait: (n) => { job.status = 'queued'; job.message = `Waiting for a free worker (${n} ahead)`; } });
}

function runJob(job, fn) {
  const { signal } = job.ctrl;
  const step = (name, from, to) => {
    const t = Date.now();
    job.status = 'running';
    job.message = name;
    job.progress = from;
    return { done: () => { job.timings[name] = Math.round((Date.now() - t) / 100) / 10; job.progress = to; }, progress: (f) => { job.progress = Math.round((from + (to - from) * f) * 1000) / 1000; } };
  };
  fn({ signal, step, status: (m) => { job.message = m; } })
    .then((r) => Object.assign(job, { status: 'done', message: 'Done', progress: 1, ...r }))
    .catch((e) => Object.assign(job, { status: signal.aborted ? 'cancelled' : 'error', error: e.message, message: signal.aborted ? 'Cancelled' : e.message }))
    .finally(() => { job.finishedAt = now(); });
  return view(job);
}

/* ---------------- enhance one video ---------------- */

export const ENHANCE_DEFAULTS = { subtitles: 'off', language: 'auto', translate: false, subtitleStyle: 'clean', audio: 'off', loudness: true, denoise: false, smoothMotion: 'off', upscale: 'off', vad: true };

/** Normalise user options (unknown values fall back to defaults so the Apple app can send partial bodies). */
export function enhanceOptions(body = {}) {
  const o = { ...ENHANCE_DEFAULTS };
  const pick = (k, allowed) => { if (body[k] != null && allowed.includes(body[k])) o[k] = body[k]; };
  pick('subtitles', ['off', 'soft', 'burn']);
  pick('subtitleStyle', ['clean', 'box']);
  pick('audio', Object.keys(AUDIO_MODES));
  pick('smoothMotion', ['off', 'auto']);
  pick('upscale', ['off', '1080p', '1440p', '2160p']);
  if (typeof body.language === 'string' && /^(auto|[a-z]{2,3})$/.test(body.language)) o.language = body.language;
  o.translate = !!body.translate;
  o.vad = body.vad !== false;
  o.loudness = body.loudness !== false;
  o.denoise = body.denoise === true || body.denoise === 'on';
  return o;
}

/** What an enhance would cost in the cloud (USD for fal, credits for ElevenLabs). */
export function estimate(info, o) {
  const out = { usd: 0, elevenCredits: 0, notes: [] };
  if (o.upscale !== 'off') {
    const size = upscaleSize(info, o.upscale);
    if (size) { out.usd += topazCost(size, info.duration, o.smoothMotion === 'auto' && info.fps < 23 ? 24 : info.fps); out.notes.push(`Topaz ${size.width}×${size.height}`); }
  }
  if (o.audio === 'isolate' && info.hasAudio) { out.elevenCredits = Math.ceil((info.duration / 60) * 1000); out.notes.push('ElevenLabs voice isolation'); }
  return out;
}

export function startEnhance(assetId, body = {}) {
  const src = getAsset(assetId);
  if (!src || src.kind !== 'video') throw Object.assign(new Error('video not found'), { status: 404 });
  const o = enhanceOptions(body);
  const job = newJob('enhance', assetId, o);
  return runJob(job, (ctx) => enhance(src, o, ctx, job));
}

async function enhance(src, o, { signal, step }, job) {
  const dir = await fsp.mkdtemp(path.join(TMP, 'enh-'));
  try {
    let file = assetPath(src);
    let info = await probe(file);
    // Sound always comes from the original: a cloud upscale may return picture only.
    const audioSrc = file;
    const srcInfo = info;
    job.estimate = estimate(info, o);
    const size = o.upscale !== 'off' ? upscaleSize(info, o.upscale) : null;
    const slot = (fn) => jobSlot(job, signal, fn);

    // 1. Cloud upscale first (Topaz can also interpolate) — no local slot needed while fal works.
    let interpolatedInCloud = false;
    if (size) {
      const s = step('Upscaling with Topaz (fal.ai)', 0.02, 0.35);
      const targetFps = o.smoothMotion === 'auto' && info.fps < 23 ? 24 : null;
      file = await topazUpscale({ file, factor: size.factor, targetFps, signal, outDir: dir, onStatus: ({ message, progress }) => { job.message = `Topaz: ${message}`; if (progress != null) s.progress(progress); } });
      interpolatedInCloud = !!targetFps;
      info = await probe(file);
      s.done();
    }

    // 2. Audio: cleanup (CPU or ElevenLabs) → 48 kHz float WAV, then pass-one loudness.
    let audio = null;
    let measured = null;
    if (srcInfo.hasAudio && (o.audio !== 'off' || o.loudness || o.subtitles !== 'off')) {
      audio = path.join(dir, 'audio.wav');
      if (o.audio === 'isolate') {
        const s = step('Isolating voices (ElevenLabs)', 0.36, 0.45);
        const raw = path.join(dir, 'raw.wav');
        await exec(FFMPEG, ['-y', '-v', 'error', '-i', audioSrc, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', raw], { signal });
        const iso = await elevenIsolate({ file: raw, signal, outDir: dir });
        await exec(FFMPEG, ['-y', '-v', 'error', '-i', iso, '-af', `aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${srcInfo.duration.toFixed(3)}`, '-t', srcInfo.duration.toFixed(3), '-c:a', 'pcm_f32le', audio], { signal });
        s.done();
      } else {
        const s = step(o.audio === 'off' ? 'Reading audio' : 'Cleaning up dialogue', 0.36, 0.45);
        await slot(() => exec(FFMPEG, ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:2', '-i', audioSrc, '-vn', '-af', ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', ...audioChain(o.audio)].join(','), '-c:a', 'pcm_f32le', audio], { signal, duration: srcInfo.duration, onProgress: s.progress }));
        s.done();
      }
      if (o.loudness) {
        const s = step('Measuring loudness', 0.45, 0.48);
        measured = await measureLoudness(audio, { signal });
        job.loudnessBefore = measured;
        s.done();
      }
    }

    // 3. Subtitles from the cleaned audio.
    let transcript = null;
    let cueFiles = null;
    if (o.subtitles !== 'off' && audio) {
      const s = step('Transcribing (whisper.cpp)', 0.48, 0.7);
      transcript = await slot(() => transcribe(audio, { language: o.language, translate: o.translate, vad: o.vad, signal, onProgress: s.progress }));
      transcript.cues = clampCues(transcript.cues, info.duration);
      if (transcript.cues.length) {
        cueFiles = { srt: path.join(dir, 'subs.srt'), ass: path.join(dir, 'subs.ass') };
        await fsp.writeFile(cueFiles.srt, toSrt(transcript.cues));
        await fsp.writeFile(cueFiles.ass, toAss(transcript.cues, { W: info.width, H: info.height, font: SUB_FONT, style: o.subtitleStyle }));
      }
      s.done();
    }

    // 4. One encode pass: picture filters (+ burn-in) and mastered audio. After a Topaz pass the picture is already
    //    denoised (and interpolated if asked) — running nlmeans on its larger frames would only cost time.
    const chain = pictureChain({ ...o, denoise: o.denoise && !size, smoothMotion: interpolatedInCloud ? 'off' : o.smoothMotion }, info);
    const vf = [...chain.pre];
    if (chain.fps) vf.push(chain.fps);
    if (o.subtitles === 'burn' && cueFiles) vf.push(`ass=${safeArg(cueFiles.ass)}`);
    const reencode = vf.length > 0;
    const out = newAssetPath('video/mp4');
    const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:2', '-i', file];
    if (audio) args.push('-i', audio);
    const subIn = o.subtitles === 'soft' && cueFiles ? (audio ? 2 : 1) : null;
    if (subIn != null) args.push('-i', cueFiles.srt);
    args.push('-map', '0:v:0');
    if (audio) args.push('-map', '1:a:0'); else if (info.hasAudio) args.push('-map', '0:a:0'); else if (srcInfo.hasAudio) { args.splice(args.indexOf(file) + 1, 0, '-i', audioSrc); args.push('-map', '1:a:0'); }
    if (subIn != null) args.push('-map', `${subIn}:s:0`);
    if (reencode) args.push('-vf', [...vf, 'format=yuv420p'].join(','), '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', '17', '-threads', String(THREADS), '-filter_threads', String(Math.min(THREADS, 8)), '-x264-params', 'aq-mode=3');
    else args.push('-c:v', 'copy');
    if (audio) args.push('-af', o.loudness ? loudnormFilter(measured) : PIN_48K, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
    else if (info.hasAudio || srcInfo.hasAudio) args.push('-c:a', 'copy');
    if (subIn != null) args.push('-c:s', 'mov_text', '-metadata:s:s:0', `language=${iso639_2(transcript.language)}`, '-metadata:s:s:0', 'handler_name=Subtitles');
    args.push('-movflags', '+faststart', out.abs);
    {
      const label = [reencode && (size ? 'Upscaling' : 'Enhancing picture'), chain.fps && 'interpolating frames', o.subtitles === 'burn' && cueFiles && 'burning in subtitles', audio && o.loudness && 'mastering audio'].filter(Boolean).join(', ') || 'Muxing';
      const s = step(label[0].toUpperCase() + label.slice(1), 0.7, 0.97);
      await (reencode ? slot(() => exec(FFMPEG, args, { signal, duration: info.duration, onProgress: s.progress })) : exec(FFMPEG, args, { signal, duration: info.duration, onProgress: s.progress }));
      s.done();
    }

    const outInfo = await probe(out.abs);
    const posterOut = newAssetPath('image/jpeg');
    let posterId = null;
    try {
      await exec(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.min(1, outInfo.duration / 2)), '-i', out.abs, '-frames:v', '1', '-q:v', '3', posterOut.abs], { signal });
      posterId = (await addAsset({ ...posterOut, mime: 'image/jpeg', meta: { source: 'poster' } })).id;
    } catch {}
    const asset = await addAsset({ ...out, mime: 'video/mp4', meta: {
      source: 'enhanced', parentId: src.id, model: src.model ? `${src.model} · enhanced` : 'Enhanced', prompt: src.prompt || src.name || '',
      width: outInfo.width, height: outInfo.height, duration: outInfo.duration, hasAudio: outInfo.hasAudio, enhance: o,
      ...(posterId ? { posterId, posterUrl: getAsset(posterId).url } : {}),
    } });
    const result = { assetId: asset.id, url: asset.url, posterUrl: asset.posterUrl || null, duration: outInfo.duration, width: outInfo.width, height: outInfo.height };
    if (transcript) result.transcript = await saveTranscript(asset, transcript);
    if (audio && o.loudness) result.loudness = await loudnessReport(out.abs, { signal }).catch(() => null);
    return result;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------------- transcribe-only job ---------------- */

export function startTranscribe(assetId, body = {}) {
  const src = getAsset(assetId);
  if (!src || !['video', 'audio'].includes(src.kind)) throw Object.assign(new Error('media not found'), { status: 404 });
  const o = enhanceOptions(body);
  const job = newJob('transcribe', assetId, { language: o.language, translate: o.translate, vad: o.vad });
  return runJob(job, async ({ signal, step }) => {
    const s = step('Transcribing (whisper.cpp)', 0, 0.95);
    const t = await jobSlot(job, signal, () => transcribe(assetPath(src), { language: o.language, translate: o.translate, vad: o.vad, signal, onProgress: s.progress }));
    s.done();
    const transcript = await saveTranscript(src, t);
    return { assetId: src.id, url: src.url, transcript: { ...transcript, text: t.text } };
  });
}

/* ---------------- long-form assembly hooks ---------------- */

/** Brief fields the long-form studio adds for post-production (merged into longform's defaults). */
export const POST_BRIEF_DEFAULTS = {
  subtitles: 'off', // off | soft | burn
  subtitleLanguage: 'auto',
  subtitleStyle: 'clean', // clean | box
  translateSubtitles: false,
  audioCleanup: 'off', // off | clean | isolate
  colorMatch: false,
  smoothMotion: 'auto', // auto: motion-interpolate clips below 23 fps (e.g. Wan 16 fps) instead of duplicating frames
  upscale: 'off', // off | topaz — cloud upscale of clips smaller than the master frame
};

const hash = (x) => crypto.createHash('md5').update(JSON.stringify(x)).digest('hex').slice(0, 8);

/**
 * Per-shot inputs and filters for the conform step. Returns [{ file, vfx, afx, key }] (key is ''
 * when nothing changes, so existing segment caches stay valid). Expensive derived inputs (Topaz
 * upscales, ElevenLabs isolation) are cached on the source asset and reused on re-assembly.
 */
export async function prepareShots({ shots, brief, W, H, onStatus }) {
  const b = { ...POST_BRIEF_DEFAULTS, ...brief };
  const items = [];
  for (const s of shots) {
    const a = getAsset(s.videoId);
    items.push({ shot: s, asset: a, file: assetPath(a), info: await probe(assetPath(a)).catch(() => ({})) });
  }
  if (b.upscale === 'topaz') {
    for (const [k, it] of items.entries()) {
      const fit = Math.min(W / (it.info.width || W), H / (it.info.height || H));
      if (!(fit > 1.15)) continue;
      const cacheKey = `${W}x${H}`;
      let up = getAsset(it.asset.upscaled?.[cacheKey]);
      if (!up) {
        onStatus?.(`Upscaling clip ${k + 1}/${items.length} with Topaz`);
        try {
          const f = await topazUpscale({ file: it.file, factor: Math.min(4, Math.ceil(fit * 4) / 4) });
          const dest = newAssetPath('video/mp4');
          await fsp.rename(f, dest.abs).catch(async () => { await fsp.copyFile(f, dest.abs); await fsp.rm(f, { force: true }); });
          const info = await probe(dest.abs);
          up = await addAsset({ ...dest, mime: 'video/mp4', meta: { source: 'upscaled', hidden: true, parentId: it.asset.id, ...info } });
          updateAsset(it.asset.id, { upscaled: { ...(it.asset.upscaled || {}), [cacheKey]: up.id } });
        } catch (e) { onStatus?.(`Topaz failed for clip ${k + 1}: ${e.message} — using Lanczos`); continue; }
      }
      const upInfo = await probe(assetPath(up)).catch(() => ({}));
      // Topaz may drop the soundtrack: keep taking the sound from the original clip.
      const keepAudio = !upInfo.hasAudio && it.info.hasAudio ? it.file : null;
      Object.assign(it, { file: assetPath(up), derived: up.id, audioFile: keepAudio, info: { ...it.info, width: upInfo.width || it.info.width, height: upInfo.height || it.info.height, fps: upInfo.fps || it.info.fps } });
    }
  }
  if (b.audioCleanup === 'isolate') {
    for (const [k, it] of items.entries()) {
      if (!it.info.hasAudio) continue;
      const base = it.asset;
      let iso = getAsset(base.isolatedId);
      if (!iso) {
        onStatus?.(`Isolating voices in clip ${k + 1}/${items.length} (ElevenLabs)`);
        const dir = await fsp.mkdtemp(path.join(TMP, 'iso-'));
        try {
          const raw = path.join(dir, 'raw.wav');
          await exec(FFMPEG, ['-y', '-v', 'error', '-i', assetPath(base), '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', raw]);
          const f = await elevenIsolate({ file: raw, outDir: dir });
          const dest = newAssetPath('audio/mp4');
          const dur = it.info.duration || 8;
          await exec(FFMPEG, ['-y', '-v', 'error', '-i', f, '-af', `aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${dur.toFixed(3)}`, '-t', dur.toFixed(3), '-c:a', 'aac', '-b:a', '256k', dest.abs]);
          iso = await addAsset({ ...dest, mime: 'audio/mp4', meta: { source: 'isolated', hidden: true, parentId: base.id } });
          updateAsset(base.id, { isolatedId: iso.id });
        } catch (e) { onStatus?.(`Voice isolation failed for clip ${k + 1}: ${e.message}`); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
      }
      if (iso) it.audioFile = assetPath(iso);
    }
  }
  let plan = items.map(() => null);
  if (b.colorMatch) {
    onStatus?.('Matching colour between shots');
    const stats = [];
    for (const it of items) {
      let st = it.asset.colorStats;
      if (!st || st.v !== 1) {
        st = await withSlot(() => colourStats(it.file, { duration: it.info.duration })).catch(() => null);
        if (st) { st = { ...st, v: 1 }; updateAsset(it.asset.id, { colorStats: st }); }
      }
      stats.push(st);
    }
    plan = colourPlan(stats, items.map((it) => it.shot.sceneId || 'all'));
  }
  return items.map((it, k) => {
    const chain = pictureChain({ smoothMotion: b.smoothMotion }, it.info);
    // Interpolate at the clip's own size, before conform scales it (cheaper, and the 24 fps step becomes a no-op).
    const vfx = { pre: [...chain.pre, ...(chain.fps ? [chain.fps] : [])], post: chain.post };
    const lut = colourFilter(plan[k]);
    if (lut) vfx.post.push(lut);
    const afx = b.audioCleanup === 'clean' ? audioChain('clean') : [];
    const changed = it.derived || it.audioFile || vfx.pre.length || vfx.post.length || afx.length;
    return { file: it.file, audioFile: it.audioFile || null, info: it.info, vfx, afx, colour: plan[k], key: changed ? hash({ d: it.derived, a: it.audioFile && path.basename(it.audioFile), vfx, afx }) : '' };
  });
}

/**
 * Finish a long-form master: subtitles (transcribed from the mix), two-pass loudness to −16 LUFS
 * (linear gain, true peak ≤ −1.5 dBTP), soft MP4 subtitle track or burned-in captions. `input` may be
 * an MP4 (concat) or a PCM MKV (mixed soundtrack). Returns { file, transcript, loudness, timings }.
 */
export async function finishMaster({ input, out, brief, W, H, onStatus }) {
  const b = { ...POST_BRIEF_DEFAULTS, ...brief };
  const dir = await fsp.mkdtemp(path.join(TMP, 'master-'));
  const timings = {};
  const timed = async (k, fn) => { const t = Date.now(); try { return await fn(); } finally { timings[k] = Math.round((Date.now() - t) / 100) / 10; } };
  try {
    const info = await probe(input);
    let transcript = null;
    let subs = null;
    if (b.subtitles !== 'off' && info.hasAudio) {
      onStatus?.('Transcribing dialogue for subtitles');
      try {
        transcript = await timed('transcribe', () => withSlot(() => transcribe(input, { language: b.subtitleLanguage, translate: !!b.translateSubtitles, onProgress: (f) => onStatus?.(`Transcribing dialogue for subtitles · ${Math.round(f * 100)}%`) })));
        transcript.cues = clampCues(transcript.cues, info.duration);
        if (transcript.cues.length) {
          subs = { srt: path.join(dir, 'subs.srt'), ass: path.join(dir, 'subs.ass') };
          await fsp.writeFile(subs.srt, toSrt(transcript.cues));
          await fsp.writeFile(subs.ass, toAss(transcript.cues, { W, H, font: SUB_FONT, style: b.subtitleStyle }));
        }
      } catch (e) { onStatus?.(`Subtitles skipped: ${e.message}`); }
    }
    let measured = null;
    if (info.hasAudio) {
      onStatus?.('Measuring loudness');
      measured = await timed('loudness', () => measureLoudness(input));
    }
    const burn = b.subtitles === 'burn' && subs;
    const soft = b.subtitles === 'soft' && subs;
    const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:2', '-i', input];
    if (soft) args.push('-i', subs.srt);
    args.push('-map', '0:v:0');
    if (info.hasAudio) args.push('-map', '0:a:0');
    if (soft) args.push('-map', '1:s:0');
    if (burn) args.push('-vf', `ass=${safeArg(subs.ass)},format=yuv420p`, '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', '17', '-threads', String(THREADS), '-x264-params', 'aq-mode=3');
    else args.push('-c:v', 'copy');
    if (info.hasAudio) args.push('-af', loudnormFilter(measured), '-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
    if (soft) args.push('-c:s', 'mov_text', '-metadata:s:s:0', `language=${iso639_2(transcript.language)}`, '-metadata:s:s:0', 'handler_name=Subtitles');
    args.push('-movflags', '+faststart', out);
    onStatus?.(burn ? 'Burning in subtitles and mastering audio' : 'Mastering audio');
    const run = () => exec(FFMPEG, args, { duration: info.duration, onProgress: (f) => onStatus?.(`${burn ? 'Burning in subtitles' : 'Mastering audio'} · ${Math.round(f * 100)}%`) });
    await timed('master', () => (burn ? withSlot(run) : run()));
    const loudness = info.hasAudio ? await loudnessReport(out).catch(() => null) : null;
    return { transcript, loudness, measured, timings };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------------- HTTP routes ---------------- */

/** Mount the post-production API on the engine's router: route(method, pattern, handler). */
export function mountRoutes(route, HttpError) {
  const need = (cond, code, msg) => { if (!cond) throw new HttpError(code, msg); };
  route('GET', '/post/capabilities', () => capabilities());
  route('POST', '/post/enhance', ({ body }) => { need(body.assetId, 400, 'assetId required'); try { return startEnhance(body.assetId, body); } catch (e) { throw new HttpError(e.status || 400, e.message); } });
  route('POST', '/post/estimate', async ({ body }) => {
    const a = getAsset(body.assetId);
    need(a?.kind === 'video', 404, 'video not found');
    const info = await probe(assetPath(a));
    return { ...estimate(info, enhanceOptions(body)), info };
  });
  route('POST', '/post/transcribe', ({ body }) => { need(body.assetId, 400, 'assetId required'); try { return startTranscribe(body.assetId, body); } catch (e) { throw new HttpError(e.status || 400, e.message); } });
  route('GET', '/post/jobs', ({ url }) => listJobs(url.searchParams.get('assetId')));
  route('GET', '/post/jobs/:id', ({ params }) => getJob(params.id) || Promise.reject(new HttpError(404, 'job not found')));
  route('POST', '/post/jobs/:id/cancel', ({ params }) => cancelJob(params.id) || Promise.reject(new HttpError(404, 'job not found')));
  route('GET', '/post/transcripts/:assetId', async ({ params }) => (await readTranscript(params.assetId)) || Promise.reject(new HttpError(404, 'no transcript yet — POST /post/transcribe')));
}
