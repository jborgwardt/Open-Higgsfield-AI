// Director: a small writers' room that turns a premise / script into a cut-ready shot list.
//   1. concept — three takes on the premise, a self-judged pick, and a timed beat sheet
//   2. shot list — coverage, per-shot edit length vs render length, on-screen dialogue, sound
//   3. critique + revision — a ruthless note pass and a rewritten shot list
// The user picks the director (Claude subscription CLI, Gemini, Grok, an ApiMart model, a local LLM, or
// "No AI" which splits the script). There is no automatic choice and no silent fallback.
import { getSettings, updateSettings } from './store.js';
import { getModel } from './catalog.js';
import { fetchJSON } from './http.js';
import { xaiChat, xaiAvailable, xaiModels } from './providers/xai.js';
import { googleChat, googleAvailable } from './providers/google.js';
import { openaiChat, openaiPing } from './providers/openai.js';
import { APIMART, APIMART_DIRECTOR_DEFAULT, apimartAvailable, apimartModels } from './providers/apimart.js';
import { claudeChat, claudeStatus, CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from './providers/claude-cli.js';

// Qwen Cloud Token Plan (OpenAI-compatible). QWEN_BASE may point at the Alibaba host instead.
export const QWEN = `${(process.env.QWEN_BASE || 'https://token-plan.maas.qwencloudapi.com').replace(/\/+$/, '')}/compatible-mode/v1`;

// Chat-model filters: provider model lists also contain image / video / audio / embedding models.
const NOT_CHAT = /image|video|audio|tts|speech|voice|embed|rerank|moderation|whisper|transcri|dall-?e|imagen|veo|kling|seedance|seedream|^wan|[-/]wan|sora|flux|midjourney|suno|lyria|music|banana|omni|live|robotics|computer-use|hailuo|vidu|runway|pika|luma|recraft|ideogram|^auto$|realtime|ocr/i;
const gemini = async () => {
  const j = await fetchJSON('google', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=300', { headers: { 'x-goog-api-key': getSettings().googleKey }, signal: AbortSignal.timeout(15000) });
  return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, '')).filter((id) => /^(gemini|gemma)/.test(id) && !NOT_CHAT.test(id) && !/customtools|aqa/.test(id));
};
export const VENICE = 'https://api.venice.ai/api/v1';
const venice = async () => {
  const j = await fetchJSON('venice', `${VENICE}/models?type=text`, { headers: { Authorization: `Bearer ${getSettings().veniceKey}` }, signal: AbortSignal.timeout(15000) });
  return (j.data || []).filter((m) => !m.type || m.type === 'text').map((m) => ({ id: m.id, label: m.model_spec?.name && m.model_spec.name !== m.id ? `${m.model_spec.name} (${m.id})` : m.id }));
};
const qwen = async () => {
  const j = await fetchJSON('qwen', `${QWEN}/models`, { headers: { Authorization: `Bearer ${getSettings().qwenKey}` }, signal: AbortSignal.timeout(15000) });
  return (j.data || []).map((m) => m.id).filter((id) => !NOT_CHAT.test(id));
};

