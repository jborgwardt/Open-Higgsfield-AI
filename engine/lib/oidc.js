// Sign-in with an OpenID Connect provider (built for Pocket ID: passkey-only sign-in).
// Authorization-code flow with PKCE; works as a public client (no secret) or with a client secret.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, readJSON, writeJSON, getSettings } from './store.js';

const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const OWNER_FILE = path.join(DATA, 'owner.json');
const SESSION_DAYS = 30;

export function oidcConfig() {
  const s = getSettings();
  const issuer = (process.env.OIDC_ISSUER || s.oidcIssuer || '').replace(/\/$/, '');
  const clientId = process.env.OIDC_CLIENT_ID || s.oidcClientId || '';
  if (!issuer || !clientId) return null;
  return {
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET || s.oidcClientSecret || '',
    publicUrl: (process.env.PUBLIC_URL || s.publicUrl || '').replace(/\/$/, ''),
    allowedEmails: (process.env.OIDC_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    allowedGroups: (process.env.OIDC_ALLOWED_GROUPS || '').split(',').map((g) => g.trim()).filter(Boolean),
    label: process.env.OIDC_LABEL || 'Pocket ID',
  };
}

let discovery = null;
async function discover(cfg) {
  if (discovery?.issuer === cfg.issuer && Date.now() - discovery.at < 36e5) return discovery.doc;
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = await res.json();
  discovery = { issuer: cfg.issuer, at: Date.now(), doc };
  return doc;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const pending = new Map(); // state -> { verifier, nonce, next, at }

/** This studio's public origin (PUBLIC_URL, else the forwarded host). */
export const publicBase = (req) => baseUrl(oidcConfig() || {}, req);

function baseUrl(cfg, req) {
  if (cfg.publicUrl) return cfg.publicUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

export async function loginRedirect(req, next = '/') {
  const cfg = oidcConfig();
  const doc = await discover(cfg);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  for (const [k, v] of pending) if (Date.now() - v.at > 600000) pending.delete(k);
  // Same-site paths only ("//host" and "/\host" are protocol-relative URLs to another site).
  pending.set(state, { verifier, nonce, next: /^\/(?![/\\])/.test(String(next)) ? String(next) : '/', at: Date.now() });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: `${baseUrl(cfg, req)}/engine/auth/callback`,
    scope: 'openid email profile groups',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  // Signing in another app or device always runs the passkey again, even if Pocket ID still has a session
  // in this browser (checked against auth_time in completeLogin).
  if (isNativeNext(next) || isDeviceNext(next)) { q.set('prompt', 'login'); q.set('max_age', '0'); }
  return `${doc.authorization_endpoint}?${q}`;
}

const decodeJwt = (t) => JSON.parse(Buffer.from(String(t).split('.')[1] || '', 'base64url').toString('utf8') || '{}');

/** Finish the redirect: exchange the code, check the identity, open a session. */
export async function finishLogin(req, url) {
  const st = pending.get(url.searchParams.get('state'));
  if (st) pending.delete(url.searchParams.get('state'));
  try {
    return await completeLogin(req, url, st);
  } catch (e) {
    // Let the caller send a failed native (app) sign-in back to the app instead of the web UI.
    if (st) e.next = st.next;
    throw e;
  }
}

async function completeLogin(req, url, st) {
  const cfg = oidcConfig();
  const doc = await discover(cfg);
  if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
  if (!st) throw new Error('This sign-in link expired — start again');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: url.searchParams.get('code') || '',
    redirect_uri: `${baseUrl(cfg, req)}/engine/auth/callback`,
    client_id: cfg.clientId,
    code_verifier: st.verifier,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  });
  const res = await fetch(doc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(10000) });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new Error(`Sign-in failed: ${tok.error_description || tok.error || res.status}`);
  // The ID token comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7), so we check its claims.
  const c = decodeJwt(tok.id_token);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss?.replace(/\/$/, '') !== cfg.issuer) throw new Error('Sign-in came from the wrong issuer');
  if (!aud.includes(cfg.clientId)) throw new Error('Sign-in was for a different app');
  if (c.nonce !== st.nonce) throw new Error('Sign-in check failed (nonce)');
  if (c.exp && c.exp * 1000 < Date.now() - 60000) throw new Error('Sign-in expired');
  // A device sign-in must come from a passkey used just now, not an older Pocket ID session.
  const fresh = typeof c.auth_time === 'number' && c.auth_time * 1000 >= st.at - 60000;
  if (isDeviceNext(st.next) && !fresh) throw new Error('Sign in with your passkey again to approve another device');
  if (isNativeNext(st.next) && typeof c.auth_time === 'number' && !fresh) throw new Error('Sign in with your passkey again');
  let claims = c;
  if ((!c.email || !c.groups) && doc.userinfo_endpoint && tok.access_token) {
    const ui = await fetch(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    claims = { ...ui, ...c };
  }
  const user = { sub: claims.sub, email: (claims.email || '').toLowerCase(), name: claims.name || claims.preferred_username || claims.email || 'You', groups: claims.groups || [] };
  authorize(cfg, user);
  const client = isNativeNext(st.next) ? 'native' : isDeviceNext(st.next) ? 'device' : null;
  return { session: createSession(client ? { ...user, client } : user), next: st.next };
}

