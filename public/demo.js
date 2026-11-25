// Demo mode: a week of sample data that lives only in this browser (its own storage key), no server and no AI.
// Journal entries written in the demo are read by simple rules on the device, so the journal -> plan loop still works.
'use strict';

// ---------- starting and leaving ----------

function startDemo() {
  STORE = 'pl.demo.v1';          // from here on nothing is written to the real account's storage
  data = blank();
  seedDemo();
  persist();
  try { localStorage.setItem('pl.demo', '1'); } catch {}
  location.replace('/');
}

function exitDemo() {
  try {
    for (const k of ['pl.demo', 'pl.demo.v1', 'pl.carry', 'pl.aitimes']) localStorage.removeItem(k);
  } catch {}
  location.replace('/');
}

// The few server calls the app makes, answered locally.
async function demoApi(path, opts = {}) {
  const p = path.split('?')[0];
  if (p === '/api/me') return { user: data.user, settings: data.settings };
  if (p === '/api/settings' && opts.method === 'PUT') {
    data.settings = { ...data.settings, ...opts.body };
    if (opts.body?.routine) data.settings.routine = PC.cleanRoutine(opts.body.routine);
    persist();
    return { settings: data.settings };
  }
  if (p === '/api/push/key') return { key: null, devices: 0 };
  if (/^\/api\/(extract|ask|times|plan)/.test(p)) throw new ApiError(400, 'The AI is switched off in the demo. Journal plans are still read on this device.');
  throw new ApiError(400, "That isn't available in the demo.");
}

// ---------- reading a journal entry without the AI ----------

