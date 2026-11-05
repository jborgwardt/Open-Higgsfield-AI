// ElevenLabs narration: your own voices (clones first), professional and stock voices.
import { getSettings } from '../store.js';
import { fetchJSON, httpError, ProviderError } from '../http.js';

const BASE = 'https://api.elevenlabs.io';
export const ELEVEN_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // George — warm, captivating storyteller (stock)
export const ELEVEN_TTS_MODELS = ['eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5'];

export const elevenAvailable = () => !!getSettings().elevenKey;
const key = () => {
  const k = getSettings().elevenKey;
  if (!k) throw new ProviderError('elevenlabs', 0, 'no ElevenLabs key — add one in Providers');
  return k;
};

let voiceCache = { at: 0, key: '', list: null };

/** [{ id, name, note, category }] — cloned voices first, then professional, generated, stock. Cached 10 min. */
export async function elevenVoices({ fresh } = {}) {
  const k = key();
  if (!fresh && voiceCache.list && voiceCache.key === k && Date.now() - voiceCache.at < 600000) return voiceCache.list;
  const j = await fetchJSON('elevenlabs', `${BASE}/v2/voices?page_size=100`, { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(20000) });
  const order = { cloned: 0, professional: 1, generated: 2, premade: 3 };
  const list = (j.voices || []).map((v) => {
    const [name, ...rest] = String(v.name || 'Voice').split(' - ');
    const cat = v.category || '';
    return { id: v.voice_id, name: name.trim(), note: cat === 'cloned' ? 'your cloned voice' : rest.join(' - ').trim() || null, category: cat };
  }).sort((a, b) => (order[a.category] ?? 2) - (order[b.category] ?? 2) || a.name.localeCompare(b.name));
  voiceCache = { at: Date.now(), key: k, list };
  return list;
}

export async function elevenSubscription() {
  return fetchJSON('elevenlabs', `${BASE}/v1/user/subscription`, { headers: { 'xi-api-key': key() }, signal: AbortSignal.timeout(20000) });
}

/** Speak text in an ElevenLabs voice id; returns an MP3 buffer. */
export async function elevenSpeech({ text, voice, model }, { signal } = {}) {
  const vid = String(voice || ELEVEN_DEFAULT_VOICE).replace(/^el:/, '');
  const url = `${BASE}/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`;
  const body = { text: String(text).slice(0, 9000), model_id: model || getSettings().elevenModel || 'eleven_v4', voice_settings: { stability: 0.5, similarity_boost: 0.8 } };
  const post = (b) => fetch(url, { method: 'POST', headers: { 'xi-api-key': key(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(b), signal: signal || AbortSignal.timeout(300000) });
  let res;
  try {
    res = await post(body);
    // Some models reject custom voice settings — fall back to the voice's own.
    if (res.status === 400 || res.status === 422) {
      const { voice_settings, ...plain } = body;
      void voice_settings;
      res = await post(plain);
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('cancelled');
    throw new ProviderError('elevenlabs', 0, e.cause?.code || e.message, { retryable: true });
  }
  if (!res.ok) throw await httpError('elevenlabs', res);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', ext: 'mp3' };
}

/**
 * Voice changer: re-speak a recorded line in another ElevenLabs voice (your clone included),
 * keeping the original timing and delivery — so lip movement in a generated clip still lines up.
 */
export async function elevenVoiceChange({ buffer, mime = 'audio/wav', filename = 'line.wav', voice, model = 'eleven_multilingual_sts_v2', removeNoise = true }, { signal } = {}) {
  const vid = String(voice || ELEVEN_DEFAULT_VOICE).replace(/^el:/, '');
  const fd = new FormData();
  fd.append('audio', new Blob([buffer], { type: mime }), filename);
  fd.append('model_id', model);
  fd.append('remove_background_noise', String(!!removeNoise));
  fd.append('voice_settings', JSON.stringify({ stability: 0.5, similarity_boost: 0.85, style: 0 }));
  let res;
  try {
    res = await fetch(`${BASE}/v1/speech-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_192`, { method: 'POST', headers: { 'xi-api-key': key(), Accept: 'audio/mpeg' }, body: fd, signal: signal || AbortSignal.timeout(300000) });
  } catch (e) {
    if (signal?.aborted) throw new Error('cancelled');
    throw new ProviderError('elevenlabs', 0, e.cause?.code || e.message, { retryable: true });
  }
  if (!res.ok) throw await httpError('elevenlabs', res);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', ext: 'mp3' };
}
