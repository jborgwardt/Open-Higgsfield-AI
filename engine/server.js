// Open Higgsfield local engine — provider router, long-form production runner, media server.
// Zero dependencies. Listens on 127.0.0.1:4848; the Vite dev server proxies /engine here, and
// `npm run local` serves the built UI from ./dist on the same port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, MEDIA, getSettings, publicSettings, updateSettings, addAsset, mimeForExt, listAssets, updateAsset, getAsset, accessToken, tokenMatches } from './lib/store.js';
import { publicCatalog, availableProviders, PROVIDERS } from './lib/catalog.js';
import * as jobs from './lib/jobs.js';
import * as lf from './lib/longform.js';
import * as xai from './lib/providers/xai.js';
import { comfyPing } from './lib/providers/comfy.js';
import { openaiPing } from './lib/providers/openai.js';
import { directorBackend } from './lib/director.js';
import { hasFfmpeg } from './lib/ffmpeg.js';
import { soundCatalog } from './lib/sound.js';
import { oidcConfig, loginRedirect, finishLogin, sessionFor, endSession, sessionCookie, clearSessionCookie } from './lib/oidc.js';
import { fetchJSON } from './lib/http.js';
import { apimartModels, APIMART_LLMS } from './lib/providers/apimart.js';
import { elevenSubscription, elevenVoices, elevenAvailable, ELEVEN_TTS_MODELS } from './lib/providers/eleven.js';
import * as tools from './lib/tools.js'; // Higgsfield-parity one-click tools (server-driven registry)
import { qwenModels, qwenTaskPing } from './lib/providers/qwen.js';