/** Allowlist by email/group if configured; otherwise the first person to sign in owns this studio. */
function authorize(cfg, user) {
  if (cfg.allowedEmails.length || cfg.allowedGroups.length) {
    const ok = cfg.allowedEmails.includes(user.email) || user.groups.some((g) => cfg.allowedGroups.includes(g));
    if (!ok) throw new Error(`${user.email || user.name} is not allowed to use this studio`);
    return;
  }
  const owner = readJSON(OWNER_FILE, null);
  if (!owner) { fs.writeFileSync(OWNER_FILE, JSON.stringify({ sub: user.sub, email: user.email, at: new Date().toISOString() }, null, 2), { mode: 0o600 }); return; }
  if (owner.sub !== user.sub) throw new Error(`This studio belongs to ${owner.email || 'someone else'}`);
}

/* ---------------- sessions ---------------- */

let sessions = readJSON(SESSIONS_FILE, {});
const saveSessions = () => writeJSON(SESSIONS_FILE, sessions, 0o600).catch(() => {});

function createSession(user) {
  const id = b64url(crypto.randomBytes(32));
  const hash = crypto.createHash('sha256').update(id).digest('hex');
  for (const [k, v] of Object.entries(sessions)) if (v.expires < Date.now()) delete sessions[k];
  sessions[hash] = { ...user, created: Date.now(), expires: Date.now() + SESSION_DAYS * 864e5 };
  saveSessions();
  return id;
}

export function sessionFor(id) {
  if (!id) return null;
  const s = sessions[crypto.createHash('sha256').update(id).digest('hex')];
  return s && s.expires > Date.now() ? s : null;
}

export function endSession(id) {
  if (!id) return;
  delete sessions[crypto.createHash('sha256').update(id).digest('hex')];
  saveSessions();
}

