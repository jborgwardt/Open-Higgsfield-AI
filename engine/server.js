// Open Higgsfield local engine — provider router, long-form production runner, media server.
// Zero dependencies. Listens on 127.0.0.1:4848; the Vite dev server proxies /engine here, and
// `npm run local` serves the built UI from ./dist on the same port.
import http from 'node:http';
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import path from 'node:path';
import { REPO_ROOT, DATA, MEDIA, getSettings, publicSettings, updateSettings, addAsset, mimeForExt, listAssets, updateAsset, getAsset, accessToken, tokenMatches } from './lib/store.js';
import { createArchiveManager } from './lib/archive.js';
import { publicCatalog, availableProviders, PROVIDERS } from './lib/catalog.js';
import * as jobs from './lib/jobs.js';
import * as lf from './lib/longform.js';
import * as xai from './lib/providers/xai.js';
import { comfyPing } from './lib/providers/comfy.js';
import { openaiPing } from './lib/providers/openai.js';
import { directorBackend, chosenDirector, listDirectors, chooseDirector } from './lib/director.js';
import { claudeStatus } from './lib/providers/claude-cli.js';
import { chatgptStatus, beginConnection, completeConnection, cancelConnection, disconnect as disconnectChatGPT, chatgptModels, recordStudioOwner } from './lib/providers/chatgpt.js';
import * as screening from './lib/screening.js';
import { hasFfmpeg } from './lib/ffmpeg.js';
import { soundCatalog } from './lib/sound.js';
import { oidcConfig, loginRedirect, finishLogin, sessionFor, endSession, sessionCookie, clearSessionCookie, NATIVE_PATH, isNativeNext, nativeState, nativeHandoff, redeemHandoff, nativeRedirect, publicBase, handoffValid, DEVICE_PATH, isDeviceNext, normalizeUserCode, startDevice, pendingDevice, approveDevice, pollDevice } from './lib/oidc.js';
import { DEVICE_PAGE_HEADERS, enterCodePage, confirmPage, donePage, messagePage } from './lib/devicepage.js';
import { fetchJSON } from './lib/http.js';
import { apimartModels, APIMART_LLMS } from './lib/providers/apimart.js';
import { elevenSubscription, elevenVoices, elevenAvailable, ELEVEN_TTS_MODELS } from './lib/providers/eleven.js';
import * as post from './lib/post.js';
import { characterRoutes } from './lib/characters.js';
import { appConfig, patchAppConfig, appVersion, appendAppLog, readAppLog, clearAppLog } from './lib/appconfig.js';
import * as tools from './lib/tools.js'; // Higgsfield-parity one-click tools (server-driven registry)
import { qwenModels, qwenTaskPing } from './lib/providers/qwen.js';
import * as feed from './lib/feed.js'; // server-defined Home feed + preview media
import * as characters from './lib/characters.js';

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
const bearerOf = (req) => req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
function currentUser(req) {
  // A Pocket ID session: the browser's cookie, or the same kind of session as a Bearer token (the Apple app).
  return oidcConfig() ? sessionFor(cookie(req, 'engine_session')) || sessionFor(bearerOf(req)) : null;
}
/**
 * Who is asking, for the ChatGPT account routes. Always an explicitly authenticated studio session:
 * a Pocket ID session (cookie or the app's Bearer), or — on a studio without Pocket ID — the access code
 * presented as a Bearer token or cookie. Never the implicit "open on this machine" access of a local engine.
 */
