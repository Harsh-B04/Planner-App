// Checks planning features on a running local server, with a fake AI.
// Usage: node test/plan.test.mjs [baseUrl] [inviteCode]
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

let lastSystem = '', lastPrompt = '';
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const b = JSON.parse(raw);
    lastSystem = b.messages[0].content;
    lastPrompt = b.messages[1].content;
    let out;
    if (lastSystem.includes('scheduling rule')) {
      out = lastPrompt.includes('Friday') ? { rule: { type: 'day_off', days: [5], strict: false } }
          : lastPrompt.includes('night') ? { rule: { type: 'prefer_time', start: '20:00', end: '24:00' } }
          : { rule: { type: 'nonsense' } };
    } else if (lastSystem.includes('Do not ask questions')) {
      out = { goal: 'Project report', tasks: [
        { title: 'Collect results from lab', minutes: 45, deadline: '2026-11-03', priority: 1, category: 'study', done_when: 'all tables filled' },
        { title: 'Write the method section', minutes: 9999, priority: 7, category: 'nope' },
        { title: '', minutes: 30 },
      ] };
    } else {
      out = { questions: ['When is it due?', 'How much is written already?', 'Q3', 'Q4 should be dropped'] };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
  });
}).listen(9914);

const uid = Math.random().toString(36).slice(2, 8);
const A = client(), B = client();
await A('/api/signup', { method: 'POST', body: { username: 'pl' + uid, password: 'longpassword', invite: INVITE } });
await B('/api/signup', { method: 'POST', body: { username: 'plb' + uid, password: 'longpassword', invite: INVITE } });

await test('without an AI, planning help says so clearly', async () => {
  const r = await A('/api/plan/breakdown', { method: 'POST', body: { goal: 'Write report', today: '2026-10-30' } });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /No AI chosen/);
});

await A('/api/settings', { method: 'PUT', body: { ai_provider: 'openai_compat', ai_model: 'f', ai_base_url: 'http://127.0.0.1:9914/v1', ai_key: 'k' } });

