/* Globals the shared modules expect (esbuild "inject"): Buffer, fetch via Android, AbortSignal.timeout. */
import { Buffer } from 'buffer';
import { request } from './native';

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;

/* AbortSignal.timeout that also tells Android the time limit */
const realTimeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout.bind(AbortSignal) : null;
AbortSignal.timeout = ms => {
  const s = realTimeout ? realTimeout(ms) : (() => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; })();
  s.__ms = ms;
  return s;
};

/* fetch done by Android: any host, no CORS, the User-Agent we choose. Text bodies. */
async function nativeFetch(url, opts = {}) {
  const headers = {};
  if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) headers[k] = String(v);
  const r = await request({ method: opts.method || 'GET', url: String(url), headers, body: opts.body == null ? null : String(opts.body), timeout: (opts.signal && opts.signal.__ms) || 30000, redirect: opts.redirect || 'follow' });
  if (!r.ok) {
    const e = new Error(r.error || 'fetch failed');
    if (/timed? ?out/i.test(r.error || '')) e.name = 'TimeoutError';
    e.cause = { code: r.code || undefined };
    throw e;
  }
  const h = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: r.status >= 200 && r.status < 300, status: r.status, url: r.url || url, headers: { get: k => h.get(String(k).toLowerCase()) || null }, text: async () => r.body || '', json: async () => JSON.parse(r.body || 'null') };
}
globalThis.fetch = nativeFetch;
export { nativeFetch };
