// Google Gemini API — Gemini Omni Flash (video) and Nano Banana (image) via the Interactions API.
// Billed to the Cloud project behind the API key. Google AI Ultra includes $100/month of Google
// Cloud credits through the Google Developer Program, which can pay for these calls.
import { getSettings } from '../store.js';
import { fetchJSON, sleep, download, ProviderError } from '../http.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const REVISION = '2026-05-20';

function key() {
  const k = getSettings().googleKey;
  if (!k) throw new ProviderError('google', 0, 'no Gemini API key — add one in Providers');
  return k;
}

const headers = (revision = true) => ({ 'x-goog-api-key': key(), 'Content-Type': 'application/json', ...(revision ? { 'Api-Revision': REVISION } : {}) });

const part = (media) => {
  if (!media) return null;
  if (media.uri) return { type: media.kind || 'image', uri: media.uri };
  return { type: media.kind || 'image', mime_type: media.mime, data: media.base64 };
};

// Pull the generated media out of an interaction (REST returns it inside `steps`).
async function extractMedia(it, type, signal) {
  const steps = it.steps || [];
  for (const s of steps.slice().reverse()) {
    for (const c of s.content || []) {
      if (c.type !== type) continue;
      if (c.data) return { buffer: Buffer.from(c.data, 'base64'), mime: c.mime_type };
      if (c.uri) return fetchFile(c.uri, signal);
    }
  }
  const direct = type === 'video' ? it.output_video : it.output_image;
  if (direct?.data) return { buffer: Buffer.from(direct.data, 'base64'), mime: direct.mime_type };
  if (direct?.uri) return fetchFile(direct.uri, signal);
  const blocked = steps.flatMap((s) => s.content || []).find((c) => c.type === 'text')?.text;
  throw new ProviderError('google', 0, blocked ? `no ${type} returned: ${blocked.slice(0, 300)}` : `no ${type} returned (status ${it.status})`);
}

async function fetchFile(uri, signal) {
  const id = uri.match(/files\/([\w-]+)/)?.[1];
  if (!id) return download(uri, { headers: { 'x-goog-api-key': key() }, signal });
  for (let i = 0; i < 120; i++) {
    const f = await fetchJSON('google', `${API}/files/${id}`, { headers: headers(), signal });
    if (f.state === 'ACTIVE') break;
    if (f.state === 'FAILED') throw new ProviderError('google', 0, 'video file processing failed');
    await sleep(5000, signal);
  }
  return download(`${API}/files/${id}:download?alt=media`, { headers: { 'x-goog-api-key': key() }, signal });
}

async function interact(body, { onStatus, signal, label, revision = true }) {
  onStatus?.({ message: `${label} on Gemini API` });
  let it = await fetchJSON('google', `${API}/interactions`, { method: 'POST', headers: headers(revision), body: JSON.stringify(body), signal });
  // Background interactions come back in_progress; poll until complete.
  for (let i = 0; it.status && !['completed', 'failed', 'cancelled'].includes(it.status) && i < 400; i++) {
    await sleep(4000, signal);
    it = await fetchJSON('google', `${API}/interactions/${it.id}`, { headers: headers(), signal });
    onStatus?.({ message: `${label} · ${it.status}` });
  }
  if (it.status === 'failed') {
    // The API reports why in errors[] (e.g. INVALID_ARGUMENT when Omni refuses a real person's likeness).
    const e0 = it.errors?.[0] || it.error || {};
    const code = e0.code || e0.status || '';
    const msg = e0.message || it.error?.message || 'interaction failed';
    throw new ProviderError('google', 0, code ? `${code}: ${msg}` : msg, { retryable: !/INVALID_ARGUMENT|PERMISSION_DENIED|FAILED_PRECONDITION|SAFETY|BLOCKED/i.test(`${code} ${msg}`) });
  }
  return it;
}

