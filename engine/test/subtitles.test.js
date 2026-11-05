// node --test engine/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhisperJson, dropHallucinations, buildCues, splitLines, toSrt, toVtt, toAss, timestamp, transcriptText, iso639_2, assStyle, clampCues, placeWords } from '../lib/subtitles.js';

const tok = (text, from, to, p = 0.9, dtw = -1) => ({ text, offsets: { from, to }, id: 1, p, t_dtw: dtw });

test('parseWhisperJson rebuilds words from BPE tokens and skips special tokens', () => {
  const j = {
    result: { language: 'en' },
    transcription: [{
      offsets: { from: 0, to: 3000 }, text: ' Hello there, world.',
      tokens: [tok('[_BEG_]', 0, 0), tok(' Hel', 0, 300), tok('lo', 300, 500), tok(' there', 600, 900), tok(',', 900, 950), tok(' world', 1000, 1500), tok('.', 1500, 1550), tok('[_TT_150]', 3000, 3000)],
    }],
  };
  const r = parseWhisperJson(j);
  assert.equal(r.language, 'en');
  assert.deepEqual(r.words.map((w) => w.text), ['Hello', 'there,', 'world.']);
  assert.equal(r.words[0].start, 0);
  assert.equal(r.words[0].end, 0.5);
  assert.equal(r.words[2].end, 1.55);
  assert.equal(r.segments[0].text, 'Hello there, world.');
});

test('parseWhisperJson prefers DTW times and keeps words monotonic inside the segment', () => {
  const j = { transcription: [{ offsets: { from: 1000, to: 2000 }, text: ' a b', tokens: [tok(' a', 1000, 1800, 0.9, 120), tok(' b', 1100, 2500, 0.9, 110)] }] };
  const r = parseWhisperJson(j);
  assert.equal(r.words[0].start, 1);
  assert.ok(r.words[1].start >= r.words[0].start);
  assert.ok(r.words[1].end <= 2);
});

test('parseWhisperJson drops punctuation-only words and empty segments', () => {
  const j = { transcription: [{ offsets: { from: 0, to: 1000 }, text: ' ...', tokens: [tok(' ...', 0, 1000)] }, { offsets: { from: 1000, to: 2000 }, text: '', tokens: [] }] };
  const r = parseWhisperJson(j);
  assert.equal(r.words.length, 0);
  assert.equal(r.segments.length, 1);
});

test('placeWords: VAD-timeline tokens are mapped onto the real segment, collapsed ones spread by length', () => {
  // whisper.cpp with VAD: segment at 19.2–23.8 s, tokens on the speech-only timeline from 0 s.
  const vad = placeWords([{ text: 'On', start: 0, end: 0.16 }, { text: 'all', start: 0.16, end: 0.29 }, { text: 'counts', start: 0.39, end: 0.82 }, { text: 'guilty.', start: 3.9, end: 4.4 }], 19.2, 23.8);
  assert.equal(vad[0].start, 19.2);
  assert.ok(Math.abs(vad.at(-1).end - 23.8) < 1e-9);
  assert.ok(vad[1].start > vad[0].start && vad[2].start > vad[1].start);
  // Every token at one instant → spread across the segment by character count.
  const flat = placeWords(['On', 'all', 'counts', 'of', 'being', 'bipolar'].map((t) => ({ text: t, start: 18.8, end: 18.8 })), 18.8, 23.8);
  assert.equal(flat[0].start, 18.8);
  assert.ok(flat.every((w, i) => !i || w.start > flat[i - 1].start));
  assert.ok(flat.at(-1).end <= 23.8 + 1e-9 && flat.at(-1).end > 23);
  // Normal tokens inside the segment are left alone.
  const ok = [{ text: 'a', start: 1.2, end: 1.5 }, { text: 'b', start: 1.6, end: 2.4 }];
  assert.deepEqual(placeWords(ok, 1, 3), ok);
});

test('parseWhisperJson with VAD: words land inside their segment, not all on its first instant', () => {
  const j = { transcription: [{ offsets: { from: 19200, to: 23800 }, text: ' On all counts guilty.', tokens: [tok(' On', 0, 160), tok(' all', 160, 290), tok(' counts', 390, 820), tok(' guilty', 3900, 4300), tok('.', 4300, 4400)] }] };
  const w = parseWhisperJson(j).words;
  assert.equal(new Set(w.map((x) => x.start)).size, 4);
  assert.ok(w.every((x) => x.start >= 19.2 && x.end <= 23.8));
});

test('dropHallucinations removes low-confidence stock phrases and loops, keeps real speech', () => {
  const r = dropHallucinations({
    words: [{ text: 'Order', start: 0, end: 0.4, p: 0.9 }, { text: 'Thank', start: 10, end: 10.3, p: 0.2 }],
    segments: [
      { text: 'Order in the court.', start: 0, end: 1.5, p: 0.92 },
      { text: 'Thank you for watching!', start: 10, end: 12, p: 0.3 },
      { text: 'Again.', start: 13, end: 14, p: 0.9 }, { text: 'Again.', start: 14, end: 15, p: 0.9 }, { text: 'Again.', start: 15, end: 16, p: 0.9 },
    ],
  });
  assert.deepEqual(r.segments.map((s) => s.text), ['Order in the court.', 'Again.', 'Again.']);
  assert.deepEqual(r.words.map((w) => w.text), ['Order']);
  assert.ok(r.dropped.includes('Thank you for watching!'));
});

