// ffmpeg helpers for the engine: probing, frames, offline previs, and long-form assembly.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

export function run(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${bin} not found — install ffmpeg (brew install ffmpeg)`) : e));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

export async function hasFfmpeg() {
  try { await run(FFMPEG, ['-hide_banner', '-version']); return true; } catch { return false; }
}

export async function probe(file) {
  const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return { width: v?.width, height: v?.height, duration: Number(j.format?.duration) || undefined, videoDuration: Number(v?.duration) || undefined, hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio') };
}

export const poster = (video, out, at = 0) => run(FFMPEG, ['-y', '-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '3', out]);
export const lastFrame = (video, out) => run(FFMPEG, ['-y', '-v', 'error', '-sseof', '-0.4', '-i', video, '-update', '1', '-q:v', '2', out]);

const even = (n) => Math.round(n / 2) * 2;
export function frameSize(aspect, base = 1280) {
  const [w, h] = String(aspect || '16:9').split(':').map(Number);
  if (!w || !h) return { W: 1280, H: 720 };
  return w >= h ? { W: even(base), H: even((base * h) / w) } : { W: even((base * w) / h), H: even(base) };
}

/** Offline previs plate: gradient + silhouettes seeded by the prompt. */
export async function plate({ out, aspect, prompt = '', signal }) {
  const { W, H } = frameSize(aspect);
  const seed = crypto.createHash('md5').update(prompt).digest();
  const hue = (seed[0] / 255) * 360;
  const hsl = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return '0x' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  const horizon = Math.round(H * (0.55 + (seed[1] / 255) * 0.15));
  const boxes = [];
  for (let x = 0, i = 2; x < W; i++) {
    const w = Math.round(W * (0.04 + (seed[i % 16] / 255) * 0.08));
    const h = Math.round(H * (0.05 + (seed[(i * 7) % 16] / 255) * 0.3));
    if (seed[(i * 3) % 16] > 80) boxes.push(`drawbox=x=${x}:y=${horizon - h}:w=${w}:h=${h}:color=${hsl(hue, 0.25, 0.12)}@0.95:t=fill`);
    x += w + Math.round(W * 0.012);
  }
  const vf = [`drawbox=x=0:y=${horizon}:w=${W}:h=${H - horizon}:color=${hsl(hue, 0.2, 0.1)}:t=fill`, ...boxes, 'vignette=PI/4', 'noise=alls=8:allf=t'].join(',');
  const sky = `gradients=s=${W}x${H}:c0=${hsl(hue, 0.55, 0.32)}:c1=${hsl((hue + 30) % 360, 0.65, 0.7)}:x0=0:y0=0:x1=0:y1=${horizon}:nb_colors=2:speed=0:d=1`;
  try {
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', sky, '-vf', vf, '-frames:v', '1', '-q:v', '2', out], { signal });
  } catch {
    // Older ffmpeg (e.g. Debian's 5.x) has no `gradients` source: flat sky instead.
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${hsl(hue, 0.5, 0.45)}:s=${W}x${H}:d=1`, '-vf', vf, '-frames:v', '1', '-q:v', '2', out], { signal });
  }
}

/** Offline animatic: slow push-in over a still, with a silent audio track. */
export async function animatic({ image, out, duration = 5, aspect, signal }) {
  const { W, H } = frameSize(aspect);
  const N = Math.max(2, Math.round(duration * 24));
  await run(FFMPEG, ['-y', '-v', 'error', '-i', image, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.18*on/${N}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${N}:s=${W}x${H}:fps=24,format=yuv420p`,
    '-frames:v', String(N), '-t', String(N / 24), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out], { signal });
}

/**
 * Conform one clip into a uniform segment (size, 24 fps, AAC stereo) so segments can be
 * concatenated losslessly. Optional trim (start/end), scene fades.
 * Post-production hooks (engine/lib/post.js): vfx.pre / vfx.post filters around the scale step,
 * afx audio filters, and audioInput to take the sound from another file (e.g. an isolated voice track).
 */
/** A segment's real length: conform() renders whole 24 fps frames. */
export const segmentLength = (seconds) => Math.max(1, Math.round(seconds * 24)) / 24;

export async function conform({ input, out, W, H, start = 0, duration, fadeIn = 0, fadeOut = 0, hasAudio, signal, vfx = {}, afx = [], audioInput = null }) {
  // The picture sets the segment length, in whole 24 fps frames; the audio is padded with silence / trimmed to
  // exactly that, so concatenated segments have no gaps at the cuts and the master stays at a true 24 fps.
  let len = duration;
  if (!len) { const info = await probe(input).catch(() => ({})); len = Math.max(0, (info.videoDuration || info.duration || 0) - start); }
  const N = len ? Math.round(segmentLength(len) * 24) : 0;
  const T = (N / 24).toFixed(6);
  const vf = [...(vfx.pre || []), `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`, 'fps=24',
    ...(N ? [`tpad=stop_mode=clone:stop_duration=${T}`] : []), 'setsar=1', 'format=yuv420p', ...(vfx.post || [])];
  const af = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', ...afx];
  if (fadeIn) { vf.push(`fade=t=in:st=0:d=${fadeIn}`); af.push(`afade=t=in:st=0:d=${fadeIn}`); }
  if (fadeOut && duration) { vf.push(`fade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}`); af.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}`); }
  if (N) af.push(`apad=whole_dur=${T}`, `atrim=end=${T}`);
  const args = ['-y', '-v', 'error'];
  if (start) args.push('-ss', start.toFixed(3));
  args.push('-i', input);
  if (audioInput) { if (start) args.push('-ss', start.toFixed(3)); args.push('-i', audioInput); }
  else if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  if (N) args.push('-t', T); // not -frames:v: on ffmpeg 5.1 that closes the whole file, cutting the padded audio short
  args.push('-map', '0:v:0', '-map', hasAudio && !audioInput ? '0:a:0' : '1:a:0', '-vf', vf.join(','), '-af', af.join(','),
    '-c:v', 'libx264', '-preset', process.env.ENGINE_X264_PRESET || 'slow', '-crf', '17', '-r', '24', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    ...(N ? [] : ['-shortest']), '-movflags', '+faststart', out);
  await run(FFMPEG, args, { signal });
  return { frames: N, duration: N / 24 };
}

