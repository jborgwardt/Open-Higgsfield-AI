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
  pending.set(state, { verifier, nonce, next: String(next).startsWith('/') ? next : '/', at: Date.now() });
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
  return `${doc.authorization_endpoint}?${q}`;
}

const decodeJwt = (t) => JSON.parse(Buffer.from(String(t).split('.')[1] || '', 'base64url').toString('utf8') || '{}');

/** Finish the redirect: exchange the code, check the identity, open a session. */
export async function finishLogin(req, url) {
  const cfg = oidcConfig();
  const doc = await discover(cfg);
  if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
  const st = pending.get(url.searchParams.get('state'));
  if (!st) throw new Error('This sign-in link expired — start again');
  pending.delete(url.searchParams.get('state'));
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
  let claims = c;
  if ((!c.email || !c.groups) && doc.userinfo_endpoint && tok.access_token) {
    const ui = await fetch(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    claims = { ...ui, ...c };
  }
  const user = { sub: claims.sub, email: (claims.email || '').toLowerCase(), name: claims.name || claims.preferred_username || claims.email || 'You', groups: claims.groups || [] };
  authorize(cfg, user);
  return { session: createSession(user), next: st.next };
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
