// Habit streak rules. node test/habits.test.mjs
import assert from 'node:assert/strict';
import '../public/planner-core.js';
const PC = globalThis.PlannerCore;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };
// 2026-11-13 is a Friday. Weeks start Monday 2026-11-09.
const TODAY = '2026-11-13';
const day = n => PC.addDays(TODAY, n);
const logs = (...ds) => ds.map(d => ({ date: d, amount: 1 }));
const habit = (step, paused = []) => JSON.stringify({ changes: [{ from: '2026-10-01', ...step }], paused });
const st = (h, l, o = {}) => PC.habitStats({ habit: h, logs: l, today: TODAY, nowMin: 600, ...o });

test('daily: today not done yet does not break the streak', () => {
  const s = st(habit({ kind: 'daily' }), logs(day(-1), day(-2), day(-3)));
  assert.equal(s.streak, 3); assert.equal(s.atRisk, false);
});
test('daily: streak at risk only in the evening', () => {
  assert.equal(st(habit({ kind: 'daily' }), logs(day(-1)), { nowMin: 19 * 60 }).atRisk, true);
});
test('daily: a missed day breaks it, done today adds one', () => {
  assert.equal(st(habit({ kind: 'daily' }), logs(day(0), day(-1), day(-3))).streak, 2);
});
test('daily: days off from settings do not break it', () => {
  // Sat 7 + Sun 8 are off.
  const s = st(habit({ kind: 'daily' }), logs('2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09', '2026-11-06'), { daysOff: [0, 6] });
  assert.equal(s.streak, 5);
});
test('set days: other days are dots, not misses', () => {
  // Mon Wed Fri. Done Mon 9, Wed 11; today Fri not done yet; last week Fri 6 done.
  const s = st(habit({ kind: 'days', days: [1, 3, 5] }), logs('2026-11-09', '2026-11-11', '2026-11-06', '2026-11-04', '2026-11-02'));
  assert.equal(s.streak, 5);
  assert.equal(s.ticks.find(t => t.date === '2026-11-10').state, 'off');
  assert.equal(s.ticks.at(-1).state, 'today');
});
test('flex: weeks in a row; this week counts once met', () => {
  const h = habit({ kind: 'flex', per_week: 3 });
  const past = logs('2026-11-02', '2026-11-04', '2026-11-06', '2026-10-27', '2026-10-28', '2026-10-30');
  assert.equal(st(h, past).streak, 2);
  const s = st(h, [...past, ...logs('2026-11-09', '2026-11-10', '2026-11-12')]);
  assert.equal(s.streak, 3); assert.equal(s.weekDone, 3);
});
test('flex: at risk when the days left equal what is still needed', () => {
  const h = habit({ kind: 'flex', per_week: 3 });
  const s = st(h, logs('2026-11-09'));      // 1 of 3, Fri Sat Sun left = 3 days, need 2 → fine
  assert.equal(s.atRisk, false); assert.equal(s.daysLeft, 3);
  const s2 = PC.habitStats({ habit: h, logs: logs('2026-11-09'), today: '2026-11-14', nowMin: 600 }); // Sat: need 2, 2 left
  assert.equal(s2.atRisk, true);
});
test('flex: a week below target breaks it, only after it ends', () => {
  const h = habit({ kind: 'flex', per_week: 3 });
  assert.equal(st(h, logs('2026-11-02', '2026-11-04', '2026-10-27', '2026-10-28', '2026-10-30')).streak, 0);
});
test('count habit: done only when the count is reached; logs from two devices add up', () => {
  const h = habit({ kind: 'daily', count: 8, unit: 'glasses' });
  const l = [{ date: TODAY, amount: 1 }, { date: TODAY, amount: 1 }, { date: day(-1), amount: 8 }];
  const s = st(h, l);
  assert.equal(s.amount, 2); assert.equal(s.todayDone, false); assert.equal(s.streak, 1);
});
test('paused days neither count nor break', () => {
  const h = habit({ kind: 'daily' }, [{ from: day(-4), to: day(0) }]);
  assert.equal(st(h, logs(day(-5), day(-6))).streak, 2);
});
test('schedule change keeps old weeks on the old target', () => {
  const h = JSON.stringify({ changes: [{ from: '2026-10-01', kind: 'flex', per_week: 2 }, { from: '2026-11-09', kind: 'flex', per_week: 4 }] });
  assert.equal(st(h, logs('2026-11-02', '2026-11-03')).streak, 1);
});
test('best streak and 30-day rate', () => {
  const s = st(habit({ kind: 'daily' }), logs(day(-1), day(-2), day(-10), day(-11), day(-12), day(-13)));
  assert.equal(s.best, 4); assert.ok(s.rate30.of >= 30 - 1);
});
test('before the habit started is not a miss', () => {
  const h = JSON.stringify({ changes: [{ from: day(-2), kind: 'daily' }] });
  const s = st(h, logs(day(-1), day(-2)));
  assert.equal(s.streak, 2); assert.equal(s.ticks[0].state, 'before');
});
console.log(`\n${passed} habit checks passed`);
