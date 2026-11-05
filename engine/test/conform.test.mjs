// node --test engine/test — conform/concat/mix with real ffmpeg (skipped when ffmpeg is missing).
// Proves every segment's audio is exactly its picture length, so the cut is gap-free, 24 fps, and the
// mixed master's audio runs to the end of the picture (closing narration finishes over black).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.ENGINE_X264_PRESET = 'ultrafast';
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
  return { v: Number(v.duration), frames: Number(v.nb_read_packets), rate: v.avg_frame_rate, r: v.r_frame_rate, a: a && Number(a.duration) };
}
// Source clip: `vdur` s of 30 fps picture with `adur` s of tone (adur 0 → no audio track at all).
function source(name, vdur, adur) {
  const args = ['-f', 'lavfi', '-i', `testsrc=s=320x180:r=30:d=${vdur}`];
  if (adur) args.push('-f', 'lavfi', '-i', `sine=f=440:r=48000:d=${adur}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(adur ? ['-c:a', 'aac'] : []), f(name));
  sh(args);
  return f(name);
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
  assert.ok(Math.abs(cut.a - total) < 0.03, `cut audio ${cut.a} vs ${total}`);

  // Mix: narration line near the end outruns the picture → extendTail, then the mix must cover it all.
  const voice = f('line.m4a');
  sh(['-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=3', '-c:a', 'aac', voice]);
  const lineStart = total - 1.5;
  const tail = lineStart + 3 + 0.8 - total;
  await ff.extendTail({ video: f('cut.mp4'), out: f('cut.tail.mp4'), seconds: tail });
  await ff.mixSoundtrack({ video: f('cut.tail.mp4'), out: f('mix.mov'), voice: [{ file: voice, start: lineStart, duration: 3 }], normalize: false });
  await ff.normalizeAudio({ video: f('mix.mov'), out: f('master.mp4') });
  const m = streams(f('master.mp4'));
  assert.ok(Math.abs(m.a - m.v) < 0.05, `master audio ${m.a} vs picture ${m.v}`);
  assert.ok(m.a >= lineStart + 3, 'closing narration line plays to its end');
  assert.equal(m.rate, '24/1');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
