// Web Push without any library: message encryption (RFC 8291, aes128gcm) and VAPID sign-in (RFC 8292).
// Uses only the Web Crypto built into Cloudflare Workers.

const enc = new TextEncoder();

export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), c => c.charCodeAt(0));
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF-Expand for outputs of at most 32 bytes (one block).
const expand = async (prk, info, len) => (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);

// The server's VAPID key pair, from the VAPID_PRIVATE_JWK secret. Public key = 0x04 || x || y.
export function vapidPublicKey(env) {
  if (!env.VAPID_PRIVATE_JWK) return null;
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    return b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  } catch {
    return null;
  }
}

export async function encryptPayload(text, p256dh, auth) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await expand(await hmac(authSecret, shared), concat(enc.encode('WebPush: info\u0000'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, enc.encode('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = await expand(prk, enc.encode('Content-Encoding: nonce\u0000'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(text), new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

async function vapidHeader(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:planner@example.com',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapidPublicKey(env)}`;
}

// Returns the push service's HTTP status. 404/410 mean the device turned notifications off: delete it.
export async function sendPush(env, sub, message, ttl = 3600) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency: 'high',
      authorization: await vapidHeader(env, sub.endpoint),
    },
    body: await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth),
  });
  return res.status;
}

// Only real push services, so the server can't be used to send requests to random sites.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export function allowedEndpoint(env, endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (env.LOCAL_TESTING === '1' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
}

export function validKeys(p256dh, auth) {
  try { return unb64u(p256dh).length === 65 && unb64u(p256dh)[0] === 4 && unb64u(auth).length === 16; } catch { return false; }
}
