// Unit tests for the scheduler. No server needed: node test/planner.test.mjs
import assert from 'node:assert/strict';
import '../public/planner-core.js';

const PC = globalThis.PlannerCore;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

const FRI = '2026-10-30', SAT = '2026-10-31', SUN = '2026-11-01', MON = '2026-11-02';
const H = h => h * 60;
const task = (id, est, extra = {}) => ({ id, title: id, est_minutes: est, status: 'open', priority: 2, deadline: null, created_at: 1, deleted: 0, ...extra });
const pref = rule => ({ text: 'x', rule_json: JSON.stringify(rule), deleted: 0 });
const college = { start: '09:00', end: '22:00', busy: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '16:00', label: 'College' }] };
const plan = o => PC.makePlan({ today: FRI, nowMin: H(8), blocks: [], prefs: [], routine: college, ...o });
const hhmm = b => `${b.date} ${PC.toHHMM(b.start_min)}-${PC.toHHMM(b.end_min)}`;

test('fits around college, splits into sessions with a break', () => {
  const r = plan({ tasks: [task('report', 120)] });
  assert.deepEqual(r.blocks.map(hhmm), [`${FRI} 16:00-17:30`, `${FRI} 17:45-18:15`]);
});
test('never schedules in the past', () => {
  const r = plan({ tasks: [task('a', 60)], nowMin: H(18) + 7 });
  assert.equal(r.blocks[0].start_min, H(18) + 30);
});
test('strict day off: nothing on Friday', () => {
  const r = plan({ tasks: [task('a', 60)], prefs: [pref({ type: 'day_off', days: [5], strict: true })] });
  assert.equal(r.blocks[0].date, SAT);
  assert.equal(r.blocks[0].start_min, H(9));
});
test('soft day off: Friday avoided normally', () => {
  const r = plan({ tasks: [task('a', 60)], prefs: [pref({ type: 'day_off', days: [5], strict: false })] });
  assert.equal(r.blocks[0].date, SAT);
  assert.equal(r.warnings.length, 0);
});
test('soft day off: used anyway when a deadline needs it, with a warning', () => {
  const r = plan({ tasks: [task('a', 60, { deadline: FRI })], prefs: [pref({ type: 'day_off', days: [5], strict: false })] });
  assert.equal(r.blocks[0].date, FRI);
  assert.deepEqual(r.warnings.map(w => w.kind), ['avoid']);
});
test('strict day off is never broken, deadline shortfall reported', () => {
  const r = plan({ tasks: [task('a', 60, { deadline: FRI })], prefs: [pref({ type: 'day_off', days: [5], strict: true })] });
  assert.equal(r.blocks.length, 0);
  assert.deepEqual(r.warnings.map(w => [w.kind, w.minutes]), [['short', 60]]);
});
test('daily limit respected', () => {
  const r = plan({ tasks: [task('big', 1200)], maxMinutes: 240 });
  for (const [, m] of Object.entries(r.perDay)) assert.ok(m <= 240);
  assert.equal(r.maxMinutes, 240);
});
test('max-hours rule lowers the limit', () => {
  const r = plan({ tasks: [task('big', 1200)], prefs: [pref({ type: 'max_hours', hours: 2 })] });
  for (const [, m] of Object.entries(r.perDay)) assert.ok(m <= 120);
});
test('earliest deadline goes first', () => {
  const r = plan({ tasks: [task('later', 60, { deadline: MON, created_at: 1 }), task('soon', 60, { deadline: SAT, created_at: 2 })] });
  assert.equal(r.blocks[0].task_id, 'soon');
});
test('too much work before a deadline is reported, not hidden', () => {
  const r = plan({ tasks: [task('a', 900, { deadline: SAT })], maxMinutes: 300 });
  const w = r.warnings.find(x => x.kind === 'short');
  assert.ok(w && w.minutes > 0 && w.deadline === SAT);
});
test('overdue task planned as soon as possible', () => {
  const r = plan({ tasks: [task('a', 60, { deadline: '2026-10-28' })] });
  assert.equal(r.blocks[0].date, FRI);
  assert.equal(r.warnings[0].kind, 'overdue');
});
test('time already spent is subtracted', () => {
  const done = { id: 'b1', task_id: 'a', date: '2026-10-29', start_min: H(16), end_min: H(17) + 30, status: 'done', actual_minutes: 90 };
  const r = plan({ tasks: [task('a', 120)], blocks: [done] });
  assert.equal(r.blocks.reduce((s, b) => s + b.end_min - b.start_min, 0), 30);
});
test('over the estimate but still open: one more session', () => {
  const done = { id: 'b1', task_id: 'a', date: '2026-10-29', start_min: H(16), end_min: H(18), status: 'done', actual_minutes: 150 };
  const r = plan({ tasks: [task('a', 120)], blocks: [done] });
  assert.equal(r.blocks.reduce((s, b) => s + b.end_min - b.start_min, 0), 30);
});
test('future planned blocks are replaced, started ones are kept', () => {
  const future = { id: 'f', task_id: 'a', date: SAT, start_min: H(10), end_min: H(11), status: 'planned' };
  const running = { id: 'r', task_id: 'b', date: FRI, start_min: H(16), end_min: H(17), status: 'planned', started_at: 123 };
  const r = plan({ tasks: [task('a', 60), task('b', 60)], blocks: [future, running], nowMin: H(16) + 20 });
  assert.ok(!r.blocks.some(b => b.task_id === 'b'), 'running block covers task b');
  const a = r.blocks.find(b => b.task_id === 'a');
  assert.equal(a.date, FRI);
  assert.ok(a.start_min >= H(17) + 15, 'leaves a break after the running block');
});
test('preferred time used first', () => {
  const r = plan({ tasks: [task('a', 60)], prefs: [pref({ type: 'prefer_time', start: '20:00', end: '24:00' })] });
  assert.equal(PC.toHHMM(r.blocks[0].start_min), '20:00');
});
test('no 15-minute scraps: a session goes where it fits whole', () => {
  // Evening is preferred but only 45 min of it is free; the 60-min task should go whole into the afternoon.
  const busyEvening = { id: 'e', task_id: 'z', date: FRI, start_min: H(20), end_min: H(21), status: 'planned', started_at: 1 };
  const r = plan({ tasks: [task('a', 60)], blocks: [busyEvening], prefs: [pref({ type: 'prefer_time', start: '20:00', end: '24:00' })] });
  assert.deepEqual(r.blocks.map(hhmm), [`${FRI} 16:00-17:00`]);
});
test('remainders are never smaller than 25 min', () => {
  const r = plan({ tasks: [task('a', 100)] });
  assert.ok(r.blocks.every(b => b.end_min - b.start_min >= 25), r.blocks.map(hhmm).join(', '));
});
test('repeating task: one session on each matching day, at its usual time', () => {
  const gym = task('gym', 60, { repeat: JSON.stringify({ days: [1, 3, 5], time: '18:00' }) });
  const r = plan({ tasks: [gym] });
  assert.deepEqual(r.blocks.map(hhmm), [`${FRI} 18:00-19:00`, `${MON} 18:00-19:00`, `2026-11-04 18:00-19:00`]);
});
test('repeating task goes before normal tasks and is never "finished" by the plan', () => {
  const daily = task('revise', 30, { repeat: { days: [0, 1, 2, 3, 4, 5, 6] } });
  const r = plan({ tasks: [task('big', 600), daily], maxMinutes: 120 });
  for (const d of Object.keys(r.perDay)) assert.ok(r.blocks.some(b => b.date === d && b.task_id === 'revise'), d);
});
test('repeating task skips days that already have its session', () => {
  const done = { id: 'x', task_id: 'gym', date: FRI, start_min: H(17), end_min: H(18), status: 'done', actual_minutes: 60 };
  const r = plan({ tasks: [task('gym', 60, { repeat: { days: [5] } })], blocks: [done] });
  assert.equal(r.blocks.length, 0);
});
test('usual time taken: repeating task moves to a free gap', () => {
  const busy = { id: 'b', task_id: 'z', date: FRI, start_min: H(18), end_min: H(19), status: 'planned', started_at: 1 };
  const r = plan({ tasks: [task('gym', 60, { repeat: { days: [5], time: '18:00' } })], blocks: [busy] });
  assert.equal(r.blocks[0].date, FRI);
  assert.notEqual(r.blocks[0].start_min, H(18));
});
test('repeat descriptions', () => {
  assert.equal(PC.describeRepeat({ days: [1, 2, 3, 4, 5] }), 'weekdays');
  assert.equal(PC.describeRepeat({ days: [1, 3, 5], time: '07:00' }), 'Mon, Wed, Fri at 07:00');
  assert.equal(PC.cleanRepeat({ days: [] }), null);
});
test('no-work window across midnight', () => {
  const r = plan({ tasks: [task('a', 60)], routine: { start: '06:00', end: '24:00' }, prefs: [pref({ type: 'no_work_between', start: '22:00', end: '08:00', strict: true })], nowMin: H(5) });
  assert.equal(PC.toHHMM(r.blocks[0].start_min), '08:00');
});
test('days off in the routine', () => {
  const r = plan({ tasks: [task('a', 60)], routine: { ...college, daysOff: [5, 6] } });
  assert.equal(r.blocks[0].date, SUN);
});
test('"Later" finds the next free slot', () => {
  const blocks = [{ id: 'x', task_id: 'a', date: FRI, start_min: H(16), end_min: H(17), status: 'planned' },
                  { id: 'y', task_id: 'b', date: FRI, start_min: H(17) + 15, end_min: H(21) + 45, status: 'planned' }];
  const s = PC.nextSlot({ blocks, routine: college, prefs: [], today: FRI, nowMin: H(15), length: 60, skipId: 'x', afterMin: H(17) });
  assert.equal(s.date, SAT);
  assert.equal(s.start_min, H(9));
});
test('rule cleaning rejects junk', () => {
  assert.equal(PC.cleanRule({ type: 'day_off', days: [9] }), null);
  assert.equal(PC.cleanRule({ type: 'no_work_between', start: '25:00', end: '07:00' }), null);
  assert.equal(PC.cleanRule({ type: 'drop table' }), null);
  assert.deepEqual(PC.cleanRule({ type: 'max_hours', hours: '4.2', days: [] }), { type: 'max_hours', hours: 4 });
});
test('reading rules without AI', () => {
  assert.deepEqual(PC.guessRule("I don't like working on Fridays"), { type: 'day_off', days: [5], strict: false });
  assert.deepEqual(PC.guessRule('Never work on Sundays'), { type: 'day_off', days: [0], strict: true });
  assert.deepEqual(PC.guessRule('max 4 hours a day'), { type: 'max_hours', hours: 4 });
  assert.equal(PC.guessRule('I like tea'), null);
});
test('rules described in plain words', () => {
  assert.equal(PC.describeRule({ type: 'day_off', days: [5], strict: false }), 'Avoid work on Fridays unless a deadline needs it');
  assert.equal(PC.describeRule({ type: 'day_off', days: [0, 6], strict: true }), 'No work on Sundays and Saturdays');
});
test('routine cleaning keeps good values, fixes bad ones', () => {
  const r = PC.cleanRoutine({ start: '10:00', end: '08:00', maxMinutes: 5000, busy: [{ days: [1], start: '09:00', end: '10:00', label: 'Lab' }, { days: [], start: 'x' }] });
  assert.equal(r.start, '09:00');
  assert.equal(r.maxMinutes, 960);
  assert.equal(r.busy.length, 1);
});

