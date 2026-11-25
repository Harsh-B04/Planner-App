// Makes the key the server uses to send notifications. Run once: node scripts/vapid.mjs
// Then: npx wrangler secret put VAPID_PRIVATE_JWK   and paste the line this prints.
// Keep it. If you replace it, every device has to turn notifications on again.
const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', privateKey);
console.log(JSON.stringify({ kty, crv, x, y, d }));
