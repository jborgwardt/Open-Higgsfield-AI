// Director: turns a script / brief into a long-form shot list.
// Uses Grok (SuperGrok sign-in or API key), Gemini, or any OpenAI-compatible LLM; falls back to a
// deterministic splitter so planning never blocks on an LLM.
import { getSettings } from './store.js';
import { xaiChat, xaiAvailable } from './providers/xai.js';
import { googleChat, googleAvailable } from './providers/google.js';
import { openaiChat, openaiPing } from './providers/openai.js';
import { APIMART, APIMART_DIRECTOR_DEFAULT, apimartAvailable } from './providers/apimart.js';

export const DIRECTOR_LABEL = { xai: 'Grok', google: 'Gemini', apimart: 'ApiMart', openai: 'your LLM' };

export async function directorBackend() {
  const s = getSettings();
  const pref = s.directorProvider || 'auto';
  const llmUp = async () => { try { await openaiPing(); return true; } catch { return false; } };
  if (pref === 'xai' || (pref === 'auto' && xaiAvailable())) return xaiAvailable() ? 'xai' : null;
  if (pref === 'google' || (pref === 'auto' && googleAvailable())) return googleAvailable() ? 'google' : null;
  if (pref === 'apimart' || (pref === 'auto' && apimartAvailable())) return apimartAvailable() ? 'apimart' : null;
  if (pref === 'openai' || pref === 'auto') return (await llmUp()) ? 'openai' : null;
  return null;
}

async function chat(messages, signal) {
  const be = await directorBackend();
  const model = getSettings().directorModel || undefined;
  if (be === 'xai') return xaiChat({ model, messages, signal });
  if (be === 'google') return googleChat({ model, messages, signal });
  if (be === 'apimart') return openaiChat({ provider: 'apimart', baseUrl: APIMART, key: getSettings().apimartKey, model: model || APIMART_DIRECTOR_DEFAULT, messages, signal });
  if (be === 'openai') return openaiChat({ model, messages, signal });
  throw new Error('no director LLM connected');
}

function parseJSON(text) {
  const t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('director returned no JSON');
  return JSON.parse(t.slice(a, b + 1));
}

async function chatJSON(messages, signal) {
  try {
    return parseJSON(await chat(messages, signal));
  } catch (e) {
    if (signal?.aborted) throw e;
    return parseJSON(await chat([...messages, { role: 'user', content: 'Your last reply was not valid JSON. Reply again with ONLY the JSON object, no prose.' }], signal));
  }
}

const SYSTEM = `You are a film director and cinematographer planning a film that will be rendered shot-by-shot by an AI video model.
Every shot becomes an independent short clip, so each shot prompt must be fully self-contained: restate who is on screen with their
fixed visual description (face, hair, wardrobe), the setting, time of day, lighting, lens/camera move, and the action within the clip.
Keep characters, wardrobe, props and locations consistent across shots. Prefer one clear action and one camera move per shot.
Describe sound (ambience, music mood, short dialogue lines in quotes) when useful. Never include text overlays or subtitles.`;

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

/** Two-pass plan: outline scenes, then write shots per scene (parallel, 3 at a time). */
export async function planProduction(brief, { onStatus, signal } = {}) {
  const total = shotCountFor(brief);
  const backend = await directorBackend();
  if (!backend) {
    onStatus?.({ message: 'No director LLM connected — splitting the script locally' });
    return { ...fallbackPlan(brief, total), director: 'local' };
  }
  onStatus?.({ message: `Outlining ${total} shots with ${DIRECTOR_LABEL[backend] || backend}` });
  const outline = await chatJSON([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Plan a ${brief.targetMinutes}-minute film made of exactly ${total} shots of about ${brief.clipSeconds} seconds each.
${bible(brief)}
Script / brief:
"""${String(brief.script || '').slice(0, 24000)}"""

Return JSON: {"title": string, "logline": string, "style": string (one sentence global look), "scenes": [{"title": string, "summary": string (2-3 sentences of what happens), "shots": integer, "music": string (one sentence describing the instrumental score for this scene: genre, instruments, tempo, mood)}]}
Scene shot counts must add up to exactly ${total}. Use as many scenes as the story needs (typically ${Math.max(1, Math.round(total / 8))}).`,
    },
  ], signal);
  let scenes = (outline.scenes || []).filter((s) => s && s.summary);
  if (!scenes.length) throw new Error('director outline had no scenes');
  // Normalise shot counts to the exact total.
  const sum = scenes.reduce((n, s) => n + Math.max(1, Number(s.shots) || 1), 0);
  let assigned = 0;
  scenes = scenes.map((s, i) => {
    const n = i === scenes.length - 1 ? Math.max(1, total - assigned) : Math.max(1, Math.round(((Number(s.shots) || 1) / sum) * total));
    assigned += n;
    return { ...s, shots: n };
  });
  const style = brief.style || outline.style || '';
  const out = new Array(scenes.length);
  let done = 0;
  const queue = scenes.map((s, i) => i);
  const worker = async () => {
    while (queue.length) {
      const i = queue.shift();
      const sc = scenes[i];
      const r = await chatJSON([
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Film: ${outline.title || brief.title || 'Untitled'} — ${outline.logline || ''}
Global look: ${style}
${bible(brief)}
Previous scene: ${scenes[i - 1]?.summary || '(opening)'}
THIS scene (${i + 1}/${scenes.length}) "${sc.title}": ${sc.summary}
Next scene: ${scenes[i + 1]?.summary || '(ending)'}

Write exactly ${sc.shots} consecutive shots of about ${brief.clipSeconds}s for this scene.
Return JSON: {"shots": [{"title": string (3-6 words), "action": string (what happens), "camera": string (shot size + move), "prompt": string (60-120 word self-contained video prompt), "continuity": "continue" | "cut"${brief.narration ? `, "narration": string (voice-over line for this shot, at most ${Math.round((brief.clipSeconds || 8) * 2.3)} words, ${brief.narratorStyle || "a warm documentary narrator"}; empty string when the shot should breathe)` : ""}}]}
"continue" means the shot follows directly from the previous shot's last frame (same place, same moment); "cut" means a new angle or location.
The first shot of the scene is usually "cut".`,
        },
      ], signal);
      out[i] = (r.shots || []).slice(0, sc.shots);
      while (out[i].length < sc.shots) out[i].push({ title: `${sc.title} ${out[i].length + 1}`, action: sc.summary, prompt: `${style}. ${sc.summary}`, continuity: 'continue' });
      done++;
      onStatus?.({ message: `Wrote shots for scene ${done}/${scenes.length}`, progress: done / scenes.length });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return {
    title: outline.title || brief.title,
    logline: outline.logline || '',
    style,
    director: backend,
    scenes: scenes.map((s, i) => ({ title: s.title, summary: s.summary, music: s.music || brief.musicPrompt || '', shots: out[i] })),
  };
}

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

// Tools (UGC ad scripts, What's-next ideas) reuse whichever director LLM is connected.
export { chat as directorChat, chatJSON as directorJSON };
