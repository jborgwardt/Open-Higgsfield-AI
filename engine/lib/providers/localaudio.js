// Free offline narration: macOS `say`, or `espeak-ng` on Linux servers.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = (bin, args) => new Promise((resolve, reject) => {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', reject);
  p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${bin} exited ${c}: ${err.slice(-200)}`))));
});

let engineCache;
export async function localVoiceEngine() {
  if (engineCache !== undefined) return engineCache;
  try { await run('say', ['-v', '?']); engineCache = 'say'; } catch {
    try { await run('espeak-ng', ['--version']); engineCache = 'espeak-ng'; } catch { engineCache = null; }
  }
  return engineCache;
}

export async function localVoices() {
  const eng = await localVoiceEngine();
  if (eng === 'say') {
    const out = await run('say', ['-v', '?']);
    return out.split('\n').map((l) => l.match(/^(.+?)\s{2,}(en[_-]\w+)/)).filter(Boolean).map((m) => m[1].trim()).slice(0, 150);
  }
  if (eng === 'espeak-ng') return ['en-us', 'en-gb', 'en-us+f3', 'en-us+m3'];
  return [];
}

export async function localSpeech({ text, voice }) {
  const eng = await localVoiceEngine();
  if (!eng) throw new Error('no offline voice available (macOS `say` or `espeak-ng`)');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'voice-'));
  try {
    if (eng === 'say') {
      const out = path.join(dir, 'v.aiff');
      await run('say', [...(voice ? ['-v', voice] : []), '-o', out, text]);
      return { buffer: await fsp.readFile(out), mime: 'audio/aiff', ext: 'aiff' };
    }
    const out = path.join(dir, 'v.wav');
    await run('espeak-ng', ['-v', voice || 'en-us', '-s', '160', '-w', out, text]);
    return { buffer: await fsp.readFile(out), mime: 'audio/wav', ext: 'wav' };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
