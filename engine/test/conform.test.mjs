// node --test engine/test — conform/concat/mix with real ffmpeg (skipped when ffmpeg is missing).
// Proves every segment's audio is exactly its picture length, so the cut is gap-free, 24 fps, and the
// mixed master's audio runs to the end of the picture (closing narration finishes over black).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.ENGINE_X264_PRESET = 'veryfast'; // has B-frames, like the production preset (ultrafast has none)
const ff = await import('../lib/ffmpeg.js');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const have = spawnSync(FFMPEG, ['-version']).status === 0 && spawnSync(FFPROBE, ['-version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conform-test-'));
const f = (n) => path.join(dir, n);

const sh = (args) => { const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args]); if (r.status) throw new Error(String(r.stderr)); };
function streams(file) {
  const j = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-count_packets', file]).stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { v: Number(v.duration), vstart: Number(v.start_time), astart: a && Number(a.start_time), frames: Number(v.nb_read_packets), rate: v.avg_frame_rate, r: v.r_frame_rate, a: a && Number(a.duration) };
}
// Source clip: `vdur` s of 30 fps picture with `adur` s of tone (adur 0 → no audio track at all).
function source(name, vdur, adur) {
  const args = ['-f', 'lavfi', '-i', `testsrc=s=320x180:r=30:d=${vdur}`];
  if (adur) args.push('-f', 'lavfi', '-i', `sine=f=440:r=48000:d=${adur}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(adur ? ['-c:a', 'aac'] : []), f(name));
  sh(args);
  return f(name);
}

// A decoded AAC file may keep its last frame's padding (ffmpeg 5.1 doesn't trim it): up to 1024 samples, at the end only.
const tailOk = (audio, picture) => audio - picture > -0.005 && audio - picture < 1024 / 48000 + 0.001;
// Decoded audio (mono s16 at 48 kHz) and the times where a marker beep starts after silence.
function decode(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  if (r.status) throw new Error(String(r.stderr));
  return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 1);
}
function onsets(pcm, gap = 0.3) {
  const out = [];
  let last = -Infinity;
  const thr = 0.02 * 32768;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) < thr) continue;
    if (i - last > gap * 48000) out.push(i / 48000);
    last = i;
  }
  return out;
}

test('conform: short audio padded, long audio trimmed, picture whole 24 fps frames; concat is gap-free', { skip: !have && 'ffmpeg not installed' }, async () => {
  const srcs = [
    { file: source('short.mp4', 5, 3.584), hasAudio: true, duration: 5 }, // animatic-like: audio ends early
    { file: source('long.mp4', 5, 5.4), hasAudio: true, duration: 5 }, // extra source audio past the picture end
    { file: source('silent.mp4', 4.2, 0), hasAudio: false, duration: 4.2 },
    { file: source('trimmed.mp4', 6, 6), hasAudio: true, start: 1.3, duration: 3.33, fadeOut: 0.4 },
  ];
  const segs = [];
  let total = 0;
  for (const [k, s] of srcs.entries()) {
    const out = f(`seg${k}.mp4`);
    const r = await ff.conform({ input: s.file, out, W: 320, H: 180, start: s.start || 0, duration: s.duration, fadeOut: s.fadeOut || 0, hasAudio: s.hasAudio });
    const st = streams(out);
    const want = ff.segmentLength(s.duration);
    assert.equal(r.duration, want);
    assert.equal(st.frames, Math.round(want * 24), `segment ${k} frame count`);
    assert.ok(Math.abs(st.a - want) < 0.005, `segment ${k} audio ${st.a} vs picture ${want}`);
    assert.ok(Math.abs(st.v - want) < 0.005, `segment ${k} video ${st.v} vs ${want}`);
    segs.push(out);
    total += want;
  }
  // No duration given (Stitch tool): the picture length comes from the source's video stream.
  const r = await ff.conform({ input: srcs[1].file, out: f('nodur.mp4'), W: 320, H: 180, hasAudio: true });
  assert.equal(r.frames, 120);
  assert.ok(Math.abs(streams(f('nodur.mp4')).a - 5) < 0.005);

  await ff.concat({ segments: segs, out: f('cut.mp4') });
  const cut = streams(f('cut.mp4'));
  assert.equal(cut.frames, Math.round(total * 24));
  assert.equal(cut.rate, '24/1', `cut frame rate ${cut.rate}`);
  assert.ok(Math.abs(cut.v - total) < 0.01, `cut video ${cut.v} vs ${total}`);
  // Decoded, not container durations: the muxer's timestamp fix-ups can hide audio that really runs long.
  const cutA = decode(f('cut.mp4')).length / 48000;
  assert.ok(tailOk(cutA, total), `cut audio decodes to ${cutA}s vs picture ${total}s`);
  assert.ok(Math.abs(cut.vstart - cut.astart) < 0.001, `cut picture starts at ${cut.vstart}s, sound at ${cut.astart}s`);

  // Mix: narration line near the end outruns the picture → extendTail, then the mix must cover it all.
  const voice = f('line.m4a');
  sh(['-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=3', '-c:a', 'aac', voice]);
  const lineStart = total - 1.5;
  const tail = lineStart + 3 + 0.8 - total;
  await ff.extendTail({ video: f('cut.mp4'), out: f('cut.tail.mp4'), seconds: tail });
  await ff.mixSoundtrack({ video: f('cut.tail.mp4'), out: f('mix.mov'), voice: [{ file: voice, start: lineStart, duration: 3 }], normalize: false });
  await ff.normalizeAudio({ video: f('mix.mov'), out: f('master.mp4') });
  const m = streams(f('master.mp4'));
  const mA = decode(f('master.mp4')).length / 48000;
  assert.ok(tailOk(mA, m.v), `master audio decodes to ${mA}s vs picture ${m.v}s`);
  assert.ok(mA >= lineStart + 3, 'closing narration line plays to its end');
  assert.equal(m.rate, '24/1');
});

test('concat keeps every segment\'s sound on its picture: no drift at the cuts', { skip: !have && 'ffmpeg not installed' }, async () => {
  // Odd lengths (not on the AAC 1024-sample grid); each source has a short beep at t=0 and silence after it.
  const lens = [1.3, 0.9, 1.7, 1.25, 2.1, 0.8, 1.45, 1.05, 1.9, 1.15, 0.95, 1.6];
  const segs = [];
  const starts = [];
  let t = 0;
  for (const [k, d] of lens.entries()) {
    const src = f(`beep${k}.mp4`);
    sh(['-f', 'lavfi', '-i', `testsrc=s=160x90:r=30:d=${d + 0.5}`, '-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=0.08', '-af', 'apad', '-t', String(d + 0.5),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    const out = f(`bseg${k}.mp4`);
    await ff.conform({ input: src, out, W: 160, H: 90, duration: d, hasAudio: true });
    segs.push(out);
    starts.push(t);
    t += ff.segmentLength(d);
  }
  await ff.concat({ segments: segs, out: f('bcut.mp4') });
  await ff.normalizeAudio({ video: f('bcut.mp4'), out: f('bmaster.mp4') });
  for (const file of ['bcut.mp4', 'bmaster.mp4']) {
    const pcm = decode(f(file));
    const st = streams(f(file));
    assert.equal(st.frames, Math.round(t * 24), `${file} frames`);
    assert.ok(Math.abs(st.vstart - st.astart) < 0.001, `${file}: picture starts at ${st.vstart}s, sound at ${st.astart}s`);
    assert.ok(tailOk(pcm.length / 48000, t), `${file}: decoded audio ${pcm.length / 48000}s vs picture ${t}s`);
    const got = onsets(pcm);
    assert.equal(got.length, starts.length, `${file}: one beep per segment (${got.map((x) => x.toFixed(3))})`);
    for (const [k, s] of starts.entries()) assert.ok(Math.abs(got[k] - s) < 0.006, `${file}: segment ${k} sound at ${got[k].toFixed(4)}s, picture cut at ${s.toFixed(4)}s`);
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
