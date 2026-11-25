// Private calendar link on a running local server. node test/feed.test.mjs
import assert from 'node:assert/strict';
import { localToUtc } from '../src/ics.js';

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

await test('local time to UTC, including a daylight-saving zone', async () => {
  assert.equal(new Date(localToUtc('2026-11-02', 990, 'Asia/Kolkata')).toISOString(), '2026-11-02T11:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-07-01', 540, 'Europe/London')).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-12-01', 540, 'Europe/London')).toISOString(), '2026-12-01T09:00:00.000Z');
});

const uid = Math.random().toString(36).slice(2, 8);
const A = client();
await A('/api/signup', { method: 'POST', body: { username: 'fd' + uid, password: 'longpassword', invite: 'test-invite' } });
await A('/api/settings', { method: 'PUT', body: { timezone: 'Asia/Kolkata' } });
const day = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
const t = { id: crypto.randomUUID(), goal: 'Lab, report', title: 'CTME experiment; part 1', notes: null, category: 'study', est_minutes: 90, deadline: day, priority: 1, status: 'open', done_at: null, repeat: null, created_at: 1, updated_at: 1, deleted: 0 };
const blk = (start, status) => ({ id: crypto.randomUUID(), task_id: t.id, date: day, start_min: start, end_min: start + 90, status, actual_minutes: null, started_at: null, reason: null, created_at: 1, updated_at: 1, deleted: 0 });
await A('/api/sync', { method: 'POST', body: { tasks: [t], blocks: [blk(990, 'planned'), blk(600, 'skipped')] } });

let link;
await test('create a private link', async () => {
  const r = await A('/api/calendar/link', { method: 'POST', body: { action: 'create' } });
  link = `/cal/${r.data.settings.cal_token}.ics`;
  assert.ok(r.data.settings.cal_token.length >= 30);
  const again = await A('/api/calendar/link', { method: 'POST', body: { action: 'create' } });
  assert.equal(again.data.settings.cal_token, r.data.settings.cal_token, 'create keeps the same link');
});
await test('feed is a valid calendar: sessions in UTC with alerts, deadlines as all-day, skipped left out', async () => {
  const res = await fetch(BASE + link);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const ics = await res.text();
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.trimEnd().endsWith('END:VCALENDAR'));
  const d = day.replace(/-/g, '');
  assert.match(ics, new RegExp(`DTSTART:${d}T110000Z`));
  assert.match(ics, new RegExp(`DTEND:${d}T123000Z`));
  assert.ok(ics.includes('SUMMARY:CTME experiment' + String.fromCharCode(92) + '; part 1'), 'title with escaped semicolon');
  assert.match(ics, /TRIGGER:-PT10M/);
  assert.match(ics, new RegExp(`DTSTART;VALUE=DATE:${d}`));
  assert.ok(ics.includes('SUMMARY:Due: CTME experiment' + String.fromCharCode(92) + '; part 1'), 'deadline event');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, 'skipped session not included');
  assert.ok(ics.split('\r\n').every(l => l.length <= 75), 'lines folded');
});
await test('no login needed for the feed, but a wrong link shows nothing', async () => {
  assert.equal((await fetch(BASE + '/cal/notarealtokennotarealtoken.ics')).status, 404);
});
await test('a new link replaces the old one; turning off removes it', async () => {
  const r = await A('/api/calendar/link', { method: 'POST', body: { action: 'reset' } });
  assert.equal((await fetch(BASE + link)).status, 404);
  const fresh = `/cal/${r.data.settings.cal_token}.ics`;
  assert.equal((await fetch(BASE + fresh)).status, 200);
  await A('/api/calendar/link', { method: 'POST', body: { action: 'off' } });
  assert.equal((await fetch(BASE + fresh)).status, 404);
});
console.log(`\nAll ${passed} calendar-link checks passed.`);
