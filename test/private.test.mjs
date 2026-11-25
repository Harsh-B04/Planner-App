// Private journal + repeating tasks on a running local server. node test/private.test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}
let lastPrompt = '';
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    lastPrompt = JSON.parse(raw).messages[1].content;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"items":[{"kind":"intention","task":"Call the lab","category":"work","date":"2026-11-01"}]}' } }] }));
  });
}).listen(9919);

const uid = Math.random().toString(36).slice(2, 8);
const A = client();
await A('/api/signup', { method: 'POST', body: { username: 'pv' + uid, password: 'longpassword', invite: 'test-invite' } });
await A('/api/settings', { method: 'PUT', body: { ai_provider: 'openai_compat', ai_model: 'f', ai_base_url: 'http://127.0.0.1:9919/v1', ai_key: 'k' } });
const lock = { salt: 'c2FsdHNhbHRzYWx0c2FsdA==', iv: 'aXZpdml2aXZpdml2', key: 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5', iter: 310000 };
const entry = (id, body, updated_at) => ({ id, body, entry_date: '2026-10-31', energy: null, created_at: 1, updated_at, deleted: 0 });
const e1 = crypto.randomUUID();

await test('plain journal works before private mode', async () => {
  assert.equal((await A('/api/sync', { method: 'POST', body: { entries: [entry(e1, 'plain text', 1)] } })).status, 200);
});
await test('bad vault settings are refused', async () => {
  assert.equal((await A('/api/settings', { method: 'PUT', body: { vault: { pass: lock } } })).status, 400);
  assert.equal((await A('/api/settings', { method: 'PUT', body: { vault: { pass: { ...lock, iter: 10 }, recovery: lock } } })).status, 400);
});
await test('vault is saved and returned (only locked copies, no key)', async () => {
  const r = await A('/api/settings', { method: 'PUT', body: { vault: { v: 1, pass: lock, recovery: { ...lock, iter: 150000 }, junk: 'x' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data.settings.vault).sort(), ['created_at', 'off', 'pass', 'recovery', 'v']);
});
await test('with private mode on, readable journal text is refused', async () => {
  const r = await A('/api/sync', { method: 'POST', body: { entries: [entry(e1, 'oops plain', 2)] } });
  assert.equal(r.status, 409);
  const o = { id: crypto.randomUUID(), entry_id: e1, kind: 'activity', data: '{"task":"x"}', status: 'pending', source: 'ai', created_at: 1, updated_at: 1, deleted: 0 };
  assert.equal((await A('/api/sync', { method: 'POST', body: { observations: [o] } })).status, 409);
});
await test('encrypted entries and notes are accepted, including long ones', async () => {
  const big = 'enc:v1:' + 'A'.repeat(30000);
  const o = { id: crypto.randomUUID(), entry_id: e1, kind: 'activity', data: JSON.stringify({ enc: 'enc:v1:QUJD' }), status: 'pending', source: 'ai', created_at: 1, updated_at: 1, deleted: 0 };
  const r = await A('/api/sync', { method: 'POST', body: { entries: [entry(e1, big, 3)], observations: [o] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok((await A('/api/sync?table=entries&since=0')).data.rows[0].body.startsWith('enc:v1:'));
});
await test('deleting works while private (text wiped)', async () => {
  const e2 = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { entries: [entry(e2, 'enc:v1:QUJD', 1)] } });
  assert.equal((await A('/api/sync', { method: 'POST', body: { entries: [{ ...entry(e2, 'anything', 2), deleted: 1 }] } })).status, 200);
});
await test('the server cannot read a private entry with AI on its own', async () => {
  const r = await A('/api/extract', { method: 'POST', body: { entry_id: e1 } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /private/);
});
await test('private AI reading: text in, notes out, nothing readable stored', async () => {
  const r = await A('/api/extract', { method: 'POST', body: { entry_id: e1, text: 'Need to call the lab tomorrow', already: ['Write intro'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.items[0].data.task, 'Call the lab');
  assert.match(lastPrompt, /call the lab tomorrow/);
  assert.match(lastPrompt, /Already recorded[\s\S]*Write intro/);
  const obs = (await A('/api/sync?table=observations&since=0')).data.rows;
  assert.ok(obs.every(o => o.data.startsWith('{"enc"')), 'server stored no readable notes');
  assert.equal((await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === e1).extracted_version, 3);
});
await test('switching off: readable text accepted again, then vault removed', async () => {
  const me = (await A('/api/me')).data.settings.vault;
  await A('/api/settings', { method: 'PUT', body: { vault: { ...me, off: true } } });
  assert.equal((await A('/api/sync', { method: 'POST', body: { entries: [entry(e1, 'back to plain', 4)] } })).status, 200);
  await A('/api/settings', { method: 'PUT', body: { vault: null } });
  assert.equal((await A('/api/me')).data.settings.vault, null);
});
await test('repeating tasks sync; bad repeat refused', async () => {
  const t = { id: crypto.randomUUID(), goal: null, title: 'Gym', notes: null, category: 'exercise', est_minutes: 60, deadline: null, priority: 2, status: 'open', done_at: null, repeat: '{"days":[1,3,5],"time":"18:00"}', created_at: 1, updated_at: 1, deleted: 0 };
  assert.equal((await A('/api/sync', { method: 'POST', body: { tasks: [t] } })).status, 200);
  assert.equal((await A('/api/sync?table=tasks&since=0')).data.rows[0].repeat, '{"days":[1,3,5],"time":"18:00"}');
  assert.equal((await A('/api/sync', { method: 'POST', body: { tasks: [{ ...t, id: crypto.randomUUID(), repeat: '{"days":[]}' }] } })).data.rejected[0].field, 'repeat');
});
fake.close();
console.log(`\nAll ${passed} private-journal and repeat checks passed.`);
