// Update 5: exam countdowns, carry-over of missed sessions, voice journal, "Ask your journal", and habits.
'use strict';

const HB_UNIT = s => (s.unit ? s.unit : s.count > 1 ? 'times' : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const DAY2 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- exams ----------

const examRows = () => liveRows('exams').sort((a, b) => a.date.localeCompare(b.date));
const examsOn = d => examRows().filter(x => x.date === d);
const daysTo = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(localDate() + 'T00:00:00Z')) / 864e5);
const subjOf = x => (x.subject || '').toLowerCase().replace(/^#/, '');

// Hours put in for an exam: finished sessions of tasks with its subject, since it was added.
function examHours(x) {
  const s = subjOf(x);
  if (!s) return null;
  const since = new Date(x.created_at - 864e5 * 60).toLocaleDateString('en-CA');
  let done = 0, planned = 0;
  const today = localDate();
  for (const b of liveRows('blocks')) {
    const t = data.tasks[b.task_id];
    if (!t || t.subject !== s || b.date > x.date) continue;
    if (b.status === 'done' && b.date >= since) done += b.actual_minutes ?? blen(b);
    if (b.status === 'planned' && b.date >= today) planned += blen(b);
  }
  return { done, planned };
}

function renderExamStrip() {
  const box = $('#exams-strip');
  if (!box) return;
  const today = localDate();
  const rows = examRows().filter(x => x.status === 'upcoming' && daysTo(x.date) <= 120);
  box.hidden = !rows.length;
  box.innerHTML = rows.map(x => {
    const n = daysTo(x.date), h = examHours(x);
    const hrs = h ? `<span class="mono muted">${dur(h.done) || '0m'} done${h.planned ? ` · ${dur(h.planned)} planned` : ''}</span>` : '';
    if (x.date < today) {
      return `<div class="ex-card ask" data-xid="${esc(x.id)}"><p class="ex-name">${esc(x.name)} <span class="muted">· ${esc(dayLabel(x.date))}</span></p>
        <p class="small">How did it go?</p>
        <input class="ex-note" maxlength="300" placeholder="One line, optional">
        <div class="row"><button class="primary" data-ex="done">Mark done</button><button class="bare" data-ex="del">Delete</button></div></div>`;
    }
    return `<div class="ex-card${n <= 7 ? ' soon' : ''}" data-xid="${esc(x.id)}">
      <span class="ex-days disp">${n === 0 ? 'Today' : n}</span><span class="ex-unit mono">${n === 0 ? '' : n === 1 ? 'day' : 'days'}</span>
      <span class="ex-body"><span class="ex-name">${esc(x.name)}</span>${hrs}</span></div>`;
  }).join('');
}

function renderExams() {
  const box = $('#exams');
  if (!box) return;
  const rows = examRows(), up = rows.filter(x => x.status === 'upcoming'), done = rows.filter(x => x.status === 'done');
  const subjects = [...new Set(liveRows('tasks').map(t => t.subject).filter(Boolean))];
  box.innerHTML = `${up.length ? up.map(x => `<div class="ex-row" data-xid="${esc(x.id)}"><span class="main">${esc(x.name)}</span>
      <span class="sub"><span class="mono muted">${esc(dayLabel(x.date))}</span>${x.subject ? `<span class="chip">#${esc(subjOf(x))}</span>` : ''}<button class="bare" data-ex="del" aria-label="Delete">✕</button></span></div>`).join('')
    : '<p class="muted small">None yet. Add one to see a countdown on Today and a marker on the Calendar.</p>'}
    <div class="ex-add">
      <input id="ex-name" maxlength="80" placeholder="Exam, e.g. Thermo end sem" aria-label="Exam">
      <div class="ex-add-row"><input id="ex-date" type="date" aria-label="Date"><input id="ex-subj" list="ex-subjects" maxlength="40" placeholder="#subject (optional)" aria-label="Subject"></div>
      <datalist id="ex-subjects">${subjects.map(x => `<option value="#${esc(x)}">`).join('')}</datalist>
      <button type="button" class="primary" data-ex="add">Add exam</button>
    </div>
    ${done.length ? `<details class="ex-done"><summary class="lbl">Completed · ${done.length}</summary>${done.map(x => {
      const h = examHours(x);
      return `<div class="ex-row"><span class="main">${esc(x.name)}</span><span class="sub"><span class="mono muted">${esc(dayLabel(x.date))}${h ? ` · ${dur(h.done) || '0m'} put in` : ''}</span></span>${x.note ? `<p class="small muted">${esc(x.note)}</p>` : ''}</div>`;
    }).join('')}</details>` : ''}`;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-ex]');
  if (!btn) return;
  const act = btn.dataset.ex, x = data.exams[btn.closest('[data-xid]')?.dataset.xid];
  if (act === 'add') {
    const name = $('#ex-name').value.trim(), date = $('#ex-date').value;
    if (!name || !date) { toast('Give the exam a name and a date.'); return; }
    const subject = $('#ex-subj').value.trim().replace(/^#/, '').toLowerCase() || null;
    put('exams', fresh({ name: name.slice(0, 80), date, subject, status: 'upcoming', note: null }));
    toast(`Added "${name}".`);
  }
  if (act === 'done' && x) {
    const note = btn.closest('.ex-card')?.querySelector('.ex-note')?.value.trim() || null;
    Object.assign(x, { status: 'done', note: note && note.slice(0, 300) }); put('exams', x);
    toast(`"${x.name}" is done. Well played.`);
  }
  if (act === 'del' && x) {
    const before = { ...x };
    x.deleted = 1; put('exams', x);
    toast(`Removed "${x.name}".`, 'Undo', () => { put('exams', { ...before, deleted: 0, updated_at: data.exams[x.id].updated_at }); persist(); renderExams(); renderExamStrip(); sync(); });
  }
  persist(); renderExams(); renderExamStrip(); sync();
});

// ---------- carry-over ----------