// Model lists are fetched live (free calls) and cached for 10 minutes.
export const DIRECTORS = [
  { id: 'claude', label: 'Claude (your subscription)', note: 'Claude Code CLI signed in with your Claude plan', defaultModel: CLAUDE_DEFAULT_MODEL, list: async () => CLAUDE_MODELS },
  { id: 'google', label: 'Google Gemini', note: 'Gemini API key (Google Cloud credits)', defaultModel: 'gemini-3.8-flash', list: gemini, ok: googleAvailable, need: 'add a Gemini API key' },
  { id: 'xai', label: 'xAI Grok', note: 'SuperGrok sign-in or xAI key', defaultModel: '', list: async () => (await xaiModels()).filter((id) => /^grok/.test(id) && !NOT_CHAT.test(id) && !/imagine/.test(id)), ok: xaiAvailable, need: 'sign in with SuperGrok or add an xAI key' },
  { id: 'apimart', label: 'ApiMart (paid API)', note: 'Billed to your ApiMart balance', defaultModel: APIMART_DIRECTOR_DEFAULT, list: async () => (await apimartModels()).filter((id) => !NOT_CHAT.test(id)), ok: apimartAvailable, need: 'add an ApiMart key' },
  { id: 'qwen', label: 'Qwen Cloud Token Plan', note: 'QWEN_API_KEY (OpenAI-compatible)', defaultModel: 'qwen3.8-max', list: qwen, ok: () => !!getSettings().qwenKey, need: 'set QWEN_API_KEY' },
  { id: 'venice', label: 'Venice AI', note: 'VENICE_API_KEY (OpenAI-compatible)', defaultModel: '', list: venice, ok: () => !!getSettings().veniceKey, need: 'set VENICE_API_KEY' },
  { id: 'openai', label: 'OpenAI-compatible / local LLM', note: 'Ollama, LM Studio, vLLM… (Providers → local LLM)', defaultModel: '', list: openaiPing },
  { id: 'split', label: 'No AI (split my script)', note: 'One shot per sentence, no writing', defaultModel: '', list: async () => [] },
];
export const DIRECTOR_LABEL = Object.fromEntries(DIRECTORS.map((d) => [d.id, d.label]));
const ids = DIRECTORS.map((d) => d.id);
const clean = (v) => (ids.includes(v) ? v : ''); // a stored 'auto' (old default) counts as "not chosen"
const MODEL_SHAPE = { claude: /^(opus|sonnet|haiku|fable|claude)/i, google: /^(gemini|gemma)/i, xai: /^grok/i };

/** The saved director: the production's own choice if it has one, else the studio-wide choice. */
export function chosenDirector(brief = {}) {
  const s = getSettings();
  const own = clean(brief.directorProvider);
  const id = own || clean(s.directorProvider);
  const d = DIRECTORS.find((x) => x.id === id);
  let want = String((own ? brief.directorModel : s.directorModel) || '').trim();
  // A model id left over from another provider (e.g. "opus" after switching to Gemini) falls back to the default.
  if (want && MODEL_SHAPE[id] && !MODEL_SHAPE[id].test(want)) want = '';
  return { id: id || null, model: want || d?.defaultModel || '', source: own ? 'production' : id ? 'studio' : null };
}