const PORT = Number(process.env.ENGINE_PORT) || 4848;
const HOST = process.env.ENGINE_HOST || '127.0.0.1';
const DIST = process.env.ENGINE_DIST || path.join(REPO_ROOT, 'dist');
// Anything other than loopback means other devices (your iPhone) can reach the engine: require the access code.
const REMOTE = process.env.ENGINE_REQUIRE_AUTH === '1' || !['127.0.0.1', '::1', 'localhost'].includes(HOST);

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
function currentUser(req) {
  return oidcConfig() ? sessionFor(cookie(req, 'engine_session')) : null;
}
function authed(req, url) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (oidcConfig()) {
    // Pocket ID is the only way in; the access code is accepted only from the server itself (maintenance).
    return !!currentUser(req) || (isLoopback(req) && !!bearer && tokenMatches(bearer));
  }
  if (!REMOTE) return true;
  return [bearer, cookie(req, 'engine_token'), url.searchParams.get('t')].some((t) => t && tokenMatches(t));
}
const secureReq = (req) => req.headers['x-forwarded-proto'] === 'https';
const failures = new Map();
function throttled(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const f = failures.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - f.at > 60000) { f.n = 0; f.at = Date.now(); }
  failures.set(ip, f);
  return f;
}
const MAX_JSON = 80 * 1024 * 1024;
const MAX_UPLOAD = 1024 * 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req) {
  const buf = await readRaw(req, MAX_JSON);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function serveFile(req, res, abs, type, immutable) {
  let st;
  try { st = fs.statSync(abs); } catch { return false; }
  if (!st.isFile()) return false;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache' };
  const m = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` }); return true; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(abs, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(abs).pipe(res);
  return true;
}

/* ---------------- provider status ---------------- */

let ffOk = null;
async function status(fresh) {
  const s = getSettings();
  if (ffOk === null || fresh) ffOk = await hasFfmpeg();
  const [comfy, llm] = await Promise.all([
    comfyPing(s.comfyUrl).then(() => true).catch(() => false),
    openaiPing().then((m) => m).catch(() => null),
  ]);
  globalThis.__comfyOnline = comfy;
  const avail = availableProviders();
  const x = xai.loginStatus();
  return {
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { ...v, available: !!avail[k] }])),
    xai: { ...x, apiKey: !!s.xaiKey, preferSubscription: s.xaiPreferSubscription },
    comfy,
    llm: { online: !!llm, models: llm || [] },
    director: await directorBackend(),
    directorModels: { apimart: APIMART_LLMS },
    eleven: { available: elevenAvailable(), models: ELEVEN_TTS_MODELS },
    ffmpeg: ffOk,
  };
}

/* ---------------- routes ---------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^/engine/api${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });
const prod = (id) => { const p = lf.getProduction(id); if (!p) throw new HttpError(404, 'production not found'); return p; };

route('GET', '/health', ({ req, url }) => {
  const cfg = oidcConfig();
  const user = currentUser(req);
  return { ok: true, name: 'open-higgsfield-engine', version: 1, auth: REMOTE || !!cfg, mode: cfg ? 'oidc' : 'code', provider: cfg?.label || null, authed: authed(req, url), user: user ? { name: user.name, email: user.email } : null };
});
route('POST', '/login', ({ req, body }) => {
  if (oidcConfig()) throw new HttpError(403, 'Sign in with Pocket ID');
  const f = throttled(req);
  if (f.n >= 10) throw new HttpError(429, 'Too many attempts — wait a minute');
  if (!tokenMatches(String(body.token || '').trim())) { f.n++; throw new HttpError(401, 'That access code is not right'); }
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return { ok: true, __cookie: `engine_token=${encodeURIComponent(accessToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` };
});
route('POST', '/logout', ({ req }) => { endSession(cookie(req, 'engine_session')); return { ok: true, __cookie: oidcConfig() ? clearSessionCookie() : 'engine_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' }; });
route('GET', '/status', ({ url }) => status(url.searchParams.has('fresh')));
route('GET', '/catalog', async () => { await status(); return { models: publicCatalog(), providers: PROVIDERS }; });
route('GET', '/settings', () => publicSettings());
route('POST', '/settings', async ({ body }) => ({ settings: await updateSettings(body), status: await status(true) }));

route('POST', '/xai/login', () => xai.startDeviceLogin());
route('GET', '/xai/login', () => xai.loginStatus());
route('POST', '/xai/logout', async () => { await xai.logout(); return xai.loginStatus(); });
route('POST', '/test/:provider', async ({ params }) => {
  const s = getSettings();
  switch (params.provider) {
    case 'xai': { const ids = await xai.xaiModels(); const cred = await xai.credential(); return { ok: true, via: cred.via, detail: `${ids.length} models visible (${ids.filter((i) => /imagine/.test(i)).join(', ') || 'no Imagine models listed'})` }; }
    case 'google': { const j = await fetchJSON('google', `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': s.googleKey } }); const ids = (j.models || []).map((m) => m.name.replace('models/', '')); return { ok: true, detail: `${ids.length} models (${ids.filter((i) => /omni|banana|image|veo/.test(i)).slice(0, 6).join(', ')})` }; }
    case 'apimart': {
      const ids = await apimartModels();
      const video = ids.filter((i) => /^(veo3\.1-(quality|fast)|kling-v[34]|seedance-2\.[05]|wan2\.6|wan3\.0-video)$/.test(i));
      return { ok: true, detail: `${ids.length} models (${video.join(', ') || 'no studio video models listed'})` };
    }
    case 'eleven': {
      const [sub, voices] = await Promise.all([elevenSubscription(), elevenVoices({ fresh: true })]);
      const used = sub.character_limit ? ` · ${Math.round(((sub.character_count || 0) / sub.character_limit) * 100)}% of ${sub.character_limit.toLocaleString('en')} credits used` : '';
      return { ok: true, detail: `${sub.tier || 'plan'} plan${used} · ${voices.length} voices (${voices.filter((v) => v.category === 'cloned').map((v) => v.name).join(', ') || 'no clones'} cloned)` };
    }
    case 'qwen': { // free: model list + a task lookup proves the key; entitlement is per model (see providers/qwen.js)
      const [ids] = await Promise.all([qwenModels(), qwenTaskPing()]);
      return { ok: true, detail: `Token Plan key works · ${ids.length} models listed (HappyHorse video, ${ids.filter((i) => /image/.test(i)).join(', ')})` };
    }
    case 'comfy': return { ok: true, detail: JSON.stringify((await comfyPing(s.comfyUrl)).devices?.[0]?.name || 'online') };
    case 'llm': return { ok: true, detail: `${(await openaiPing()).length} models` };
    default: throw new HttpError(400, 'no live test for this provider — run a generation');
  }
});

// Raw binary upload (images, clips). ?name=file.ext
route('POST', '/upload', async ({ req, url }) => {
  const buf = await readRaw(req, MAX_UPLOAD);
  if (!buf.length) throw new HttpError(400, 'empty upload');
  const name = url.searchParams.get('name') || 'upload';
  const asset = await addAsset({ buffer: buf, mime: req.headers['content-type'] || mimeForExt(path.extname(name)), meta: { source: 'upload', name } });
  return asset;
});

// Library: everything generated or imported locally (posters / extracted frames are hidden).
route('GET', '/media', () => listAssets()
  .filter((a) => !a.hidden && ['image', 'video'].includes(a.kind) && !['poster', 'last-frame', 'continuity'].includes(a.source))
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, 1000)
  .map((a) => ({ id: a.id, engine: true, url: a.url, thumb: a.kind === 'video' ? a.posterUrl || '' : a.url, kind: a.kind === 'video' ? 'videos' : 'images', model: a.model || (a.source === 'master' ? 'Long-form master' : a.source || 'upload'), prompt: a.prompt || a.name || '', createdAt: a.createdAt, resolution: a.width ? `${a.width}×${a.height}` : '' })));