// Each morning, sessions you didn't get to in the last 3 days move into today's free time.
// "Move it" still works on them afterwards.
function carryOver() {
  const r = PC.cleanRoutine(data.settings?.routine), today = localDate();
  try { if (localStorage.getItem('pl.carry') === today) return; localStorage.setItem('pl.carry', today); } catch {}
  keepRepeats();
  if (!r.carry) return;
  const from = PC.addDays(today, -3);
  const late = liveRows('blocks').filter(b => b.status === 'planned' && !b.started_at && b.date < today && b.date >= from)
    .filter(b => { const t = data.tasks[b.task_id]; return t && !t.deleted && t.status === 'open' && !t.repeat && !t.habit; })
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  const moved = [];
  for (const b of late) {
    const slot = PC.nextSlot({ blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'), today, nowMin: nowMin(), length: blen(b), skipId: b.id });
    if (!slot || slot.date !== today) continue;
    moved.push({ ...b });
    Object.assign(b, slot);
    put('blocks', b);
  }
  if (!moved.length) return;
  persist(); sync(); safeRender();
  toast(moved.length === 1 ? `Moved "${taskTitle(moved[0])}" from ${dayLabel(moved[0].date)} to ${hm(data.blocks[moved[0].id].start_min)} today.` : `Moved ${moved.length} missed sessions into today.`, 'Undo', () => {
    for (const b of moved) put('blocks', { ...b, updated_at: data.blocks[b.id].updated_at });
    persist(); sync(); safeRender();
  });
}

// Repeating tasks keep a week of sessions ahead: each day the next 7 days are topped up
// (set days get their session, "twice a week" gets its two). Same ids on every device, so no doubles.
function keepRepeats() {
  let n = 0;
  for (const t of liveRows('tasks')) if (t.repeat && t.status === 'open') n += placeRepeating(t);
  n += timeReminders();
  if (n) { persist(); sync(); safeRender(); }
  return n;
}

// ---------- voice journal ----------

(function voice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition, btn = $('#mic');
  if (!SR || !btn) return;
  btn.hidden = false;
  let rec = null, base = '', userStop = false;
  btn.addEventListener('click', () => {
    if (rec) { userStop = true; rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || 'en-IN';
    rec.continuous = true; rec.interimResults = true;
    const box = $('#composer');
    base = box.value ? box.value.replace(/\s*$/, ' ') : '';
    userStop = false;
    rec.onresult = ev => {
      let fin = '', mid = '';
      for (const r of ev.results) (r.isFinal ? (fin += r[0].transcript) : (mid += r[0].transcript));
      box.value = base + fin + mid;
      box.dispatchEvent(new Event('input'));
    };
    rec.onerror = ev => { if (ev.error === 'not-allowed') toast('Allow the microphone for this site to speak your notes.'); };
    rec.onend = () => {
      rec = null; btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false');
      // Tapping stop saves it, so it goes on to become plans and notes like a typed entry.
      if (userStop && $('#composer').value.trim()) $('#save-entry').click();
    };
    rec.start();
    btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
    buzz();
  });
})();

// ---------- ask your journal ----------

const ASK_STOP = new Set('a an the i my me of to for on in at and or did do does was were is are what when where how many much long last this that with have has had about from by it its any'.split(' '));
const keyWords = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s#]/gu, ' ').split(/\s+/).map(w => w.replace(/^#/, '')).filter(w => w.length > 2 && !ASK_STOP.has(w));

async function askJournal() {
  const q = $('#search').value.trim(), out = $('#ask-card');
  if (!q) { $('#search').focus(); toast('Type a question in the box, then tap Ask.'); return; }
  const words = keyWords(q);
  const hit = text => { const t = String(text || '').toLowerCase(); return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0); };
  const entries = liveRows('entries').filter(e => !e._locked && e.body)
    .map(e => ({ e, s: hit(e.body) })).sort((a, b) => b.s - a.s || b.e.entry_date.localeCompare(a.e.entry_date));
  const picked = (entries.some(x => x.s) ? entries.filter(x => x.s) : entries).slice(0, 40).map(x => ({ id: x.e.id, date: x.e.entry_date, text: x.e.body }));
  const since = PC.addDays(localDate(), -180);
  let sessions = liveRows('blocks').filter(b => b.status === 'done' && b.date >= since).map(b => {
    const t = data.tasks[b.task_id];
    return { date: b.date, title: t?.title || '', subject: t?.subject || '', minutes: b.actual_minutes ?? blen(b) };
  });
  const rel = sessions.filter(x => hit(x.title + ' ' + x.subject));
  if (rel.length) sessions = rel;
  sessions = sessions.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 400);
  out.hidden = false;
  out.innerHTML = '<p class="muted small">Reading your journal…</p>';
  try {
    const r = await api('/api/ask', { method: 'POST', body: { question: q, today: localDate(), entries: picked, sessions } });
    out.innerHTML = `<p class="lbl">Answer</p><p class="ask-a">${esc(r.answer)}</p>
      ${r.used?.length ? `<p class="small muted">From ${r.used.map(id => data.entries[id] ? `<button class="link" data-askgo="${esc(id)}">${esc(dayLabel(data.entries[id].entry_date))}</button>` : '').join(' · ')}</p>` : ''}
      <button class="bare small" data-askgo="close">Close</button>`;
  } catch (err) {
    out.innerHTML = `<p class="small">${esc(err.message === 'Failed to fetch' ? 'You need internet to ask.' : err.message)}</p>`;
  }
}

$('#ask-btn')?.addEventListener('click', askJournal);
$('#ask-card')?.addEventListener('click', e => {
  const id = e.target.closest('[data-askgo]')?.dataset.askgo;
  if (!id) return;
  if (id === 'close') { $('#ask-card').hidden = true; return; }
  const en = data.entries[id];
  if (!en) return;
  $('#search').value = ''; openDays.add(en.entry_date); renderEntries();
  const el = document.querySelector(`.entry[data-id="${CSS.escape(id)}"]`);
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
});

// ---------- habits ----------

const habitLogs = taskId => liveRows('habit_logs').filter(l => l.task_id === taskId);
function habitInfo(t) {
  if (!t?.habit || t.deleted) return null;
  return PC.habitStats({ habit: t.habit, logs: habitLogs(t.id), today: localDate(), nowMin: nowMin(), daysOff: PC.cleanRoutine(data.settings?.routine).daysOff });
}
function habitAdd(t, date, n) {
  if (date > localDate()) return;
  put('habit_logs', fresh({ task_id: t.id, date, amount: Math.max(1, Math.min(1000, n)) }));
}
function habitClear(t, date) {
  for (const l of habitLogs(t.id)) if (l.date === date) { l.deleted = 1; put('habit_logs', l); }
}
// Fill a day to its target (a habit session marked done).
function habitFill(taskId, date) {
  const t = data.tasks[taskId], s = habitInfo(t);
  if (!s) return;
  const have = habitLogs(taskId).filter(l => l.date === date).reduce((n, l) => n + l.amount, 0);
  if (have < s.count) habitAdd(t, date, s.count - have);
}

function habitCaption(s) {
  if (s.paused) return 'Paused';
  if (s.atRisk) return s.kind === 'flex' ? `${s.weekDone} of ${s.weekTarget} this week · do it today` : 'Do it today to keep the streak';
  if (s.count > 1 && !s.todayDone) return `${s.amount} of ${s.count}${s.unit ? ' ' + esc(s.unit) : ''} today`;
  if (s.kind === 'flex') return `${s.weekDone} of ${s.weekTarget} this week${s.weekDone < s.weekTarget ? ` · ${plural(s.daysLeft, 'day')} left` : ' · done'}`;
  if (s.kind === 'days') return s.days.map(d => DAY2[d]).sort((a, b) => DAY2.indexOf(a) - DAY2.indexOf(b)).join(' · ');
  return s.todayDone ? 'Done today' : 'Every day';
}

function tickHtml(t, tk, streakFrom) {
  const cls = tk.state === 'done' ? (tk.date >= streakFrom ? 'done cur' : 'done') : tk.state;
  const fill = tk.state === 'today' && tk.target > 1 ? Math.min(1, tk.amount / tk.target) : 0;
  const label = `${dayLabel(tk.date)}: ${tk.state === 'done' ? 'done' : tk.state === 'miss' ? 'missed' : tk.state === 'today' ? `${tk.amount} of ${tk.target}` : tk.state === 'paused' ? 'paused' : 'not planned'}`;
  return `<button class="hb-t ${cls}" data-hb="tick" data-tid="${esc(t.id)}" data-date="${tk.date}" style="--f:${fill}" aria-label="${esc(label)}" title="${esc(label)}"></button>`;
}