const DEMO_DONE = /\b(finished|completed|done with|wrapped up|i did|studied|went to|attended)\b/i;
const DEMO_PREF = /\b(i (?:focus|work|study|think) best|i prefer|i like to|i'?m (?:a )?(?:morning|night) person)\b/i;
const DEMO_PLAN = /\b(want to|need to|have to|will|going to|plan to|should|remind|tomorrow|tommorow|today|tonight|every|daily|twice|times a week|next \d+ days|by (?:mon|tue|wed|thu|fri|sat|sun))|\bat \d|#/i;

function demoRead(entryId) {
  const e = data.entries[entryId];
  if (!e || e.deleted) return;
  writtenHere(entryId);
  const sents = e.body.split(/(?<=[.!?\n])\s+/).map(x => x.trim()).filter(x => x.length > 3);
  let i = 0;
  const add = (kind, d) => {
    const now = Date.now() + i++;
    const o = { id: crypto.randomUUID(), entry_id: entryId, kind, data: JSON.stringify(d), status: 'pending', source: 'ai', created_at: now, updated_at: now, deleted: 0 };
    data.observations[o.id] = o;
  };
  for (const s of sents) {
    const tag = (s.match(/#([\p{L}\p{N}_-]{1,40})/u) || [])[1];
    if (DEMO_PREF.test(s)) { add('preference', { text: s.replace(/[.!]+$/, '') }); continue; }
    if (DEMO_DONE.test(s) && !/\b(will|want|need|have to|tomorrow)\b/i.test(s)) {
      add('activity', { task: planTitle(s.replace(DEMO_DONE, '')) || 'Work', category: 'study', minutes: minutesInText(s), outcome: 'done', subject: tag?.toLowerCase() || null });
      continue;
    }
    if (!DEMO_PLAN.test(s)) continue;
    const rep = repeatInText(s);
    const d = { task: planTitle(s.replace(/[.!]+$/, '')), category: REMIND_RE.test(s) ? 'reminder' : 'study', subject: tag?.toLowerCase() || null };
    if (rep) d.repeat = rep; else { d.date = dateInText(s) || localDate(); const t = timeInText(s); if (t) d.time = t; }
    const m = minutesInText(s); if (m) d.minutes = m;
    if (d.category === 'reminder') d.task = s.replace(/[.!]+$/, '').replace(/^(also\s+)?remind me (?:of|about|to)\s+/i, '').replace(/\s+(today|tomorrow|tommorow|tonight)\b.*$/i, '');
    add('intention', d);
  }
  e.extracted_version = e.updated_at;
  persist();
  safeRender();
  if (!i) toast('Nothing to plan in that one. Try "Revise thermo tomorrow at 10" or "Gym twice a week at 6 pm".');
}

// ---------- the sample week ----------

function seedDemo() {
  const today = localDate(), day = n => PC.addDays(today, n), H = h => Math.round(h * 60);
  const now = Math.min(Math.max(new Date().getHours() * 60 + new Date().getMinutes(), 11 * 60), 20 * 60);
  const t0 = Date.now();
  data.user = { id: 'demo', username: 'demo' };
  data.settings = {
    ai_provider: null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    routine: PC.cleanRoutine({ start: '07:00', end: '23:00', maxMinutes: 360, session: 60, breakMin: 15, daysOff: [0], clock: 12,
      busy: [{ label: 'College', days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }], autoPlan: true, journalAuto: 'add', carry: true }),
    notify: { lead: 10, evening: '21:00', morning: null, weekly: true, todo: '08:00' },
  };
  const task = (f) => { const t = fresh({ goal: null, notes: null, category: 'study', est_minutes: 60, deadline: null, priority: 2, status: 'open',
    done_at: null, repeat: null, start_date: null, revise: null, subject: null, effort: null, habit: null, entry_id: null, ...f }); put('tasks', t); return t; };
  const block = (t, date, start, len, status = 'planned') => { put('blocks', fresh({ task_id: t.id, date, start_min: start, end_min: start + len, status,
    actual_minutes: status === 'done' ? len : null, started_at: null, reason: null })); };
  const entry = (n, at, body, energy) => { const id = crypto.randomUUID(), ts = Math.min(t0 - 6e4, new Date(day(-n) + 'T00:00:00').getTime() + at * 6e4);
    data.entries[id] = { id, body, entry_date: day(-n), energy, created_at: ts, updated_at: ts, deleted: 0, extracted_version: ts }; return id; };
  const obs = (entry_id, kind, d) => { const o = fresh({ entry_id, kind, data: JSON.stringify(d), status: 'confirmed', source: 'ai' }); put('observations', o); return o; };
  const exam = (name, n, subject) => { const x = fresh({ name, date: day(n), subject, status: 'upcoming', note: null }); put('exams', x); return x; };

  const thermo = exam('Thermodynamics end sem', 9, 'thermo');
  exam('Machine Design quiz', 4, 'md');

  // Thermodynamics: 4 cycles split from one entry, plus revision on the eve of the exam.
  const e1 = entry(0, H(7.9), 'Thermo end sem is in 9 days. Study #thermo cycles: Rankine, Brayton, Otto and Diesel, Refrigeration in the next 4 days. A cycle takes about an hour.', 3);
  const cyc = ['Rankine cycle', 'Brayton cycle', 'Otto and Diesel cycles', 'Refrigeration cycles'].map(title =>
    task({ goal: thermo.name, title, subject: 'thermo', deadline: day(3), entry_id: e1, effort: 3 }));
  const rev = task({ goal: thermo.name, title: 'Revise all THERMO topics', subject: 'thermo', est_minutes: 45, deadline: day(8), entry_id: e1 });
  block(cyc[0], today, now - 150, 60, 'done');
  block(cyc[1], today, now + 20, 60);
  block(cyc[2], day(1), H(14), 60);
  block(cyc[3], day(2), H(14), 60);
  block(rev, day(8), H(19), 45);
  obs(e1, 'intention', { task: 'Study thermo cycles', category: 'study', subject: 'thermo', task_id: 'split', split_ids: [...cyc.map(t => t.id), rev.id],
    exam_id: thermo.id, per: 60, parts_n: 4, revision: true, date: today });

  // Gym twice a week (a habit with weekly streaks) and a birthday reminder.
  const e2 = entry(0, H(7.6), 'Gym twice a week at 6 pm. Also remind me of Riya\'s birthday tomorrow.', 2);
  const gym = task({ title: 'Gym', category: 'exercise', repeat: JSON.stringify({ days: [], per_week: 2, time: '18:00' }), est_minutes: 60, entry_id: e2,
    habit: JSON.stringify({ changes: [{ from: day(-27), kind: 'flex', days: [], per_week: 2, count: 1, unit: '' }], paused: [] }) });
  for (const n of [-2, -6, -8, -13, -15, -20, -22]) { put('habit_logs', fresh({ task_id: gym.id, date: day(n), amount: 1 })); block(gym, day(n), H(18), 60, 'done'); }
  block(gym, day(2), H(18), 60);
  const bday = task({ title: "Riya's birthday", category: 'reminder', est_minutes: 15, deadline: day(1), priority: 1, entry_id: e2 });
  block(bday, day(1), H(8), 15);
  obs(e2, 'intention', { task: 'Gym', category: 'exercise', repeat: { days: [], per_week: 2, time: '18:00' }, task_id: gym.id });
  obs(e2, 'intention', { task: "Riya's birthday", category: 'reminder', date: day(1), time: '08:00', task_id: bday.id });

  // Water: a daily count habit.
  const water = task({ title: 'Water', category: 'other', est_minutes: 5,
    habit: JSON.stringify({ changes: [{ from: day(-20), kind: 'daily', days: [], per_week: null, count: 8, unit: 'glasses' }], paused: [] }) });
  for (let n = 1; n <= 11; n++) put('habit_logs', fresh({ task_id: water.id, date: day(-n), amount: 8 }));
  for (let k = 0; k < 3; k++) put('habit_logs', fresh({ task_id: water.id, date: today, amount: 1 }));

  // Machine Design: one plan with two sessions, one of them later today.
  const e3 = entry(2, H(21.5), 'Gears numericals for the #md quiz, 2 hrs over the next 2 days.', 2);
  const gears = task({ title: 'Gears numericals', subject: 'md', est_minutes: 120, deadline: day(3), entry_id: e3, effort: 3 });
  block(gears, today, Math.min(now + 100, H(21.5)), 60);
  block(gears, day(1), H(16), 60);
  obs(e3, 'intention', { task: 'Gears numericals', category: 'study', subject: 'md', minutes: 120, date: day(1), task_id: gears.id });

  // The last few days: finished work, so Week and "By subject" have something to show.
  const e4 = entry(1, H(22), 'Finished the Rankine cycle notes, took about an hour. I focus best in the morning.', 3);
  obs(e4, 'activity', { task: 'Rankine cycle notes', category: 'study', minutes: 60, outcome: 'done' });
  obs(e4, 'preference', { text: 'Focuses best in the morning' });
  const e5 = entry(3, H(21), 'Lab report done. Long day at college.', 1);
  const lab = task({ title: 'Heat transfer lab report', subject: 'lab', est_minutes: 90, status: 'done', done_at: t0 - 3 * 864e5 });
  block(lab, day(-3), H(15), 90, 'done');
  obs(e5, 'activity', { task: 'Heat transfer lab report', category: 'study', minutes: 90, outcome: 'done', task_id: lab.id });
  entry(5, H(22.5), 'Slow day. Watched lectures, nothing planned got done.', 1);
  const past = [[-1, 'thermo', 'First law problems', 75], [-1, 'md', 'Shaft design', 60], [-2, 'thermo', 'Entropy notes', 60], [-4, 'md', 'Bearings', 45], [-4, 'thermo', 'PYQs 2023', 90], [-5, 'lab', 'Lab readings', 30]];
  for (const [n, subject, title, len] of past) { const t = task({ title, subject, est_minutes: len, status: 'done', done_at: t0 + n * 864e5 }); block(t, day(n), H(15.5), len, 'done'); }
  const id = crypto.randomUUID();
  data.prefs[id] = { id, text: 'Focuses best in the morning', rule_json: null, created_at: t0, updated_at: t0, deleted: 0 };

  // Nothing here is waiting to go to a server.
  for (const k of Object.keys(data.dirty)) data.dirty[k] = [];
  try { localStorage.setItem('pl.carry', today); } catch {}
}

// ---------- wiring ----------

document.addEventListener('click', e => {
  if (e.target.closest('[data-demo="start"]')) { e.preventDefault(); startDemo(); }
  if (e.target.closest('[data-demo="exit"]')) { e.preventDefault(); exitDemo(); }
});
if (DEMO) document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('demo');
  document.body.insertAdjacentHTML('afterbegin', '<div class="demo-bar" role="status"><span><b>Demo</b> · sample data, kept only in this browser</span><button class="link" data-demo="exit">Exit demo</button></div>');
});
