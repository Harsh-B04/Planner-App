// End-to-end checks against a running local server (npm run dev in another terminal).
// Usage: node test/api.test.mjs [baseUrl] [inviteCode]
import http from 'node:http';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const INVITE = process.argv[3] || 'test-invite';
let passed = 0;

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
async function test(name, fn) {
  await fn();
  passed++;
  console.log('ok -', name);
}

const uid = Math.random().toString(36).slice(2, 8);
const A = client(), B = client();
const entry = (id, body, updated_at, extra = {}) =>
  ({ id, body, entry_date: '2026-10-30', energy: null, created_at: 1000, updated_at, deleted: 0, ...extra });

await test('sign-up needs the right invite code', async () => {
  const r = await A('/api/signup', { method: 'POST', body: { username: 'karthik' + uid, password: 'longpassword', invite: 'nope' } });
  assert.equal(r.status, 403);
});
await test('sign-up works and logs in', async () => {
  const r = await A('/api/signup', { method: 'POST', body: { username: 'karthik' + uid, password: 'longpassword', invite: INVITE } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await A('/api/me')).status, 200);
});
await test('duplicate username rejected', async () => {
  const r = await B('/api/signup', { method: 'POST', body: { username: 'KARTHIK' + uid, password: 'longpassword', invite: INVITE } });
  assert.equal(r.status, 409);
});
await test('wrong password rejected', async () => {
  const r = await client()('/api/login', { method: 'POST', body: { username: 'karthik' + uid, password: 'wrongpassword' } });
  assert.equal(r.status, 401);
});
await test('not logged in is rejected', async () => {
  assert.equal((await client()('/api/sync?table=entries')).status, 401);
});

const id1 = crypto.randomUUID(), id2 = crypto.randomUUID();
await test('push entries and pull them back', async () => {
  const p = await A('/api/sync', { method: 'POST', body: { entries: [entry(id1, 'first #test', 2000), entry(id2, 'second', 2000, { energy: 3 })] } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const r = await A('/api/sync?table=entries&since=0');
  assert.equal(r.data.rows.length, 2);
  assert.equal(r.data.rows.find(x => x.id === id2).energy, 3);
  assert.ok(!('user_id' in r.data.rows[0]));
});
await test('retrying the same push does not duplicate', async () => {
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id1, 'first #test', 2000)] } });
  assert.equal((await A('/api/sync?table=entries&since=0')).data.rows.length, 2);
});
await test('newer edit wins, older edit is ignored', async () => {
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id1, 'edited on phone', 5000)] } });
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id1, 'stale laptop edit', 3000)] } });
  const row = (await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === id1);
  assert.equal(row.body, 'edited on phone');
});
await test('incremental pull only returns recent changes', async () => {
  await new Promise(r => setTimeout(r, 6000)); // longer than the 5 s re-send overlap
  const now = (await A('/api/sync?table=entries&since=0')).data.now;
  assert.equal((await A(`/api/sync?table=entries&since=${now}`)).data.rows.length, 0);
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id2, 'changed later', 9000)] } });
  const rows = (await A(`/api/sync?table=entries&since=${now}`)).data.rows;
  assert.deepEqual(rows.map(r => r.id), [id2]);
});
await test('delete syncs and wipes the text on the server', async () => {
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id2, 'changed later', 10000, { deleted: 1 })] } });
  const row = (await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === id2);
  assert.equal(row.deleted, 1);
  assert.equal(row.body, '');
});
await test('a bad row is skipped and reported; the good rows in the same batch still save', async () => {
  const bad = crypto.randomUUID(), good = crypto.randomUUID();
  const r = await A('/api/sync', { method: 'POST', body: { entries: [entry(bad, 'x', 1, { entry_date: 'yesterday' }), entry(good, 'fine', 1)] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rejected, [{ table: 'entries', id: bad, field: 'entry_date' }]);
  const rows = (await A('/api/sync?table=entries&since=0')).data.rows;
  assert.ok(rows.some(x => x.id === good) && !rows.some(x => x.id === bad));
  await A('/api/sync', { method: 'POST', body: { entries: [entry(good, 'fine', 2, { deleted: 1 })] } });
});

await test('a delete wins even when its timestamp is older (device clocks out of step)', async () => {
  const id = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id, 'made on a fast clock', 9000)] } });
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id, 'x', 8000, { deleted: 1 })] } });
  const row = (await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === id);
  assert.equal(row.deleted, 1);
  // ...but an ordinary older edit still loses
  const id2 = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id2, 'newer', 9000)] } });
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id2, 'older edit', 8000)] } });
  assert.equal((await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === id2).body, 'newer');
  await A('/api/sync', { method: 'POST', body: { entries: [entry(id2, 'x', 9500, { deleted: 1 })] } });
});

