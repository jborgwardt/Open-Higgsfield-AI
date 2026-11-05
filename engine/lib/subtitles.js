// Pure subtitle helpers: whisper.cpp JSON → words → readable cues → SRT / WebVTT / ASS.
// No I/O here so every rule is unit-testable (engine/test/subtitles.test.js).

/** Tokens whisper.cpp emits that are not speech: [_BEG_], [_TT_123], <|endoftext|>, … */
const SPECIAL = /^\s*(\[_[A-Z_0-9]*\]|<\|[^|]*\|>)\s*$/;
// Things whisper says over music / silence. Only dropped when the model was also unsure.
const HALLUCINATIONS = [
  /^(thank you|thanks) (so much )?for watching/i, /^please subscribe/i, /^subtitles? by/i, /^untertitel (im auftrag|von|der)/i,
  /^vielen dank( fürs zuschauen)?\.?$/i, /amara\.org/i, /^\(?(music|applause|silence|laughs?)\)?\.?$/i, /^\[.*\]$/, /^♪+$/, /^\.+$/,
];

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const endsSentence = (w) => /[.?!…]["'»”)]?$/.test(w);
const endsClause = (w) => /[,;:–—]["'»”)]?$/.test(w);
// Words a line should not end on (EN + DE): moving them to the next line reads better.
const WEAK = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'but', 'in', 'on', 'at', 'for', 'with', 'my', 'your', 'his', 'her', 'is', 'i', 'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'aber', 'zu', 'mit', 'im', 'in', 'am', 'ich']);

/**
 * whisper.cpp `-ojf` JSON → { language, words:[{text,start,end,p}], segments:[{text,start,end,p}] } (seconds).
 * Words are rebuilt from BPE tokens: a token starting with a space opens a new word, everything else
 * (suffixes, punctuation) glues onto the current one. Prefers DTW token times when present.
 */
export function parseWhisperJson(j) {
  const segments = [];
  const words = [];
  for (const seg of j?.transcription || []) {
    const segStart = (seg.offsets?.from ?? 0) / 1000;
    const segEnd = (seg.offsets?.to ?? 0) / 1000;
    const toks = (seg.tokens || []).filter((t) => t && typeof t.text === 'string' && !SPECIAL.test(t.text) && t.text !== '');
    const segWords = [];
    let cur = null;
    for (const t of toks) {
      let t0 = t.offsets ? t.offsets.from / 1000 : null;
      let t1 = t.offsets ? t.offsets.to / 1000 : null;
      if (Number.isFinite(t.t_dtw) && t.t_dtw >= 0) { const d = t.t_dtw / 100; t0 = t0 == null ? d : Math.min(t0, d); if (t1 == null || t1 < d) t1 = d; }
      const startsWord = /^\s/.test(t.text) || !cur;
      const piece = t.text;
      if (startsWord && /\S/.test(piece) && !/^\s*[.,!?;:…'’)\]»”]/.test(piece)) {
        if (cur) segWords.push(cur);
        cur = { text: piece.trim(), start: t0 ?? segStart, end: t1 ?? segEnd, ps: [t.p ?? 1] };
      } else if (cur) {
        cur.text += piece.trim() ? piece.replace(/^\s+/, '') : '';
        if (t1 != null) cur.end = Math.max(cur.end, t1);
        cur.ps.push(t.p ?? 1);
      }
    }
    if (cur) segWords.push(cur);
    const ws = segWords.filter((w) => /[\p{L}\p{N}]/u.test(w.text)).map((w) => ({ text: w.text, start: round3(Math.max(segStart, Math.min(w.start, segEnd))), end: round3(Math.min(segEnd, Math.max(w.end, w.start))), p: round3(avg(w.ps)) }));
    // Token times can run backwards a little; keep them monotonic and inside the segment.
    for (let i = 0; i < ws.length; i++) {
      if (i && ws[i].start < ws[i - 1].start) ws[i].start = ws[i - 1].start;
      if (ws[i].end < ws[i].start) ws[i].end = ws[i].start;
    }
    const text = clean(seg.text);
    if (!text) continue;
    const p = ws.length ? avg(ws.map((w) => w.p)) : 1;
    segments.push({ text, start: round3(segStart), end: round3(segEnd), p: round3(p) });
    words.push(...ws);
  }
  return { language: j?.result?.language || j?.params?.language || null, words, segments };
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Drop segments whisper invents over music/silence: known phrases said with low confidence, and loops. */
export function dropHallucinations({ words, segments, ...rest }, { minP = 0.45 } = {}) {
  const bad = [];
  let prev = '';
  let repeats = 0;
  for (const s of segments) {
    const t = s.text.replace(/^[\s\-–]+/, '');
    repeats = t.toLowerCase() === prev ? repeats + 1 : 0;
    prev = t.toLowerCase();
    const phrase = HALLUCINATIONS.some((re) => re.test(t));
    if ((phrase && s.p < 0.8) || (s.p < minP && t.length < 40 && phrase) || repeats >= 2 || !/[\p{L}\p{N}]/u.test(t)) bad.push(s);
  }
  if (!bad.length) return { words, segments, ...rest };
  const inBad = (w) => bad.some((s) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01);
  return { words: words.filter((w) => !inBad(w)), segments: segments.filter((s) => !bad.includes(s)), dropped: bad.map((s) => s.text), ...rest };
}

export const SUB_DEFAULTS = { maxChars: 42, maxLines: 2, maxDuration: 6, minDuration: 1, minGap: 0.084, pause: 0.7, linger: 0.25, maxCps: 20 };

/**
 * Group words into subtitle cues with broadcast-style rules: ≤ maxChars per line, ≤ 2 lines,
 * ≤ maxDuration, new cue after a sentence end or a pause, balanced line breaks that avoid
 * leaving "the"/"und" at a line end, minimum display time and gaps between cues.
 */
export function buildCues(words, opts = {}) {
  const o = { ...SUB_DEFAULTS, ...opts };
  const cap = o.maxChars * o.maxLines;
  const chunks = [];
  let cur = [];
  const len = (ws) => ws.reduce((n, w, i) => n + w.text.length + (i ? 1 : 0), 0);
  for (const w of words) {
    if (!w?.text) continue;
    if (cur.length) {
      const last = cur.at(-1);
      const gap = w.start - last.end;
      const tooLong = len(cur) + 1 + w.text.length > cap;
      const tooSlow = w.end - cur[0].start > o.maxDuration;
      const sentence = endsSentence(last.text) && (len(cur) >= 10 || gap > 0.25);
      if (gap > o.pause || sentence || tooLong || tooSlow) {
        // Overflowing mid-clause: cut at the last comma in the back half instead of mid-phrase.
        if ((tooLong || tooSlow) && !sentence && gap <= o.pause) {
          const k = lastIndex(cur, (x, i) => endsClause(x.text) && len(cur.slice(0, i + 1)) >= cap * 0.4);
          if (k >= 0 && k < cur.length - 1) { chunks.push(cur.slice(0, k + 1)); cur = cur.slice(k + 1); cur.push(w); continue; }
        }
        chunks.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  const cues = chunks.map((ws) => ({ start: ws[0].start, end: ws.at(-1).end, lines: splitLines(ws.map((w) => w.text), o.maxChars, o.maxLines) }));
  return retime(cues, o);
}

function lastIndex(arr, fn) { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i], i)) return i; return -1; }

/** Best split of a word list into ≤ maxLines lines of ≤ maxChars, balanced, preferring punctuation. */
export function splitLines(tokens, maxChars = 42, maxLines = 2) {
  const text = tokens.join(' ');
  if (text.length <= maxChars || maxLines < 2 || tokens.length < 2) return [text];
  let best = null;
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens.slice(0, i).join(' ');
    const b = tokens.slice(i).join(' ');
    let score = Math.abs(a.length - b.length);
    if (a.length > maxChars) score += 1000 + (a.length - maxChars) * 10;
    if (b.length > maxChars) score += 1000 + (b.length - maxChars) * 10;
    const tail = tokens[i - 1];
    if (endsSentence(tail)) score -= 14; else if (endsClause(tail)) score -= 9;
    if (WEAK.has(tail.toLowerCase())) score += 12;
    if (b.length > a.length) score -= 1; // slight preference for a longer bottom line (pyramid)
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best.lines;
}

function retime(cues, o) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    const limit = next ? next.start - o.minGap : Infinity;
    const chars = c.lines.join(' ').length;
    const want = Math.max(c.end + o.linger, c.start + o.minDuration, c.start + chars / o.maxCps);
    c.end = Math.min(Math.max(c.end, Math.min(want, limit)), c.start + Math.max(o.maxDuration, o.minDuration) + 1);
    if (c.end <= c.start) c.end = c.start + 0.3;
    c.start = round3(c.start);
    c.end = round3(c.end);
  }
  // A later cue may still overlap when words were dense; push it back by the gap.
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end + o.minGap) cues[i - 1].end = round3(Math.max(cues[i - 1].start + 0.3, cues[i].start - o.minGap));
  }
  return cues;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function timestamp(sec, sep = ',') {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

export const toSrt = (cues) => cues.map((c, i) => `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.lines.join('\n')}\n`).join('\n');

const vttEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const toVtt = (cues) => `WEBVTT\n\n${cues.map((c) => `${timestamp(c.start, '.')} --> ${timestamp(c.end, '.')} line:-1\n${c.lines.map(vttEsc).join('\n')}\n`).join('\n')}`;

const assTime = (sec) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
};
const assEsc = (s) => s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');

/** Burn-in style, sized from the frame so 720p, 1080p and vertical video all read the same. */
export function assStyle(W, H, { font = 'Inter', style = 'clean' } = {}) {
  const short = Math.min(W, H);
  const size = Math.round(short * (H > W ? 0.06 : 0.056));
  const outline = Math.max(1.5, Math.round(size * 0.07 * 10) / 10);
  const marginV = Math.round(H * (H > W ? 0.16 : 0.065));
  const marginH = Math.round(W * 0.08);
  // ASS colours are &HAABBGGRR. "box" = translucent plate (BorderStyle 3), "clean" = white with soft outline.
  const box = style === 'box';
  return { size, outline, marginV, marginH, line: `Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,${box ? '&H00000000' : '&H00101010'},${box ? '&H80000000' : '&H96000000'},-1,0,0,0,100,100,0,0,${box ? 3 : 1},${box ? Math.round(size * 0.18) : outline},${box ? 0 : Math.round(outline * 0.6 * 10) / 10},2,${marginH},${marginH},${marginV},1` };
}

export function toAss(cues, { W = 1920, H = 1080, font, style } = {}) {
  const st = assStyle(W, H, { font, style });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${st.line}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.lines.map(assEsc).join('\\N')}`).join('\n')}
`;
}

