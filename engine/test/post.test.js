// node --test engine/test — pure parts of engine/lib/post.js (no ffmpeg / whisper needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENGINE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'post-test-'));
const post = await import('../lib/post.js');

test('audioChain: off/isolate add no CPU filters, clean uses the RNNoise std model from the model dir', () => {
  assert.deepEqual(post.audioChain('off'), []);
  assert.deepEqual(post.audioChain('isolate'), []);
  assert.deepEqual(post.audioChain('clean', { rnnDir: '/m/rnn' }), ['arnndn=m=/m/rnn/std.rnnn:mix=0.85']);
  assert.throws(() => post.audioChain('clean', { rnnDir: "/bad:path'" }));
  assert.deepEqual(Object.keys(post.AUDIO_MODES), ['off', 'clean', 'isolate']);
});

const LN = `[Parsed_loudnorm_1 @ 0x1]
{
	"input_i" : "-22.47",
	"input_tp" : "-7.71",
	"input_lra" : "4.30",
	"input_thresh" : "-32.55",
	"output_i" : "-16.20",
	"output_tp" : "-1.50",
	"output_lra" : "3.40",
	"output_thresh" : "-26.24",
	"normalization_type" : "dynamic",
	"target_offset" : "0.20"
}`;

test('parseLoudnorm + loudnormFilter build a linear second pass and pin the output format', () => {
  const m = post.parseLoudnorm(LN);
  assert.deepEqual(m, { I: -22.47, TP: -7.71, LRA: 4.3, thresh: -32.55, offset: 0.2 });
  const f = post.loudnormFilter(m);
  assert.match(f, /^loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-22.47:measured_TP=-7.71:measured_LRA=4.3:measured_thresh=-32.55:offset=0.2:linear=true/);
  assert.ok(f.endsWith('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'));
  assert.ok(post.loudnormFilter(null).startsWith('loudnorm=I=-16:TP=-1.5:LRA=11,'), 'falls back to one-pass');
  assert.ok(post.loudnormFilter({ ...m, I: -70 }).startsWith('anull,'), 'leaves silence alone');
  assert.equal(post.parseLoudnorm('no json here'), null);
});

test('upscaleSize keeps aspect, rounds to even, never shrinks', () => {
  assert.deepEqual(post.upscaleSize({ width: 1280, height: 720 }, '1080p'), { width: 1920, height: 1080, factor: 1.5 });
  assert.deepEqual(post.upscaleSize({ width: 720, height: 1280 }, '1080p'), { width: 1080, height: 1920, factor: 1.5 });
  assert.equal(post.upscaleSize({ width: 1920, height: 1080 }, '1080p'), null);
  assert.equal(post.upscaleSize({ width: 1920, height: 1080 }, 'off'), null);
  const r = post.upscaleSize({ width: 854, height: 480 }, '2160p');
  assert.equal(r.height, 2160);
  assert.equal(r.width % 2, 0);
});

test('pictureChain: interpolation only for genuinely low frame rates in auto mode', () => {
  assert.equal(post.pictureChain({ smoothMotion: 'auto' }, { fps: 24 }).fps, null);
  assert.match(post.pictureChain({ smoothMotion: 'auto' }, { fps: 16 }).fps, /^minterpolate=fps=24:/);
  assert.equal(post.pictureChain({ smoothMotion: 'off' }, { fps: 16 }).fps, null);
  assert.equal(post.pictureChain({ smoothMotion: 'auto' }, {}).fps, null, 'unknown fps: leave alone');
  assert.deepEqual(post.pictureChain({ denoise: true }, { fps: 24 }), { pre: [post.PICTURE.denoise], fps: null, post: [] });
  assert.deepEqual(post.pictureChain({}, { fps: 24 }), { pre: [], fps: null, post: [] });
});

const stats = (yLow, yAvg, yHigh, u = 128, v = 128) => ({ yLow, yAvg, yHigh, u, v, sat: 20 });

test('parseSignalstats takes medians over sampled frames', () => {
  const txt = ['frame:0', 'lavfi.signalstats.YLOW=30', 'lavfi.signalstats.YAVG=100', 'lavfi.signalstats.YHIGH=180', 'lavfi.signalstats.UAVG=126', 'lavfi.signalstats.VAVG=131', 'lavfi.signalstats.SATAVG=12',
    'frame:1', 'lavfi.signalstats.YLOW=32', 'lavfi.signalstats.YAVG=104', 'lavfi.signalstats.YHIGH=182', 'lavfi.signalstats.UAVG=127', 'lavfi.signalstats.VAVG=130', 'lavfi.signalstats.SATAVG=13',
    'frame:2', 'lavfi.signalstats.YLOW=90', 'lavfi.signalstats.YAVG=200', 'lavfi.signalstats.YHIGH=230', 'lavfi.signalstats.UAVG=120', 'lavfi.signalstats.VAVG=140', 'lavfi.signalstats.SATAVG=30'].join('\n');
  assert.deepEqual(post.parseSignalstats(txt), { yLow: 32, yAvg: 104, yHigh: 182, u: 126, v: 131, sat: 13, n: 3 });
  assert.equal(post.parseSignalstats(''), null);
});