const lists = new Map(); // id -> { at, models, error }
async function availability(id, { fresh } = {}) {
  const d = DIRECTORS.find((x) => x.id === id);
  if (!d) return { available: false, detail: 'unknown director', models: [] };
  if (id === 'claude') {
    const st = await claudeStatus({ fresh });
    return { available: st.available, detail: st.available ? `Claude Code ${st.version || ''} · ${st.subscription || st.authMethod || 'signed in'}`.replace(/\s+/g, ' ') : st.error, models: CLAUDE_MODELS.map((m) => ({ id: m, label: m })) };
  }
  if (id === 'split') return { available: true, detail: '', models: [] };
  if (d.ok && !d.ok()) return { available: false, detail: d.need, models: [] };
  let c = lists.get(id);
  if (fresh || !c || Date.now() - c.at > 10 * 60 * 1000) {
    try {
      const raw = (await d.list()).map((m) => (typeof m === 'string' ? { id: m, label: m } : m));
      c = { at: Date.now(), models: [...new Map(raw.map((m) => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id)), error: null };
    } catch (e) { c = { at: Date.now() - 9 * 60 * 1000, models: [], error: e.message }; }
    lists.set(id, c);
  }
  if (id === 'openai') return { available: !c.error, detail: c.error ? 'no OpenAI-compatible server reachable' : `${c.models.length} models`, models: c.models };
  return { available: true, detail: c.error ? `model list unavailable: ${c.error.slice(0, 120)}` : `${c.models.length} chat models`, models: c.models };
}

/** Every director with its chat models and live availability — for pickers (web UI, Apple app). */
export async function listDirectors({ fresh = false } = {}) {
  const providers = await Promise.all(DIRECTORS.map(async ({ id, label, note, defaultModel }) => {
    const a = await availability(id, { fresh });
    return { id, label, note, defaultModel, available: a.available, detail: a.detail || '', models: a.models };
  }));
  const s = getSettings();
  return { selected: clean(s.directorProvider) || null, model: s.directorModel || '', providers };
}

/** Studio-wide choice (persists in settings until changed). */
export async function chooseDirector({ provider, model } = {}) {
  if (provider != null && provider !== '' && !ids.includes(provider)) throw Object.assign(new Error(`unknown director ${provider}`), { status: 400 });
  await updateSettings({ ...(provider != null ? { directorProvider: provider } : {}), ...(model != null ? { directorModel: model } : {}) });
  return listDirectors();
}

/** Kept for /status: the chosen director id if it is usable right now, else null. */
export async function directorBackend(brief) {
  const { id } = chosenDirector(brief);
  if (!id) return null;
  return (await availability(id)).available ? id : null;
}

async function chat(d, messages, signal) {
  const model = d.model || undefined;
  switch (d.id) {
    case 'claude': return claudeChat({ model, messages, signal });
    case 'xai': return xaiChat({ model, messages, signal });
    case 'google': return googleChat({ model, messages, signal });
    case 'apimart': return openaiChat({ provider: 'apimart', baseUrl: APIMART, key: getSettings().apimartKey, model: model || APIMART_DIRECTOR_DEFAULT, messages, signal });
    case 'venice': if (!model) throw new Error('choose a Venice model for the director'); return openaiChat({ provider: 'venice', baseUrl: VENICE, key: getSettings().veniceKey, model, messages, signal });
    case 'qwen': return openaiChat({ provider: 'qwen', baseUrl: QWEN, key: getSettings().qwenKey, model: model || 'qwen3.8-max', messages, signal });
    case 'openai': return openaiChat({ model, messages, signal });
    default: throw new Error(`director ${d.id} cannot chat`);
  }
}

/* ---------------- robust JSON (Claude / Gemini / Grok all wrap it differently) ---------------- */

export function parseJSON(text) {
  const t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('director returned no JSON');
  const body = t.slice(a, b + 1);
  try { return JSON.parse(body); } catch {}
  // Common slips: raw newlines / tabs inside strings and trailing commas. Walk the text so only
  // characters outside or inside strings are touched as appropriate.
  let out = '';
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === '\\') { out += ch + (body[++i] ?? ''); continue; }
      if (ch === '"') inStr = false;
      out += ch === '\n' ? '\\n' : ch === '\r' ? '' : ch === '\t' ? '\\t' : ch;
      continue;
    }
    if (ch === '"') inStr = true;
    if (ch === ',' && /^\s*[}\]]/.test(body.slice(i + 1, i + 40))) continue;
    out += ch;
  }
  return JSON.parse(out);
}

async function chatJSON(d, messages, signal) {
  let reply = '';
  try {
    reply = await chat(d, messages, signal);
    return parseJSON(reply);
  } catch (e) {
    if (signal?.aborted || e.quota || /not found|not signed in|no .* key|cannot chat|choose a/i.test(e.message)) throw e;
    if (!reply) { // the call itself failed: one plain retry for transient errors
      if (!e.retryable) throw e;
      return parseJSON(await chat(d, messages, signal));
    }
    const retry = [...messages, { role: 'assistant', content: reply.slice(0, 20000) }, { role: 'user', content: 'That reply was not one complete, valid JSON object. Reply again with ONLY the complete JSON object — no prose, no code fences.' }];
    return parseJSON(await chat(d, retry, signal));
  }
}

/* ---------------- craft notes ---------------- */

export const GENRES = ['comedy', 'drama', 'horror', 'thriller', 'ad', 'music-video', 'documentary'];

