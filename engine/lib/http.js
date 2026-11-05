export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
  });

export class ProviderError extends Error {
  constructor(provider, status, message, { retryable = false, quota = false } = {}) {
    super(`${provider}${status ? ` ${status}` : ''}: ${message}`);
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    this.quota = quota;
  }
}

export async function httpError(provider, res) {
  let body = '';
  try { body = await res.text(); } catch {}
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.detail ?? j.error?.message ?? j.error ?? j.message ?? j.msg ?? body;
    if (Array.isArray(msg)) msg = msg.map((d) => (d.loc ? `${d.loc.slice(1).join('.')}: ${d.msg}` : d.msg || JSON.stringify(d))).join('; ');
    else if (typeof msg === 'object') msg = JSON.stringify(msg);
  } catch {}
  msg = String(msg || res.statusText).slice(0, 600);
  const quota = res.status === 429 || /quota|rate limit|usage limit|exhausted|insufficient/i.test(msg);
  return new ProviderError(provider, res.status, msg, { retryable: res.status === 429 || res.status >= 500, quota });
}

export async function fetchJSON(provider, url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    throw new ProviderError(provider, 0, e.cause?.code || e.message, { retryable: true });
  }
  if (!res.ok) throw await httpError(provider, res);
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { throw new ProviderError(provider, res.status, `invalid JSON: ${text.slice(0, 200)}`); }
}

export async function download(url, { headers, signal } = {}) {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw await httpError('download', res);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] };
}

export const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null)).toString();
