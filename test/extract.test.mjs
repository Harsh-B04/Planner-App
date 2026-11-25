// Checks the AI reading of journal entries against a running local server, using a fake AI.
// Usage: node test/extract.test.mjs [baseUrl] [inviteCode]   (expects AI_DAILY_LIMIT=10 in .dev.vars)
import http from 'node:http';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const INVITE = process.argv[3] || 'test-invite';
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };

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

// Fake AI: returns a messy reply on purpose, to check that the server cleans it.
let calls = 0, lastPrompt = '';
const MESSY = {
  items: [
    { kind: 'activity', task: 'Report writing', category: 'study', minutes: 120, estimated: true, outcome: 'not_done', reason: 'waiting on results' },
    { kind: 'activity', task: 'Gym', category: 'lifting', minutes: 99999, outcome: 'weird' },
    { kind: 'intention', task: 'Slides', category: 'study', date: '2026-10-31' },
    { kind: 'preference', text: 'I focus better at night' },
    { kind: 'hack', task: 'drop table' },
    { kind: 'intention', task: '', date: 'bad' },
  ],
};
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    calls++;
    const b = JSON.parse(raw);
    lastPrompt = b.messages[1].content;
    const ok = req.headers.authorization === 'Bearer good-key';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok
      ? { choices: [{ message: { content: 'Here you go:\n```json\n' + JSON.stringify(MESSY) + '\n```' } }] }
      : { error: { message: 'bad key' } }));
  });
}).listen(9912);

const uid = Math.random().toString(36).slice(2, 8);
const A = client(), B = client();
const entry = (id, body, updated_at, extra = {}) =>
  ({ id, body, entry_date: '2026-10-30', energy: null, created_at: 1761800000000, updated_at, deleted: 0, ...extra });
const pullObs = async () => (await A('/api/sync?table=observations&since=0')).data.rows;

await A('/api/signup', { method: 'POST', body: { username: 'ex' + uid, password: 'longpassword', invite: INVITE } });
await A('/api/settings', { method: 'PUT', body: { ai_provider: 'openai_compat', ai_model: 'fake', ai_base_url: 'http://127.0.0.1:9912/v1', ai_key: 'good-key', timezone: 'Asia/Kolkata' } });