test('a task waits for its start date; long plans reach months ahead', () => {
  const r = PC.makePlan({ tasks: [task('rev', 30, { start_date: '2026-11-06' })], blocks: [], routine: null, prefs: [], today: MON, nowMin: 0, days: 7 });
  assert.deepEqual(r.blocks.map(b => b.date), ['2026-11-06']);
  const year = PC.makePlan({ tasks: [task('gym', 60, { repeat: { days: [1, 2], time: '18:00' } })], blocks: [], routine: null, prefs: [], today: MON, nowMin: 0, days: 365 });
  assert.ok(year.blocks.length >= 104 && year.blocks.at(-1).date > '2027-10-01', year.blocks.length);
});

test('sessions beyond the planning range are kept, not replaced', () => {
  const far = { id: 'b9', task_id: 'rev', date: '2026-12-01', start_min: 600, end_min: 630, status: 'planned', started_at: null, deleted: 0 };
  const r = PC.makePlan({ tasks: [task('rev', 30, { start_date: '2026-12-01' })], blocks: [far], routine: null, prefs: [], today: MON, nowMin: 0, days: 7 });
  assert.equal(r.blocks.length, 0);
  assert.equal(r.warnings.length, 0);
});

test('hard work gets your focus hours, short sessions, room around it, and at most 60% of a day', () => {
  const prefs = [pref({ type: 'prefer_time', start: '09:00', end: '12:00' })];
  const tasks = [task('easy', 120, { deadline: MON }), task('thermo', 300, { effort: 3, deadline: '2026-11-05' })];
  const r = PC.makePlan({ tasks, blocks: [], routine: null, prefs, today: MON, nowMin: 0, days: 3 });
  const mon = r.blocks.filter(b => b.date === MON);
  const firstHard = mon.filter(b => b.task_id === 'thermo')[0];
  assert.ok(firstHard && firstHard.start_min >= H(9) && firstHard.end_min <= H(12), JSON.stringify(mon));
  assert.ok(mon.filter(b => b.task_id === 'easy').every(b => b.start_min >= H(12)), 'easy work leaves the focus hours');
  assert.ok(r.blocks.filter(b => b.task_id === 'thermo').every(b => b.end_min - b.start_min <= 60));
  const hardMon = mon.filter(b => b.task_id === 'thermo').reduce((s, b) => s + b.end_min - b.start_min, 0);
  assert.ok(hardMon <= 360 * 0.6, hardMon);
  const hs = mon.filter(b => b.task_id === 'thermo').sort((a, b) => a.start_min - b.start_min);
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i].start_min - hs[i - 1].end_min >= 30, 'gap between hard sessions');
});