async function providerOwner(req) {
  const user = currentUser(req);
  if (user?.sub) { await recordStudioOwner(user); return user.sub; }
  if (!oidcConfig() && [bearerOf(req), cookie(req, 'engine_token')].some((t) => t && tokenMatches(t))) return 'local-studio';
  throw new HttpError(401, 'Sign in to Film Studio before connecting ChatGPT');
}
function authed(req, url) {
  const bearer = bearerOf(req);
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
  // Validators let a phone resume a dropped download (URLSession resume data sends If-Range + Range).
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const lastModified = st.mtime.toUTCString();
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache', ETag: etag, 'Last-Modified': lastModified };
  // If-Range: only honour the range when the file is still the one the client started with (RFC 9110 13.1.5).
  const ifRange = req.headers['if-range'];
  const rangeOk = !ifRange || ifRange === etag || ifRange === lastModified;
  const m = rangeOk ? req.headers.range?.match(/bytes=(\d*)-(\d*)/) : null;
  if (m) {
    const start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` }); return true; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    streamFile(req, res, abs, { start, end });
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  streamFile(req, res, abs);
  return true;
}

/**
 * Send a file body. pipeline() destroys the read stream when the client disconnects, seeks away (a new range
 * request aborts the old one) or a read fails — `.pipe()` kept those file descriptors open (dozens for one
 * big master after a few seeks). HEAD gets headers only.
 */
function streamFile(req, res, abs, range) {
  if (req.method === 'HEAD') { res.end(); return; }
  pipeline(fs.createReadStream(abs, range), res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.destroyed) res.destroy(err);
  });
}

/* ---------------- provider status ---------------- */

let ffOk = null;
async function status(fresh, owner) {
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
    directorChoice: chosenDirector(), // { id, model } — null id means the user has not picked one yet
    claude: await claudeStatus({ fresh }),
    // Never let the ChatGPT account check break the studio's status (e.g. owner not recorded yet).
    chatgpt: await chatgptStatus(owner).catch(() => ({ installed: true, available: false, loggedIn: false, state: 'error', account: null, error: 'Sign in as the studio owner to connect ChatGPT', loginMethod: 'mac_local_oauth' })),
    directorModels: { apimart: APIMART_LLMS },
    screening: screening.screeningAvailable(),
    eleven: { available: elevenAvailable(), models: ELEVEN_TTS_MODELS },
    ffmpeg: ffOk,
  };
}

/* ---------------- routes ---------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^/engine/api${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });
const prod = (id) => { const p = lf.getProduction(id); if (!p) throw new HttpError(404, 'production not found'); return p; };
const archive = createArchiveManager({ data: DATA, media: MEDIA, getAsset, listAssets,
  listProductions: lf.listProductions, getProduction: lf.getProduction, getCharacter: characters.getCharacter,
  listCharacters: characters.list,
  isBusy: () => jobs.hasActiveJobs() || characters.list().some((c) => c.processing?.length) || post.listJobs().some((j) => ['running', 'queued'].includes(j.status)) || lf.listProductions().some((m) => {
    const p = lf.getProduction(m.id); return ['running', 'planning'].includes(p.status) || p.assembling || p.screening?.status === 'running';
  }),
});

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
route('POST', '/logout', ({ req }) => {
  endSession(cookie(req, 'engine_session'));
  if (oidcConfig() && sessionFor(bearerOf(req))) endSession(bearerOf(req)); // the app signing out
  return { ok: true, __cookie: oidcConfig() ? clearSessionCookie() : 'engine_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' };
});
route('GET', '/status', async ({ req, url }) => { const user = currentUser(req); if (user?.sub) await recordStudioOwner(user).catch(() => {}); return status(url.searchParams.has('fresh'), user?.sub); });
route('GET', '/catalog', async () => { await status(); return { models: publicCatalog().map(feed.withModelPreview), providers: PROVIDERS }; });
route('GET', '/settings', () => publicSettings());

// Film Studio Apple app: server-driven config (tabs, web fallbacks, flags, defaults, copy) + remote diagnostics.
route('GET', '/app/version', () => appVersion()); // unauthenticated (see `open` below)
route('GET', '/app/config', () => appConfig());
route('PATCH', '/app/config', ({ body }) => patchAppConfig(body));
route('POST', '/app/log', ({ req, body }) => appendAppLog(body, { user: currentUser(req)?.email, ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress }));
route('GET', '/app/log', ({ url }) => readAppLog(Object.fromEntries(url.searchParams)));
route('DELETE', '/app/log', () => clearAppLog());
route('POST', '/settings', async ({ body }) => ({ settings: await updateSettings(body), status: await status(true) }));
// Server-owned Google Drive connection; no OAuth tokens or filesystem paths leave these endpoints.
route('GET', '/archive/status', ({ url }) => archive.status({ fresh: url.searchParams.has('fresh') }));
route('PATCH', '/archive/settings', ({ body }) => archive.settings(body));
route('POST', '/archive/run', () => archive.requestRun({ manual: true }));
route('GET', '/productions/:id/archive', ({ params }) => archive.projectStatus(params.id));
route('POST', '/productions/:id/archive', ({ params }) => {
  const queued = archive.requestRun({ manual: true, projectId: params.id });
  return { ...archive.projectStatus(params.id), queued: queued.queued, busy: queued.busy };
});
route('POST', '/productions/:id/restore', ({ params }) => archive.restoreProject(params.id));

route('POST', '/xai/login', () => xai.startDeviceLogin());
route('GET', '/xai/login', () => xai.loginStatus());
route('POST', '/xai/logout', async () => { await xai.logout(); return xai.loginStatus(); });
// ChatGPT plan access is provisioned by the Mac app's local OAuth flow. These
// routes stay behind studio authentication; no public callback or API-key fallback.
route('GET', '/codex/login', async ({ req }) => chatgptStatus(await providerOwner(req)));
route('POST', '/codex/login', async ({ req }) => beginConnection(await providerOwner(req)));
route('POST', '/codex/login/complete', async ({ req, body }) => {
  // The Mac client also enforces HTTPS and rejects redirects. Require an
  // encrypted reverse-proxy connection (or a local-only development request)
  // before accepting account credentials here.
  if (!secureReq(req) && !isLoopback(req)) throw new HttpError(400, 'Use HTTPS to connect ChatGPT to this studio');
  return completeConnection(await providerOwner(req), body);
});
route('POST', '/codex/login/cancel', async ({ req, body }) => cancelConnection(await providerOwner(req), body.connectionId));
route('POST', '/codex/logout', async ({ req }) => disconnectChatGPT(await providerOwner(req)));
route('GET', '/codex/models', async ({ req, url }) => chatgptModels({ owner: await providerOwner(req), fresh: url.searchParams.has('fresh') }));
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
// `origin` lets the app keep uploads and film parts out of the main grid: upload | film | master | generated.
route('GET', '/media', () => { const parts = lf.productionAssetIds(), titles = lf.masterTitles(); return listAssets()
  .filter((a) => !a.hidden && ['image', 'video'].includes(a.kind) && !['poster', 'last-frame', 'continuity'].includes(a.source))
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, 1000)
  .map((a) => ({ id: a.id, engine: true, url: a.url, thumb: a.kind === 'video' ? a.posterUrl || '' : a.url, kind: a.kind === 'video' ? 'videos' : 'images', model: a.model || (a.source === 'master' ? 'Long-form master' : a.source || 'upload'), prompt: a.prompt || titles.get(a.id) || a.name || '', createdAt: a.createdAt, resolution: a.width ? `${a.width}×${a.height}` : '',
    origin: a.source === 'upload' || a.source === 'handoff' ? 'upload' : a.source === 'master' ? 'master' : parts.has(a.id) ? 'film' : 'generated' })); });
// Hide from the library (files stay on disk in engine-data/media).
route('DELETE', '/media/:id', ({ params }) => { if (!getAsset(params.id)) throw new HttpError(404, 'not found'); updateAsset(params.id, { hidden: true }); return { ok: true }; });

// Studio jobs
route('POST', '/generate', ({ body }) => {
  if (!body.model) throw new HttpError(400, 'model required');
  const id = String(body.model).replace(/^engine:/, '');
  return jobs.startJob({
    model: id, prompt: body.prompt || '', image: body.image_url || body.image || null, endImage: body.end_image_url || null,
    refs: body.images_list || body.refs || [], refMode: body.ref_mode === true || body.refMode === true, aspect: body.aspect_ratio || body.aspect || '16:9', duration: body.duration, resolution: body.resolution,
    seed: Number.isInteger(body.seed) && body.seed >= 0 ? body.seed : undefined,
    characters: Array.isArray(body.characters) ? body.characters : body.characters ? [body.characters] : undefined, // character ids → refs routed per model
    keyframeModel: body.keyframe_model || body.keyframeModel || undefined,
    identityLock: body.identity_lock ?? body.identityLock, // false = keep a first-frame-only model for real people
    likeness: body.likeness, // false = skip the likeness check on character renders
  });
});
route('GET', '/jobs/:id', ({ params }) => jobs.getJob(params.id) || Promise.reject(new HttpError(404, 'job not found')));

// ---- Tools (Higgsfield-parity apps): server-driven registry rendered by the web Tools page and the Apple app ----
route('GET', '/tools', async ({ url }) => (await tools.listTools({ all: url.searchParams.has('all') })).map(feed.withToolPreview));
route('GET', '/tools/:id', async ({ params }) => { const t = (await tools.listTools()).find((x) => x.id === params.id); if (!t) throw new HttpError(404, 'no such tool'); return feed.withToolPreview(t); });

// ---- Home feed (engine/lib/feed.js): server-defined sections, editable in DATA/feed.json without an app update ----
route('GET', '/feed', async () => feed.buildFeed({ models: publicCatalog(), tools: await tools.listTools(), characters: characters.list(), media: listAssets(), partIds: lf.productionAssetIds(), masterTitles: lf.masterTitles() }));
route('GET', '/feed/config', () => feed.feedConfig());
route('PATCH', '/feed', ({ body }) => feed.patchFeed(body));
route('GET', '/feed/previews', () => feed.previewsMap());
route('PATCH', '/feed/previews', ({ body }) => feed.setPreviews(body));
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
route('POST', '/productions/:id/screen', async ({ params }) => {
  if (!prod(params.id).master?.assetId) throw new HttpError(409, 'assemble a master first');
  if (!screening.screeningAvailable()) throw new HttpError(409, 'screening needs a Gemini API key');
  screening.screenProduction(params.id).catch(() => {});
  return lf.hydrate(prod(params.id));
});
route('POST', '/productions/:id/screen/apply', async ({ params, body }) => { prod(params.id); return lf.hydrate(await screening.applyScreening(params.id, body)); });
route('POST', '/productions/:id/autoimport', async ({ params, body }) => lf.hydrate(await lf.setAutoImport(params.id, body.on)));
route('POST', '/productions/:id/shots', async ({ params, body }) => { await lf.addShot(params.id, body.afterId, body); return lf.hydrate(prod(params.id)); });
route('PATCH', '/productions/:id/scenes/:scid', async ({ params, body }) => { await lf.updateScene(params.id, params.scid, body); return lf.hydrate(prod(params.id)); });
route('GET', '/sound', () => soundCatalog());
// Director picker (web + Apple apps): every chat model across connected keys, grouped by provider.
route('GET', '/directors', ({ url }) => listDirectors({ fresh: url.searchParams.has('fresh') }));
route('POST', '/directors', ({ body }) => chooseDirector({ provider: body.provider ?? body.directorProvider, model: body.model ?? body.directorModel }));
route('PATCH', '/productions/:id/shots/:sid', async ({ params, body }) => { await lf.updateShot(params.id, params.sid, body); return lf.hydrate(prod(params.id)); });
route('DELETE', '/productions/:id/shots/:sid', async ({ params }) => { await lf.deleteShot(params.id, params.sid); return lf.hydrate(prod(params.id)); });
route('POST', '/productions/:id/shots/:sid/voice-swap', async ({ params, body }) => { await lf.voiceSwap(params.id, params.sid, body); return lf.hydrate(prod(params.id)); });
// Characters (engine/lib/characters.js): /characters, /characters/:id, refs, coverage, sheet
characterRoutes(route);
route('POST', '/productions/:id/shots/:sid/import', async ({ params, body }) => lf.hydrate(await lf.importClip(params.id, params.sid, body.assetId)));

// Post-production: /post/enhance, /post/transcribe, /post/jobs/:id, /post/transcripts/:assetId, /post/capabilities
post.mountRoutes(route, HttpError);

/* ---------------- device sign-in ---------------- */
// App: POST /auth/device → code to show; POST /auth/device/poll → the session once approved in a browser.
const deviceStarts = new Map(); // per-IP starts in the last minute (unauthenticated endpoint)
route('POST', '/auth/device', async ({ req, body }) => {
  if (!oidcConfig()) throw new HttpError(404, 'Pocket ID sign-in is not configured on this server');
  const ip = clientIp(req);
  const w = deviceStarts.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - w.at > 60000) { w.n = 0; w.at = Date.now(); }
  deviceStarts.set(ip, w);
  if (deviceStarts.size > 1000) for (const [k, v] of deviceStarts) if (Date.now() - v.at > 60000) deviceStarts.delete(k);
  if (++w.n > 10) throw new HttpError(429, 'Too many sign-in codes — wait a minute');
  let d;
  try { d = startDevice(body?.name, { ip }); } catch (e) { throw new HttpError(e.status || 500, e.message); }
  // Deliberately no "complete" link with the code in it: the code is always typed (RFC 8628 §5.4).
  return { ...d, verifyUrl: `${publicBase(req)}${DEVICE_PATH}` };
});
route('POST', '/auth/device/poll', async ({ body }) => pollDevice(body?.deviceCode));

/** The client's address as our own reverse proxy saw it (rightmost X-Forwarded-For hop; clients can forge the rest). */
function clientIp(req) {
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) || req.socket.remoteAddress || '';
}
const DEVICE_COOKIE = 'device_handoff';
const deviceHandoffCookie = (v, secure) => `${DEVICE_COOKIE}=${v}; Path=${DEVICE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${v ? 300 : 0}${secure ? '; Secure' : ''}`;

async function devicePage(req, res, url) {
  const secure = secureReq(req);
  const html = (status, body, clear = false) => send(res, status, body, { ...DEVICE_PAGE_HEADERS, ...(clear ? { 'Set-Cookie': deviceHandoffCookie('', secure) } : {}) });
  if (!oidcConfig()) return html(404, messagePage('Not available', 'Pocket ID sign-in is not configured on this server.'));
  const handoff = cookie(req, DEVICE_COOKIE);
  const signedIn = handoffValid(handoff, 'device');
  if (req.method === 'GET') {
    if (signedIn) return html(200, enterCodePage());
    // Always a fresh passkey (prompt=login, checked via auth_time): an existing session never approves a device.
    try {
      return send(res, 302, '', { Location: await loginRedirect(req, DEVICE_PATH) });
    } catch (e) {
      return html(502, messagePage('Pocket ID unreachable', e.message));
    }
  }
  if (req.method !== 'POST') return html(405, messagePage('Not allowed', 'Use the sign-in page.'));
  // Same-site form posts only carry the SameSite=Lax handoff cookie; a cross-site form can't.
  const form = new URLSearchParams((await readRaw(req, 4096)).toString('utf8'));
  const action = form.get('action');
  if (action === 'cancel') {
    const s = redeemHandoff(handoff, 'device');
    if (s) endSession(s);
    return html(200, messagePage('Cancelled', 'Nothing was approved. You can close this page.'), true);
  }
  if (!signedIn) return html(400, messagePage('Sign-in expired', 'Sign in with your passkey again to approve a device.'), true);
  const code = normalizeUserCode(form.get('code'));
  const pending = code && pendingDevice(code);
  if (!pending) return html(200, enterCodePage({ error: "That code isn't valid or has expired. Check the app for the current code." }));
  if (action === 'check') return html(200, confirmPage(pending));
  if (action !== 'approve') return html(400, messagePage('Not allowed', 'Use the sign-in page.'));
  const session = redeemHandoff(handoff, 'device');
  if (!session) return html(400, messagePage('Sign-in expired', 'Sign in with your passkey again to approve a device.'), true);
  if (!approveDevice(code, session)) { endSession(session); return html(410, messagePage('Code expired', 'That code expired or was already used. Get a new one in the app.'), true); }
  return html(200, donePage(), true);
}

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
        if (isDeviceNext(next)) {
          // Device sign-in: no session cookie. The fresh session waits behind a one-time handoff kept in an
          // HttpOnly cookie scoped to the device page (never in the URL / history).
          return send(res, 302, '', { Location: DEVICE_PATH, 'Set-Cookie': deviceHandoffCookie(nativeHandoff(session, { purpose: 'device' }), secureReq(req)) });
        }
        if (isNativeNext(next)) {
          // App sign-in: no browser cookie; hand the fresh session to /engine/auth/native with a one-time code.
          const u = new URL(next, 'http://engine.invalid');
          u.searchParams.set('handoff', nativeHandoff(session));
          return send(res, 302, '', { Location: `${NATIVE_PATH}${u.search}` });
        }
        return send(res, 302, '', { Location: next, 'Set-Cookie': sessionCookie(session, secureReq(req)) });
      } catch (e) {
        if (isDeviceNext(e.next)) return send(res, 200, messagePage('Sign-in failed', e.message), DEVICE_PAGE_HEADERS);
        if (isNativeNext(e.next)) {
          const state = nativeState(new URL(e.next, 'http://engine.invalid').searchParams.get('state'));
          return send(res, 302, '', { Location: nativeRedirect({ error: e.message, state }) });
        }
        return send(res, 302, '', { Location: `/?auth_error=${encodeURIComponent(e.message)}` });
      }
    }
    // Device sign-in: approve, in any browser, a code shown in the app (see "device sign-in" in lib/oidc.js).
    if (p === DEVICE_PATH) return await devicePage(req, res, url);
    // Native (Film Studio app) sign-in via ASWebAuthenticationSession. Only ever redirects to filmstudio://auth.
    if (p === NATIVE_PATH) {
      const state = nativeState(url.searchParams.get('state'));
      const handoff = url.searchParams.get('handoff');
      if (handoff) {
        const session = redeemHandoff(handoff);
        return send(res, 302, '', { Location: session ? nativeRedirect({ session, state }) : nativeRedirect({ error: 'This sign-in link expired — start again', state }) });
      }
      if (!oidcConfig()) return send(res, 302, '', { Location: nativeRedirect({ error: 'Pocket ID sign-in is not configured on this server', state }) });
      // Always a fresh passkey sign-in: an existing browser session is never handed to an app.
      try {
        return send(res, 302, '', { Location: await loginRedirect(req, `${NATIVE_PATH}${state ? `?state=${state}` : ''}`) });
      } catch (e) {
        return send(res, 302, '', { Location: nativeRedirect({ error: `Pocket ID unreachable: ${e.message}`, state }) });
      }
    }
    const open = p === '/engine/api/health' || p === '/engine/api/login' || p === '/engine/api/logout' || (p === '/engine/api/app/version' && req.method === 'GET')
      || (req.method === 'POST' && (p === '/engine/api/auth/device' || p === '/engine/api/auth/device/poll'));
    if ((p.startsWith('/engine/api/') || p.startsWith('/engine/media/')) && !open && !authed(req, url)) {
      return send(res, 401, { error: 'access code required', auth: true });
    }
    if (p.startsWith('/engine/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (!m) continue;
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) && !p.endsWith('/upload') ? await readJSONBody(req) : {};
        // Finished videos may have been offloaded. Restore referenced inputs before a job can use
        // their local paths. Source clips, reference photos and soundtrack uploads are never evicted.
        if (['POST', 'PATCH', 'PUT'].includes(req.method) && !p.includes('/archive') && !p.endsWith('/restore')) {
          await archive.restoreReferences(body);
          if (m.groups?.id?.startsWith('prod_') && !p.endsWith('/pause')) {
            const production = lf.getProduction(m.groups.id);
            if (production) await archive.restoreReferences(production);
          }
        }
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
      const id = f.match(/^(a_[a-zA-Z0-9]+)\.[a-zA-Z0-9]+$/)?.[1];
      if (id && getAsset(id)?.file === f) await archive.ensureLocal(id);
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
  archive.start();
  console.log(`\n  Open Higgsfield engine → http://${HOST}:${PORT}${fs.existsSync(DIST) ? '  (serving the app)' : ''}`);
  const cfg = oidcConfig();
  if (cfg) console.log(`  Sign-in: ${cfg.label} only (${cfg.issuer})`);
  // Never print the access code itself: an ENGINE_TOKEN from the environment is already known to the operator, a
  // generated one is shown masked (the full code is in Settings on this machine / engine-data/settings.json).
  else if (REMOTE) console.log(`  Remote mode: devices must sign in with the access code${process.env.ENGINE_TOKEN ? ' (ENGINE_TOKEN)' : `: ${accessToken().slice(0, 4)}… (full code: accessToken in the engine data folder’s settings.json)`}`);
  console.log('');
  lf.resumeAll();
});