const CRAFT = {
  comedy: `COMEDY CRAFT
- Find the game: ONE absurd idea, made clear in the first 3 seconds, then heightened at least three times — each step bigger and more specific than the last. Never repeat a joke at the same size.
- Every joke is set up before it pays off. Plant details early and call them back later.
- Play it straight: characters treat the absurd situation with total seriousness. Deadpan beats mugging.
- Specific beats generic ("reorganized his garage. At 3 a.m." beats "was very productive").
- Reactions are half the comedy: after a punchline, cut to the person hearing it. Let a reaction sit 1–1.5 s in silence.
- Cut ON the laugh: a shot ends right after its punchline or reaction lands — never let it run past its joke.
- Rhythm: vary shot lengths; quick cuts while escalating, a held beat right before the button.
- End on a button: one small extra laugh after the big payoff, then cut. No moral, no explaining the joke.
- Music: default to NONE. Silence and room tone make deadpan funnier; a constant score bed kills comedy. Use score only when it is part of the joke (mock-epic, parody) — enter and exit on cuts, and stop dead before the punchline and the button.`,
  drama: `DRAMA CRAFT
- Stakes clear within 10 seconds: who wants what, and what it costs to fail.
- Pressure builds; each beat makes the problem harder. Subtext over exposition — people rarely say what they mean.
- A turn around two-thirds in (a decision, a reveal) that recolours what came before; pay it off with an image, not a speech.
- Hold on faces for the important beats; cut away from what the audience can imagine.
- Score is sparse: let it enter at the turn, not under everything.`,
  horror: `HORROR CRAFT
- Start normal, then one wrong detail. Dread comes from negative space, withholding, and stillness.
- Sound design over score: room tone, a creak, silence before the hit.
- A false scare relieves tension; the real one comes when the audience relaxes. The last shot reveals something worse.
- Keep the threat mostly off screen; inserts of small details do the work.`,
  thriller: `THRILLER CRAFT
- A ticking clock or a clear threat in the first seconds. Information is a weapon: show the audience something the character doesn't know.
- Escalate obstacles; cut faster as tension rises; one reversal the audience didn't see coming.
- Score pulses only where pressure peaks; silence before the reveal.`,
  ad: `AD CRAFT
- Hook in 0–2 s: a visual surprise or a relatable problem. Product visible early.
- Dramatise ONE benefit — show it, don't say it. Escalate the problem or the delight.
- Product hero shot and brand line in the final 3 s, then a clear call to action. Fast, confident rhythm.`,
  'music-video': `MUSIC VIDEO CRAFT
- Cut on the beat; build visual motifs that return and transform.
- Intercut performance with a simple narrative; escalate energy towards the final chorus.
- The track is the score: music is on throughout; dialogue is rare.`,
  documentary: `DOCUMENTARY CRAFT
- Pose the question up front. Interview fragments intercut with observational b-roll and telling details.
- Narration is sparse and specific; let images carry it.
- End on an image that answers — or complicates — the opening question.`,
};

const WATCHABLE = `WHAT KEEPS A VIEWER WATCHING
- A hook in the first 3 seconds (image + line that raises a question or gets a laugh).
- Something changes every few seconds: new information, a new angle, a reaction, an escalation.
- A surprise or reversal, and an ending that pays off what was set up.
- Real coverage, not a slideshow: wides to orient, mediums for action, close-ups for lines and reactions, inserts for details, cutaways for jokes.`;

const SYSTEM = `You are a writers' room and film director making short films that are rendered shot-by-shot by an AI video model.
Each shot is an independent clip rendered from its prompt alone. The video model also speaks the dialogue (lip-synced) from the quoted lines in the prompt.
You are funny when the material is funny, ruthless about pacing, and you respect the writer's own words.
You always answer with ONE valid JSON object and nothing else.`;

/* ---------------- brief helpers ---------------- */

