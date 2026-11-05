// Screening: Gemini watches an assembled master (video + audio) and writes structured notes —
// entertainment score, hook, pacing, joke-by-joke landing, likeness, audio, music — plus concrete
// per-shot fixes (re-cut with new in/out points, re-shoot with a new prompt, cut, add a reaction).
// One upload (Files API) + one generateContent call per master. Re-cuts can be applied for free.
import fsp from 'node:fs/promises';
import { getSettings, getAsset, assetPath, now } from './store.js';
import { fetchJSON, sleep, ProviderError, httpError } from './http.js';
import { parseJSON } from './director.js';

const API = 'https://generativelanguage.googleapis.com';
const PREFERRED = [process.env.SCREEN_MODEL, 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean);

const key = () => {
  const k = getSettings().googleKey;
  if (!k) throw new ProviderError('google', 0, 'screening needs a Gemini API key');
  return k;
};
export const screeningAvailable = () => !!getSettings().googleKey;

let modelPick = null;
async function pickModel() {
  if (modelPick && Date.now() - modelPick.at < 36e5) return modelPick.id;
  let ids = [];
  try {
    const j = await fetchJSON('google', `${API}/v1beta/models?pageSize=300`, { headers: { 'x-goog-api-key': key() }, signal: AbortSignal.timeout(15000) });
    ids = (j.models || []).map((m) => m.name.replace(/^models\//, ''));
  } catch {}
  const id = PREFERRED.find((m) => ids.includes(m)) || PREFERRED[0];
  modelPick = { id, at: Date.now() };
  return id;
}

/** Resumable upload to the Gemini Files API; resolves once the file is ACTIVE. */
async function upload(file, mime, signal) {
  const buf = await fsp.readFile(file);
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key(), 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(buf.length), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: `screening-${Date.now()}` } }),
    signal,
  });
  if (!start.ok) throw await httpError('google', start);
  const url = start.headers.get('x-goog-upload-url');
  if (!url) throw new ProviderError('google', 0, 'Files API returned no upload URL');
  const put = await fetch(url, { method: 'POST', headers: { 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: buf, signal });
  if (!put.ok) throw await httpError('google', put);
  let f = (await put.json()).file;
  for (let i = 0; f.state !== 'ACTIVE' && i < 90; i++) {
    if (f.state === 'FAILED') throw new ProviderError('google', 0, 'Gemini could not process the video');
    await sleep(3000, signal);
    f = await fetchJSON('google', `${API}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': key() }, signal });
  }
  if (f.state !== 'ACTIVE') throw new ProviderError('google', 0, 'video processing timed out');
  return f;
}

const tc = (sec) => `${Math.floor((sec || 0) / 60)}:${(Math.round((sec || 0) * 10) / 10 % 60).toFixed(1).padStart(4, '0')}`;

const PROMPT = (ctx) => `You are screening a short film for its director. Be the honest test audience and the sharp editor in one.
Do not be polite. Score like a festival programmer: 5 = forgettable, 7 = people would share it, 9 = great. Most AI-made shorts are 3–5.
Anchor the score to the experience, not the craft: if a comedy never made you laugh out loud, it scores 4 or less; if you would have scrolled away before the end, 3 or less. Good-looking pictures do not raise the score.
Watch AND listen to the whole film, then judge:
- Hook: does the first 3 seconds make you want to keep watching?
- Pacing and rhythm: where does it go flat? Are shots uniform in length? Does each beat escalate? Does any shot outstay its moment?
- Every joke (or dramatic beat): is it set up, does the payoff land, does the cut land on it, is there a reaction shot when one is needed?
- Staging and coverage: is it a slideshow of static blocks, or real coverage (wide / medium / close / insert / reaction)?
- Likeness: do recurring characters keep the same face, hair, build and wardrobe from shot to shot? Name the shots where they drift.
- Audio: dialogue intelligibility, garbled or wrong lines, lip-sync, levels, abrupt cuts, room tone.
- Music: does the score help or fight the tone? For comedy, a constant score bed under deadpan dialogue usually kills the laughs — say so.
Then give concrete fixes per shot. Prefer cheap fixes first: a re-cut (new editIn/editLength within the clip's render length), cutting a shot entirely, or adding a reaction. Propose a re-shoot only when the shot itself fails, and write the new video prompt for it (self-contained, 50–110 words, dialogue in quotes).

${ctx}

Reply with ONE JSON object, nothing else:
{"score": number (1-10), "wouldKeepWatching": "no"|"maybe"|"yes", "verdict": string (one or two sentences),
 "hook": {"score": number, "note": string},
 "pacing": {"score": number, "note": string, "flat": [{"at": "m:ss-m:ss", "why": string}]},
 "jokes": [{"shot": number|null, "at": "m:ss", "joke": string, "landed": "yes"|"partly"|"no", "why": string}],
 "likeness": [{"character": string, "consistent": boolean, "shots": [number], "note": string}],
 "audio": [{"shot": number|null, "at": "m:ss", "issue": string}],
 "music": {"verdict": "helps"|"neutral"|"fights"|"none", "note": string},
 "shots": [{"shot": number, "verdict": "keep"|"recut"|"reshoot"|"cut"|"add-reaction", "note": string, "editIn": number|null, "editLength": number|null, "newPrompt": string|null}],
 "topFixes": [string] (most impact first, at most 6)}`;

/** Describe the intended film so notes can be keyed to shot numbers and real render lengths. */
export function productionContext(p) {
  const room = p.plan?.room || {};
  const c = room.concepts?.[room.pick] || {};
  const cuts = p.master?.cuts || [];
  const byId = new Map(p.shots.map((s) => [s.id, s]));
  const chars = (p.brief.characters || []).filter((x) => x.name || x.description);
  const lines = cuts.map((cut) => {
    const s = byId.get(cut.shotId) || {};
    const render = Math.max(0.5, (getAsset(s.videoId)?.duration || s.clipDuration || s.duration || 8) - (s.trimStart || 0));
    const said = (s.dialogue || []).map((l) => `${l.speaker}: "${l.line}"`).join(' ');
    return `Shot ${cut.index + 1} [${tc(cut.start)}–${tc(cut.end)}] ${s.coverage || ''} "${s.title || ''}" — ${s.action || s.prompt?.slice(0, 160) || ''}${said ? ` | dialogue ${said}` : ''}${s.narration ? ` | narrator: "${s.narration}"` : ''}${s.hit ? ` | should land: ${s.hit}` : ''} | uses ${(s.editIn ?? 0)}s–${((s.editIn ?? 0) + (cut.end - cut.start)).toFixed(1)}s of a ${render.toFixed(1)}s render${s.score === true ? ' | score under' : ''}`;
  });
  return [
    `INTENDED FILM: "${p.title}" — ${p.plan?.logline || ''}`,
    room.genre ? `Genre: ${room.genre}. ${room.tone || ''}` : '',
    c.engine ? `Engine: ${c.engine}. Hook: ${c.hook || ''}. Button: ${c.button || ''}` : '',
    chars.length ? `Recurring characters: ${chars.map((x) => `${x.name}: ${x.description}`).join('; ')}` : '',
    `Music setting: ${p.brief.music === 'off' ? 'no score' : p.brief.music === 'ai' ? 'AI score where cued' : 'uploaded track'}${p.brief.narration ? '; narrator voice-over on' : ''}.`,
    cuts.length ? `CUT LIST (use these shot numbers in your notes):\n${lines.join('\n')}` : 'No cut list: number the shots yourself in order of the cuts you see.',
  ].filter(Boolean).join('\n');
}

const VERDICTS = ['keep', 'recut', 'reshoot', 'cut', 'add-reaction'];

/** Watch a video file and return normalised notes. context: free text describing the intended film. */
export async function screenFile({ file, mime = 'video/mp4', context = '', signal, fps } = {}) {
  const model = await pickModel();
  const f = await upload(file, mime, signal);
  try {
    const call = (meta) => fetchJSON('google', `${API}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ fileData: { mimeType: f.mimeType || mime, fileUri: f.uri }, ...(meta ? { videoMetadata: meta } : {}) }, { text: PROMPT(context) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
      signal: signal || AbortSignal.timeout(300000),
    });
    // Two frames a second catches comic timing better than the default one; fall back if refused.
    let j;
    try { j = await call(fps ? { fps } : null); } catch (e) { if (!fps || e.status !== 400) throw e; j = await call(null); }
    const text = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
    if (!text) throw new ProviderError('google', 0, `no notes returned (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'empty'})`);
    const n = parseJSON(text);
    const usage = j.usageMetadata || {};
    return {
      model,
      score: Number(n.score) || null,
      wouldKeepWatching: n.wouldKeepWatching || null,
      verdict: n.verdict || '',
      hook: n.hook || null,
      pacing: n.pacing || null,
      jokes: Array.isArray(n.jokes) ? n.jokes : [],
      likeness: Array.isArray(n.likeness) ? n.likeness : [],
      audio: Array.isArray(n.audio) ? n.audio : [],
      music: n.music || null,
      shots: (Array.isArray(n.shots) ? n.shots : []).filter((s) => Number.isFinite(Number(s?.shot))).map((s) => ({
        shot: Number(s.shot), verdict: VERDICTS.includes(s.verdict) ? s.verdict : 'keep', note: s.note || '',
        editIn: Number.isFinite(Number(s.editIn)) && s.editIn !== null ? Number(s.editIn) : null,
        editLength: Number.isFinite(Number(s.editLength)) && s.editLength !== null ? Number(s.editLength) : null,
        newPrompt: s.newPrompt || null,
      })),
      topFixes: Array.isArray(n.topFixes) ? n.topFixes.slice(0, 8) : [],
      tokens: { input: usage.promptTokenCount || 0, output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) },
    };
  } finally {
    fetch(`${API}/v1beta/${f.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key() } }).catch(() => {});
  }
}

/* ---------------- productions ---------------- */

const running = new Set();

export async function screenProduction(id) {
  const lf = await import('./longform.js');
  const p = lf.getProduction(id);
  if (!p) throw Object.assign(new Error('production not found'), { status: 404 });
  const master = getAsset(p.master?.assetId);
  if (!master) throw Object.assign(new Error('assemble a master first'), { status: 409 });
  if (!screeningAvailable()) throw Object.assign(new Error('screening needs a Gemini API key'), { status: 409 });
  if (running.has(id)) return;
  running.add(id);
  await lf.mutate(id, (x) => { x.screening = { ...(x.screening || {}), status: 'running', masterAssetId: master.id, startedAt: now(), error: null }; x.message = 'Gemini is watching the master'; });
  try {
    const notes = await screenFile({ file: assetPath(master), context: productionContext(p), fps: (p.master?.duration || 60) <= 180 ? 2 : undefined });
    // Key per-shot notes to shot ids and keep re-cuts inside each clip's render.
    const byNum = new Map(p.shots.map((s) => [s.index + 1, s]));
    notes.shots = notes.shots.map((n) => {
      const s = byNum.get(n.shot);
      if (!s) return n;
      const render = Math.max(0.5, (getAsset(s.videoId)?.duration || s.clipDuration || 8) - (s.trimStart || 0));
      const out = { ...n, shotId: s.id };
      if (n.verdict === 'recut' && n.editLength) {
        out.editLength = Math.round(Math.min(render, Math.max(0.5, n.editLength)) * 10) / 10;
        out.editIn = Math.round(Math.max(0, Math.min(n.editIn ?? s.editIn ?? 0, render - out.editLength)) * 10) / 10;
      }
      return out;
    });
    await lf.mutate(id, (x) => {
      x.screening = { status: 'done', at: now(), masterAssetId: master.id, ...notes, applied: [] };
      x.log = [...(x.log || []).slice(-199), { at: now(), msg: `Screened by ${notes.model}: ${notes.score ?? '?'}/10 — ${notes.verdict}` }];
      x.message = `Screening: ${notes.score ?? '?'}/10`;
    });
  } catch (e) {
    await lf.mutate(id, (x) => { x.screening = { ...(x.screening || {}), status: 'error', error: e.message }; x.message = `Screening failed: ${e.message}`; }).catch(() => {});
  } finally {
    running.delete(id);
  }
}

/** Apply the screening's cheap fixes (re-cuts and cuts; optionally only some shots), then re-assemble. */
export async function applyScreening(id, { shots } = {}) {
  const lf = await import('./longform.js');
  const p = lf.getProduction(id);
  const notes = p?.screening?.shots || [];
  const want = Array.isArray(shots) && shots.length ? new Set(shots.map(Number)) : null;
  const picked = notes.filter((n) => n.shotId && (!want || want.has(n.shot)) && ((n.verdict === 'recut' && n.editLength) || n.verdict === 'cut'));
  if (!picked.length) throw Object.assign(new Error('no re-cuts to apply'), { status: 409 });
  await lf.mutate(id, (x) => {
    for (const n of picked) {
      const s = x.shots.find((y) => y.id === n.shotId);
      if (!s) continue;
      if (n.verdict === 'cut') s.omit = true;
      else { s.editIn = n.editIn ?? 0; s.editLength = n.editLength; }
    }
    x.screening.applied = [...new Set([...(x.screening.applied || []), ...picked.map((n) => n.shot)])];
    x.log = [...(x.log || []).slice(-199), { at: now(), msg: `Applied ${picked.length} screening fixes (re-cuts) — re-assembling` }];
  });
  lf.assemble(id).catch(() => {});
  return lf.getProduction(id);
}
