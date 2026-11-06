// The small browser pages for device sign-in (see "device sign-in" in oidc.js).
// Self-contained HTML: no scripts, no external assets, every dynamic value escaped.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Headers for every device page: never cached, never framed (the Approve button must not be clickjackable). */
export const DEVICE_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Film Studio</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0908;color:#f4f1ec;font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
main{width:min(440px,calc(100% - 40px));padding:32px 28px;border-radius:28px;background:#17151a;border:1px solid #2a2730;text-align:center}
h1{font-size:22px;margin:0 0 8px;font-weight:650;letter-spacing:-.01em}
p{color:#a9a3b3;margin:8px 0}
.code{font:600 34px/1.2 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.12em;margin:18px 0 6px;color:#fff}
.who{color:#d8d2e0}
input{box-sizing:border-box;width:100%;margin:18px 0 6px;padding:14px 16px;border-radius:16px;border:1px solid #3a3642;background:#0f0e12;color:#fff;font:600 24px ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.12em;text-align:center;text-transform:uppercase}
button{width:100%;margin-top:14px;padding:15px 18px;border:0;border-radius:999px;background:#f2a94b;color:#141210;font:600 17px -apple-system,system-ui,sans-serif;cursor:pointer}
a.secondary,button.secondary{display:block;background:transparent;color:#a9a3b3;font-weight:500;text-decoration:none;margin-top:10px}
.warn{font-size:13.5px;color:#8f8899;margin-top:16px}
.ok{font-size:44px;margin:4px 0 6px}
</style></head><body><main>${body}</main></body></html>`;
}

/** After the passkey: type the code shown on the device (never pre-filled from a link). */
export function enterCodePage({ error } = {}) {
  return page('Sign in a device', `
<h1>Sign in a device</h1>
<p>Type the code shown in the Film Studio app on the device you're signing in.</p>
${error ? `<p class="who">${esc(error)}</p>` : ''}
<form method="post" action="">
<input type="hidden" name="action" value="check">
<input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="12" placeholder="XXXX-XXXX" aria-label="Code from the app" required autofocus>
<button type="submit">Continue</button>
</form>
<form method="post" action=""><input type="hidden" name="action" value="cancel"><button class="secondary" type="submit">Cancel</button></form>
<p class="warn">If someone sent you a link or a code to enter here, stop — only enter a code you can see on your own screen.</p>`);
}

const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} seconds ago` : `${Math.round(s / 60)} min ago`; };

/** Details of the waiting device and an explicit Approve (handoff stays in the cookie). */
export function confirmPage({ userCode, name, ip, at }) {
  return page('Approve sign-in', `
<h1>Approve this device?</h1>
<div class="code">${esc(userCode)}</div>
<p>${name ? `It says it is <span class="who">${esc(name)}</span>.` : 'It did not give a name.'}<br>
Requested ${esc(ago(Date.now() - at))}${ip ? ` from <span class="who">${esc(ip)}</span>` : ''}.</p>
<form method="post" action="">
<input type="hidden" name="action" value="approve">
<input type="hidden" name="code" value="${esc(userCode)}">
<button type="submit">Approve</button>
</form>
<form method="post" action=""><input type="hidden" name="action" value="cancel"><button class="secondary" type="submit">Cancel</button></form>
<p class="warn">Approving gives that device full access to your studio for 30 days.</p>`);
}

export function donePage() {
  return page('Signed in', `
<div class="ok" aria-hidden="true">✓</div>
<h1>Device signed in</h1>
<p>Go back to the Film Studio app. You can close this page.</p>`);
}

export function messagePage(title, message) {
  return page(title, `
<h1>${esc(title)}</h1>
<p>${esc(message)}</p>
<a class="secondary" href="">Start again</a>`);
}