// Hide from the library (files stay on disk in engine-data/media).
route('DELETE', '/media/:id', ({ params }) => { if (!getAsset(params.id)) throw new HttpError(404, 'not found'); updateAsset(params.id, { hidden: true }); return { ok: true }; });

// Studio jobs
route('POST', '/generate', ({ body }) => {
  if (!body.model) throw new HttpError(400, 'model required');
  const id = String(body.model).replace(/^engine:/, '');
  return jobs.startJob({
    model: id, prompt: body.prompt || '', image: body.image_url || body.image || null, endImage: body.end_image_url || null,
    refs: body.images_list || body.refs || [], aspect: body.aspect_ratio || body.aspect || '16:9', duration: body.duration, resolution: body.resolution,
    seed: Number.isInteger(body.seed) && body.seed >= 0 ? body.seed : undefined,
  });
});
route('GET', '/jobs/:id', ({ params }) => jobs.getJob(params.id) || Promise.reject(new HttpError(404, 'job not found')));

// ---- Tools (Higgsfield-parity apps): server-driven registry rendered by the web Tools page and the Apple app ----
route('GET', '/tools', ({ url }) => tools.listTools({ all: url.searchParams.has('all') }));
route('GET', '/tools/:id', async ({ params }) => (await tools.listTools()).find((t) => t.id === params.id) || Promise.reject(new HttpError(404, 'no such tool')));
route('POST', '/tools/:id/run', ({ params, body }) => { const job = tools.runTool(params.id, body.inputs || body); return { jobId: job.id, job }; });
route('GET', '/cinema/presets', () => tools.cinemaPresets());
route('POST', '/jobs/:id/cancel', ({ params }) => jobs.cancelJob(params.id) || Promise.reject(new HttpError(404, 'job not found')));