/**
 * Gemini Omni Flash video.
 * p: { model, prompt, image:{mime,base64}, endImage, aspect, resolution, duration, previousInteractionId }
 */
export async function googleVideo(p, ctx = {}) {
  const input = [];
  if (!p.previousInteractionId) {
    if (p.image) input.push(part(p.image));
    if (p.endImage) input.push(part(p.endImage));
  }
  const dur = p.duration ? ` Duration: about ${Math.round(p.duration)} seconds.` : '';
  input.push({ type: 'text', text: `${p.prompt}${dur}` });
  const body = {
    model: p.model || 'gemini-omni-1.1-flash',
    input,
    response_format: { type: 'video', delivery: 'uri', ...(p.aspect && ['16:9', '9:16'].includes(p.aspect) ? { aspect_ratio: p.aspect } : {}), ...(p.resolution ? { resolution: p.resolution } : {}) },
    background: true,
  };
  if (p.previousInteractionId) body.previous_interaction_id = p.previousInteractionId;
  let it;
  try {
    it = await interact(body, { ...ctx, label: p.previousInteractionId ? 'Extending with Omni Flash' : 'Rendering with Omni Flash' });
  } catch (e) {
    if (p.image && /INVALID_ARGUMENT/.test(e.message)) e.message += ' — Gemini Omni refuses to animate stills of real people; use Veo 3.1, Kling, Seedance or Grok for character shots';
    throw e;
  }
  const file = await extractMedia(it, 'video', ctx.signal);
  return { ...file, ref: { provider: 'google', interactionId: it.id } };
}

/** Nano Banana keyframes / edits. p: { model, prompt, image, refs:[{mime,base64}], aspect } */
export async function googleImage(p, ctx = {}) {
  const imgs = [p.image, ...(p.refs || [])].filter(Boolean).slice(0, 6);
  const input = [...imgs.map(part), { type: 'text', text: p.prompt }];
  const body = {
    model: p.model || 'gemini-nano-banana-2.1',
    input,
    response_format: { type: 'image', mime_type: 'image/jpeg', ...(p.aspect && p.aspect !== 'auto' ? { aspect_ratio: p.aspect } : {}), image_size: '2K' },
  };
  const it = await interact(body, { ...ctx, label: 'Nano Banana' });
  return extractMedia(it, 'image', ctx.signal);
}

/** Director LLM through Gemini's OpenAI-compatible endpoint. */
export async function googleChat({ model, messages, signal }) {
  const r = await fetchJSON('google', `${API}/openai/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'gemini-flash-latest', messages, temperature: 0.7 }),
    signal,
  });
  return r.choices?.[0]?.message?.content || '';
}

export const googleAvailable = () => !!getSettings().googleKey;

/* ---------------- sound ---------------- */

export const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];

/** Lyria music. lyria-3-clip-preview = 30s loopable clip; lyria-3.5 = full track, length steered by prompt. */
export async function googleMusic({ model = 'lyria-3.5', prompt, seconds }, ctx = {}) {
  const len = model === 'lyria-3.5' && seconds ? ` Length: about ${Math.round(seconds)} seconds, with a clean ending.` : '';
  const it = await interact({ model, input: `${prompt}. Instrumental only, no vocals, film score that sits under dialogue.${len}`, response_format: { type: 'audio' } }, { ...ctx, label: 'Composing with Lyria' });
  return extractMedia(it, 'audio', ctx.signal);
}

/** Gemini TTS narration (returns WAV). */
export async function googleSpeech({ model = 'gemini-3.8-flash-tts', text, voice = 'Kore', style }, ctx = {}) {
  const it = await interact({
    model,
    input: [{ type: 'user_input', content: [{ type: 'text', text, ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}) }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  }, { ...ctx, label: 'Voicing with Gemini', revision: false });
  const out = await extractMedia(it, 'audio', ctx.signal);
  return { ...out, mime: out.mime || 'audio/wav' };
}
