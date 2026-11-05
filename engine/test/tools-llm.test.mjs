// node --test engine/test — ops.llmJSON (LLM-backed tools) resolves a real chat backend and says so in the job.
// Offline: a mock OpenAI-compatible server stands in for the "local LLM" director; no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

for (const k of ['FAL_KEY', 'FAL_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'APIMART_API_KEY', 'QWEN_API_KEY', 'VENICE_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];
process.env.CLAUDE_CLI = '/nonexistent/claude'; // never reach a real Claude subscription from tests

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-chat' }] }));
    seen.push(JSON.parse(body));
    res.end(JSON.stringify({ choices: [{ message: { content: 'Sure:\n```json\n{"frames":[{"prompt":"wide shot"},{"prompt":"close-up"}]}\n```' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-llm-'));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ llmBaseUrl: base, llmModel: 'mock-chat', directorProvider: 'openai' }));
process.env.ENGINE_DATA = dir;
const store = await import('../lib/store.js');
const op = await import('../lib/ops.js');

test('llmJSON uses the chosen director with the (d, messages, signal) signature', async () => {
  const notes = [];
  const r = await op.llmJSON('You are a storyboard artist.', 'N=2', { note: (m) => notes.push(m) });
  assert.deepEqual(r, { frames: [{ prompt: 'wide shot' }, { prompt: 'close-up' }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'mock-chat');
  assert.deepEqual(seen[0].messages.map((m) => m.role), ['system', 'user']);
  assert.deepEqual(notes, []);
});

test('llmJSON with no director chosen falls back to an available chat backend and notes it in the job', async () => {
  await store.updateSettings({ directorProvider: '' });
  const notes = [];
  const r = await op.llmJSON('sys', 'user', { note: (m) => notes.push(m) });
  assert.ok(r?.frames);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /No director chosen — text written by OpenAI-compatible/);
});

test('llmJSON whose backend fails returns null (template text) and says why in the job', async () => {
  await store.updateSettings({ directorProvider: '', llmBaseUrl: 'http://127.0.0.1:9/v1' });
  const notes = [];
  assert.equal(await op.llmJSON('sys', 'user', { note: (m) => notes.push(m) }), null);
  // The model list is cached for a few minutes, so the backend still looks available and the call itself fails.
  assert.match(notes.at(-1), /failed \(.*\) — used template text instead|No chat model is available/);
});

test('the Storyboard / UGC tools pass their job context (signal + note) to llmJSON', () => {
  const src = fs.readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8');
  const calls = src.match(/op\.llmJSON\([^\n]*/g);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /, ctx\);$/);
});

test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