// Long-form productions
route('GET', '/productions', () => lf.listProductions());
route('POST', '/productions', async ({ body }) => lf.hydrate(await lf.createProduction(body)));
route('GET', '/productions/:id', ({ params }) => lf.hydrate(prod(params.id)));
route('PATCH', '/productions/:id', async ({ params, body }) => { prod(params.id); await lf.updateBrief(params.id, body); return lf.hydrate(prod(params.id)); });
route('DELETE', '/productions/:id', async ({ params }) => { await lf.deleteProduction(params.id); return { ok: true }; });
route('POST', '/productions/:id/plan', async ({ params }) => lf.hydrate(await lf.plan(params.id)));
route('POST', '/productions/:id/start', async ({ params }) => lf.hydrate(await lf.start(params.id)));
route('POST', '/productions/:id/pause', async ({ params }) => { await lf.pause(params.id); return lf.hydrate(prod(params.id)); });
route('POST', '/productions/:id/assemble', async ({ params }) => { prod(params.id); lf.assemble(params.id); return lf.hydrate(prod(params.id)); });
route('POST', '/productions/:id/autoimport', async ({ params, body }) => lf.hydrate(await lf.setAutoImport(params.id, body.on)));
route('POST', '/productions/:id/shots', async ({ params, body }) => { await lf.addShot(params.id, body.afterId, body); return lf.hydrate(prod(params.id)); });
route('PATCH', '/productions/:id/scenes/:scid', async ({ params, body }) => { await lf.updateScene(params.id, params.scid, body); return lf.hydrate(prod(params.id)); });
route('GET', '/sound', () => soundCatalog());
route('PATCH', '/productions/:id/shots/:sid', async ({ params, body }) => { await lf.updateShot(params.id, params.sid, body); return lf.hydrate(prod(params.id)); });
route('DELETE', '/productions/:id/shots/:sid', async ({ params }) => { await lf.deleteShot(params.id, params.sid); return lf.hydrate(prod(params.id)); });
route('POST', '/productions/:id/shots/:sid/voice-swap', async ({ params, body }) => { await lf.voiceSwap(params.id, params.sid, body); return lf.hydrate(prod(params.id)); });
route('POST', '/productions/:id/shots/:sid/import', async ({ params, body }) => lf.hydrate(await lf.importClip(params.id, params.sid, body.assetId)));

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);
  try {
    // Pocket ID sign-in redirects
    if (p === '/engine/auth/login') {
      if (!oidcConfig()) return send(res, 404, 'Pocket ID sign-in is not configured');
      try { return send(res, 302, '', { Location: await loginRedirect(req, url.searchParams.get('next') || '/') }); } catch (e) { return send(res, 502, `Pocket ID unreachable: ${e.message}`); }
    }
    if (p === '/engine/auth/callback') {
      try {
        const { session, next } = await finishLogin(req, url);
        return send(res, 302, '', { Location: next, 'Set-Cookie': sessionCookie(session, secureReq(req)) });
      } catch (e) {
        return send(res, 302, '', { Location: `/?auth_error=${encodeURIComponent(e.message)}` });
      }
    }
    const open = p === '/engine/api/health' || p === '/engine/api/login' || p === '/engine/api/logout';
    if ((p.startsWith('/engine/api/') || p.startsWith('/engine/media/')) && !open && !authed(req, url)) {
      return send(res, 401, { error: 'access code required', auth: true });
    }
    if (p.startsWith('/engine/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (!m) continue;
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) && !p.endsWith('/upload') ? await readJSONBody(req) : {};
        const out = await r.handler({ req, url, params: m.groups || {}, body });
        if (out && out.__cookie) {
          const { __cookie, ...rest } = out;
          return send(res, 200, rest, { 'Set-Cookie': __cookie });
        }
        return send(res, 200, out ?? { ok: true });
      }
      return send(res, 404, { error: 'no such route' });
    }
    if (p.startsWith('/engine/media/')) {
      const f = path.basename(p);
      if (!serveFile(req, res, path.join(MEDIA, f), mimeForExt(path.extname(f)), true)) send(res, 404, 'not found');
      return;
    }
    // Built UI (npm run local)
    if (fs.existsSync(DIST)) {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const abs = path.normalize(path.join(DIST, rel));
      if (abs.startsWith(DIST) && serveFile(req, res, abs, TYPES[path.extname(abs)] || 'application/octet-stream')) return;
      if (!path.extname(p)) return serveFile(req, res, path.join(DIST, 'index.html'), TYPES['.html']);
    }
    send(res, 404, 'not found');
  } catch (e) {
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (code >= 500) console.error(e);
    if (!res.headersSent) send(res, code, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Open Higgsfield engine → http://${HOST}:${PORT}${fs.existsSync(DIST) ? '  (serving the app)' : ''}`);
  const cfg = oidcConfig();
  if (cfg) console.log(`  Sign-in: ${cfg.label} only (${cfg.issuer})`);
  else if (REMOTE) console.log(`  Remote mode: devices must sign in with the access code: ${accessToken()}`);
  console.log('');
  lf.resumeAll();
});
