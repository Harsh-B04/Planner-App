// Notifications end to end against a running local server (needs LOCAL_TESTING=1 and VAPID_PRIVATE_JWK in .dev.vars).
// A fake push service plays the phone: it decrypts every message and checks the VAPID signature.
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const INVITE = process.argv[3] || 'test-invite';
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };
const b64u = b => Buffer.from(b).toString('base64url');

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

// The "phone": its own key pair and auth secret, like a browser makes when you allow notifications.
const phone = crypto.createECDH('prime256v1');
phone.generateKeys();
const authSecret = crypto.randomBytes(16);
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function decrypt(body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverPub = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = phone.computeSecret(serverPub);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), phone.getPublicKey(), serverPub, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

let serverKey = null;
function checkVapid(header) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || '');
  assert.ok(m, 'VAPID header missing');
  assert.equal(m[2], serverKey);
  const [h, c, sig] = m[1].split('.');
  const raw = Buffer.from(serverKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'bad VAPID signature');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'http://127.0.0.1:9916');
  assert.ok(claims.exp > Date.now() / 1000);
}

const uid = Math.random().toString(36).slice(2, 8);
const inbox = [];
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (req.url.endsWith('/gone')) { res.writeHead(410); return res.end(); }
    if (req.url === `/push/${uid}`) {
      checkVapid(req.headers.authorization);
      assert.equal(req.headers['content-encoding'], 'aes128gcm');
      inbox.push(decrypt(Buffer.concat(chunks)));
    }
    res.writeHead(201);
    res.end();
  });
}).listen(9916);

const take = () => inbox.splice(0);
const A = client();
await A('/api/signup', { method: 'POST', body: { username: 'nt' + uid, password: 'longpassword', invite: INVITE } });
const sub = { endpoint: `http://127.0.0.1:9916/push/${uid}`, keys: { p256dh: b64u(phone.getPublicKey()), auth: b64u(authSecret) } };

await test('server gives its public key', async () => {
  const r = await A('/api/push/key');
  serverKey = r.data.key;
  assert.equal(Buffer.from(serverKey, 'base64url').length, 65);
  assert.equal(r.data.devices, 0);
});
await test('random addresses and bad keys are refused', async () => {
  assert.equal((await A('/api/push/subscribe', { method: 'POST', body: { subscription: { ...sub, endpoint: 'https://evil.example.com/x' } } })).status, 400);
  assert.equal((await A('/api/push/subscribe', { method: 'POST', body: { subscription: { ...sub, keys: { p256dh: 'abc', auth: 'x' } } } })).status, 400);
});
await test('device turns notifications on', async () => {
  const r = await A('/api/push/subscribe', { method: 'POST', body: { subscription: sub, label: 'Android phone' } });
  assert.equal(r.data.devices, 1);
});
await test('test notification arrives, decrypts, VAPID signature checks out', async () => {
  const r = await A('/api/push/test', { method: 'POST', body: {} });
  assert.equal(r.data.sent, 1);
  assert.deepEqual(take().map(m => m.title), ['Notifications work']);
});

// A fixed day in India time: Monday 2026-11-02.
const IST = (h, m) => Date.UTC(2026, 10, 2, h, m) - 330 * 60000;
const DAY = '2026-11-02';
const run = async now => (await A('/api/dev/run-reminders', { method: 'POST', body: { now } })).data;
await A('/api/settings', { method: 'PUT', body: { timezone: 'Asia/Kolkata', notify: { lead: 10, evening: '21:00', morning: '07:30' }, routine: { clock: 24 } } });
const t1 = crypto.randomUUID(), t2 = crypto.randomUUID(), b1 = crypto.randomUUID(), b2 = crypto.randomUUID();
const task = (id, title) => ({ id, goal: null, title, notes: null, category: 'study', est_minutes: 90, deadline: null, priority: 2, status: 'open', done_at: null, created_at: 1, updated_at: 1, deleted: 0 });
const block = (id, task_id, s, e) => ({ id, task_id, date: DAY, start_min: s, end_min: e, status: 'planned', actual_minutes: null, started_at: null, reason: null, created_at: 1, updated_at: 1, deleted: 0 });
await A('/api/sync', { method: 'POST', body: { tasks: [task(t1, 'Write method section'), task(t2, 'Collect lab results')], blocks: [block(b1, t1, 990, 1080), block(b2, t2, 1110, 1170)] } });