test('dropHallucinations keeps a confident "thank you for watching" that was really said', () => {
  const r = dropHallucinations({ words: [], segments: [{ text: 'Thank you for watching.', start: 0, end: 2, p: 0.95 }] });
  assert.equal(r.segments.length, 1);
});

const words = (s, t0 = 0, step = 0.3) => s.split(' ').map((w, i) => ({ text: w, start: t0 + i * step, end: t0 + i * step + step * 0.9 }));

test('buildCues: short sentences become separate cues, all within limits', () => {
  const cues = buildCues([...words('The court will now come to order.'), ...words('Please be seated.', 3)]);
  assert.equal(cues.length, 2);
  for (const c of cues) {
    assert.ok(c.lines.length <= 2);
    for (const l of c.lines) assert.ok(l.length <= 42, l);
    assert.ok(c.end > c.start);
  }
  assert.ok(cues[0].end <= cues[1].start - 0.08 + 1e-9, 'gap between cues');
});

test('buildCues: long run-on speech is split into ≤2×42 char cues no longer than ~6 s', () => {
  const text = 'and then we walked down to the river where the old mill used to stand and nobody had been there for years because the road had washed out in the spring floods and the bridge was gone';
  const cues = buildCues(words(text, 0, 0.25));
  assert.ok(cues.length >= 3);
  for (const c of cues) {
    assert.ok(c.lines.join(' ').length <= 84);
    assert.ok(c.lines.every((l) => l.length <= 42));
    assert.ok(c.end - c.start <= 7.01, `${c.end - c.start}`);
  }
  // Every word appears exactly once, in order.
  assert.equal(cues.map((c) => c.lines.join(' ')).join(' '), text);
});

test('buildCues: a pause starts a new cue; a lone word still shows for the minimum time', () => {
  const cues = buildCues([{ text: 'Yes.', start: 1, end: 1.2 }, { text: 'Later', start: 5, end: 5.3 }, { text: 'on.', start: 5.3, end: 5.6 }]);
  assert.equal(cues.length, 2);
  assert.ok(cues[0].end - cues[0].start >= 1 - 1e-9);
});

test('buildCues: prefers to break an overlong cue at a comma', () => {
  const text = 'If the defendant had told the truth from the start, none of us would be sitting in this room today';
  const cues = buildCues(words(text, 0, 0.2));
  assert.ok(cues[0].lines.join(' ').endsWith('start,'), JSON.stringify(cues));
});

test('splitLines balances and avoids ending a line on a weak word', () => {
  const lines = splitLines('I never said that I was going to the station tonight'.split(' '), 42);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0].length - lines[1].length) <= 12);
  assert.ok(!/\b(the|to)$/.test(lines[0]));
  assert.deepEqual(splitLines(['Short', 'line.'], 42), ['Short line.']);
});

test('timestamps and formats', () => {
  assert.equal(timestamp(3725.5), '01:02:05,500');
  assert.equal(timestamp(0.0004, '.'), '00:00:00.000');
  const cues = [{ start: 1, end: 2.5, lines: ['Hello <world>', 'two'] }];
  assert.equal(toSrt(cues), '1\n00:00:01,000 --> 00:00:02,500\nHello <world>\ntwo\n');
  assert.ok(toVtt(cues).startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:02.500 line:-1\nHello &lt;world&gt;\ntwo'));
  const ass = toAss([{ start: 1, end: 2.5, lines: ['a {b}', 'c\\d'] }], { W: 1280, H: 720 });
  assert.match(ass, /PlayResX: 1280\nPlayResY: 720/);
  assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:02\.50,Default,,0,0,0,,a \\\{b\\\}\\Nc\\\\d/);
});

test('assStyle scales with the frame and lifts captions higher on vertical video', () => {
  const land = assStyle(1920, 1080);
  const vert = assStyle(1080, 1920);
  const small = assStyle(1280, 720);
  assert.ok(land.size > small.size);
  assert.ok(vert.marginV / 1920 > land.marginV / 1080);
  assert.match(assStyle(1920, 1080, { style: 'box' }).line, /,3,\d+,0,2,/);
});

test('clampCues keeps the subtitle track inside the picture', () => {
  const cues = [{ start: 1, end: 2, lines: ['a'] }, { start: 17, end: 19.2, lines: ['b'] }, { start: 18.5, end: 19.5, lines: ['c'] }];
  assert.deepEqual(clampCues(cues, 18.53).map((c) => [c.start, c.end]), [[1, 2], [17, 18.53]]);
  assert.equal(clampCues(cues, 0), cues);
});

test('transcriptText paragraphs on long pauses; iso639_2 maps languages', () => {
  assert.equal(transcriptText([{ text: 'A.', start: 0, end: 1 }, { text: 'B.', start: 1.2, end: 2 }, { text: 'C.', start: 5, end: 6 }]), 'A. B.\n\nC.');
  assert.equal(iso639_2('de'), 'deu');
  assert.equal(iso639_2('EN'), 'eng');
  assert.equal(iso639_2('xx'), 'und');
});
