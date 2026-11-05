// Starts a throwaway engine for tests: temp data dir, clean environment (no provider keys, no LLM,
// no ComfyUI), optionally with OIDC pointed at the fake provider. Nothing here can spend money.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function startEngine({ port = 4900 + Math.floor(Math.random() * 90), env = {} } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'filmstudio-engine-'));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['engine/server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: data, ENGINE_PORT: String(port), ENGINE_DATA: data, LLM_BASE_URL: 'http://127.0.0.1:9/v1', COMFY_URL: 'http://127.0.0.1:9', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/engine/api/health`)).ok) break; } catch {}
    if (i === 99) throw new Error(`engine did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    data,
    get log() { return log; },
    stop() { child.kill(); fs.rmSync(data, { recursive: true, force: true }); },
  };
}