await test('settings keep the notification times', async () => {
  assert.deepEqual((await A('/api/me')).data.settings.notify, { lead: 10, evening: '21:00', morning: '07:30', weekly: true, todo: '08:00' });
});
await test('morning summary at 07:30', async () => {
  await run(IST(7, 32));
  const [m] = take();
  assert.equal(m.title, "Today's plan");
  assert.equal(m.body, '2 sessions, 2.5 h. First: Write method section at 16:30.');
});
await test('reminder 10 minutes before a session, with a Start button', async () => {
  await run(IST(16, 19));
  assert.equal(take().length, 0, 'too early');
  await run(IST(16, 20));
  const [m] = take();
  assert.deepEqual([m.title, m.body], ['In 10 min', 'Write method section · 16:30–18:00']);
  assert.equal(m.actions[0].action, 'start');
  assert.equal(m.startUrl, `/?view=today&start=${b1}`);
});
await test('never sent twice', async () => {
  await run(IST(16, 20));
  await run(IST(16, 25));
  assert.equal(take().length, 0);
});
await test('a late check still sends (up to 10 min late), in the 12-hour clock when that is the setting', async () => {
  await A('/api/settings', { method: 'PUT', body: { routine: { clock: 12 } } });
  await run(IST(18, 27));   // reminder was due 18:20
  assert.equal(take()[0].body, 'Collect lab results · 6:30 pm–7:30 pm');
  await A('/api/settings', { method: 'PUT', body: { routine: { clock: 24 } } });
});
await test("a running session that reaches its length gets \"Time's up\" with Done and +15 min", async () => {
  const b4 = crypto.randomUUID();
  const started = IST(19, 45);
  await A('/api/sync', { method: 'POST', body: { blocks: [{ ...block(b4, t2, 1180, 1210), started_at: started }] } });
  await run(IST(20, 10));
  assert.equal(take().filter(m => m.title === "Time's up").length, 0, 'not yet');
  await run(IST(20, 16));   // 30 min after starting
  const m = take().find(x => x.title === "Time's up");
  assert.ok(m, 'sent');
  assert.deepEqual(m.actions.map(a => a.title), ['Done', '+15 min']);
  assert.equal(m.actionUrls.more, `/?view=today&extend=${b4}`);
  await run(IST(20, 20));
  assert.equal(take().filter(x => x.title === "Time's up").length, 0, 'once');
  await A('/api/sync', { method: 'POST', body: { blocks: [{ ...block(b4, t2, 1180, 1210), started_at: null, status: 'done', actual_minutes: 30, updated_at: 5 }] } });
});
await test('evening check-in asks about sessions with no update', async () => {
  await run(IST(21, 3));
  const [m] = take();
  assert.match(m.title, /2 sessions/);
  assert.equal(m.url, '/?view=today');
  await run(IST(21, 20));
  assert.equal(take().length, 0, 'only one check-in a day');
});
await test('evening asks for a journal line when nothing else is missing', async () => {
  await run(Date.UTC(2026, 10, 3, 21, 5) - 330 * 60000);
  const [m] = take();
  assert.equal(m.url, '/?view=journal');
  assert.equal(m.body, 'A line or two is enough.');
});
await test('no check-in at all when nothing is missing', async () => {
  await A('/api/sync', { method: 'POST', body: { entries: [{ id: crypto.randomUUID(), body: 'Good day.', entry_date: '2026-11-04', energy: null, created_at: 1, updated_at: 1, deleted: 0 }] } });
  await run(Date.UTC(2026, 10, 4, 21, 5) - 330 * 60000);
  assert.equal(take().length, 0);
});
await test('morning to-do check: due today with no time -> suggests a free slot with "Plan at"', async () => {
  const t3 = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { tasks: [{ ...task(t3, 'Do CTME experiment'), est_minutes: 60, deadline: '2026-11-03' }] } });
  await run(Date.UTC(2026, 10, 3, 8, 5) - 330 * 60000);
  const m = take().find(x => x.tag === 'todo');
  assert.ok(m, 'to-do check sent');
  assert.equal(m.title, 'Today: Do CTME experiment');
  assert.equal(m.actions[0].title, 'Plan at 09:00');
  assert.equal(m.actionUrls.accept, `/?view=today&todo=accept&task=${t3}&at=540&len=60`);
  await run(Date.UTC(2026, 10, 3, 8, 30) - 330 * 60000);
  assert.equal(take().filter(x => x.tag === 'todo').length, 0, 'once a day');
});
await test('session reminders can be switched off', async () => {
  const b3 = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { blocks: [{ ...block(b3, t1, 600, 660), date: '2026-11-05' }] } });
  await A('/api/settings', { method: 'PUT', body: { notify: { lead: null, evening: null, morning: null } } });
  await run(Date.UTC(2026, 10, 5, 9, 55) - 330 * 60000);
  assert.equal(take().length, 0);
});
await test('Sunday: week in review notification', async () => {
  // Evening check-in is off now, so the review comes at 19:00 on Sunday 2026-11-08.
  await run(Date.UTC(2026, 10, 8, 19, 5) - 330 * 60000);
  const m = take().find(x => x.title === 'Your week in review');
  assert.ok(m, 'review sent');
  assert.equal(m.url, '/?view=log&review=1');
  await run(Date.UTC(2026, 10, 8, 19, 30) - 330 * 60000);
  assert.equal(take().length, 0, 'only once');
});
await test('a device that turned notifications off is forgotten', async () => {
  await A('/api/push/subscribe', { method: 'POST', body: { subscription: { ...sub, endpoint: `http://127.0.0.1:9916/push/${uid}/gone` } } });
  assert.equal((await A('/api/push/key')).data.devices, 2);
  await A('/api/push/test', { method: 'POST', body: {} });
  take();
  assert.equal((await A('/api/push/key')).data.devices, 1);
});
await test('turning off on a device removes it', async () => {
  const r = await A('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  assert.equal(r.data.devices, 0);
});
await test('deleting the account removes devices', async () => {
  await A('/api/push/subscribe', { method: 'POST', body: { subscription: sub } });
  assert.equal((await A('/api/account', { method: 'DELETE', body: { password: 'longpassword' } })).status, 200);
});

fake.close();
console.log(`\nAll ${passed} notification checks passed.`);
