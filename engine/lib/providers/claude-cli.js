// Claude as a director through the official Claude Code CLI in headless mode (`claude -p`), billed to
// the user's Claude subscription rather than an API key. Works with:
//   - the CLI installed next to the engine (Docker image: npm @anthropic-ai/claude-code, state in
//     CLAUDE_CONFIG_DIR=/data/claude, headless auth via CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`)
//   - any command set in CLAUDE_CLI, e.g. CLAUDE_CLI="ssh mac claude" (args are shell-quoted for ssh).
// No tools are enabled: the model only writes text. Calls are serialised (CLAUDE_CLI_CONCURRENCY, default 1).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderError } from '../http.js';

export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'];
export const CLAUDE_DEFAULT_MODEL = process.env.CLAUDE_CLI_MODEL || 'opus';
const TIMEOUT = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 6 * 60 * 1000;
const LIMIT = Math.max(1, Number(process.env.CLAUDE_CLI_CONCURRENCY) || 1);
// Keep the CLI away from the engine's checkout (no CLAUDE.md / project settings get picked up).
const WORKDIR = path.join(os.tmpdir(), 'engine-claude-director');

function command() {
  const raw = (process.env.CLAUDE_CLI || 'claude').trim();
  const parts = raw.split(/\s+/);
  return { bin: parts[0], pre: parts.slice(1), viaSsh: path.basename(parts[0]) === 'ssh' };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A CLI started from inside another Claude Code session inherits its env (CLAUDE_CODE_SIMPLE, a proxied
// ANTHROPIC_BASE_URL…), which would bypass the subscription login. Pass only what the CLI needs.
// ANTHROPIC_API_KEY is dropped on purpose: this backend is for the subscription, never API billing.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC)/.test(k) && !['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(k)) delete env[k];
  }
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

function exec(args, { input, timeout = TIMEOUT, signal } = {}) {
  const { bin, pre, viaSsh } = command();
  const argv = [...pre, ...(viaSsh ? args.map(shq) : args)];
  fs.mkdirSync(WORKDIR, { recursive: true });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, { cwd: WORKDIR, env: cleanEnv(), stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(reject, new ProviderError('claude', 0, `no reply within ${Math.round(timeout / 1000)} s`, { retryable: true })); }, timeout);
    const onAbort = () => { child.kill('SIGTERM'); finish(reject, new Error('cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', (e) => finish(reject, e.code === 'ENOENT' ? new ProviderError('claude', 0, `${bin} not found — install Claude Code or set CLAUDE_CLI`) : e));
    child.on('close', (code) => finish(resolve, { code, out, err }));
    if (input != null) child.stdin.end(input);
  });
}

/* ---------------- availability (cheap: `claude auth status`, no tokens) ---------------- */

let cached = null;
let cachedAt = 0;
let inflight = null;

/** { available, installed, loggedIn, authMethod, subscription, version, error } — cached for a minute. */
export async function claudeStatus({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 60000) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const st = { available: false, installed: false, loggedIn: false, authMethod: null, subscription: null, version: null, error: null, command: command().bin };
    try {
      const v = await exec(['--version'], { timeout: 15000 });
      if (v.code !== 0) throw new Error((v.err || v.out).trim().split('\n').pop() || `exit ${v.code}`);
      st.installed = true;
      st.version = v.out.trim().split(/\s+/)[0] || null;
      const a = await exec(['auth', 'status', '--json'], { timeout: 15000 });
      let j = {};
      try { j = JSON.parse(a.out); } catch {}
      st.loggedIn = !!j.loggedIn || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
      st.authMethod = j.authMethod || (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : null);
      st.subscription = j.subscriptionType || null;
      if (j.apiProvider && j.apiProvider !== 'firstParty') st.error = `CLI is set up for ${j.apiProvider}, not a Claude subscription`;
      else if (!st.loggedIn) st.error = 'Claude Code is installed but not signed in — run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN';
      st.available = st.loggedIn && !st.error;
    } catch (e) {
      st.error = e.message;
    }
    cached = st;
    cachedAt = Date.now();
    return st;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Synchronous best guess for menus (last known status). */
export const claudeAvailable = () => !!cached?.available;

/* ---------------- chat ---------------- */

let active = 0;
const waiters = [];
async function slot(signal) {
  while (active >= LIMIT) {
    await new Promise((r) => waiters.push(r));
    if (signal?.aborted) throw new Error('cancelled');
  }
  active++;
}
const release = () => { active--; waiters.shift()?.(); };

/** Render an OpenAI-style message list as one prompt (system → --system-prompt, the rest on stdin). */
function render(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const body = turns.length === 1
    ? turns[0].content
    : turns.map((m) => `${m.role === 'assistant' ? '[Your previous reply]' : '[Request]'}\n${m.content}`).join('\n\n');
  return { system, body };
}

export async function claudeChat({ model, messages, signal }) {
  const { system, body } = render(messages);
  const m = model || CLAUDE_DEFAULT_MODEL;
  const args = ['-p', '--output-format', 'json', '--model', m, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--safe-mode',
    '--system-prompt', system || 'You are a helpful writing assistant. Reply with only what is asked.'];
  if (m !== 'sonnet') args.push('--fallback-model', 'sonnet');
  await slot(signal);
  let r;
  try {
    r = await exec(args, { input: body, signal });
  } finally {
    release();
  }
  let j = null;
  try { j = JSON.parse(r.out); } catch {}
  if (!j) {
    const msg = (r.err || r.out || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 400);
    if (/not (logged|signed) in|login|authenticat|setup-token/i.test(msg)) cached = { ...(cached || {}), available: false, loggedIn: false, error: msg };
    throw new ProviderError('claude', 0, msg, { retryable: /timeout|ECONN|overloaded|5\d\d/i.test(msg) });
  }
  if (j.is_error || j.subtype !== 'success') {
    const msg = String(j.result || j.subtype || 'error').slice(0, 400);
    const quota = /usage limit|rate limit|limit reached|quota/i.test(msg);
    throw new ProviderError('claude', j.api_error_status || 0, msg, { quota, retryable: quota || /overloaded|timeout/i.test(msg) });
  }
  return String(j.result || '');
}