// Streaming loudness target (−16 LUFS integrated, −1.5 dBTP) so every master plays at a consistent level.
// The explicit aformat matters: ffmpeg 5.1 (the Docker image) can't pick an output layout after loudnorm otherwise.
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** Loudness-normalise a finished video's audio; picture is copied untouched. */
export async function normalizeAudio({ video, out, signal }) {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-af', LOUDNORM, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', out], { signal });
}

/** Pull a clip's soundtrack out as 44.1 kHz WAV (voice-changer input). */
export const extractAudio = (video, out, { signal } = {}) => run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', out], { signal });

/** Swap a clip's audio for a new track (picture copied untouched); the original can stay underneath as a quiet bed. */
export async function replaceAudio({ video, audio, out, bedVolume = 0, signal }) {
  const af = bedVolume > 0
    ? ['-filter_complex', `[1:a]aresample=48000,aformat=channel_layouts=stereo,apad[new];[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${bedVolume}[bed];[new][bed]amix=inputs=2:normalize=0:duration=longest[a]`, '-map', '0:v', '-map', '[a]']
    : ['-map', '0:v', '-map', '1:a', '-af', 'aresample=48000,aformat=channel_layouts=stereo,apad'];
  // apad + -shortest: the picture sets the length, even if the new track comes back a little short.
  await run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-i', audio, ...af, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out], { signal });
}

/** Hold the final frame (black after a scene fade) for extra seconds, padding audio with silence. */
export async function extendTail({ video, out, seconds, signal }) {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-vf', `tpad=stop_mode=clone:stop_duration=${seconds.toFixed(3)}`, '-af', `apad=pad_dur=${seconds.toFixed(3)}`,
    '-c:v', 'libx264', '-preset', process.env.ENGINE_X264_PRESET || 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '24', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out], { signal });
}

/**
 * Concatenate conformed segments. The picture is copied through the concat demuxer; each entry carries its picture
 * length (`duration`), so the next segment starts exactly where this one's last frame ends — ffmpeg 5.1 otherwise
 * offsets by the container length, which the AAC frame grid rounds up, and the master drifts off 24 fps.
 * The sound can't be copied the same way: every AAC segment carries priming and tail-padding packets, which
 * overlap the next file and push the audio ~30 ms later at every cut. So each segment's audio is decoded on its
 * own (the mp4 edit list drops the priming), cut / padded to exactly its picture length in samples, and joined
 * with the concat filter. An .mkv/.mov `out` keeps that as float PCM; .mp4 gets one AAC encode.
 */