const e1 = crypto.randomUUID();
let first;
await test('AI reads an entry and the messy reply is cleaned', async () => {
  await A('/api/sync', { method: 'POST', body: { entries: [entry(e1, 'Spent ages on the report, stuck waiting for results. Gym after. Slides tomorrow.', 2000)] } });
  const r = await A('/api/extract', { method: 'POST', body: { entry_id: e1 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  first = r.data.rows;
  assert.equal(first.length, 4);
  assert.ok(first.every(o => o.status === 'pending' && o.source === 'ai'));
  const gym = JSON.parse(first.find(o => o.data.includes('Gym')).data);
  assert.equal(gym.minutes, 960);
  assert.equal(gym.outcome, 'unknown');
  assert.equal(gym.category, 'other');
  assert.equal(r.data.extracted_version, 2000);
  assert.match(lastPrompt, /2026-10-30 \(Friday\)/);
});
await test('reading the same version again does not call the AI', async () => {
  const before = calls;
  const r = await A('/api/extract', { method: 'POST', body: { entry_id: e1 } });
  assert.equal(r.data.rows.length, 4);
  assert.equal(calls, before);
});
await test('confirming a fact syncs', async () => {
  const report = first.find(o => o.data.includes('Report'));
  const p = await A('/api/sync', { method: 'POST', body: { observations: [{ ...report, status: 'confirmed', updated_at: report.updated_at + 1 }] } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal((await pullObs()).find(o => o.id === report.id).status, 'confirmed');
});
await test('editing the entry re-reads it: unconfirmed replaced, confirmed kept', async () => {
  await A('/api/sync', { method: 'POST', body: { entries: [entry(e1, 'Edited text', 3000)] } });
  const r = await A('/api/extract', { method: 'POST', body: { entry_id: e1 } });
  assert.match(lastPrompt, /Already recorded[\s\S]*Report writing/);
  const live = r.data.rows.filter(o => !o.deleted);
  assert.equal(live.filter(o => o.status === 'confirmed').length, 1);
  assert.equal(live.filter(o => o.status === 'pending').length, 3);   // the AI repeated the confirmed 'Report writing': dropped
  assert.equal(r.data.rows.filter(o => o.deleted).length, 3);
  assert.ok(r.data.rows.filter(o => o.deleted).every(o => o.data === '{}'));
});
await test('the entry records which version the AI read', async () => {
  const row = (await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === e1);
  assert.equal(row.extracted_version, 3000);
});
await test('another user cannot make the AI read my entry', async () => {
  await B('/api/signup', { method: 'POST', body: { username: 'exb' + uid, password: 'longpassword', invite: INVITE } });
  assert.equal((await B('/api/extract', { method: 'POST', body: { entry_id: e1 } })).status, 404);
  assert.equal((await B('/api/sync?table=observations&since=0')).data.rows.length, 0);
});
await test('another user cannot change my observations', async () => {
  const o = (await pullObs()).find(x => !x.deleted && x.status === 'pending');
  await B('/api/sync', { method: 'POST', body: { observations: [{ ...o, status: 'rejected', updated_at: o.updated_at + 999 }] } });
  assert.equal((await pullObs()).find(x => x.id === o.id).status, 'pending');
});
await test('bad observation data is rejected', async () => {
  const o = (await pullObs())[0];
  const r = await A('/api/sync', { method: 'POST', body: { observations: [{ ...o, status: 'weird', updated_at: o.updated_at + 1 }] } });
  assert.equal(r.data.rejected[0].field, 'status');
  assert.equal((await pullObs()).find(x => x.id === o.id).status, o.status, 'not saved');
});
await test('deleting the entry removes its facts', async () => {
  await A('/api/sync', { method: 'POST', body: { entries: [entry(e1, '', 4000, { deleted: 1 })] } });
  assert.ok((await pullObs()).every(o => o.deleted === 1 && o.data === '{}'));
});
await test('a bad AI key gives a clear error and saves nothing', async () => {
  await A('/api/settings', { method: 'PUT', body: { ai_key: 'wrong' } });
  const e2 = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { entries: [entry(e2, 'something', 5000)] } });
  const r = await A('/api/extract', { method: 'POST', body: { entry_id: e2 } });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /rejected the API key/);
  const row = (await A('/api/sync?table=entries&since=0')).data.rows.find(x => x.id === e2);
  assert.equal(row.extracted_version, null);
});
await test('daily AI limit stops runaway use', async () => {
  await A('/api/settings', { method: 'PUT', body: { ai_key: 'good-key' } });
  let hit = null;
  for (let i = 0; i < 12 && !hit; i++) {
    const id = crypto.randomUUID();
    await A('/api/sync', { method: 'POST', body: { entries: [entry(id, 'entry ' + i, 6000)] } });
    const r = await A('/api/extract', { method: 'POST', body: { entry_id: id } });
    if (r.status === 429) hit = r.data.error;
  }
  assert.match(hit || '', /Daily AI limit/);
});
await test('export includes confirmed facts', async () => {
  const r = await A('/api/export');
  assert.ok(Array.isArray(r.data.noted));
});

await test('a habit on set days becomes a repeating plan, not a preference', async () => {
  const { cleanItems } = await import('../src/extract.js');
  const [x] = cleanItems({ items: [{ kind: 'intention', task: 'Gym', category: 'exercise', date: '2026-11-02', repeat: { days: ['Monday', 'tue', 9], time: '18:00' }, minutes: 60 }] });
  assert.deepEqual(x.data, { task: 'Gym', category: 'exercise', date: null, repeat: { days: [1, 2], time: '18:00' }, minutes: 60 });
  const [y] = cleanItems({ items: [{ kind: 'intention', task: 'Read', repeat: { days: [] } }] });
  assert.equal(y.data.repeat, undefined);
});

await test('a change to an existing plan comes back as an update', async () => {
  const { cleanItems, buildPrompt } = await import('../src/extract.js');
  const [u] = cleanItems({ items: [{ kind: 'update', plan: 'Automobile', add: ['Module 5'], which: ['Module 1', 'Module 2'], deadline: '2026-11-16' }] });
  assert.equal(u.kind, 'update'); assert.deepEqual(u.data.add, ['Module 5']); assert.equal(u.data.deadline, '2026-11-16');
  assert.equal(cleanItems({ items: [{ kind: 'update', plan: 'Automobile' }] }).length, 0, 'an update that changes nothing is dropped');
  const p = buildPrompt({ entry_date: '2026-11-14', created_at: 0, body: 'x' }, 'UTC', [], ['Automobile #auto: Module 1 (2026-11-17)']);
  assert.ok(p.includes('Plans they already have') && p.includes('Automobile #auto'));
});

await test('"twice a week" becomes a repeat with a weekly count', async () => {
  const { cleanItems } = await import('../src/extract.js');
  const [x] = cleanItems({ items: [{ kind: 'intention', task: 'Exercise', repeat: { per_week: 2, time: '18:00' } }] });
  assert.deepEqual(x.data.repeat, { days: [], per_week: 2, time: '18:00' });
  const [y] = cleanItems({ items: [{ kind: 'intention', task: 'Walk', repeat: { per_week: 7 } }] });
  assert.deepEqual(y.data.repeat, { days: [0, 1, 2, 3, 4, 5, 6], time: null });
});

await test('the same note twice, or one already confirmed, is dropped', async () => {
  const { cleanItems, dropRepeats } = await import('../src/extract.js');
  const items = cleanItems({ items: [
    { kind: 'intention', task: 'Vijay sir paper', category: 'study', date: '2026-11-02' },
    { kind: 'intention', task: 'Vijay Sir paper', category: 'study', date: '2026-11-02' },
    { kind: 'activity', task: 'Exam study', category: 'study', minutes: 60, outcome: 'done' },
    { kind: 'intention', task: 'Call the lab', category: 'work', date: null },
  ] });
  assert.deepEqual(dropRepeats(items, ['Call the lab (plan)']).map(x => x.data.task), ['Vijay sir paper', 'Exam study']);
});

fake.close();
console.log(`\nAll ${passed} checks passed.`);