/** Plain transcript text from segments, one paragraph per pause > 1.2 s. */
export function transcriptText(segments) {
  let out = '';
  let prevEnd = null;
  for (const s of segments) {
    if (prevEnd != null) out += s.start - prevEnd > 1.2 ? '\n\n' : ' ';
    out += s.text;
    prevEnd = s.end;
  }
  return out.trim();
}

/** Keep cues inside the media: a subtitle track that outlasts the picture would lengthen the MP4. */
export function clampCues(cues, duration) {
  if (!(duration > 0)) return cues;
  return cues.filter((c) => c.start < duration - 0.05).map((c) => ({ ...c, end: round3(Math.min(c.end, duration)) }));
}

/** Shift cues/words by an offset (seconds) — e.g. when transcribing a sub-range. */
export const shiftCues = (cues, by) => cues.map((c) => ({ ...c, start: round3(c.start + by), end: round3(c.end + by) }));

const ISO3 = { en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol', ru: 'rus', uk: 'ukr', ja: 'jpn', zh: 'zho', ko: 'kor', tr: 'tur', ar: 'ara', sv: 'swe', da: 'dan', no: 'nor', nb: 'nob', fi: 'fin', cs: 'ces', el: 'ell', hu: 'hun', ro: 'ron', hi: 'hin', he: 'heb', id: 'ind', vi: 'vie', th: 'tha' };
/** ISO 639-1 → ISO 639-2 for the MP4 subtitle track's language tag. */
export const iso639_2 = (code) => ISO3[String(code || '').toLowerCase()] || 'und';
