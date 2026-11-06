// HMAC-SHA256 webhook signatures, header format `t=<unix seconds>,v1=<hex>`.
// The signed content is `<t>.<raw body>`, so a captured request cannot be
// replayed with a different body, and the timestamp bounds replay in time.
// Web Crypto only: runs unchanged in Deno (Edge Functions) and Node (tests).

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison, so response timing reveals nothing about the expected value. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signatureHeader(secret: string, rawBody: string, nowSeconds: number): Promise<string> {
  return `t=${nowSeconds},v1=${await hmacHex(secret, `${nowSeconds}.${rawBody}`)}`;
}

export type Verification = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' };

export async function verifySignature(opts: {
  secret: string;
  header: string | null;
  rawBody: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): Promise<Verification> {
  const { secret, header, rawBody, nowSeconds, toleranceSeconds = 300 } = opts;
  if (!header) return { ok: false, reason: 'missing' };
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: 'expired' };
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return safeEqual(expected, parts.v1) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
