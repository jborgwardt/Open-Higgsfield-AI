// Google AI Ultra plan (cloudcode sign-in) vs the paid Gemini API key: separate providers, models and labels.
// Offline: fetch is stubbed, tokens are synthetic. Run: node --test engine/test/google-ultra.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ultra-test-'));
process.env.ENGINE_DATA = DATA;
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_ULTRA_CLIENT_SECRET']) delete process.env[k];

let cat, store, ultra, director, sound;
before(async () => {
  store = await import('../lib/store.js');
  cat = await import('../lib/catalog.js');
  ultra = await import('../lib/providers/google-ultra.js');
  director = await import('../lib/director.js');
  sound = await import('../lib/sound.js');
});

test('provider labels keep the paid Gemini API and the AI Ultra plan apart', () => {
  assert.match(cat.PROVIDERS.google.label, /Gemini API/);
  assert.match(cat.PROVIDERS.google.note, /billed/i);
  assert.equal(cat.PROVIDERS['google-ultra'].label, 'Google AI Ultra (your plan)');
  assert.match(cat.PROVIDERS['google-ultra'].note, /Included with your AI Ultra subscription/);
  for (const m of cat.allModels().filter((x) => x.provider === 'google')) assert.match(m.label, /Gemini API/, m.id);
  const ul = director.DIRECTORS.find((d) => d.id === 'google-ultra');
  assert.ok(ul, 'AI Ultra director exists');
  assert.equal(director.DIRECTOR_LABEL.google, 'Google Gemini API (paid key)');
});

test('AI Ultra models exist and are unavailable without a googleUltra sign-in', async () => {
  for (const id of ['google-ultra/nano-banana-2.1', 'google-ultra/nano-banana-pro']) {
    const m = cat.getModel(id);
    assert.ok(m, id);
    assert.equal(m.kind, 'image');
    assert.equal(m.refs, 6);
    assert.deepEqual(m.aspects, cat.getModel('google/gemini-nano-banana-2.1').aspects);
    assert.match(m.label, /\(AI Ultra plan\)$/);
  }
  assert.equal(cat.getModel('google-ultra/lyria-3.5')?.kind, 'music');
  assert.equal(cat.availableProviders()['google-ultra'], false);
  assert.ok(cat.publicCatalog().filter((m) => m.provider === 'google-ultra').every((m) => !m.available));
  const sc = await sound.soundCatalog();
  assert.equal(sc.music.find((m) => m.id === 'google-ultra/lyria-3.5')?.available, false);
  assert.equal(sc.voice.find((v) => v.id === 'google-ultra')?.available, false);
  await assert.rejects(cat.generate({ model: 'google-ultra/nano-banana-2.1', prompt: 'a pine forest', aspect: '16:9' }), /not connected/);
});

test('signed in: Ultra models light up and images go to cloudcode with refs + aspect', async () => {
  await store.setGoogleUltra({ refresh_token: 'synthetic-refresh', access_token: 'synthetic-access', expires_at: Date.now() + 3600e3, email: 'test@example.com' });
  assert.equal(cat.availableProviders()['google-ultra'], true);
  assert.deepEqual(ultra.ultraStatus(), { connected: true, email: 'test@example.com', hasSecret: false });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } }] } }] } }), { status: 200 });
  };
  try {
    const r = await ultra.ultraImage({ model: 'nano-banana-2.1', prompt: 'a cabin', refs: [{ mime: 'image/jpeg', base64: 'AAA' }], aspect: '9:16' });
    assert.equal(r.mime, 'image/png');
    assert.equal(calls[0].body.model, 'gemini-nano-banana-2.1');
    assert.equal(calls[0].body.request.generationConfig.imageConfig.aspectRatio, '9:16');
    assert.equal(calls[0].body.request.contents[0].parts[0].inlineData.data, 'AAA');
    assert.match(calls[0].url, /cloudcode/);
    assert.ok(!calls.some((c) => c.url.includes('generativelanguage.googleapis.com')), 'never the paid Gemini API');

    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Hello' }] } }] } }), { status: 200 });
    };
    const out = await ultra.ultraChat({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Yo' }, { role: 'user', content: 'Again' }] });
    assert.equal(out, 'Hello');
    const req = calls.at(-1).body;
    assert.equal(req.model, 'gemini-3.8-flash');
    assert.deepEqual(req.request.systemInstruction, { parts: [{ text: 'Be brief.' }] });
    assert.deepEqual(req.request.contents.map((c) => c.role), ['user', 'model', 'user']);
  } finally {
    globalThis.fetch = realFetch;
    await ultra.logout();
  }
  assert.equal(cat.availableProviders()['google-ultra'], false);
});

test('Ultra TTS PCM is wrapped as WAV', () => {
  const w = ultra.pcmToWav({ buffer: Buffer.alloc(480), mime: 'audio/L16;codec=pcm;rate=24000' });
  assert.equal(w.mime, 'audio/wav');
  assert.equal(w.buffer.length, 524);
  assert.equal(w.buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.buffer.readUInt32LE(24), 24000);
  const mp3 = { buffer: Buffer.from('x'), mime: 'audio/mpeg' };
  assert.equal(ultra.pcmToWav(mp3), mp3);
});

test('server exposes the AI Ultra sign-in routes behind studio auth', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const r of ["route('GET', '/google-ultra/login'", "route('POST', '/google-ultra/login'", "route('POST', '/google-ultra/login/complete'", "route('POST', '/google-ultra/logout'"]) assert.ok(src.includes(r), r);
  const open = src.match(/const open = [^\n]+/)[0];
  assert.ok(!open.includes('google-ultra'), 'not on the unauthenticated list');
});