export const sessionCookie = (id, secure) => `engine_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
export const clearSessionCookie = () => 'engine_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

/* ---------------- native app sign-in ---------------- */
// The Film Studio app signs in with ASWebAuthenticationSession:
//   /engine/auth/native?state=… → Pocket ID (passkey) → /engine/auth/callback
//   → /engine/auth/native?state=…&handoff=… → filmstudio://auth?session=…&state=…
// The app then sends that session as `Authorization: Bearer`. It is an ordinary session (same lifetime,
// same allowlist/owner check) that is never set as a browser cookie, and the native route only hands out
// a session minted by the sign-in that just happened — never an existing browser session.

export const NATIVE_PATH = '/engine/auth/native';
const NATIVE_CALLBACK = 'filmstudio://auth'; // the only place a native sign-in ever redirects to
const HANDOFF_MS = 120000;
const DEVICE_HANDOFF_MS = 300000; // device approval: time to type the code from the other screen
const handoffTTL = (purpose) => (purpose === 'device' ? DEVICE_HANDOFF_MS : HANDOFF_MS);
const handoffs = new Map(); // sha256(code) -> { session, at }
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

export function isNativeNext(next) {
  try { return new URL(String(next), 'http://engine.invalid').pathname === NATIVE_PATH; } catch { return false; }
}

/** The app's anti-forgery state, echoed back untouched (opaque, URL-safe, bounded). */
export const nativeState = (v) => (/^[\w-]{1,128}$/.test(String(v ?? '')) ? String(v) : '');

/** One-time, short-lived code that carries a fresh session from the callback to the native redirect. */
export function nativeHandoff(session, { purpose = 'native', userCode = '' } = {}) {
  for (const [k, v] of handoffs) if (Date.now() - v.at > handoffTTL(v.purpose)) handoffs.delete(k);
  const code = b64url(crypto.randomBytes(24));
  handoffs.set(sha(code), { session, at: Date.now(), purpose, userCode });
  return code;
}

/** Is this handoff code still good? (Does not use it up — for showing a confirmation page.) */
export function handoffValid(code, purpose = 'native', userCode = '') {
  const h = code ? handoffs.get(sha(code)) : null;
  return !!h && h.purpose === purpose && h.userCode === userCode && Date.now() - h.at <= handoffTTL(purpose) && !!sessionFor(h.session);
}

/** Use up a handoff. Only one minted for this purpose (and, for devices, this exact code) is accepted. */
export function redeemHandoff(code, purpose = 'native', userCode = '') {
  if (!code || typeof code !== 'string') return null;
  const k = sha(code);
  const h = handoffs.get(k);
  if (!h) return null;
  handoffs.delete(k);
  if (h.purpose !== purpose || h.userCode !== userCode) { endSession(h.session); return null; }
  return Date.now() - h.at <= handoffTTL(purpose) && sessionFor(h.session) ? h.session : null;
}

export function nativeRedirect({ session, state, error } = {}) {
  const q = new URLSearchParams();
  if (session) q.set('session', session);
  if (error) q.set('error', String(error).slice(0, 300));
  if (nativeState(state)) q.set('state', nativeState(state));
  return `${NATIVE_CALLBACK}?${q}`;
}

/* ---------------- device sign-in (code shown in the app, approved in any browser) ---------------- */
// For a device that can't do the passkey itself (the iOS Simulator, a borrowed iPad, a Mac without the
// passkey), modelled on OAuth 2.0 Device Authorization (RFC 8628):
//   app  POST /engine/api/auth/device        → { deviceCode (secret, kept in the app), userCode "BCDF-GHJK", verifyUrl }
//   you  open verifyUrl in any browser → passkey (forced fresh: prompt=login + auth_time) → TYPE the code
//        from the app → details page (claimed name, requesting address, age) → "Approve"
//   app  POST /engine/api/auth/device/poll { deviceCode } → pending … then { session } (grace-repeated 30 s).
// The link never carries the code (a link someone sends you can't pre-fill one), the one-time handoff
// lives in an HttpOnly cookie scoped to this page (not the URL), and handoffs only work for their own flow.
// Approval always needs a fresh passkey sign-in plus an explicit click on a page that shows the code, the
// approving browser never gets a cookie, and the session goes only to whoever holds the device code.

export const DEVICE_PATH = '/engine/auth/device';
export const DEVICE_MS = 600000; // codes live 10 minutes
const DEVICE_MAX = 200;          // sign-ins in progress at once; the oldest waiting one makes room
const DEVICE_PER_CLIENT = 3;
const POLL_GRACE_MS = 30000;     // an approved session can be fetched again for this long (lost responses)     // waiting codes per requester address
const USER_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // RFC 8628 §6.1: no vowels (no words), no look-alike digits
const devices = new Map(); // sha(deviceCode) -> { userCode, name, at, session|null }

export function isDeviceNext(next) {
  try { return new URL(String(next), 'http://engine.invalid').pathname === DEVICE_PATH; } catch { return false; }
}
/** "bcdf-ghjk", "BCDFGHJK", " bcdf ghjk " → "BCDFGHJK" (or '' if it can't be one of ours). */
export function normalizeUserCode(v) {
  const c = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === 8 && [...c].every((ch) => USER_ALPHABET.includes(ch)) ? c : '';
}
export const formatUserCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

function pruneDevices() {
  for (const [k, v] of devices) if (Date.now() - v.at > DEVICE_MS) devices.delete(k);
}
function deviceByUserCode(code) {
  const c = normalizeUserCode(code);
  if (!c) return null;
  for (const v of devices.values()) if (v.userCode === c && Date.now() - v.at <= DEVICE_MS) return v;
  return null;
}

/** Start a device sign-in. `name` is a label the app sends ("iPhone 15 Pro Max") — shown, escaped, on the approval page. */
export function startDevice(name, { ip = '' } = {}) {
  pruneDevices();
  // One requester can't hold more than a few codes (its oldest gives way), and a full table drops the
  // oldest waiting code — so a flood can't lock the owner out for ten minutes.
  const mine = [...devices].filter(([, v]) => v.ip === ip && !v.session).sort((a, b) => a[1].at - b[1].at);
  while (mine.length >= DEVICE_PER_CLIENT) devices.delete(mine.shift()[0]);
  if (devices.size >= DEVICE_MAX) {
    const oldest = [...devices].filter(([, v]) => !v.session).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) devices.delete(oldest[0]);
    else { const e = new Error('Too many sign-ins in progress — try again in a few minutes'); e.status = 429; throw e; }
  }
  const deviceCode = b64url(crypto.randomBytes(32));
  let userCode;
  do { userCode = Array.from({ length: 8 }, () => USER_ALPHABET[crypto.randomInt(USER_ALPHABET.length)]).join(''); } while (deviceByUserCode(userCode));
  const label = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  devices.set(sha(deviceCode), { userCode, name: label, ip: String(ip).slice(0, 64), at: Date.now(), session: null });
  return { deviceCode, userCode: formatUserCode(userCode), expiresIn: DEVICE_MS / 1000, interval: 3 };
}

/** The pending sign-in for a code someone typed, if it is still waiting (not expired, not approved). */
export function pendingDevice(userCode) {
  const d = deviceByUserCode(userCode);
  return d && !d.session ? { userCode: formatUserCode(d.userCode), name: d.name, ip: d.ip, at: d.at } : null;
}

/** Bind a fresh session to the waiting device. False if the code expired or was already approved. */
export function approveDevice(userCode, session) {
  const d = deviceByUserCode(userCode);
  if (!d || d.session || !sessionFor(session)) return false;
  d.session = session;
  return true;
}

/** What the app sees while it waits: pending → { session } once → expired. */
export function pollDevice(deviceCode) {
  if (typeof deviceCode !== 'string' || !deviceCode || deviceCode.length > 200) return { status: 'expired' };
  const k = sha(deviceCode);
  const d = devices.get(k);
  if (!d || Date.now() - d.at > DEVICE_MS) { devices.delete(k); return { status: 'expired' }; }
  if (!d.session) return { status: 'pending' };
  // Handed to the device-code holder; repeated for a short grace window in case that response got lost.
  d.handedAt ??= Date.now();
  if (Date.now() - d.handedAt > POLL_GRACE_MS) { devices.delete(k); return { status: 'expired' }; }
  return sessionFor(d.session) ? { status: 'approved', session: d.session } : { status: 'expired' };
}

/** Test hook. */
export function _resetDevices() { devices.clear(); }