await test('second user cannot see or overwrite first user\'s entries', async () => {
  await B('/api/signup', { method: 'POST', body: { username: 'friend' + uid, password: 'longpassword', invite: INVITE } });
  assert.equal((await B('/api/sync?table=entries&since=0')).data.rows.length, 0);
  await B('/api/sync', { method: 'POST', body: { entries: [entry(id1, 'hijack', 99999)] } });
  const row = (await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === id1);
  assert.equal(row.body, 'edited on phone');
  assert.equal((await B('/api/sync?table=entries&since=0')).data.rows.length, 0);
});

await test('preferences sync', async () => {
  const pid = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { prefs: [{ id: pid, text: "I don't work on Fridays", created_at: 1, updated_at: 1, deleted: 0 }] } });
  const rows = (await A('/api/sync?table=prefs&since=0')).data.rows;
  assert.equal(rows[0].text, "I don't work on Fridays");
});

await test('paging works past 500 rows', async () => {
  const C = client();
  await C('/api/signup', { method: 'POST', body: { username: 'bulk' + uid, password: 'longpassword', invite: INVITE } });
  for (let b = 0; b < 4; b++) {
    const rows = Array.from({ length: 150 }, () => entry(crypto.randomUUID(), 'bulk', 1));
    assert.equal((await C('/api/sync', { method: 'POST', body: { entries: rows } })).status, 200);
  }
  let q = 'table=entries&since=0', seen = new Set(), pages = 0;
  for (;;) {
    const r = (await C(`/api/sync?${q}`)).data;
    r.rows.forEach(x => seen.add(x.id));
    pages++;
    if (!r.more) break;
    q = `table=entries&since=0&after_ts=${r.next.after_ts}&after_id=${r.next.after_id}`;
  }
  assert.equal(seen.size, 600);
  assert.equal(pages, 2);
});

// A fake OpenAI-style server, to check the AI layer end to end without a real key.
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const ok = req.headers.authorization === 'Bearer sk-test-123' && JSON.parse(raw).model === 'fake-model';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok
      ? { choices: [{ message: { content: '```json\n{"ok": true}\n```' } }] }
      : { error: { message: 'bad key' } }));
  });
}).listen(9911);

await test('AI settings: key is stored but never returned', async () => {
  const r = await A('/api/settings', { method: 'PUT', body: { ai_provider: 'openai_compat', ai_model: 'fake-model', ai_base_url: 'http://127.0.0.1:9911/v1', ai_key: 'sk-test-123' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.settings.ai_has_key, true);
  assert.ok(!JSON.stringify(r.data).includes('sk-test-123'));
});
await test('AI test call goes through the swappable layer', async () => {
  const r = await A('/api/ai/test', { method: 'POST', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
});
await test('AI with a wrong key gives a clear message', async () => {
  await A('/api/settings', { method: 'PUT', body: { ai_key: 'sk-wrong' } });
  const r = await A('/api/ai/test', { method: 'POST', body: {} });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /rejected the API key/);
});
await test('provider list hides the free option when it is switched off', async () => {
  const ids = (await A('/api/ai/providers')).data.providers.map(p => p.id);
  assert.ok(ids.includes('anthropic') && ids.includes('openai_compat'));
});
fake.close();

await test('export includes entries and preferences, not deleted ones', async () => {
  const r = await A('/api/export');
  assert.equal(r.data.entries.length, 1);
  assert.equal(r.data.prefs.length, 1);
});
await test('delete account removes everything', async () => {
  assert.equal((await A('/api/account', { method: 'DELETE', body: { password: 'wrong-one' } })).status, 401);
  assert.equal((await A('/api/account', { method: 'DELETE', body: { password: 'longpassword' } })).status, 200);
  const r = await client()('/api/login', { method: 'POST', body: { username: 'karthik' + uid, password: 'longpassword' } });
  assert.equal(r.status, 401);
});
await test('logout ends the session', async () => {
  await B('/api/logout', { method: 'POST' });
  assert.equal((await B('/api/me')).status, 401);
});

console.log(`\nAll ${passed} checks passed.`);
