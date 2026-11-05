// Music + narration for long-form films.
import fsp from 'node:fs/promises';
import { addAsset, assetPath, newAssetPath, updateAsset } from './store.js';
import { googleMusic, googleSpeech, googleAvailable, GEMINI_VOICES } from './providers/google.js';
import { xaiSpeech, xaiVoices, xaiAvailable } from './providers/xai.js';
import { localSpeech, localVoices, localVoiceEngine } from './providers/localaudio.js';
import { elevenSpeech, elevenVoices, elevenAvailable, ELEVEN_DEFAULT_VOICE } from './providers/eleven.js';
import * as ff from './ffmpeg.js';

export async function soundCatalog() {
  const [ev, xv, lv, le] = await Promise.all([
    elevenAvailable() ? elevenVoices().catch(() => []) : [],
    xaiAvailable() ? xaiVoices().catch(() => ['eve', 'ara']) : [],
    localVoices().catch(() => []),
    localVoiceEngine(),
  ]);
  return {
    music: [
      { id: 'google/lyria-3.5', label: 'Lyria 3.5 — full score (Gemini API)', available: googleAvailable() },
      { id: 'google/lyria-3-clip-preview', label: 'Lyria 3 Clip — 30 s loops (Gemini API)', available: googleAvailable() },
    ],
    // Same order as pickVoiceProvider, so "Best available" in the UI matches what the engine uses.
    voice: [
      { id: 'eleven', label: 'ElevenLabs voice (your voices + stock)', available: elevenAvailable(), voices: ev.map((v) => ({ id: v.id, name: v.note ? `${v.name} — ${v.note}` : v.name })), defaultVoice: ELEVEN_DEFAULT_VOICE },
      { id: 'xai', label: 'Grok voice (SuperGrok / xAI)', available: xaiAvailable(), voices: xv.length ? xv : ['eve', 'ara'] },
      { id: 'google', label: 'Gemini voice (Gemini API)', available: googleAvailable(), voices: GEMINI_VOICES },
      { id: 'local', label: le === 'say' ? 'Mac built-in voice (free, offline)' : 'Offline voice (espeak, free)', available: !!le, voices: lv },
    ],
  };
}

export function pickVoiceProvider(pref) {
  if (pref && pref !== 'auto') return pref;
  if (elevenAvailable()) return 'eleven';
  if (xaiAvailable()) return 'xai';
  if (googleAvailable()) return 'google';
  return 'local';
}

async function toAsset(r, meta, signal) {
  const ext = r.ext || ({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aiff': 'aiff' }[r.mime] || 'bin');
  const tmp = newAssetPath('audio/mpeg');
  const raw = `${tmp.abs}.src.${ext}`;
  await fsp.writeFile(raw, r.buffer);
  const out = `${tmp.abs.replace(/\.mp3$/, '')}.m4a`;
  try {
    const duration = await ff.toM4a(raw, out, { signal });
    const file = out.split('/').pop();
    const asset = await addAsset({ abs: out, id: tmp.id, file, mime: 'audio/mp4', meta: { ...meta, duration } });
    updateAsset(asset.id, { kind: 'audio' });
    return { ...asset, kind: 'audio', duration };
  } finally {
    await fsp.rm(raw, { force: true });
  }
}

export async function makeVoice({ provider, voice, text, style }, { signal } = {}) {
  const prov = pickVoiceProvider(provider);
  let r;
  if (prov === 'eleven') r = await elevenSpeech({ text, voice }, { signal });
  else if (prov === 'xai') r = await xaiSpeech({ text, voice: voice || 'eve' }, { signal });
  else if (prov === 'google') r = await googleSpeech({ text, voice: voice || 'Kore', style }, { signal });
  else r = await localSpeech({ text, voice });
  return toAsset(r, { source: 'narration', prompt: text, model: `${prov}-voice` }, signal);
}

export async function makeMusic({ model = 'google/lyria-3.5', prompt, seconds }, { signal, onStatus } = {}) {
  const slug = model.replace(/^google\//, '');
  const r = await googleMusic({ model: slug, prompt, seconds }, { signal, onStatus });
  return toAsset({ ...r, mime: r.mime || 'audio/mpeg' }, { source: 'music', prompt, model }, signal);
}

export const audioPath = (a) => assetPath(a);
