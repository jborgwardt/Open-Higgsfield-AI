// A tiny fake OpenID Connect provider for testing the engine's sign-in without Pocket ID.
// It auto-approves every authorization request (standing in for the passkey ceremony), checks PKCE,
// and returns an unsigned ID token with the requested nonce.
//
//   node apple/scripts/fake-oidc.mjs [port] [email]   # run standalone (e.g. for the simulator sign-in test)
import http from 'node:http';
import crypto from 'node:crypto';

export function startFakeOidc({ port = 0, clientId = 'filmstudio-test', user = { sub: 'u-justin', email: 'justin@example.com', name: 'Justin' } } = {}) {
  const codes = new Map();
  const state = { user, authorizations: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const issuer = `http://127.0.0.1:${server.address().port}`;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo` });
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), user: state.user });
      state.authorizations++;
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const c = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (!c) return json(400, { error: 'invalid_grant' });
      const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
      if (challenge !== c.challenge || f.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant', error_description: 'PKCE or redirect mismatch' });
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const idToken = `${b64({ alg: 'none' })}.${b64({ iss: issuer, aud: clientId, sub: c.user.sub, email: c.user.email, name: c.user.name, groups: [], nonce: c.nonce, iat: now, exp: now + 300 })}.`;
      return json(200, { id_token: idToken, access_token: 'fake-access', token_type: 'Bearer' });
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    server,
    state,
    issuer: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 4960;
  const email = process.argv[3] || 'justin@example.com';
  const idp = await startFakeOidc({ port, user: { sub: 'u-justin', email, name: 'Justin' } });
  console.log(`fake OIDC provider at ${idp.issuer} (auto-approves as ${email})`);
}