let questions;
await test('goal breakdown asks at most 3 questions first', async () => {
  const r = await A('/api/plan/breakdown', { method: 'POST', body: { goal: 'Finish my project report', today: '2026-10-30' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  questions = r.data.questions;
  assert.equal(questions.length, 3);
  assert.match(lastPrompt, /Today is 2026-10-30 \(Friday\)/);
});
await test('after answers it returns cleaned tasks, never more questions', async () => {
  const r = await A('/api/plan/breakdown', { method: 'POST', body: { goal: 'Finish my project report', today: '2026-10-30', answers: [{ q: questions[0], a: 'Tuesday' }] } });
  assert.match(lastPrompt, /A: Tuesday/);
  assert.equal(r.data.goal, 'Project report');
  assert.equal(r.data.tasks.length, 2);
  const [a, b] = r.data.tasks;
  assert.deepEqual([a.minutes, a.deadline, a.priority, a.category], [45, '2026-11-03', 1, 'study']);
  assert.deepEqual([b.minutes, b.deadline, b.priority, b.category], [480, null, 2, 'other']);
});
await test('"skip questions" goes straight to tasks', async () => {
  const r = await A('/api/plan/breakdown', { method: 'POST', body: { goal: 'x', today: '2026-10-30', noQuestions: true } });
  assert.equal(r.data.tasks.length, 2);
});
await test('preference sentences become checked rules', async () => {
  assert.deepEqual((await A('/api/prefs/parse', { method: 'POST', body: { text: "I don't like working on Fridays" } })).data.rule,
    { type: 'day_off', days: [5], strict: false });
  assert.deepEqual((await A('/api/prefs/parse', { method: 'POST', body: { text: 'I focus better at night' } })).data.rule,
    { type: 'prefer_time', start: '20:00', end: '24:00' });
  assert.equal((await A('/api/prefs/parse', { method: 'POST', body: { text: 'I like tea' } })).data.rule, null);
});
await test('routine is cleaned and saved', async () => {
  const r = await A('/api/settings', { method: 'PUT', body: { routine: { start: '08:00', end: '23:00', maxMinutes: 99999, busy: [{ days: [1, 2], start: '09:00', end: '16:00', label: 'College' }, { junk: 1 }] } } });
  assert.equal(r.data.settings.routine.maxMinutes, 960);
  assert.equal(r.data.settings.routine.busy.length, 1);
  assert.equal((await A('/api/me')).data.settings.routine.start, '08:00');
});

const tid = crypto.randomUUID(), bid = crypto.randomUUID();
const task = { id: tid, goal: 'Report', title: 'Write intro', notes: null, category: 'study', est_minutes: 60, deadline: '2026-11-03', priority: 1, status: 'open', done_at: null, created_at: 1, updated_at: 1, deleted: 0 };
const block = { id: bid, task_id: tid, date: '2026-10-30', start_min: 960, end_min: 1050, status: 'planned', actual_minutes: null, started_at: null, reason: null, created_at: 1, updated_at: 1, deleted: 0 };

await test('tasks and blocks sync', async () => {
  const r = await A('/api/sync', { method: 'POST', body: { tasks: [task], blocks: [block] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await A('/api/sync?table=tasks&since=0')).data.rows[0].title, 'Write intro');
  assert.equal((await A('/api/sync?table=blocks&since=0')).data.rows[0].start_min, 960);
});
await test('finishing a block with real time syncs', async () => {
  await A('/api/sync', { method: 'POST', body: { blocks: [{ ...block, status: 'done', actual_minutes: 75, updated_at: 2 }] } });
  const row = (await A('/api/sync?table=blocks&since=0')).data.rows[0];
  assert.deepEqual([row.status, row.actual_minutes], ['done', 75]);
});
await test('preference rules sync with the preference', async () => {
  const id = crypto.randomUUID();
  await A('/api/sync', { method: 'POST', body: { prefs: [{ id, text: 'No Fridays', rule_json: '{"type":"day_off","days":[5],"strict":true}', created_at: 1, updated_at: 1, deleted: 0 }] } });
  assert.match((await A('/api/sync?table=prefs&since=0')).data.rows.find(p => p.id === id).rule_json, /day_off/);
});
await test('bad tasks and blocks are rejected', async () => {
  const bad = [
    { tasks: [{ ...task, id: crypto.randomUUID(), title: '' }] },
    { tasks: [{ ...task, id: crypto.randomUUID(), est_minutes: 1.5 }] },
    { tasks: [{ ...task, id: crypto.randomUUID(), category: 'hack' }] },
    { blocks: [{ ...block, id: crypto.randomUUID(), end_min: 900 }] },
    { blocks: [{ ...block, id: crypto.randomUUID(), status: 'maybe' }] },
    { prefs: [{ id: crypto.randomUUID(), text: 'x', rule_json: '{not json', created_at: 1, updated_at: 1, deleted: 0 }] },
  ];
  for (const b of bad) { const r = await A('/api/sync', { method: 'POST', body: b }); assert.ok(r.status === 400 || r.data?.rejected?.length === 1, JSON.stringify(b)); }
});
await test('friends cannot see or change my tasks', async () => {
  assert.equal((await B('/api/sync?table=tasks&since=0')).data.rows.length, 0);
  await B('/api/sync', { method: 'POST', body: { tasks: [{ ...task, title: 'hijacked', updated_at: 99 }] } });
  assert.equal((await A('/api/sync?table=tasks&since=0')).data.rows[0].title, 'Write intro');
});
await test('deleted task text is wiped on the server', async () => {
  await A('/api/sync', { method: 'POST', body: { tasks: [{ ...task, deleted: 1, updated_at: 5 }] } });
  const row = (await A('/api/sync?table=tasks&since=0')).data.rows[0];
  assert.deepEqual([row.deleted, row.title, row.goal], [1, '(deleted)', null]);
});
await test('export has tasks and blocks; delete account removes them', async () => {
  const e = await A('/api/export');
  assert.ok(Array.isArray(e.data.tasks) && Array.isArray(e.data.blocks));
  assert.equal(e.data.blocks.length, 1);
  assert.equal((await A('/api/account', { method: 'DELETE', body: { password: 'longpassword' } })).status, 200);
});

fake.close();
console.log(`\nAll ${passed} planning checks passed.`);