function habitStrip(t, s = habitInfo(t)) {
  if (!s) return '';
  // Where the current run started, so those ticks can be brighter than older done days.
  let from = '9999';
  if (s.streak) {
    if (s.streakUnit === 'week') from = PC.addDays(PC.weekStart(localDate()), -7 * (s.streak - (s.weekDone >= s.weekTarget ? 1 : 0)));
    else { let n = s.streak; for (let i = s.ticks.length - 1; i >= 0 && n > 0; i--) { if (s.ticks[i].state === 'done') { from = s.ticks[i].date; n--; } } }
  }
  return `<div class="hb${s.atRisk ? ' risk' : ''}">
    <div class="hb-l"><div class="hb-ticks${s.kind === 'flex' ? ' week' : ''}">${stripTicks(s).map(tk => tk.state === 'future' ? `<i class="hb-t future" title="${esc(dayLabel(tk.date))}"></i>` : tickHtml(t, tk, from)).join('')}</div><p class="hb-cap mono${s.atRisk ? ' amber' : ''}">${habitCaption(s)}</p></div>
    <button class="hb-n" data-hb="hist" data-tid="${esc(t.id)}" aria-label="History">${s.streak
      ? `<span class="disp${s.atRisk ? ' amber' : ''}">${s.streak}</span><span class="mono">${s.streakUnit === 'week' ? (s.streak === 1 ? 'week' : 'weeks in a row') : 'day streak'}</span>`
      : '<span class="hb-start">Start a streak</span><span class="mono">history ›</span>'}</button>
  </div>`;
}

// "Times a week" habits show just this week, Monday to Sunday; the others show the last 2 weeks.
function stripTicks(s) {
  if (s.kind !== 'flex') return s.ticks;
  const ws = PC.weekStart(localDate());
  return Array.from({ length: 7 }, (_, i) => { const d = PC.addDays(ws, i); return s.ticks.find(x => x.date === d) || { date: d, state: 'future' }; });
}

// The main button on a count habit's card: "+1 glass".
function habitPlusBtn(t, s = habitInfo(t)) {
  if (!s || s.count < 2) return '';
  // "glasses" -> "glass", "pages" -> "page", "reps" -> "rep"
  const u = s.unit ? s.unit.replace(/(ss|sh|ch|x)es$/i, '$1').replace(/([^s])s$/i, '$1') : '';
  return `<button class="primary" data-hb="plus" data-tid="${esc(t.id)}">+1${u ? ' ' + esc(u) : ''}</button>`;
}

// Habits with nothing on the clock today still show on Today, under Up next.
function renderTodayHabits() {
  const box = $('#today-habits');
  if (!box) return;
  const today = localDate();
  const withBlock = new Set(liveRows('blocks').filter(b => b.date === today).map(b => b.task_id));
  const rows = liveRows('tasks').filter(t => t.habit && t.status === 'open' && !withBlock.has(t.id)).map(t => ({ t, s: habitInfo(t) }))
    .filter(({ s }) => s && !s.paused && (s.kind === 'flex' ? s.weekDone < s.weekTarget || s.todayDone : s.ticks.at(-1).scheduled || s.todayDone));
  // Reminders due today (a birthday, a call) sit here too, with a Done button. No session, no clock time.
  const rem = liveRows('tasks').filter(t => t.category === 'reminder' && t.deadline === today && !withBlock.has(t.id) && (t.status === 'open' || (t.done_at && new Date(t.done_at).toLocaleDateString('en-CA') === today)));
  const remHtml = rem.length ? `<p class="lbl">Reminders today</p><div class="list rem-list">${rem.map(t => `<div class="li-row rem${t.status === 'done' ? ' done' : ''}" data-tid="${esc(t.id)}">
    <div class="li-main"><span class="li-time disp">${t.status === 'done' ? '✓' : '🔔'}</span><span class="li-body"><span class="li-title">${esc(t.title)}</span></span></div>
    <div class="li-acts">${t.status === 'done' ? `<button class="bare" data-rem="undo" data-tid="${esc(t.id)}">↺ Undo</button>` : `<button class="primary" data-rem="done" data-tid="${esc(t.id)}">Done</button>`}</div></div>`).join('')}</div>` : '';
  box.hidden = !rows.length && !rem.length;
  box.innerHTML = remHtml + (rows.length ? `<p class="lbl">Habits today</p><div class="list">${rows.map(({ t, s }) => `<div class="li-row hab${s.todayDone ? ' done' : ''}" data-tid="${esc(t.id)}">
    <div class="li-main"><span class="li-time disp hab-mark">${s.todayDone ? '✓' : '↻'}</span><span class="li-body"><span class="li-title">${esc(t.title)}</span><span class="li-meta">${s.count > 1 ? `${s.count} ${esc(HB_UNIT(s))}` : ''}</span></span></div>
    <div class="li-acts">${s.count > 1 ? habitPlusBtn(t, s) : ''}${s.todayDone ? `<button class="bare" data-hb="undo" data-tid="${esc(t.id)}">↺ Undo</button>` : `<button${s.count > 1 ? '' : ' class="primary"'} data-hb="done" data-tid="${esc(t.id)}">Done</button>`}</div>
    ${habitStrip(t, s)}</div>`).join('')}</div>` : '');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-rem]');
  if (!b) return;
  const t = data.tasks[b.dataset.tid];
  if (!t) return;
  if (b.dataset.rem === 'done') Object.assign(t, { status: 'done', done_at: Date.now() });
  else Object.assign(t, { status: 'open', done_at: null });
  put('tasks', t); persist(); sync(); renderToday(); buzz();
});

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-hb]');
  if (!btn) return;
  const t = data.tasks[btn.dataset.tid];
  if (!t) return;
  const act = btn.dataset.hb, today = localDate();
  if (act === 'hist') { openHabitHistory(t); return; }
  if (act === 'plus') { habitAdd(t, today, 1); buzz(); const s = habitInfo(t); if (s.todayDone && s.amount === s.count) toast(`${t.title}: done for today.`); }
  if (act === 'done') { habitFill(t.id, today); buzz(); }
  if (act === 'undo') {
    // Takes back the last +1 (or the whole day when it was one tap).
    const last = habitLogs(t.id).filter(l => l.date === today).sort((a, b) => b.created_at - a.created_at)[0];
    if (last) { last.deleted = 1; put('habit_logs', last); }
  }
  if (act === 'tick') {
    // Fill in a day you forgot to log, or take it back. Future days can't be ticked.
    const d = btn.dataset.date, s = habitInfo(t);
    if (!d || d > today) return;
    const tk = s.ticks.find(x => x.date === d);
    if (tk?.state === 'before') return;
    if (tk?.done) habitClear(t, d);
    else habitFill(t.id, d);
    toast(tk?.done ? `${dayLabel(d)} cleared.` : `${dayLabel(d)} marked done.`);
  }
  persist(); sync();
  renderToday();
  if (!$('#view-plan').hidden) renderPlan();
  if ($('.hb-sheet')) openHabitHistory(t);
});