test('learned subject times stretch the estimate', () => {
  const tasks = [task('t1', 60, { subject: 'thermo' }), task('t2', 60, { subject: 'thermo' })];
  const done = [1, 2, 3].map(i => ({ id: 'd' + i, task_id: 't1', date: SAT, start_min: H(9), end_min: H(10), status: 'done', actual_minutes: 84, deleted: 0 }));
  const rates = PC.subjectRates(tasks, done, MON);
  assert.deepEqual(rates, { thermo: { rate: 1.4, n: 3 } });
  const r = PC.makePlan({ tasks: [tasks[1]], blocks: [], routine: null, prefs: [], today: MON, nowMin: 0, days: 2, subjectMult: { thermo: 1.4 } });
  assert.equal(r.blocks.reduce((s, b) => s + b.end_min - b.start_min, 0), 84);
});

test('"twice a week": two sessions this week, spread out, at the usual time', () => {
  const t = { id: 'ex', title: 'Exercise', status: 'open', est_minutes: 30, repeat: JSON.stringify({ days: [], per_week: 2, time: '18:00' }), deleted: 0 };
  const r = PC.makePlan({ tasks: [t], blocks: [], routine: { start: '06:00', end: '22:00' }, prefs: [], today: MON, nowMin: 0, days: 7 });
  const mine = r.blocks.filter(b => b.task_id === 'ex');
  assert.equal(mine.length, 2);
  assert.ok(mine.every(b => b.start_min === 18 * 60));
  assert.ok(PC.addDays(mine[0].date, 2) <= mine[1].date, 'not on back-to-back days');
  // One already done this week: only one more.
  const done = [{ id: 'd1', task_id: 'ex', date: MON, start_min: 600, end_min: 630, status: 'done', deleted: 0 }];
  const r2 = PC.makePlan({ tasks: [t], blocks: done, routine: { start: '06:00', end: '22:00' }, prefs: [], today: MON, nowMin: 700, days: 7 });
  assert.equal(r2.blocks.filter(b => b.task_id === 'ex').length, 1);
  assert.equal(PC.describeRepeat(t.repeat), 'twice a week at 18:00');
});

