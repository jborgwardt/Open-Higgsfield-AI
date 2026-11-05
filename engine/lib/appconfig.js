// Server-driven configuration and remote diagnostics for the Film Studio Apple app.
// The app fetches /engine/api/app/config on launch and when it comes to the foreground, caches the last
// good copy and obeys it: tab order/visibility, native vs. web screens, feature flags, defaults, copy,
// polling intervals and update prompts. Change it with PATCH /engine/api/app/config (JSON merge patch;
// `null` resets a key to the default below) — no app reinstall needed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA, readJSON, writeJSON, now } from './store.js';

const CONFIG_FILE = path.join(DATA, 'app-config.json');
const LOG_FILE = path.join(DATA, 'app-log.jsonl');
const LOG_KEEP = 2000;

export const APP_DEFAULTS = {
  minVersion: '1.0.0', // below this the app blocks with an "Update required" screen
  latestVersion: '1.0.0', // below this the app offers an update
  updateUrl: 'https://ota.heil.haus:8443/film-studio.html',
  notice: null, // { title, body, level: 'info' | 'warning' | 'critical', id? }
  // Order = order in the tab bar / sidebar. kind 'web' opens `path` on the web app inside the app, signed in.
  // Known native ids: explore, characters, library, films, settings, create, tools. Unknown ids open `path` on the web.
  tabs: [
    { id: 'explore', title: 'Explore', sfSymbol: 'sparkles', kind: 'native', path: '/#image' },
    { id: 'characters', title: 'Characters', sfSymbol: 'person.crop.rectangle.stack', kind: 'native', path: '/#characters' },
    { id: 'library', title: 'Library', sfSymbol: 'photo.on.rectangle.angled', kind: 'native', path: '/#library' },
    { id: 'films', title: 'Films', sfSymbol: 'film.stack', kind: 'native', path: '/#longform' },
    { id: 'settings', title: 'Settings', sfSymbol: 'gearshape', kind: 'native', path: '/' },
  ],
  // Per-screen overrides for screens inside tabs: { [screenId]: { kind: 'web', path: '/#longform?id={id}' } }.
  // Screen ids: explore, create, tools, tool, library, mediaViewer, films, filmDetail, shotDetail, newFilm,
  // characters, characterDetail, capture, settings. Tabs can be overridden here too.
  screens: {},
  // The home feed (Higgsfield-style): one-tap create cards, then server-defined sections in this order.
  // Cards open a create flow (`mode` image|video, optional `model`) or a tool (`tool: '<tool id>'`).
  explore: {
    title: 'What will you make?',
    subtitle: 'Images, video, effects and films — rendered on your own studio.',
    sections: ['create', 'tools', 'characters', 'models', 'recent', 'films'],
    createCards: [
      { id: 'image', title: 'Image', subtitle: 'Stills, keyframes and edits', sfSymbol: 'photo.artframe', mode: 'image' },
      { id: 'video', title: 'Video', subtitle: 'From text or a start frame', sfSymbol: 'film', mode: 'video' },
    ],
  },
  features: {
    explore: true,
    create: true,
    films: true,
    characters: true,
    tools: true,
    shareMedia: true,
    saveToPhotos: true,
    deleteMedia: true,
    startEndFrames: true,
    characterPicker: true,
    editShotPrompt: true,
    narration: true,
    music: true,
    guidedCapture: true,
    cameraCapture: true,
    videoRefImport: true,
    characterSheet: true,
    openOnWeb: true, // "Open on web" escape hatch in every screen's menu
    diagnostics: true, // the app reports errors and crashes to /app/log
  },
  defaults: {
    // First available model wins; the catalog decides what exists.
    imageModels: ['google/gemini-nano-banana-2.1', 'xai/grok-imagine-image-2.0', 'google/gemini-3-pro-image', 'fal/flux-dev', 'kie/nano-banana-2', 'replicate/flux-schnell', 'local/plate'],
    videoModels: ['xai/grok-imagine-video-1.5', 'google/gemini-omni-1.1-flash', 'apimart/veo3.1-fast', 'fal/wan22-a14b', 'kie/veo3_fast', 'replicate/wan22-fast', 'local/animatic'],
    aspect: '16:9',
    videoDuration: 8,
    film: { targetMinutes: 5, clipSeconds: 8, aspect: '16:9', resolution: '720p', continuity: 'extend', keyframes: true, narration: false, music: 'off', autoAssemble: true },
    hiddenProviders: ['handoff'], // never offered in the app's model pickers
  },
  polling: { jobMs: 1500, productionMs: 2000, productionIdleMs: 15000, characterMs: 3000, configMs: 300000 },
  limits: { promptMaxChars: 6000, scriptMaxChars: 60000, uploadMaxMB: 1024, refVideoMaxSeconds: 20, filmMaxMinutes: 30 },
  web: { baseUrl: '' }, // '' = the same server the app talks to
  capture: {
    title: 'Reference capture',
    intro: 'Nine sharp photos from these angles give the models a reliable likeness. Or import a slow 10–15 s head turn and the studio picks the sharpest frames.',
    checklist: [
      { id: 'front', title: 'Front', instruction: 'Look straight into the lens, relaxed and neutral.', sfSymbol: 'person.fill' },
      { id: 'threeQuarterLeft', title: '¾ left', instruction: 'Turn your head about 45° to your left, eyes following the nose.', sfSymbol: 'arrow.turn.up.left' },
      { id: 'threeQuarterRight', title: '¾ right', instruction: 'Turn your head about 45° to your right.', sfSymbol: 'arrow.turn.up.right' },
      { id: 'profileLeft', title: 'Profile left', instruction: 'Full side view facing left — one ear, one eye visible.', sfSymbol: 'arrow.left' },
      { id: 'profileRight', title: 'Profile right', instruction: 'Full side view facing right.', sfSymbol: 'arrow.right' },
      { id: 'smile', title: 'Smile', instruction: 'Front view with a natural, open smile.', sfSymbol: 'face.smiling' },
      { id: 'expression', title: 'Expression', instruction: 'Any strong expression: surprise, anger, laughing.', sfSymbol: 'theatermasks' },
      { id: 'lowAngle', title: 'Slightly below', instruction: 'Camera a little below eye level, looking up at the face.', sfSymbol: 'arrow.up.circle' },
      { id: 'fullBody', title: 'Full body', instruction: 'Head to toe, standing naturally, in the usual wardrobe.', sfSymbol: 'figure.stand' },
    ],
    tips: [
      'Use the back camera, 1.5–2 m away, with the 2× lens — no wide-angle distortion.',
      'No filters, no Portrait mode, no beauty or face smoothing.',
      'Sharp, even light: face a window or shoot outside in shade. Avoid hard shadows and backlight.',
      'Hair away from the face; no sunglasses or hats unless they are part of the look.',
      'Keep the same look in every photo: same hair, beard and makeup.',
    ],
    video: { minSeconds: 10, maxSeconds: 15, instruction: 'Film a slow head turn from one profile to the other and back, 10–15 s, in even light.' },
    camera: { position: 'back', zoom: 2 },
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** RFC 7396 JSON merge patch: objects merge, arrays and scalars replace, null deletes. */
function mergePatch(target, patch) {
  if (!isObj(patch)) return patch;
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** Defaults with the stored overrides applied (arrays in overrides replace the default array). */
function applyOverrides(defaults, over) {
  if (!isObj(over)) return over === undefined ? defaults : over;
  const out = isObj(defaults) ? { ...defaults } : {};
  for (const [k, v] of Object.entries(over)) out[k] = applyOverrides(out[k], v);
  return out;
}

let overrides = readJSON(CONFIG_FILE, {});

export function appConfig() {
  return { ...applyOverrides(APP_DEFAULTS, overrides), updatedAt: overrides.updatedAt || null };
}

/**
 * Change the app config. JSON merge patch over the stored overrides; `null` resets to the default.
 * `tabs` may also be an object keyed by tab id to change single tabs: { tabs: { library: { kind: 'web' } } }
 * (a null value removes that tab).
 */
export async function patchAppConfig(patch = {}) {
  if (!isObj(patch)) throw Object.assign(new Error('expected a JSON object'), { status: 400 });
  const p = { ...patch };
  delete p.updatedAt;
  if (isObj(p.tabs)) {
    const byId = p.tabs;
    const tabs = appConfig().tabs.map((t) => (t.id in byId ? (byId[t.id] === null ? null : { ...t, ...byId[t.id] }) : t)).filter(Boolean);
    for (const [id, t] of Object.entries(byId)) if (t && !tabs.some((x) => x.id === id)) tabs.push({ id, kind: 'web', path: '/', title: id, sfSymbol: 'globe', ...t });
    p.tabs = tabs;
  }
  if (p.tabs !== undefined && p.tabs !== null && !Array.isArray(p.tabs)) throw Object.assign(new Error('tabs must be an array or an object keyed by tab id'), { status: 400 });
  if (p.reset === true) { overrides = {}; delete p.reset; }
  overrides = mergePatch(overrides, p);
  overrides.updatedAt = now();
  await writeJSON(CONFIG_FILE, overrides);
  return appConfig();
}

/** Unauthenticated: just enough for the app to know it must update, even when sign-in is broken. */
export function appVersion() {
  const c = appConfig();
  return { minVersion: c.minVersion, latestVersion: c.latestVersion, updateUrl: c.updateUrl };
}

/* ---------------- remote diagnostics ---------------- */

let log = [];
try {
  log = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-LOG_KEEP).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch {}
let lines = log.length;
let writing = Promise.resolve();

const str = (v, n) => (v == null ? undefined : String(v).slice(0, n));
const LEVELS = ['debug', 'info', 'warn', 'error', 'crash'];

function clean(e, meta) {
  const level = LEVELS.includes(e.level) ? e.level : 'error';
  return {
    at: now(),
    clientAt: str(e.at || e.clientAt, 40),
    level,
    kind: str(e.kind, 40) || 'event', // request | decode | crash | error | event
    message: str(e.message, 4000) || '',
    route: str(e.route, 300),
    method: str(e.method, 10),
    status: Number.isInteger(e.status) ? e.status : undefined,
    screen: str(e.screen, 80),
    detail: str(typeof e.detail === 'string' ? e.detail : e.detail && JSON.stringify(e.detail), 16000),
    app: str(e.app || meta.app, 40),
    build: str(e.build || meta.build, 20),
    device: str(e.device || meta.device, 80),
    os: str(e.os || meta.os, 60),
    platform: str(e.platform || meta.platform, 20),
    install: str(e.install || meta.install, 64),
    user: meta.user,
    ip: meta.ip,
  };
}

/** Append entries (one object or { entries: [...] }, max 200 per call); keeps the last ~2000 on disk. */
export function appendAppLog(body = {}, meta = {}) {
  const list = (Array.isArray(body.entries) ? body.entries : [body]).filter(isObj).slice(0, 200);
  const shared = isObj(body.device) ? { ...body.device } : {};
  const add = list.map((e) => clean(e, { ...shared, ...meta }));
  if (!add.length) return { ok: true, stored: 0 };
  log.push(...add);
  if (log.length > LOG_KEEP) log = log.slice(-LOG_KEEP);
  lines += add.length;
  const compact = lines > LOG_KEEP * 1.25;
  if (compact) lines = log.length;
  const snapshot = compact ? log.map((x) => JSON.stringify(x)).join('\n') + '\n' : null;
  const chunk = add.map((x) => JSON.stringify(x)).join('\n') + '\n';
  writing = writing.then(() => (snapshot ? fsp.writeFile(LOG_FILE, snapshot) : fsp.appendFile(LOG_FILE, chunk))).catch((e) => console.error('app log', e.message));
  for (const e of add) if (['error', 'crash'].includes(e.level)) console.log(`[app ${e.level}] ${e.kind}${e.route ? ` ${e.method || ''} ${e.route}` : ''}${e.status ? ` → ${e.status}` : ''}: ${e.message.slice(0, 200)} (${e.app || '?'} ${e.device || ''})`);
  return { ok: true, stored: add.length };
}

/** Newest first. ?limit=200&level=error&since=ISO&kind=request */
export function readAppLog({ limit = 200, level, since, kind } = {}) {
  const min = LEVELS.indexOf(level);
  return log
    .filter((e) => (min < 0 || LEVELS.indexOf(e.level) >= min) && (!since || e.at > since) && (!kind || e.kind === kind))
    .slice(-Math.min(Math.max(Number(limit) || 200, 1), LOG_KEEP))
    .reverse();
}

export async function clearAppLog() {
  log = [];
  lines = 0;
  await (writing = writing.then(() => fsp.writeFile(LOG_FILE, '')));
  return { ok: true };
}
