// Weekly review (Log tab), the getting-started checklist (Today) and saving things shared from other apps.
'use strict';

// ---------- weekly review ----------

const shortDate = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekdayName = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });

function weekFacts(today, now) {
  const from = PC.addDays(today, -6);
  const inWeek = liveRows('blocks').filter(b => b.date >= from && b.date <= today);
  const over = inWeek.filter(b => b.status !== 'planned' || b.started_at || b.date < today || b.end_min <= now);
  const done = over.filter(b => b.status === 'done');
  const skipped = over.filter(b => b.status === 'skipped');
  const noUpdate = over.filter(b => b.status === 'planned' && !b.started_at);
  const len = b => b.end_min - b.start_min;
  const planned = over.reduce((s, b) => s + len(b), 0);
  const doneMin = done.reduce((s, b) => s + (b.actual_minutes ?? len(b)), 0);
  const byDay = {};
  for (const b of done) byDay[b.date] = (byDay[b.date] || 0) + (b.actual_minutes ?? len(b));
  const best = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0] || null;
  const reasons = {};
  for (const b of skipped) if (b.reason) reasons[b.reason] = (reasons[b.reason] || 0) + 1;
  const timed = done.filter(b => b.actual_minutes != null && len(b) > 0);
  const ratio = timed.length >= 3 ? timed.reduce((s, b) => s + b.actual_minutes / len(b), 0) / timed.length : null;
  const journalDays = new Set(liveRows('entries').filter(e => e.entry_date >= from && e.entry_date <= today).map(e => e.entry_date)).size;
  // Still ahead: the rest of today plus the next 6 days.
  const nextWeek = liveRows('blocks').filter(b => b.status === 'planned' && !b.started_at && b.date <= PC.addDays(today, 6)
    && (b.date > today || (b.date === today && b.start_min >= now))).reduce((s, b) => s + len(b), 0);
  return { from, over, done, skipped, noUpdate, planned, doneMin, best, reasons, ratio, journalDays, nextWeek };
}

// Things you want to do that don't have a time yet: open tasks with no upcoming session,
// and plans you confirmed in the journal that aren't tasks yet.
function waitingToPlan() {
  const today = localDate();
  const blocks = liveRows('blocks');
  const tasks = liveRows('tasks').filter(t => t.status === 'open' && !t.repeat
    && !blocks.some(b => b.task_id === t.id && b.status === 'planned' && b.date >= today));
  const notes = journalIntentions();
  return { tasks, notes, count: tasks.length + notes.length };
}