test('colourPlan pulls an outlier shot toward its scene, leaves matched shots and lone scenes alone', () => {
  const s = [stats(20, 100, 200), stats(21, 101, 199), stats(40, 130, 215, 122, 136), stats(10, 60, 150)];
  const plan = post.colourPlan(s, ['a', 'a', 'a', 'b']);
  assert.equal(plan[0], null);
  assert.equal(plan[1], null);
  assert.equal(plan[3], null, 'only shot in its scene');
  const c = plan[2];
  assert.ok(c);
  const map = (y) => c.m2 + (y < c.m ? c.lo : c.hi) * (y - c.m);
  assert.ok(map(130) < 130 && map(130) > 100, `mid-tone moved toward 100: ${map(130)}`);
  assert.ok(Math.abs(map(40) - 20) < Math.abs(40 - 20), 'black level moves toward the scene');
  assert.ok(Math.abs(map(215) - 200) < Math.abs(215 - 200), 'highlights move toward the scene');
  assert.ok(c.du > 0 && c.dv < 0, 'chroma cast pulled back');
  assert.match(post.colourFilter(c), /^lutyuv=y='clip\([\d.]+\+if\(lt\(val,[\d.]+\),[\d.]+,[\d.]+\)\*\(val-[\d.]+\),16,235\)':u='clip\(val\+[\d.]+,16,240\)':v='clip\(val\+-[\d.]+,16,240\)'$/);
  assert.equal(post.colourFilter(null), null);
});

test('colourPlan: normal blacks + dull highlights get a highlight lift without crushing shadows', () => {
  // The case a single linear gain got wrong on the real courtroom clips (blacks 29 → 19).
  const plan = post.colourPlan([stats(33, 91.8, 211), stats(33, 89.7, 182), stats(29, 89.8, 168), stats(26, 88.7, 199)], ['s', 's', 's', 's']);
  const c = plan[2];
  const map = (y) => c.m2 + (y < c.m ? c.lo : c.hi) * (y - c.m);
  assert.ok(map(29) >= 27, `blacks stay put: ${map(29)}`);
  assert.ok(map(168) > 180, `highlights lifted: ${map(168)}`);
});

test('colourPlan caps corrections so a deliberately dark shot stays dark-ish', () => {
  const plan = post.colourPlan([stats(20, 120, 220), stats(20, 120, 220), stats(5, 40, 90)], ['x', 'x', 'x']);
  const c = plan[2];
  assert.ok(c.lo <= 1.25 + 1e-9 && c.hi <= 1.25 + 1e-9);
  assert.ok(Math.abs(c.m2 - 40) <= 18 + 1e-6);
});

test('dtwPreset follows the model file', () => {
  assert.equal(post.dtwPreset('/opt/post/models/ggml-large-v3-turbo-q8_0.bin'), 'large.v3.turbo');
  assert.equal(post.dtwPreset('ggml-large-v3.bin'), 'large.v3');
  assert.equal(post.dtwPreset('ggml-small.en-q5_1.bin'), 'small.en');
  assert.equal(post.dtwPreset('ggml-medium-q5_0.bin'), 'medium');
  assert.equal(post.dtwPreset('custom.bin'), '');
});

test('topazCost follows fal pricing tiers', () => {
  assert.equal(post.topazCost({ width: 1280, height: 720 }, 10), 0.1);
  assert.equal(post.topazCost({ width: 1920, height: 1080 }, 8), 0.16);
  assert.equal(post.topazCost({ width: 3840, height: 2160 }, 8), 0.64);
  assert.equal(post.topazCost({ width: 1920, height: 1080 }, 8, 60), 0.32);
});

test('enhanceOptions validates input and estimate prices cloud steps', () => {
  const o = post.enhanceOptions({ subtitles: 'burn', audio: 'isolate', upscale: '1080p', smoothMotion: '60', denoise: 'nope', language: 'de', loudness: false });
  assert.equal(o.subtitles, 'burn');
  assert.equal(o.denoise, false);
  assert.equal(o.smoothMotion, 'off', 'only off/auto are accepted');
  assert.equal(o.language, 'de');
  assert.equal(o.loudness, false);
  assert.equal(post.enhanceOptions({ denoise: true, audio: 'dialogue' }).denoise, true);
  assert.equal(post.enhanceOptions({ audio: 'dialogue' }).audio, 'off', 'removed modes fall back to off');
  const e = post.estimate({ width: 1280, height: 720, duration: 8, fps: 24, hasAudio: true }, o);
  assert.equal(e.usd, 0.16);
  assert.equal(e.elevenCredits, 134);
  assert.equal(post.estimate({ width: 1920, height: 1080, duration: 8, fps: 24, hasAudio: true }, post.enhanceOptions({})).usd, 0);
});

test('worker pool never runs more than WORKERS jobs at once', async () => {
  let live = 0;
  let peak = 0;
  const task = () => post.withSlot(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 20)); live--; });
  await Promise.all([task(), task(), task(), task()]);
  assert.equal(peak, post.WORKERS);
  const ctrl = new AbortController();
  const blocker = post.withSlot(() => new Promise((r) => setTimeout(r, 50)));
  const queued = post.withSlot(() => 'ran', { signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(queued, /cancelled/);
  await blocker;
});