function openHabitHistory(t) {
  const s = habitInfo(t);
  if (!s) return;
  const h = PC.cleanHabit(t.habit), today = localDate();
  const amounts = {};
  for (const l of habitLogs(t.id)) amounts[l.date] = (amounts[l.date] || 0) + l.amount;
  const daysOff = PC.cleanRoutine(data.settings?.routine).daysOff;
  // A month per row, newest first, back to when the habit started (at most 12 months).
  const months = [];
  let m = today.slice(0, 7);
  while (months.length < 12 && m >= h.changes[0].from.slice(0, 7)) {
    const [y, mo] = m.split('-').map(Number), last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const ticks = [];
    for (let d = 1; d <= last; d++) {
      const iso = `${m}-${String(d).padStart(2, '0')}`;
      ticks.push(iso > today ? '<i class="hb-t future"></i>' : `<i class="hb-t ${PC.habitDay(h, amounts, iso, today, daysOff).state}" title="${esc(dayLabel(iso))}"></i>`);
    }
    months.push(`<div class="hb-month"><span class="lbl">${new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })}</span><div class="hb-ticks">${ticks.join('')}</div></div>`);
    m = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
  }
  const rate = r => r ? `${Math.round((r.done / r.of) * 100)}%` : '–';
  const unitWord = s.streakUnit === 'week' ? 'weeks' : 'days';
  const firstLog = Object.keys(amounts).sort()[0];
  const activeDays = Object.values(amounts).filter(Boolean).length;
  const events = [...h.changes.map((c, i) => ({ d: c.from, t: i ? `Changed to ${describeHabit(c)}` : `Started: ${describeHabit(c)}` })),
    ...h.paused.map(p => ({ d: p.from, t: `Paused${p.to ? ` until ${dayLabel(p.to)}` : ''}` }))].sort((a, b) => b.d.localeCompare(a.d));
  document.querySelector('.hb-sheet')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="hb-sheet" role="dialog" aria-label="Habit history"><div class="card">
    <div class="hb-head"><h2>${esc(t.title)}</h2><button class="bare" data-hbs="close" aria-label="Close">✕</button></div>
    <div class="hb-stats">
      <div><span class="disp">${s.best}</span><span class="mono">best ${unitWord}</span></div>
      <div><span class="disp good">${s.streak}</span><span class="mono">now</span></div>
      <div><span class="disp">${rate(s.rate30)}</span><span class="mono">${s.streakUnit === 'week' ? 'last 4 wks' : 'last 30 days'}</span></div>
      <div><span class="disp">${rate(s.rate90)}</span><span class="mono">${s.streakUnit === 'week' ? 'last 13 wks' : 'last 90 days'}</span></div>
    </div>
    ${s.streakUnit === 'week' && s.rate90 ? `<p class="small muted">${s.rate90.done} of ${s.rate90.of} weeks on target.</p>` : ''}
    ${s.count > 1 && firstLog ? `<p class="small">${s.total.toLocaleString('en-IN')} ${esc(HB_UNIT(s))} since ${esc(dayLabel(firstLog))} · about ${Math.round(s.total / Math.max(1, activeDays))} a day when you log</p>` : ''}
    <div class="hb-months">${months.join('')}</div>
    <div class="hb-legend mono"><span><i class="hb-t done"></i>done</span><span><i class="hb-t miss"></i>missed</span><span><i class="hb-t off"></i>not planned</span><span><i class="hb-t paused"></i>paused</span></div>
    ${events.length ? `<ul class="hb-events">${events.map(x => `<li><span class="mono muted">${esc(dayLabel(x.d))}</span> ${esc(x.t)}</li>`).join('')}</ul>` : ''}
    <div class="row"><button data-hbs="pause" data-tid="${esc(t.id)}">${s.paused ? 'Resume habit' : 'Pause habit'}</button></div>
  </div></div>`);
}

document.addEventListener('click', e => {
  const sheet = e.target.closest('.hb-sheet');
  if (!sheet) return;
  const btn = e.target.closest('[data-hbs]');
  if (e.target === sheet || btn?.dataset.hbs === 'close') { sheet.remove(); return; }
  if (btn?.dataset.hbs === 'pause') {
    const t = data.tasks[btn.dataset.tid];
    t.habit = JSON.stringify(togglePause(PC.cleanHabit(t.habit)));
    put('tasks', t); persist(); sync(); renderToday();
    toast(habitInfo(t).paused ? 'Paused. Missed days won\'t count until you resume.' : 'Resumed.');
    openHabitHistory(t);
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelector('.hb-sheet')?.remove(); });

function togglePause(h) {
  const today = localDate(), open = h.paused.find(p => !p.to);
  if (open) { if (open.from === today) h.paused = h.paused.filter(p => p !== open); else open.to = today; }
  else h.paused.push({ from: today, to: null });
  return h;
}

function describeHabit(c) {
  const n = c.count > 1 ? `, ${c.count} ${c.unit || 'times'} a day` : '';
  if (c.kind === 'flex') return `${c.per_week} days a week${n}`;
  if (c.kind === 'days') return c.days.map(d => DAY2[d]).join(' · ') + n;
  return 'every day' + n;
}

// ---------- "How often": one control for repeats and habits ----------
// Used by the task editor and by Fix on a journal plan. Once / Every day / Set days / N times a week,
// the usual time, and (in the task editor) a "Show streak" switch with an optional daily count.
const HO_KINDS = [['once', 'Once'], ['daily', 'Daily'], ['days', 'Set days'], ['flex', 'Per week']];
function repKind(rep) { return !rep ? 'once' : rep.per_week ? 'flex' : rep.days.length === 7 ? 'daily' : 'days'; }

function howOftenHtml(o) {
  const rep = PC.cleanRepeat(o.repeat), kind = repKind(rep);
  const days = rep?.days?.length && rep.days.length < 7 ? rep.days : [1, 3, 5], per = rep?.per_week || 3;
  const h = o.streak ? PC.cleanHabit(o.habit) : null, c = h?.changes.at(-1);
  return `<div class="howoften" data-kind="${kind}">
    <div class="seg" role="radiogroup" aria-label="How often">${HO_KINDS.map(([k, l]) => `<button type="button" role="radio" aria-checked="${k === kind}" class="${k === kind ? 'on' : ''}" data-ho-kind="${k}">${l}</button>`).join('')}</div>
    <div class="dbtns ho-days">${WEEK_ORDER.map(i => `<button type="button" class="dbtn${days.includes(i) ? ' on' : ''}" data-ho-day="${i}" aria-pressed="${days.includes(i)}">${PC.DAY_NAMES[i].slice(0, 2)}</button>`).join('')}</div>
    <div class="ho-per"><button type="button" class="ho-step" data-ho-step="-1" aria-label="Fewer">−</button><span class="ho-n disp">${per}</span><button type="button" class="ho-step" data-ho-step="1" aria-label="More">+</button><span class="muted">times a week, any days</span></div>
    ${o.time ? `<label class="fld ho-time"><span>Usual time <span class="muted">(optional)</span></span><input type="time" class="ho-t mono" value="${esc(rep?.time || '')}"></label>` : ''}
    ${o.streak ? `<div class="ho-streak">
      <label class="ho-sw"><span><b>Show streak</b><span class="muted small">Ticks and a streak on its card.</span></span><input type="checkbox" class="switch h-on"${h ? ' checked' : ''}></label>
      <div class="fld-row ho-count"${h ? '' : ' hidden'}><label class="fld"><span>Count per day <span class="muted">(optional)</span></span><input class="h-count mono" type="number" min="1" max="100" value="${c?.count || 1}"></label>
      <label class="fld"><span>Unit</span><input class="h-unit" maxlength="20" placeholder="e.g. glasses" value="${esc(c?.unit || '')}"></label></div>
    </div>` : ''}
  </div>`;
}

// Returns the repeat as an object, or null for "Once".
function readHowOften(box) {
  const ho = box.querySelector('.howoften');
  if (!ho) return null;
  const kind = ho.dataset.kind, time = ho.querySelector('.ho-t')?.value || null;
  if (kind === 'once') return null;
  if (kind === 'daily') return { days: [0, 1, 2, 3, 4, 5, 6], time };
  if (kind === 'flex') return PC.cleanRepeat({ days: [], per_week: Number(ho.querySelector('.ho-n').textContent), time });
  const days = [...ho.querySelectorAll('.ho-days .dbtn.on')].map(b => Number(b.dataset.hoDay));
  return days.length ? { days, time } : null;
}

// The habit follows the repeat: every day -> daily streak, set days -> those days, N a week -> weeks on target.
function readHabit(box, t, rep) {
  if (!rep || !box.querySelector('.h-on')?.checked) return null;
  const kind = rep.per_week ? 'flex' : rep.days.length === 7 ? 'daily' : 'days';
  const step = PC.cleanHabit({ changes: [{ from: localDate(), kind, days: rep.days, per_week: rep.per_week,
    count: box.querySelector('.h-count')?.value, unit: box.querySelector('.h-unit')?.value }] });
  if (!step) return t.habit || null;
  const n = step.changes[0], old = PC.cleanHabit(t.habit);
  if (!old) return JSON.stringify({ changes: [n], paused: [] });
  const last = old.changes.at(-1);
  if (JSON.stringify({ ...last, from: 0 }) === JSON.stringify({ ...n, from: 0 })) return JSON.stringify(old);
  // A new schedule starts today; earlier days and weeks keep the old one.
  if (last.from === n.from) old.changes[old.changes.length - 1] = n; else old.changes.push(n);
  return JSON.stringify(old);
}

document.addEventListener('click', e => {
  const ho = e.target.closest('.howoften');
  if (!ho) return;
  const k = e.target.closest('[data-ho-kind]'), d = e.target.closest('[data-ho-day]'), st = e.target.closest('[data-ho-step]');
  if (k) {
    ho.dataset.kind = k.dataset.hoKind;
    ho.querySelectorAll('[data-ho-kind]').forEach(b => { b.classList.toggle('on', b === k); b.setAttribute('aria-checked', String(b === k)); });
    ho.closest('.fix, .task.editing')?.setAttribute('data-repeat', ho.dataset.kind === 'once' ? 'no' : 'yes');
  }
  if (d) { d.classList.toggle('on'); d.setAttribute('aria-pressed', String(d.classList.contains('on'))); }
  if (st) { const n = ho.querySelector('.ho-n'); n.textContent = Math.max(1, Math.min(6, Number(n.textContent) + Number(st.dataset.hoStep))); }
  if (k || d || st) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('change', e => {
  if (e.target.matches('.howoften .h-on')) e.target.closest('.howoften').querySelector('.ho-count').hidden = !e.target.checked;
});

// Extra pieces on Today, after the main render.
document.addEventListener('visibilitychange', () => { if (!document.hidden && data.user) setTimeout(carryOver, 3000); });

// "2× a week", "every day", "weekdays", "Mon · Thu"
function repeatShort(rep) {
  rep = PC.cleanRepeat(rep);
  if (!rep) return '';
  if (rep.per_week) return `${rep.per_week}× a week`;
  const d = rep.days.join();
  if (d === '0,1,2,3,4,5,6') return 'every day';
  if (d === '1,2,3,4,5') return 'weekdays';
  if (d === '0,6') return 'weekends';
  return WEEK_ORDER.filter(x => rep.days.includes(x)).map(x => DAY2[x]).join(' · ');
}

// ---------- journal plans that go in by themselves ----------

// Entries written on this device. Only this device adds their plans by itself, so two devices never both do it.
function writtenHere(id) {
  try { const a = JSON.parse(localStorage.getItem('pl.mine') || '[]'); a.push(id); localStorage.setItem('pl.mine', JSON.stringify(a.slice(-300))); } catch {}
}
const isMine = id => { try { return JSON.parse(localStorage.getItem('pl.mine') || '[]').includes(id); } catch { return false; } };

// "Clear" means it says when: a day, a time or a repeat. "I finished…" notes always count.
function clearEnough(o) {
  const d = parse(o);
  if (o.kind === 'activity' || o.kind === 'update') return true;
  if (o.kind !== 'intention') return false;
  return !!(d.repeat || d.time || d.date || isComplexPlan(d, data.entries[o.entry_id], o));
}

let autoBusy = false;
function autoAddFromJournal() {
  if (autoBusy || PC.cleanRoutine(data.settings?.routine).journalAuto !== 'add') return;
  autoBusy = true;
  try {
    const added = [];
    for (const o of Object.values(data.observations)) {
      if (o.deleted || o.status !== 'pending' || o.source !== 'ai' || o._locked) continue;
      const e = data.entries[o.entry_id];
      if (!e || e.deleted || !isMine(e.id) || !clearEnough(o)) continue;
      confirmObs(o);
      added.push(o);
    }
    if (!added.length) return;
    persist(); safeRender(); sync();
    const plans = added.filter(o => o.kind === 'intention').length, done = added.length - plans;
    toast(`From your journal: ${[plans ? `${plans} plan${plans > 1 ? 's' : ''} added` : '', done ? `${done} thing${done > 1 ? 's' : ''} marked done` : ''].filter(Boolean).join(', ')}. Tap ✎ or ↺ under the entry to change it.`);
  } finally { autoBusy = false; }
}
// After each sync: journal plans that go in by themselves, and reminders that still need a time.
function afterSync() {
  try { autoAddFromJournal(); } catch {}
  try { if (timeReminders()) { persist(); safeRender(); } } catch {}
}

// ---------- complex plans split straight away ----------

// The part of an entry that belongs to one plan. An entry with several plans ("#ctme modules in 2 days. Also 4 modules
// for my #auto test. A module takes 1-2 hrs.") gives each plan its own sentences (by #tag or its words) plus the
// sentences that name no subject, which apply to all of them.
function entryPart(o, d) {
  const e = data.entries[o?.entry_id];
  const text = e && !e._locked ? e.body : '';
  const plans = obsFor(o.entry_id).filter(x => !x.deleted && x.kind === 'intention' && x.status !== 'rejected');
  if (plans.length < 2) return text;
  const sents = text.split(/(?<=[.!?\n])\s+/).map(x => x.trim()).filter(Boolean);
  const tags = x => [...x.matchAll(/#([\p{L}\p{N}_-]{1,40})/gu)].map(m => m[1].toLowerCase());
  const subj = String(d.subject || '').toLowerCase();
  const words = String(d.task || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3);
  const mine = x => { const tg = tags(x); return tg.length ? (subj ? tg.includes(subj) : tg.some(t => words.some(w => w.startsWith(t) || t.startsWith(w)))) : null; };
  const own = sents.filter(x => mine(x) === true);
  const general = sents.filter(x => mine(x) === null);
  if (!own.length) { const hit = sents.filter(x => words.some(w => x.toLowerCase().includes(w))); return [...hit, ...general.filter(x => !hit.includes(x))].join(' '); }
  return [...own, ...general].join(' ');
}

const RANGE_COUNT = /\b(?:modules?|topics?|chapters?|units?|parts?|lectures?)\s+(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\b/i;
const TOPIC_COUNT = /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(topics?|chapters?|units?|parts?|modules?|subjects?|lectures?)\b/i;
const WORDNUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function topicsInText(t) {
  const m = /\b(?:topics?|chapters?|units?|parts?|modules?|subjects?)\s*[:\-–]\s*([^.\n]+)/i.exec(String(t || ''));
  if (!m) return [];
  return m[1].split(/\s*(?:,|;|\band\b|&|\/)\s*/i).map(x => x.trim()).filter(x => x && x.length <= 60).slice(0, 20);
}
function isComplexPlan(d, e, o) {
  if (d.repeat) return false;
  const text = o ? entryPart(o, d) : e && !e._locked ? e.body : '';
  if (RANGE_COUNT.test(text)) return true;
  if ((d.topics || []).length >= 2 || topicsInText(text).length >= 2) return true;
  const c = TOPIC_COUNT.exec(text);
  const n = c ? (WORDNUM[c[1].toLowerCase()] || +c[1]) : d.parts || 0;
  return n >= 2 && n <= 20 && !!(c || (d.minutes || 0) >= 90);
}

// "in the next 3 days", "within 4 days", "by Friday", "this week" -> the last day of the window.
function windowEnd(text, today) {
  const t = String(text || '').toLowerCase();
  let m = /\b(?:in|within|over|for)\s+(?:the\s+)?(?:next\s+)?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+days?\b/.exec(t);
  if (m) { const n = WORDNUM[m[1]] || +m[1]; if (n >= 1 && n <= 30) return PC.addDays(today, n - 1); }
  if (/\bthis week\b/.test(t)) return PC.addDays(PC.weekStart(today), 6);
  m = /\b(?:by|before|till|until)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (m) { const want = DAY_RE[m[1].slice(0, 3)]; const diff = (want - PC.weekday(today) + 7) % 7 || 7; return PC.addDays(today, diff); }
  return null;
}
// An upcoming exam that matches the plan's #subject (or whose name it mentions).
function examFor(d, text) {
  const tags = [...String(text || '').matchAll(/#([\p{L}\p{N}_-]{1,40})/gu)].map(m => m[1].toLowerCase());
  if (d.subject) tags.push(String(d.subject).toLowerCase());
  const low = String(text || '').toLowerCase(), today = localDate();
  // #auto matches an exam with subject "auto", or one named "Automobile".
  return examRows().find(x => x.status === 'upcoming' && x.date >= today && ((x.subject && tags.includes(subjOf(x)))
    || (x.name && (low.includes(x.name.toLowerCase()) || tags.some(t => t.length >= 3 && x.name.toLowerCase().startsWith(t)))))) || null;
}

function splitPlan(o, d, e) {
  const text = entryPart(o, d);
  let topics = (d.topics || []).length >= 2 ? d.topics : topicsInText(text);
  const c = TOPIC_COUNT.exec(text), rc = RANGE_COUNT.exec(text);
  if (topics.length < 2 && rc && +rc[2] > +rc[1] && +rc[2] - +rc[1] < 20) {
    const word = rc[0].split(/\s+/)[0].replace(/s$/i, '');
    topics = Array.from({ length: +rc[2] - +rc[1] + 1 }, (_, i) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()} ${+rc[1] + i}`);
  }
  const n = Math.min(20, topics.length >= 2 ? topics.length : c ? (WORDNUM[c[1].toLowerCase()] || +c[1]) : d.parts || 2);
  const exam = examFor(d, text), subj = d.subject || (exam ? subjOf(exam) : null) || ((text.match(/#([\p{L}\p{N}_-]{1,40})/u) || [])[1] || '').toLowerCase() || null;
  const label = exam ? (subj ? subj.toUpperCase() : exam.name) : planTitle(d.task);
  if (topics.length < 2) topics = Array.from({ length: n }, (_, i) => `${label} topic ${i + 1}`);
  const today = localDate(), r = PC.cleanRoutine(data.settings?.routine);
  // How long each topic takes: what you wrote in total, else how long this subject really takes you, else 45 min.
  const rate = subj ? subjectRatesNow()[subj]?.rate : null;
  // "A module takes 1-2 hrs" is per part; "study 3 hrs" is the total.
  const each = d.each_minutes || perPartMinutes(text);
  const wrote = each ? null : minutesInText(text);
  const per = each ? Math.max(15, Math.round(each / 5) * 5)
    : wrote >= 15 ? Math.max(15, Math.round(wrote / n / 5) * 5)
    : Math.max(15, Math.round(45 * (rate || 1) / 5) * 5);
  // Which days: the window you gave, else up to the day before the exam, else the day you named, else today.
  // After about 6 pm, today is skipped.
  let start = d.date && d.date > today ? d.date : today;
  if (start === today && nowMin() >= 18 * 60) start = PC.addDays(today, 1);
  const said = windowEnd(text, today);
  let end = said || (exam ? PC.addDays(exam.date, -1) : null) || (d.date && d.date >= start ? d.date : start);
  if (end < start) end = start;
  const days = [];
  for (let x = start; x <= end && days.length < 31; x = PC.addDays(x, 1)) days.push(x);
  const working = days.filter(x => !r.daysOff.includes(PC.weekday(x)));
  const useDays = working.length ? working : days;
  // Share topics out by how much free time each day has (what's already planned counts), keeping their order.
  const used = x => liveRows('blocks').filter(b => b.date === x && b.status !== 'skipped').reduce((m, b) => m + blen(b), 0);
  const free = useDays.map(x => Math.max(0, r.maxMinutes - used(x) - (x === today ? Math.max(0, nowMin() - PC.toMin(r.start)) : 0)));
  const sumFree = free.reduce((a, b) => a + b, 0) || useDays.length;
  const exact = free.map(f => n * (sumFree === useDays.length && !free.some(Boolean) ? 1 / useDays.length : f / sumFree));
  const quota = exact.map(Math.floor);
  // Leftover topics go to the days with the most room left over (earlier days win ties).
  exact.map((x, i) => [x - quota[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, n - quota.reduce((a, b) => a + b, 0)).forEach(([, i]) => quota[i]++);
  const goal = (exam ? `${exam.name}` : planTitle(d.task)).slice(0, 80) || null;
  const ids = [], placed = [];
  let ti = 0;
  const mk = (title, est, deadline, i) => {
    const t = fresh({ goal, title: String(title).slice(0, 120), notes: null, category: PC.CATEGORIES.includes(d.category) ? d.category : 'study', est_minutes: est,
      deadline, priority: 2, status: 'open', done_at: null, repeat: null, revise: null, entry_id: o.entry_id || null,
      subject: subj, effort: [1, 3].includes(d.effort) ? d.effort : null, created_at: Date.now() + i });
    put('tasks', t); ids.push(t.id); return t;
  };
  // Topics go in order, one after another: Module 1 (all its sessions), then Module 2, and so on. The first session
  // of a day can follow your history and the AI's pick; the rest of that day follows on after it, earliest first.
  const routineEnd = PC.toMin(r.end);
  const earliest = (t, len, day, after) => PC.nextSlot({ blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'),
    today: day, nowMin: after == null ? (day > today ? 0 : nowMin()) : Math.max(after - 10, day > today ? 0 : nowMin()), length: len, onDate: day });
  let cur = null, curDay = null;
  useDays.forEach((day, di) => {
    if (curDay !== day) { cur = d.time && di === 0 && day === (d.date || today) ? PC.toMin(d.time) + 10 : null; curDay = day; }
    const dayNeed = quota[di] * per + Math.max(0, quota[di] * Math.ceil(per / r.session) - 1) * r.breakMin;
    for (let k = 0; k < quota[di] && ti < n; k++, ti++) {
      const t = mk(topics[ti], per, end, ti);
      // A topic longer than your "Sessions up to" is cut into sessions with breaks (90 min -> 60 + 30), back to back.
      for (let left = per, guard = 0; left >= 10 && guard < 8; guard++) {
        const len = Math.min(left, r.session);
        let slot = null;
        if (cur === null && curDay === day) {
          const pick = suggestSlot(t, { length: len, onDate: day, today: day > today ? day : today, nowMin: day > today ? 0 : nowMin(), aiTime: d.best_time });
          slot = pick && pick.start_min + dayNeed <= routineEnd ? pick : earliest(t, len, day, null) || pick;
        } else slot = earliest(t, len, curDay, cur);
        if (!slot) {
          // That day is full: carry on from the next day with room, still in order.
          slot = PC.nextSlot({ blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'), today: PC.addDays(curDay, 1), nowMin: 0, length: len });
          if (!slot) break;
        }
        put('blocks', fresh({ task_id: t.id, date: slot.date, start_min: slot.start_min, end_min: slot.end_min, status: 'planned', actual_minutes: null, started_at: null, reason: null }));
        placed.push(slot);
        left -= len;
        curDay = slot.date; cur = slot.end_min + r.breakMin;
      }
    }
    if (curDay === day || curDay < (useDays[di + 1] || '')) { curDay = useDays[di + 1] || curDay; cur = null; }
  });
  // An exam: one 45-minute "revise everything" session the evening before.
  if (exam) {
    const eve = PC.addDays(exam.date, -1);
    if (eve >= today) {
      const t = mk(`Revise all ${label} topics`, 45, eve, n + 1);
      const slot = suggestSlot(t, { length: 45, onDate: eve, today: eve, nowMin: eve === today ? Math.max(nowMin(), 18 * 60) : 18 * 60 })
        || suggestSlot(t, { length: 45, onDate: eve, today: eve, nowMin: eve === today ? nowMin() : 0 });
      if (slot) { put('blocks', fresh({ task_id: t.id, date: slot.date, start_min: slot.start_min, end_min: slot.end_min, status: 'planned', actual_minutes: null, started_at: null, reason: null })); placed.push(slot); }
    }
  }
  Object.assign(d, { task_id: 'split', split_ids: ids, exam_id: exam?.id || null, window: [start, end], per, parts_n: n, revision: !!exam });
  o.data = JSON.stringify(d);
  const clash = exam && said && said !== PC.addDays(exam.date, -1) ? ` (your ${exam.name} is on ${dayLabel(exam.date)}; I went with what you wrote)` : '';
  toast(`${splitLine(d, true)}${clash} If this isn't right, change it by hand in Plan.`, 'Undo', () => { undoSplit(o); });
}

function splitLine(d, plain) {
  const blocks = liveRows('blocks').filter(b => (d.split_ids || []).includes(b.task_id)).sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  const multi = blocks.length && blocks[0].date !== blocks.at(-1).date;
  const when = !blocks.length ? 'not placed yet' : multi ? `${dayLabel(blocks[0].date)} – ${dayLabel(blocks.at(-1).date)}`
    : `${blocks[0].date !== localDate() ? dayLabel(blocks[0].date) + ', ' : ''}${hm(blocks[0].start_min)}–${hm(blocks.at(-1).end_min)}`;
  const ex = d.exam_id && data.exams[d.exam_id] ? `, before your ${data.exams[d.exam_id].name}` : '';
  const n = (d.split_ids || []).filter(id => data.tasks[id] && !data.tasks[id].deleted).length;
  const parts = d.parts_n || (n - (d.revision ? 1 : 0)), each = d.per ? ` (~${dur(d.per)} each)` : '';
  const what = `${parts} part${parts === 1 ? '' : 's'}${each}${d.revision ? ' + revision' : ''}`;
  if (plain) return `Split "${planTitle(d.task)}" into ${what}, ${when}${ex}.`;
  return `Split <b>${esc(planTitle(d.task))}</b> into ${esc(what)} · ${esc(when)}${esc(ex)} · <button class="link" data-go="plan">change</button>`;
}

function undoSplit(o) {
  const d = parse(o);
  for (const id of d.split_ids || []) {
    const t = data.tasks[id];
    if (!t || t.deleted || t.status === 'done') continue;
    t.deleted = 1; put('tasks', t);
    for (const b of liveRows('blocks')) if (b.task_id === id && b.status !== 'done') { b.deleted = 1; put('blocks', b); }
  }
  delete d.task_id; delete d.split_ids;
  setObs(o, { data: JSON.stringify(d), status: 'pending', source: 'user' });
  persist(); safeRender(); sync();
}

document.addEventListener('click', e => { if (e.target.closest('[data-go="plan"]')) { e.preventDefault(); e.stopPropagation(); show('plan'); } }, true);


// ---------- suggested times: your history + the AI ----------

const AIT = 'pl.aitimes';
function aiTimesCache() {
  try { const c = JSON.parse(localStorage.getItem(AIT) || '{}'); if (c.date === localDate()) return c; } catch {}
  return { date: localDate(), times: {}, asked: 0 };
}
// Finished sessions from the last 60 days, by start time (Start moves a session to when you really began).
function history60() {
  const since = PC.addDays(localDate(), -60);
  return liveRows('blocks').filter(b => b.status === 'done' && b.date >= since).map(b => ({ start_min: b.start_min, subject: data.tasks[b.task_id]?.subject || null }));
}
// o: { length, onDate, today, nowMin, blocks, skipId }. Returns a slot with .why when the AI's pick changed it.
function suggestSlot(task, o = {}) {
  const ai = (task ? aiTimesCache().times[task.id] : null) || (o.aiTime ? { time: o.aiTime, why: 'AI pick from your journal' } : null);
  const r = PC.bestSlot({ blocks: o.blocks || liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'),
    today: o.today || localDate(), nowMin: o.nowMin ?? nowMin(), length: o.length || 60, skipId: o.skipId, onDate: o.onDate,
    history: history60(), subject: task?.subject || null, aiMin: ai ? PC.toMin(ai.time) : undefined });
  if (r && ai && r.moved) r.why = ai.why;
  return r;
}

let aitBusy = false;
async function refreshAiTimes() {
  const c = aiTimesCache();
  if (aitBusy || !data.user || !data.settings?.ai_provider || Date.now() - (c.asked || 0) < 10 * 60e3) return;
  const today = localDate();
  const need = liveRows('tasks').filter(t => t.status === 'open' && !t.repeat && !c.times[t.id]
    && !blocksOf(t.id).some(b => b.status === 'planned' && b.date >= today) && (!t.deadline || t.deadline <= PC.addDays(today, 7))).slice(0, 15);
  if (!need.length) return;
  aitBusy = true;
  c.asked = Date.now();
  try { localStorage.setItem(AIT, JSON.stringify(c)); } catch {}
  try {
    const notes = liveRows('entries').filter(e => !e._locked && e.body && e.entry_date >= PC.addDays(today, -14))
      .sort((a, b) => b.created_at - a.created_at).slice(0, 30).map(e => `${e.entry_date}: ${e.body}`);
    const h = history60(), byHour = {};
    for (const x of h) { const k = Math.floor(x.start_min / 60); byHour[k] = (byHour[k] || 0) + 1; }
    const usual = h.length ? 'finished sessions mostly start around ' + Object.entries(byHour).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => `${k}:00`).join(', ') : '';
    const r = await api('/api/times', { method: 'POST', body: { today, notes, usual,
      tasks: need.map(t => ({ id: t.id, title: t.title, subject: t.subject, minutes: t.est_minutes })) } });
    const c2 = aiTimesCache();
    for (const x of r.times || []) c2.times[x.id] = { time: x.time, why: x.why };
    try { localStorage.setItem(AIT, JSON.stringify(c2)); } catch {}
    if ((r.times || []).length) { renderToday(); if (!$('#view-plan').hidden) renderPlan(); }
  } catch {} finally { aitBusy = false; }
}

function renderBlendLine() {
  const el = $('#ai-blend');
  if (!el) return;
  const n = history60().length, a = Math.round(PC.aiShare(n) * 100);
  el.textContent = `Suggested times: ${100 - a}% your history · ${a}% AI (${n} finished session${n === 1 ? '' : 's'} in the last 60 days). The AI's share drops to 30% as your history grows.`;
}


// ---------- journal entries that change a plan you already have ----------

// Your open plans (tasks grouped by goal), in a few words each, so the AI can tell "add a 5th module" from a new plan.
function planGroups() {
  const g = new Map();
  for (const t of liveRows('tasks')) {
    if (!t.goal || t.repeat || t.category === 'reminder') continue;
    if (!g.has(t.goal)) g.set(t.goal, []);
    g.get(t.goal).push(t);
  }
  return [...g.entries()].filter(([, ts]) => ts.some(t => t.status === 'open'));
}
function plansForAI() {
  return planGroups().slice(0, 15).map(([goal, ts]) => {
    const ex = examRows().find(x => x.name === goal && x.status === 'upcoming');
    const parts = ts.filter(t => !/^revise all/i.test(t.title)).map(t => {
      const b = blocksOf(t.id).filter(x => x.status === 'planned').sort((a, c) => a.date.localeCompare(c.date))[0];
      return `${t.title}${t.status === 'done' ? ' (done)' : b ? ` (${b.date})` : ''}`;
    });
    return `${goal}${ts[0].subject ? ' #' + ts[0].subject : ''}${ex ? `, exam on ${ex.date}` : ''}: ${parts.join(', ')}`;
  });
}
function findGroup(name) {
  const n = String(name || '').toLowerCase().trim();
  const gs = planGroups();
  return gs.find(([g]) => g.toLowerCase() === n) || gs.find(([g, ts]) => g.toLowerCase().includes(n) || n.includes(g.toLowerCase()) || (ts[0].subject && n.includes(ts[0].subject))) || null;
}

function updateLine(d) {
  const bits = [];
  if (d.add?.length) bits.push(`add ${d.add.join(', ')}`);
  if (d.deadline) bits.push(`${d.which?.length ? d.which.join(', ') : 'everything'} by ${dayLabel(d.deadline)}`);
  if (d.drop?.length) bits.push(`drop ${d.drop.join(', ')}`);
  if (d.each_minutes) bits.push(`~${dur(d.each_minutes)} each`);
  const res = d.applied ? ` · ${d.applied.moved} moved, ${d.applied.added} added${d.applied.short ? ` · <span class="amber">${esc(d.applied.short)}</span>` : ''}` : '';
  return `Update <b>${esc(d.plan)}</b>: ${esc(bits.join(' · '))}${res}`;
}

function applyPlanUpdate(o) {
  const d = parse(o), grp = findGroup(d.plan);
  if (!grp) { toast(`Couldn't find a plan called "${d.plan}". Add it as a new plan instead, or check the name in Plan.`); return; }
  const [goal, ts] = grp, today = localDate(), r = PC.cleanRoutine(data.settings?.routine);
  const before = { tasks: ts.map(t => ({ ...t })), blocks: liveRows('blocks').filter(b => ts.some(t => t.id === b.task_id)).map(b => ({ ...b })) };
  const open = ts.filter(t => t.status === 'open');
  const parts = open.filter(t => !/^revise all/i.test(t.title));
  const lastDue = parts.map(t => t.deadline).filter(Boolean).sort().at(-1) || null;
  const each = d.each_minutes || Math.round((parts.reduce((a, t) => a + t.est_minutes, 0) / Math.max(1, parts.length)) / 5) * 5 || 60;
  const named = n => parts.filter(t => (d[n] || []).some(w => t.title.toLowerCase() === w.toLowerCase() || t.title.toLowerCase().includes(w.toLowerCase())));
  let moved = 0, added = 0, short = '';
  const upcoming = t => blocksOf(t.id).filter(b => b.status === 'planned' && !b.started_at && b.date >= today);
  // Place `len` minutes of a task between today and `end`, cut by your session length.
  // In order and back to back: each part starts after the one placed before it.
  let cDay = today, cCur = null;
  const place = (t, len, end) => {
    let left = len;
    for (let day = cDay; day <= end && left >= 10; day = PC.addDays(day, 1)) {
      for (let guard = 0; guard < 6 && left >= 10; guard++) {
        const l = Math.min(left, r.session);
        const after = day === cDay ? cCur : null;
        const s = PC.nextSlot({ blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'), today: day, onDate: day, length: l,
          nowMin: after == null ? (day > today ? 0 : nowMin()) : Math.max(after - 10, day > today ? 0 : nowMin()) });
        if (!s) break;
        put('blocks', fresh({ task_id: t.id, date: s.date, start_min: s.start_min, end_min: s.end_min, status: 'planned', actual_minutes: null, started_at: null, reason: null }));
        left -= l; cDay = s.date; cCur = s.end_min + r.breakMin;
      }
    }
    return left;
  };
  // 1. Drop parts.
  for (const t of named('drop')) { t.deleted = 1; put('tasks', t); for (const b of upcoming(t)) { b.deleted = 1; put('blocks', b); } }
  // 2. An earlier finish: parts booked on or after the new last day move into free time before it.
  if (d.deadline) {
    const which = d.which?.length ? named('which') : parts;
    let need = 0;
    for (const t of which) {
      t.deadline = d.deadline; put('tasks', t);
      for (const b of upcoming(t)) if (b.date > d.deadline) { need += blen(b); b.deleted = 1; put('blocks', b); moved++; }
    }
    for (const t of [...which].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))) {
      const missing = Math.max(0, t.est_minutes - spentOn(t.id) - upcoming(t).reduce((a, b) => a + blen(b), 0));
      if (missing >= 10 && place(t, missing, d.deadline) >= 10) short = `not enough free time before ${dayLabel(PC.addDays(d.deadline, 1))}`;
    }
  }
  // 3. New parts: same length and subject as the others, finished by the plan's last day.
  const end = lastDue && lastDue >= today ? lastDue : PC.addDays(today, 6);
  for (const [i, name] of (d.add || []).entries()) {
    const t = fresh({ goal, title: String(name).slice(0, 120), notes: null, category: parts[0]?.category || 'study', est_minutes: each, deadline: end,
      priority: 2, status: 'open', done_at: null, repeat: null, revise: null, entry_id: o.entry_id || null, subject: ts[0].subject || null,
      effort: parts[0]?.effort ?? null, created_at: Date.now() + i });
    put('tasks', t); added++;
    if (place(t, each, end) >= 10) short = short || `no room for all of ${name} before ${dayLabel(PC.addDays(end, 1))}`;
  }
  if (d.each_minutes) for (const t of parts.filter(t => !t.deleted)) { t.est_minutes = d.each_minutes; put('tasks', t); }
  // The "before" copy stays on this device (it can be big); the note itself only keeps what was added.
  try { localStorage.setItem('pl.upd.' + o.id, JSON.stringify(before)); } catch {}
  d.applied = { moved, added, short, newIds: liveRows('tasks').filter(t => t.goal === goal && !before.tasks.some(x => x.id === t.id)).map(t => t.id) };
  o.data = JSON.stringify(d);
  toast(`Updated "${goal}": ${[added ? `${added} added` : '', moved ? `${moved} session${moved > 1 ? 's' : ''} moved earlier` : '', short].filter(Boolean).join(', ') || 'saved'}.`, 'Undo', () => undoPlanUpdate(o));
}

function undoPlanUpdate(o) {
  const d = parse(o), a = d.applied;
  if (!a) return;
  for (const id of a.newIds || []) {
    const t = data.tasks[id]; if (t) { t.deleted = 1; put('tasks', t); }
    for (const b of liveRows('blocks')) if (b.task_id === id) { b.deleted = 1; put('blocks', b); }
  }
  // Sessions made by the update go; the old ones come back exactly as they were (on the device that made the change).
  let before = null;
  try { before = JSON.parse(localStorage.getItem('pl.upd.' + o.id) || 'null'); } catch {}
  if (before) {
    const oldIds = new Set(before.blocks.map(b => b.id));
    for (const b of liveRows('blocks')) if (before.tasks.some(t => t.id === b.task_id) && !oldIds.has(b.id)) { b.deleted = 1; put('blocks', b); }
    for (const t of before.tasks) put('tasks', { ...t, updated_at: data.tasks[t.id]?.updated_at || t.updated_at });
    for (const b of before.blocks) put('blocks', { ...b, updated_at: data.blocks[b.id]?.updated_at || b.updated_at });
    try { localStorage.removeItem('pl.upd.' + o.id); } catch {}
  }
  delete d.applied;
  setObs(o, { data: JSON.stringify(d), status: 'pending', source: 'user' });
  persist(); safeRender(); sync();
}