// "Plan them now": turn waiting journal plans into tasks, then open the plan proposal.
function planWaitingNow() {
  for (const { o, d } of journalIntentions()) {
    const t = fresh({ goal: null, title: String(d.task || 'Task').slice(0, 120), notes: null,
      category: PC.CATEGORIES.includes(d.category) ? d.category : 'other', est_minutes: 60,
      deadline: d.date || null, priority: 2, status: 'open', done_at: null, repeat: null, revise: defaultRevise(d.category) });
    put('tasks', t);
    d.task_id = t.id;
    setObs(o, { data: JSON.stringify(d) });
  }
  persist();
  sync();
  show('plan');
  startProposal();
  renderPlan();
  setTimeout(() => $('#proposal-card').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

$('#view-log').addEventListener('click', e => {
  if (e.target.closest('[data-rv=plan]')) planWaitingNow();
});

// One plain suggestion, from the clearest signal in the week.
function weekSuggestion(f) {
  const top = Object.entries(f.reasons).sort((a, b) => b[1] - a[1])[0];
  const pct = f.planned ? f.doneMin / f.planned : null;
  if (!f.over.length && f.waiting) return `You have ${f.waiting} thing${f.waiting > 1 ? 's' : ''} to do, but nothing has a time yet. Tap "Plan them now" to fit ${f.waiting > 1 ? 'them' : 'it'} into your week.`;
  if (!f.over.length && f.nextWeek) return `Your week starts now: ${fmtMin(f.nextWeek)} scheduled over the next 7 days. Today shows what's next.`;
  if (!f.over.length) return 'Nothing was planned this week. Add a few tasks in Plan and tap "Make my plan" to start getting a picture.';
  if (top && top[1] >= 2 && top[0] === 'Too tired') return 'Tiredness was the main reason for skipping. Try shorter sessions or a lower daily focus limit in Settings → My week.';
  if (top && top[1] >= 2 && top[0] === 'No time') return '"No time" came up most. The week may be overbooked: lower your daily focus limit by an hour and see if more gets done.';
  if (top && top[1] >= 2 && top[0] === 'Task unclear') return 'Some tasks felt unclear. Before the next big one, use "Break it down" in Plan to turn it into small first steps.';
  if (top && top[1] >= 2 && top[0] === 'Something came up') return 'Unexpected things got in the way a few times. Leave one free hour a day as a buffer (lower the focus limit a little).';
  if (f.noUpdate.length >= 3) return `${f.noUpdate.length} sessions never got an update. Turning on the evening check-in (Settings → Notifications) helps catch them.`;
  if (pct !== null && pct < 0.5) return `You finished about ${Math.round(pct * 100)}% of the planned time. A lighter plan you keep beats a heavy one you don't: try a lower daily limit next week.`;
  if (f.ratio && f.ratio > 1.25) return `Sessions took about ${f.ratio.toFixed(1)}× as long as planned. Give tasks more time when you add them.`;
  if (f.ratio && f.ratio < 0.75) return 'You often finished faster than planned. You could fit a bit more into each day.';
  if (pct !== null && pct >= 0.9 && f.done.length >= 5) return 'You finished almost everything. You could raise your daily limit a little next week.';
  return 'A steady week. Keep the same pace.';
}

function renderReview() {
  const today = localDate(), now = nowMin();
  const f = weekFacts(today, now);
  const w = waitingToPlan();
  f.waiting = w.count;
  const pct = f.planned ? Math.round((f.doneMin / f.planned) * 100) : null;
  const reasons = Object.entries(f.reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${esc(r)}${n > 1 ? ' ×' + n : ''}`).join(', ');
  $('#review').innerHTML = `
    <h2>Week in review <span class="muted small">${shortDate(f.from)} – ${shortDate(today)}</span></h2>
    <div class="stats">
      <div><b>${fmtMin(f.doneMin) || '0 min'}</b><span>done</span></div>
      <div><b>${pct === null ? '–' : pct + '%'}</b><span>of planned time</span></div>
      <div><b>${f.done.length}</b><span>sessions done</span></div>
      <div><b>${f.journalDays}/7</b><span>days journaled</span></div>
    </div>
    <ul class="review-list">
      ${f.skipped.length ? `<li>Skipped ${f.skipped.length}${reasons ? `: ${reasons}` : ''}</li>` : ''}
      ${f.noUpdate.length ? `<li>${f.noUpdate.length} with no update</li>` : ''}
      ${f.best ? `<li>Best day: ${esc(weekdayName(f.best[0]))} (${fmtMin(f.best[1])})</li>` : ''}
      ${f.ratio ? `<li>Sessions took ${f.ratio.toFixed(1)}× the planned time on average</li>` : ''}
      <li>Next 7 days: ${f.nextWeek ? fmtMin(f.nextWeek) + ' scheduled' : 'nothing scheduled yet'}${w.count
        ? ` · ${w.count} thing${w.count > 1 ? 's' : ''} waiting for a time <button class="link" data-rv="plan">Plan ${w.count > 1 ? 'them' : 'it'} now</button>` : ''}</li>
    </ul>
    <p class="suggest">${esc(weekSuggestion(f))}</p>`;
}

// ---------- getting-started checklist (Today) ----------

const checklistKey = () => `pl.checklist.hidden.${data.user?.id}`;

async function renderChecklist() {
  const box = $('#checklist');
  let hidden = false;
  try { hidden = localStorage.getItem(checklistKey()) === '1'; } catch {}
  if (hidden || !data.user) { box.hidden = true; return; }
  let pushOk = false;
  try { pushOk = pushSupported() && Notification.permission === 'granted' && !!(await currentSub()); } catch {}
  const s = data.settings || {};
  const steps = [
    { done: !!s.routine, text: 'Set your week: hours, college, days off', go: 'settings', to: '#routine' },
    { done: pushOk, text: 'Turn on notifications on this device', go: 'settings', to: '#notify' },
    { done: !!s.ai_provider, text: 'Choose an AI to read your journal', go: 'settings', to: '#ai-form' },
    { done: liveRows('entries').length > 0, text: 'Write your first journal entry', go: 'journal', to: '#composer' },
    { done: liveRows('blocks').length > 0, text: 'Add a task and tap "Make my plan"', go: 'plan', to: '#goal-card' },
  ];
  const n = steps.filter(x => x.done).length;
  if (n === steps.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="check-head"><h2>Get set up · ${n} of ${steps.length}</h2><span class="muted small">${n} of ${steps.length} done</span>
      <button class="link" data-ck="hide">Hide</button></div>
    <div class="check-bar"><i style="width:${(n / steps.length) * 100}%"></i></div>
    ${steps.map((x, i) => `<button class="check-step${x.done ? ' done' : ''}" data-ck="${i}"><span class="tick">${x.done ? '✓' : i + 1}</span>${esc(x.text)}</button>`).join('')}`;
  box._steps = steps;
}

$('#checklist').addEventListener('click', e => {
  const b = e.target.closest('[data-ck]');
  if (!b) return;
  if (b.dataset.ck === 'hide') {
    try { localStorage.setItem(checklistKey(), '1'); } catch {}
    $('#checklist').hidden = true;
    return;
  }
  const step = $('#checklist')._steps?.[Number(b.dataset.ck)];
  if (!step) return;
  show(step.go);
  setTimeout(() => {
    const el = $(step.to);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (el.matches('textarea, input')) el.focus();
  }, 60);
});

// ---------- things shared from other apps ----------

function openShareSheet(text) {
  $('#share-text').value = text;
  $('#share-sheet').hidden = false;
  setTimeout(() => $('#share-text').focus(), 50);
}

$('#share-sheet').addEventListener('click', e => {
  const b = e.target.closest('[data-share]');
  if (!b && e.target.id !== 'share-sheet') return;
  const act = b?.dataset.share || 'cancel';
  const text = $('#share-text').value.trim();
  if (act === 'journal' && text) {
    show('journal');
    composer.value = text;
    saveEntry();
  }
  if (act === 'task' && text) {
    const [first, ...rest] = text.split('\n');
    put('tasks', fresh({ goal: null, title: first.trim().slice(0, 120) || 'Shared item', notes: rest.join('\n').trim().slice(0, 1000) || null,
      category: 'other', est_minutes: 60, deadline: null, priority: 2, status: 'open', done_at: null, repeat: null }));
    persist();
    sync();
    show('plan');
    toast('Added as a task (1 h guess). Tap it to change.');
  }
  $('#share-sheet').hidden = true;
});

// ---------- calendar apps: private link ----------

function renderCalLink() {
  const box = $('#callink');
  const token = data.settings?.cal_token;
  if (!token) {
    box.innerHTML = `<p class="small">Show your planned sessions and deadlines in Google Calendar, Apple Calendar or Outlook.
      It's a private link only you know; your calendar app checks it for changes. It works one way: you still plan here.</p>
      <div class="row"><button class="primary" data-cl="create">Create my calendar link</button></div><p class="small" id="cl-msg"></p>`;
    return;
  }
  const link = `${location.origin}/cal/${token}.ics`;
  box.innerHTML = `
    <p class="small">Your private calendar link. Anyone who has it can see your planned sessions, so keep it to yourself.</p>
    <div class="code-box small-code" id="cl-link">${esc(link)}</div>
    <div class="row"><button class="primary" data-cl="check">Check the link</button><button data-cl="copy">Copy link</button><a class="btn" href="${esc(link.replace(/^https?:/, 'webcal:'))}">Open in calendar app</a></div>
    <details><summary>Google Calendar</summary><ol class="small tight">
      <li>On a computer, open calendar.google.com (this step doesn't work in the phone app).</li>
      <li>On the left, next to "Other calendars", click <b>+</b>, then <b>From URL</b>.</li>
      <li>Paste the link and click <b>Add calendar</b>. It then shows in the Google Calendar app on your phone too.</li></ol>
      <p class="muted small">Google checks subscribed calendars every few hours, so a new plan can take a while to appear there. Planner's own reminders are always on time.</p></details>
    <details><summary>Apple Calendar (iPhone, Mac)</summary><ol class="small tight">
      <li>iPhone: tap <b>Open in calendar app</b> above and confirm. Or Settings → Calendar → Accounts → Add Account → Other → <b>Add Subscribed Calendar</b>, and paste the link.</li>
      <li>Mac: Calendar → File → <b>New Calendar Subscription</b>, paste the link, and set Auto-refresh to every 15 minutes.</li></ol>
      <p class="muted small">Apple Reminders can't subscribe to links. The calendar events carry alerts before each session instead.</p></details>
    <details><summary>Outlook</summary><ol class="small tight">
      <li>outlook.com → Calendar → <b>Add calendar</b> → <b>Subscribe from web</b>, paste the link.</li></ol></details>
    <div class="row"><button data-cl="reset">Make a new link</button><button data-cl="off">Turn off</button></div>
    <p class="small" id="cl-msg"></p>`;
}

$('#callink').addEventListener('click', async e => {
  const b = e.target.closest('[data-cl]');
  if (!b) return;
  const act = b.dataset.cl;
  const msg = t => { const m = $('#cl-msg'); if (m) m.textContent = t; };
  if (act === 'copy') {
    try { await navigator.clipboard.writeText($('#cl-link').textContent); msg('Copied.'); } catch { msg('Select the link and copy it.'); }
    return;
  }
  // Fetch the feed exactly as Google or Apple would, and say what's in it.
  if (act === 'check') {
    msg('Checking…');
    try {
      const r = await fetch($('#cl-link').textContent.trim(), { cache: 'no-store' });
      const txt = await r.text();
      if (!r.ok || !txt.startsWith('BEGIN:VCALENDAR')) { msg(`The link isn't working (error ${r.status}). Tap "Make a new link" and add the new one to your calendar.`); return; }
      const ev = (txt.match(/BEGIN:VEVENT/g) || []).length, today = localDate().replace(/-/g, '');
      const next = (txt.match(/DTSTART:(\d{8})/g) || []).map(x => x.slice(8)).filter(x => x >= today).length;
      msg(ev ? `The link works: ${ev} item${ev > 1 ? 's' : ''} in it, ${next} from today on. If they're not in your calendar yet, it's on the calendar's side: Google reads the link every few hours, so new items can take up to a day to appear.`
             : 'The link works, but nothing is in it yet: only sessions with a time and tasks with a due date go in. Plan something and check again.');
    } catch { msg("Couldn't reach the link. Check your connection and try again."); }
    return;
  }
  if (act === 'reset' && !confirm('Make a new link? Calendars using the old link stop updating until you add the new one.')) return;
  if (act === 'off' && !confirm('Turn off the calendar link? Calendars using it stop updating.')) return;
  b.disabled = true;
  try {
    data.settings = (await api('/api/calendar/link', { method: 'POST', body: { action: act } })).settings;
    persist();
    renderCalLink();
    msg(act === 'off' ? 'Turned off.' : act === 'reset' ? 'New link made. The old one no longer works.' : 'Link ready. Follow the steps for your calendar app.');
  } catch (err) {
    msg(err.message === 'Failed to fetch' ? 'You need internet for this.' : err.message);
    b.disabled = false;
  }
});

// ---------- things for today with no time yet ----------

const todoSkipKey = () => `pl.todo.skip.${data.user?.id}.${localDate()}`;
function todoSkipped() { try { return JSON.parse(localStorage.getItem(todoSkipKey()) || '[]'); } catch { return []; } }

// Due today (or overdue) and not scheduled: tasks with a deadline, and journal plans for today that aren't tasks yet.
// Each gets a suggested free slot today, one after another.
function todoItems() {
  const today = localDate(), now = nowMin();
  const skip = todoSkipped();
  const blocks = liveRows('blocks');
  const items = [];
  for (const t of liveRows('tasks')) {
    if (t.status !== 'open' || t.repeat || t.category === 'reminder' || !t.deadline || t.deadline > today || skip.includes(t.id)) continue;
    if (blocks.some(b => b.task_id === t.id && b.status === 'planned' && b.date >= today)) continue;
    items.push({ key: t.id, title: t.title, task: t, len: Math.min(Math.max(t.est_minutes || 60, 15), PC.cleanRoutine(data.settings?.routine).session), overdue: t.deadline < today });
  }
  for (const { o, d } of journalIntentions()) {
    if (!d.date || d.date > today || skip.includes(o.id) || d.category === 'reminder') continue;
    items.push({ key: o.id, title: d.task || 'Task', note: o, len: 60, overdue: d.date < today });
  }
  const taken = [...blocks];
  for (const it of items) {
    const s = suggestSlot(it.task || null, { blocks: taken, today, nowMin: now, length: it.len, onDate: today });
    it.slot = s && s.date === today ? s : null;
    if (it.slot) taken.push({ id: 'sg-' + it.key, task_id: 'sg', date: today, start_min: it.slot.start_min, end_min: it.slot.end_min, status: 'planned' });
  }
  return items;
}

let todoAll = false;
function renderTodo() {
  const box = $('#todo');
  const items = todoItems();
  box.hidden = !items.length;
  if (!items.length) return;
  const shown = todoAll ? items : items.slice(0, 3);
  box.innerHTML = `<div class="todo-head"><h2>Not on the clock · ${items.length}</h2>${items.filter(i => i.slot).length > 1 ? '<button class="link" data-td="all">Plan all</button>' : ''}</div>
    ${shown.map(it => `<div class="todo-row" data-k="${esc(it.key)}">
      <div class="todo-title"><span>${esc(it.title)}</span>${it.overdue ? '<span class="due-pill over">overdue</span>' : '<span class="due-pill soon">today</span>'}</div>
      <div class="todo-acts">
        ${it.slot ? `<button class="primary" data-td="accept">Plan at ${hm(it.slot.start_min)}</button>${it.slot.why ? `<span class="why small muted">${esc(it.slot.why)}</span>` : ''}` : '<span class="muted small">No free time left. Pick one:</span>'}
        <input type="time" class="td-time" value="${it.slot ? PC.toHHMM(it.slot.start_min) : ''}" aria-label="Or pick a time">
        <button data-td="pick" aria-label="Plan at this time">Set</button>
        <button class="bare" data-td="skip">Not today</button>
      </div></div>`).join('')}
    ${items.length > shown.length ? `<button class="bare more-btn" data-td="more">Show ${items.length - shown.length} more</button>` : ''}`;
}

// A journal plan becomes a task the first time it gets a time.
function ensureTask(it) {
  if (it.task) return it.task;
  const d = parse(it.note);
  const t = fresh({ goal: null, title: String(d.task || 'Task').slice(0, 120), notes: null,
    category: PC.CATEGORIES.includes(d.category) ? d.category : 'other', est_minutes: 60,
    deadline: d.date || null, priority: 2, status: 'open', done_at: null, repeat: null, revise: defaultRevise(d.category) });
  put('tasks', t);
  d.task_id = t.id;
  setObs(it.note, { data: JSON.stringify(d) });
  return t;
}
function planTodo(it, start, len = it.len) {
  const t = ensureTask(it);
  const b = fresh({ task_id: t.id, date: localDate(), start_min: start, end_min: Math.min(1440, start + len),
    status: 'planned', actual_minutes: null, started_at: null, reason: null });
  put('blocks', b);
  return b;
}
function planAllTodo(items) {
  let n = 0;
  for (const it of items) if (it.slot) { planTodo(it, it.slot.start_min); n++; }
  return n;
}

$('#todo').addEventListener('click', e => {
  const btn = e.target.closest('[data-td]');
  if (!btn) return;
  const act = btn.dataset.td;
  if (act === 'more') { todoAll = true; renderTodo(); return; }
  const items = todoItems();
  if (act === 'all') toast(`Planned ${planAllTodo(items)} for today.`);
  else {
    const row = btn.closest('.todo-row');
    const it = items.find(x => x.key === row.dataset.k);
    if (!it) return;
    if (act === 'skip') {
      const s = todoSkipped(); s.push(it.key);
      try { localStorage.setItem(todoSkipKey(), JSON.stringify(s)); } catch {}
    }
    if (act === 'accept' && it.slot) { planTodo(it, it.slot.start_min); toast(`"${it.title}" planned at ${hm(it.slot.start_min)}.`); }
    if (act === 'pick') {
      const v = row.querySelector('.td-time').value;
      if (!v) { toast('Pick a time first.'); return; }
      const start = PC.toMin(v);
      if (start < nowMin() - 5) { toast('That time has already passed.'); return; }
      const b = planTodo(it, start);
      const clash = liveRows('blocks').find(x => x.id !== b.id && x.date === b.date && x.status !== 'skipped' && x.start_min < b.end_min && b.start_min < x.end_min);
      toast(clash ? `Planned at ${v}. It overlaps "${taskTitle(clash)}".` : `"${it.title}" planned at ${v}.`);
    }
  }
  persist();
  renderToday();
  sync();
});

// Buttons on the morning notification: "Plan at 16:00", "Plan them all", "Pick a time".
function handleTodoLaunch(todo, q) {
  show('today');
  const items = todoItems();
  if (todo === 'accept') {
    const it = items.find(x => x.key === q.get('task'));
    if (!it) { toast('That one is already planned.'); }
    else {
      let start = Number(q.get('at'));
      let len = Math.min(Math.max(Number(q.get('len')) || it.len, 10), 480);
      // Something else may have taken that time since the notification was sent: fall back to today's suggestion.
      const busy = liveRows('blocks').some(b => b.date === localDate() && b.status !== 'skipped' && b.start_min < start + len && start < b.end_min);
      if (!Number.isFinite(start) || busy || start < nowMin() - 5) { start = it.slot ? it.slot.start_min : null; len = it.len; }
      if (start === null) toast('That time has gone. Pick another one below.');
      else { planTodo(it, start, len); toast(`"${it.title}" planned at ${hm(start)}.`); }
    }
  }
  if (todo === 'all') {
    const n = planAllTodo(items);
    toast(n ? `Planned ${n} for today.` : 'No free time left today. Pick times below.');
  }
  persist();
  renderToday();
  sync();
  setTimeout(() => $('#todo')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}