function bible(brief) {
  const chars = (brief.characters || []).filter((c) => c.name || c.description);
  return [
    brief.style ? `Visual style for every shot: ${brief.style}` : '',
    chars.length ? `Characters (keep identical in every shot):\n${chars.map((c) => `- ${c.name || 'Character'}: ${c.description || ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export function shotCountFor(brief) {
  const secs = Math.max(10, (Number(brief.targetMinutes) || 5) * 60);
  return Math.max(1, Math.round(secs / (Number(brief.clipSeconds) || 8)));
}

const targetSeconds = (brief) => Math.max(10, Math.round((Number(brief.targetMinutes) || 5) * 60));
const norm = (s) => String(s || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Quoted lines in the user's script ("…" or “…”), which the film must keep verbatim. */
export function quotedLines(script) {
  const out = [];
  const re = /["“]([^"”\n]{6,400})["”]/g;
  let m;
  while ((m = re.exec(String(script || '')))) if (m[1].trim().split(/\s+/).length >= 2) out.push(m[1].trim());
  return [...new Map(out.map((l) => [norm(l), l])).values()];
}

function renderSpec(brief) {
  const m = getModel(brief.videoModel);
  const durations = (m?.durations?.length ? m.durations : [Number(brief.clipSeconds) || 8]).map(Number).sort((a, b) => a - b);
  return { label: m?.label || brief.videoModel, durations, audio: !/animatic/.test(brief.videoModel || '') };
}

const shotBudget = (brief) => Number(brief.maxShots) || Math.max(3, Math.round(targetSeconds(brief) / 3.5));

/* ---------------- the three passes ---------------- */

function conceptPrompt(brief, keep) {
  const T = targetSeconds(brief);
  const genre = GENRES.includes(brief.genre) ? brief.genre : '';
  return `PREMISE / SCRIPT
"""${String(brief.script || '').slice(0, 24000)}"""
${bible(brief)}

Target length: ${T} seconds of finished film. Genre: ${genre || 'decide from the premise'}.
${keep.length ? `The writer's own lines (keep every one VERBATIM, spoken on screen by the character the script gives it to — never move a character's line into narration, never cut or paraphrase it):\n${keep.map((l) => `- "${l}"`).join('\n')}` : ''}

${genre ? CRAFT[genre] : Object.values(CRAFT).slice(0, 2).join('\n\n')}

${WATCHABLE}

TASK
1. Pitch THREE genuinely different takes on this premise (if the writer gave a full script, all three keep their lines and differ in structure, escalation and ending).
2. Judge them as a tough producer: which one would a stranger actually watch to the end? Score each 1–10 and pick one.
3. Write the timed beat sheet for the pick. Beats add up to about ${T} s. Assign every one of the writer's lines to a beat.

Reply with JSON:
{"title": string, "genre": one of ${JSON.stringify(GENRES)}, "tone": string,
 "concepts": [{"name": string, "logline": string, "engine": string (the comic game / dramatic question that drives it), "hook": string (first 3 seconds), "escalation": [string, string, string], "turn": string, "button": string (final beat), "score": number}],
 "pick": 0|1|2, "why": string,
 "beats": [{"t": number (start, seconds), "len": number, "purpose": "hook"|"setup"|"escalation"|"turn"|"payoff"|"button"|"breath", "beat": string, "audience": string (the laugh / feeling we want), "lines": [string] (verbatim lines spoken in this beat)}],
 "music": string (score approach for the whole film and why — for comedy usually "none: silence and room tone")}`;
}

function shotsPrompt(brief, concept, keep, spec) {
  const T = targetSeconds(brief);
  const c = concept.concepts?.[concept.pick] || concept.concepts?.[0] || {};
  const genre = concept.genre || brief.genre || 'comedy';
  return `FILM: ${concept.title || brief.title || 'Untitled'} — ${c.logline || ''}
Genre: ${genre}. Tone: ${concept.tone || ''}
Engine: ${c.engine || ''}
Hook: ${c.hook || ''} | Escalation: ${(c.escalation || []).join(' → ')} | Turn: ${c.turn || ''} | Button: ${c.button || ''}
Beat sheet:
${(concept.beats || []).map((b, i) => `${i}. [${b.t ?? '?'}s +${b.len ?? '?'}s · ${b.purpose || ''}] ${b.beat}${b.lines?.length ? ` — lines: ${b.lines.map((l) => `"${l}"`).join(' ')}` : ''}${b.audience ? ` (want: ${b.audience})` : ''}`).join('\n')}
Music approach: ${concept.music || 'decide per scene'}
${bible(brief)}
${keep.length ? `Writer's lines — every one must appear VERBATIM in a shot's "dialogue" (or "narration" only if the script gives it to a narrator):\n${keep.map((l) => `- "${l}"`).join('\n')}` : ''}

${CRAFT[genre] || ''}

RENDERING + EDITING RULES
- Video model: ${spec.label}. Allowed render durations: ${spec.durations.join(', ')} s. Each shot's "duration" MUST be one of these — pick the shortest that covers editIn + editLength.
- The editor then cuts each clip to its best section: "editIn" (seconds into the render where the cut starts) and "editLength" (seconds kept). Comedy usually cuts at 1.5–5 s per shot; a reaction is 1–2 s; an insert 1–1.5 s; a spoken line needs about (words ÷ 2.5) + 0.8 s.
- The sum of editLength should be about ${T} s (±15%). Use at most ${shotBudget(brief)} shots.
- AI clips start a little stiff: in dialogue shots the character starts speaking within the first second, so use editIn 0.3–0.8. For a reaction or action, editIn where the moment happens.
- At most ~14 spoken words per shot (split longer lines across coverage, still verbatim). Dialogue stays ON SCREEN, spoken by the character in that shot.
- AI video renders written words badly. Never make a joke or story point depend on readable text (phone screens, signs, labels, documents) — carry it with a voice (a character reads it, the device speaks it), a sound, or an action.
- "continuity": "cut" for almost every shot. Use "continue" only when the shot must pick up exactly where the previous render ends.
- "score": true only for shots where music plays under the picture (cues enter/exit on these cuts). Comedy: usually false everywhere.
- "prompt" is the ONLY thing the video model sees: 50–110 words, self-contained. Restate who is on screen with their fixed look, the setting, lighting, lens/shot size and camera move, the action, the performance (expression, timing), and the dialogue as: NAME (delivery) says: "line". Say the line is spoken once, then the character holds the reaction. End with the ambient sound. No on-screen text, captions or subtitles.

Reply with JSON:
{"scenes": [{"title": string, "summary": string, "music": string ("" for no score)}],
 "shots": [{"scene": number (index into scenes), "beat": number, "title": string (3-6 words), "coverage": "wide"|"medium"|"close"|"extreme-close"|"insert"|"reaction"|"cutaway"|"two-shot"|"ots"|"pov",
   "action": string, "camera": string, "performance": string,
   "dialogue": [{"speaker": string, "line": string, "delivery": string}], "narration": string,
   "sound": string (ambience / sfx), "score": boolean, "hit": string (what lands on the cut),
   "editIn": number, "editLength": number, "duration": number, "continuity": "cut"|"continue", "prompt": string}]}`;
}

function critiquePrompt(brief, concept, draft, keep, missing, spec) {
  const T = targetSeconds(brief);
  return `You are now the harshest person in the room: a producer who has seen ten thousand shorts and walks out of boring ones.
FILM: ${concept.title || ''} (${concept.genre || ''}) — ${(concept.concepts?.[concept.pick] || {}).logline || ''}
Target: ${T} s. Video model render durations: ${spec.durations.join(', ')} s. Max ${shotBudget(brief)} shots.
${keep.length ? `Writer's lines that MUST stay verbatim on screen:\n${keep.map((l) => `- "${l}"`).join('\n')}` : ''}
${missing.length ? `These writer's lines are MISSING from the draft and must be restored verbatim: ${missing.map((l) => `"${l}"`).join(' ')}` : ''}

DRAFT SHOT LIST (JSON):
${JSON.stringify(draft)}

${CRAFT[concept.genre] || ''}

1. Critique it honestly: Would a viewer keep watching past 5 seconds? Past 20? Where exactly is it flat? Is every joke (or dramatic beat) set up AND paid off? Does each escalation get bigger? Do shots run past their punchline? Is there a reaction after each laugh line? Is the button strong? Is the music helping or fighting it? Is each prompt specific enough for the video model to stage it? Does anything depend on readable on-screen text (AI video garbles it)?
2. Then rewrite the shot list fixing every problem you found. Keep what works. Keep all writer's lines verbatim. Same JSON shape and rules as the draft.

Reply with JSON:
{"critique": {"score": number (1-10, would a stranger watch to the end), "flat": [string], "jokes": [{"joke": string, "setup": string, "payoff": string, "lands": boolean, "fix": string}], "rhythm": string, "music": string},
 "changes": [string],
 "scenes": [...same shape as draft...],
 "shots": [...same shape as draft...]}`;
}

/* ---------------- normalising the director's output ---------------- */

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round1 = (n) => Math.round(n * 10) / 10;

function normaliseShots(raw, spec) {
  const shots = (Array.isArray(raw) ? raw : []).filter((s) => s && (s.prompt || s.action));
  const D = spec.durations;
  for (const s of shots) {
    s.editIn = Math.max(0, round1(num(s.editIn, 0.5)));
    s.editLength = Math.max(0.6, round1(num(s.editLength, D[0])));
    const need = s.editIn + s.editLength;
    let dur = num(s.duration, 0);
    if (!D.includes(dur) || dur < need) dur = D.find((d) => d >= need) || D.at(-1);
    s.duration = dur;
    if (s.editIn + s.editLength > dur) { s.editLength = Math.min(s.editLength, dur); s.editIn = round1(Math.max(0, dur - s.editLength)); }
    s.dialogue = (Array.isArray(s.dialogue) ? s.dialogue : []).filter((l) => l && l.line).map((l) => ({ speaker: String(l.speaker || ''), line: String(l.line), delivery: String(l.delivery || '') }));
    s.continuity = s.continuity === 'continue' ? 'continue' : 'cut';
    s.score = s.score === true;
    s.prompt = String(s.prompt || s.action || '');
  }
  // A chained shot starts from the previous render's last frame, so the previous cut must use that tail.
  shots.forEach((s, i) => {
    const prev = shots[i - 1];
    if (s.continuity === 'continue' && prev) prev.editIn = round1(Math.max(0, prev.duration - prev.editLength));
  });
  return shots;
}

function missingLines(keep, shots) {
  const said = norm(shots.map((s) => [...(s.dialogue || []).map((l) => l.line), s.narration || ''].join(' ')).join(' '));
  return keep.filter((l) => !said.includes(norm(l)));
}

function group(scenes, shots) {
  const sc = (Array.isArray(scenes) && scenes.length ? scenes : [{ title: 'Scene 1', summary: '' }]).map((s) => ({ title: s.title || 'Scene', summary: s.summary || '', music: s.music || '', shots: [] }));
  for (const s of shots) sc[Math.min(sc.length - 1, Math.max(0, Math.round(num(s.scene, 0))))].shots.push(s);
  return sc.filter((s) => s.shots.length);
}

/** concept → shot list → critique/revision. Returns { title, logline, style, director, scenes:[{…, shots}], room }. */
export async function planProduction(brief, { onStatus, signal } = {}) {
  const d = chosenDirector(brief);
  if (!d.id) throw Object.assign(new Error('Choose a director first'), { status: 400 });
  if (d.id === 'split') return { ...fallbackPlan(brief, shotCountFor(brief)), director: 'split' };
  const av = await availability(d.id);
  if (!av.available) throw Object.assign(new Error(`${DIRECTOR_LABEL[d.id]} is not available: ${av.detail || 'not connected'}`), { status: 409 });
  const who = `${DIRECTOR_LABEL[d.id]}${d.model ? ` · ${d.model}` : ''}`;
  const spec = renderSpec(brief);
  const fromScript = quotedLines(brief.script);
  const t0 = Date.now();

  onStatus?.({ message: `Writers' room (${who}): pitching three concepts`, progress: 0.05 });
  const concept = await chatJSON(d, [{ role: 'system', content: SYSTEM }, { role: 'user', content: conceptPrompt(brief, fromScript) }], signal);
  if (!Array.isArray(concept.concepts) || !concept.concepts.length) throw new Error('director returned no concepts');
  concept.pick = Math.min(concept.concepts.length - 1, Math.max(0, Math.round(num(concept.pick, 0))));
  if (!GENRES.includes(concept.genre)) concept.genre = GENRES.includes(brief.genre) ? brief.genre : 'comedy';
  // Lines the room itself flagged count only if they really are in the writer's script.
  const scriptN = norm(brief.script);
  const keep = [...new Map([...fromScript, ...(concept.beats || []).flatMap((b) => b.lines || [])].filter((l) => l && scriptN.includes(norm(l))).map((l) => [norm(l), l])).values()];

  onStatus?.({ message: `Writers' room (${who}): shot list for “${concept.concepts[concept.pick].name || concept.title || 'the pick'}”`, progress: 0.35 });
  const draftRaw = await chatJSON(d, [{ role: 'system', content: SYSTEM }, { role: 'user', content: shotsPrompt(brief, concept, keep, spec) }], signal);
  const draft = { scenes: draftRaw.scenes || [], shots: normaliseShots(draftRaw.shots, spec) };
  if (!draft.shots.length) throw new Error('director returned no shots');

  onStatus?.({ message: `Writers' room (${who}): critique and rewrite`, progress: 0.65 });
  let final = draft;
  let critique = null;
  let changes = [];
  try {
    const rev = await chatJSON(d, [{ role: 'system', content: SYSTEM }, { role: 'user', content: critiquePrompt(brief, concept, draft, keep, missingLines(keep, draft.shots), spec) }], signal);
    critique = rev.critique || null;
    changes = Array.isArray(rev.changes) ? rev.changes : [];
    const shots = normaliseShots(rev.shots, spec);
    // Take the rewrite unless it lost more of the writer's lines than the draft did.
    if (shots.length && missingLines(keep, shots).length <= missingLines(keep, draft.shots).length) final = { scenes: rev.scenes?.length ? rev.scenes : draft.scenes, shots };
  } catch (e) {
    if (signal?.aborted) throw e;
    changes = [`Critique pass failed (${e.message.slice(0, 120)}); using the first draft.`];
  }

  const missing = missingLines(keep, final.shots);
  const warnings = [];
  if (missing.length) warnings.push(`The director dropped ${missing.length} of your lines: ${missing.map((l) => `“${l}”`).join(' ')} — add them back in the shot list.`);
  if (!brief.narration && final.shots.some((s) => s.narration)) warnings.push('Some shots have narrator lines — turn on “Add a narrator” to hear them.');
  const cut = final.shots.reduce((t, s) => t + s.editLength, 0);
  if (Math.abs(cut - targetSeconds(brief)) > targetSeconds(brief) * 0.25) warnings.push(`The cut runs ${Math.round(cut)} s against a ${targetSeconds(brief)} s target.`);
  const c = concept.concepts[concept.pick];
  return {
    title: concept.title || brief.title,
    logline: c.logline || '',
    style: brief.style || '',
    director: d.id,
    directorModel: d.model || null,
    scenes: group(final.scenes, final.shots),
    room: {
      genre: concept.genre, tone: concept.tone || '', concepts: concept.concepts, pick: concept.pick, why: concept.why || '',
      beats: concept.beats || [], music: concept.music || '', critique, changes, keep, missing, warnings,
      cutSeconds: round1(cut), renderSeconds: final.shots.reduce((t, s) => t + s.duration, 0), seconds: Math.round((Date.now() - t0) / 1000),
    },
  };
}

/* ---------------- "No AI": split the script locally ---------------- */

const chars = (brief) => (brief.characters || []).filter((c) => c.description).map((c) => `${c.name || 'Character'}: ${c.description}.`).join(' ');

const CAMERA = ['slow dolly in', 'static wide shot', 'tracking shot alongside the subject', 'slow push in to a close-up', 'gentle handheld follow', 'crane up revealing the space', 'over-the-shoulder', 'slow orbit around the subject'];

export function fallbackPlan(brief, total) {
  const text = String(brief.script || '').replace(/\s+/g, ' ').trim();
  let beats = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 3);
  if (!beats.length) beats = [text || 'An evocative cinematic moment'];
  const shots = Array.from({ length: total }, (_, i) => beats[Math.floor((i * beats.length) / total)]);
  const perScene = Math.max(3, Math.min(10, Math.round(total / Math.max(1, Math.round(total / 8)))));
  const scenes = [];
  for (let i = 0; i < shots.length; i += perScene) {
    const chunk = shots.slice(i, i + perScene);
    scenes.push({
      title: `Scene ${scenes.length + 1}`,
      summary: chunk[0],
      music: brief.musicPrompt || (brief.style ? `Cinematic instrumental score matching: ${brief.style}` : 'Understated cinematic instrumental score'),
      shots: chunk.map((beat, j) => ({
        title: `Shot ${i + j + 1}`,
        action: beat,
        camera: CAMERA[(i + j) % CAMERA.length],
        prompt: [brief.style && `${brief.style}.`, chars(brief), beat, `Camera: ${CAMERA[(i + j) % CAMERA.length]}.`].filter(Boolean).join(' '),
        continuity: j === 0 ? 'cut' : 'continue',
        narration: brief.narration ? beat : '',
      })),
    });
  }
  return { title: brief.title || 'Untitled film', logline: '', style: brief.style || '', scenes };
}