test('suggested time: AI share slides from 60% to 30% with history', () => {
  assert.equal(PC.aiShare(0), 0.6); assert.equal(PC.aiShare(30), 0.3); assert.equal(PC.aiShare(100), 0.3);
  assert.ok(Math.abs(PC.aiShare(15) - 0.45) < 1e-9);
});
test('suggested time: with no history the AI time wins inside the first free day', () => {
  const r = PC.bestSlot({ blocks: [], routine: { start: '08:00', end: '22:00' }, prefs: [], today: MON, nowMin: 0, length: 60, history: [], aiMin: 17 * 60 });
  assert.equal(r.date, MON); assert.equal(r.start_min, 17 * 60); assert.ok(r.moved);
});
test('suggested time: lots of evening history outweighs a morning AI pick', () => {
  const history = Array.from({ length: 40 }, () => ({ start_min: 20 * 60, subject: null }));
  const r = PC.bestSlot({ blocks: [], routine: { start: '08:00', end: '22:00' }, prefs: [], today: MON, nowMin: 0, length: 60, history, aiMin: 8 * 60 });
  assert.ok(r.start_min >= 19 * 60, 'history wins: ' + r.start_min);
});
test('a day you name counts even if it is a day off', () => {
  const sat = PC.addDays(MON, 5);
  const r = PC.nextSlot({ blocks: [], routine: { start: '09:00', end: '22:00', daysOff: [6, 0] }, prefs: [], today: MON, nowMin: 0, length: 60, onDate: sat });
  assert.equal(r.date, sat);
  assert.notEqual(PC.nextSlot({ blocks: [], routine: { start: '09:00', end: '22:00', daysOff: [6, 0] }, prefs: [], today: sat, nowMin: 0, length: 60 }).date, sat);
});

test('"twice a week" with one day left this week books one, not two on that day', () => {
  const t = { id: 'ex', title: 'Exercise', status: 'open', est_minutes: 60, repeat: JSON.stringify({ days: [], per_week: 2, time: '18:00' }), deleted: 0 };
  const sat = PC.addDays(MON, 5), sun = PC.addDays(MON, 6);
  const r = PC.makePlan({ tasks: [t], blocks: [], routine: { start: '00:00', end: '23:59' }, prefs: [], today: sat, nowMin: 1120, days: 7 });
  assert.equal(r.blocks.filter(b => b.date === sun).length, 1);
});

console.log(`\nAll ${passed} scheduler checks passed.`);