export async function concat({ segments, out, signal }) {
  const list = `${out}.txt`;
  const lens = await Promise.all(segments.map((s) => probe(s).then((i) => i.videoDuration).catch(() => null)));
  // Only the picture (conform's track 1) goes through the demuxer: its unused AAC priming would otherwise set the
  // input's start time to -1024 samples and delay the copied video by 21 ms against the audio.
  await fsp.writeFile(list, ['ffconcat version 1.0', 'stream', 'exact_stream_id 1',
    ...segments.map((s, k) => `file '${s.replace(/'/g, "'\\''")}'${lens[k] ? `\nduration ${lens[k].toFixed(6)}` : ''}`)].join('\n'));
  const fit = (k) => { const n = lens[k] && Math.round(lens[k] * 48000); return n ? `,apad=whole_len=${n},atrim=end_sample=${n}` : ''; };
  const graph = segments.map((_, k) => `[${k + 1}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS${fit(k)}[a${k}]`).join(';')
    + `;${segments.map((_, k) => `[a${k}]`).join('')}concat=n=${segments.length}:v=0:a=1[aout]`;
  const pcm = /\.(mkv|mov)$/.test(out);
  try {
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...segments.flatMap((s) => ['-i', s]),
      '-filter_complex', graph, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy',
      ...(pcm ? ['-c:a', 'pcm_f32le'] : ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart']), '-ar', '48000', '-ac', '2', out], { signal });
  } finally {
    await fsp.rm(list, { force: true });
  }
}

/** Convert any audio file to 48 kHz stereo AAC (m4a) and return its duration. */
export async function toM4a(input, out, { signal } = {}) {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', out], { signal });
  return (await probe(out)).duration || 0;
}

/**
 * Lay a soundtrack under a finished picture: clip audio + music cues + narration lines.
 * music: [{ file, start, duration }] (looped/trimmed to fit, faded at both ends)
 * voice: [{ file, start }]
 * Music is ducked automatically while the narrator speaks.
 * normalize: false skips the one-pass loudnorm (post.finishMaster levels the master in two passes);
 * an .mkv `out` keeps the mix as 32-bit float PCM so the master's AAC encode is the only lossy step.
 */
export async function mixSoundtrack({ video, out, music = [], voice = [], musicVolume = 0.35, clipVolume = 1, voiceVolume = 1, signal, normalize = true }) {
  const args = ['-y', '-v', 'error', '-i', video];
  const parts = [];
  let n = 1;
  const musicLabels = [];
  for (const m of music) {
    args.push('-stream_loop', '-1', '-i', m.file);
    // Cues may set their own fades (a cue that enters on a cut comes in almost hard).
    const fade = Math.min(2, m.duration / 4);
    const fi = Math.max(0.01, Math.min(m.fadeIn ?? fade, m.duration / 2));
    const fo = Math.max(0.01, Math.min(m.fadeOut ?? fade, m.duration / 2));
    parts.push(`[${n}:a]atrim=0:${m.duration.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=${fi.toFixed(2)},afade=t=out:st=${Math.max(0, m.duration - fo).toFixed(3)}:d=${fo.toFixed(2)},adelay=${Math.round(m.start * 1000)}:all=1[m${n}]`);
    musicLabels.push(`[m${n}]`);
    n++;
  }
  const voiceLabels = [];
  for (const v of voice) {
    args.push('-i', v.file);
    parts.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(v.start * 1000)}:all=1[v${n}]`);
    voiceLabels.push(`[v${n}]`);
    n++;
  }
  parts.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clipVolume}[clip0]`);
  const mixIn = [];
  // The narrator ducks both the clip's own sound and the score, so dialogue keeps full level elsewhere.
  if (voiceLabels.length) {
    const keys = ['[vkey0]', ...(musicLabels.length ? ['[vkey1]'] : [])];
    // apad: sidechaincompress stops when its sidechain ends, which used to cut the whole film off at the
    // end of the last narration line. The final amix follows the clip track (duration=first) instead.
    parts.push(`${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:normalize=0:dropout_transition=0,volume=${voiceVolume},apad,asplit=${keys.length + 1}[vmix]${keys.join('')}`);
    parts.push('[clip0][vkey0]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=500[clip]');
    mixIn.push('[clip]', '[vmix]');
  } else mixIn.push('[clip0]');
  if (musicLabels.length) {
    parts.push(`${musicLabels.join('')}amix=inputs=${musicLabels.length}:normalize=0:dropout_transition=0,volume=${musicVolume}[mbus]`);
    if (voiceLabels.length) {
      parts.push('[mbus][vkey1]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=600[mduck]');
      mixIn.push('[mduck]');
    } else mixIn.push('[mbus]');
  }
  // End at the picture length (apad + -t), not -shortest: with copied B-frame video (x264 slow), ffmpeg 5.1 ends
  // -shortest at the last video packet's decode time, ~100 ms before the end, which clipped the closing sound.
  const vlen = (await probe(video).catch(() => ({}))).videoDuration;
  parts.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:dropout_transition=0:duration=first,${vlen ? 'apad,' : ''}${normalize ? LOUDNORM : 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'}[aout]`);
  const pcm = /\.(mkv|mov)$/.test(out);
  args.push('-filter_complex', parts.join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', ...(pcm ? ['-c:a', 'pcm_f32le'] : ['-c:a', 'aac', '-b:a', '256k']), '-ar', '48000',
    ...(vlen ? ['-t', vlen.toFixed(6)] : ['-shortest']), ...(pcm ? [] : ['-movflags', '+faststart']), out);
  await run(FFMPEG, args, { signal });
}
