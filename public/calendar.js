// Calendar: a month at a glance (time worked, journal days, deadlines, planned days) and the details of any day.
// Everything comes from what's already on the device, so it works offline and opens instantly.
'use strict';

let calMonth = null;   // 'YYYY-MM' being shown
let calDay = null;     // 'YYYY-MM-DD' selected
let calForm = null;    // { mode: 'add' } or { mode: 'edit', id } while adding/moving a session

const monthOf = iso => iso.slice(0, 7);
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
const longDate = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

// One pass over the data: per day, time planned / done / logged in the journal, and what's on it.
function dayStats() {
  const s = {};
  const get = d => s[d] || (s[d] = { planned: 0, done: 0, logged: 0, sessions: 0, skipped: 0, entries: 0, due: 0 });
  for (const b of liveRows('blocks')) {
    const x = get(b.date), len = b.end_min - b.start_min;
    x.sessions++;
    if (b.status === 'skipped') x.skipped++;
    else x.planned += len;
    if (b.status === 'done') x.done += b.actual_minutes ?? len;
  }
  for (const e of liveRows('entries')) get(e.entry_date).entries++;
  for (const t of liveRows('tasks')) if (t.deadline && t.status === 'open') get(t.deadline).due++;
  for (const o of Object.values(data.observations)) {
    if (o.deleted || o.status !== 'confirmed' || o.kind !== 'activity') continue;
    const e = data.entries[o.entry_id];
    const d = parse(o);
    if (e && !e.deleted && d.minutes) get(e.entry_date).logged += d.minutes;
  }
  // Sessions and journal notes often describe the same work, so take the larger, not the sum.
  for (const x of Object.values(s)) x.worked = Math.max(x.done, x.logged);
  return s;
}

function renderCalendar() {
  const today = localDate();
  calMonth = calMonth || monthOf(today);
  calDay = calDay || today;
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;                       // weeks start on Monday
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cellsCount = Math.ceil((lead + daysInMonth) / 7) * 7;
  const start = PC.addDays(`${calMonth}-01`, -lead);
  const stats = dayStats();
  const busiest = Math.max(60, ...Object.values(stats).map(x => x.worked));

  $('#cal-title').textContent = first.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const mon = PC.addDays(today, -((new Date(today + 'T00:00:00').getDay() + 6) % 7));
  const weekWorked = Object.entries(stats).filter(([d]) => d >= mon && d <= today).reduce((s, [, x]) => s + (x.worked || 0), 0);
  $('#cal-kicker').textContent = `${y}${weekWorked ? ` · ${dur(weekWorked)} worked this week` : ''}`;
  $('#cal-today').hidden = calMonth === monthOf(today) && calDay === today;

  let html = '';
  for (let i = 0; i < cellsCount; i++) {
    const d = PC.addDays(start, i);
    const st = stats[d] || {};
    const future = d > today;
    const heat = st.worked ? Math.round(16 + 64 * Math.min(1, st.worked / busiest)) : 0;
    const ratio = st.planned ? Math.min(1, (st.done || 0) / st.planned) : 0;
    const reps = d >= today ? repeatsOn(d, today, nowMin()).length : 0;
    const dots = Math.min(3, future || d === today ? (st.sessions || 0) - (st.skipped || 0) : 0);
    const marks = '<i class="dot-p"></i>'.repeat(Math.max(0, dots)) + (reps && !st.sessions ? '<i class="dot-r"></i>' : '') + (st.entries ? '<i class="dot-j"></i>' : '');
    const C = 2 * Math.PI * 7;
    const ring = !future && st.planned ? `<svg class="cal-ring" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="#2A2F38" stroke-width="2.5"/>${ratio ? `<circle cx="9" cy="9" r="7" fill="none" stroke="#5CC8A6" stroke-width="2.5" stroke-dasharray="${(ratio * C).toFixed(1)} ${C.toFixed(1)}" stroke-linecap="round" transform="rotate(-90 9 9)"/>` : ''}</svg>` : '';
    const label = [longDate(d), st.worked ? `${fmtMin(st.worked)} worked` : '', !future && st.planned ? `${Math.round(ratio * 100)}% of plan done` : '', st.entries ? 'journal' : '', st.due ? `${st.due} due` : '', future && st.sessions ? `${st.sessions} planned` : '', reps ? `${reps} repeating` : ''].filter(Boolean).join(', ');
    html += `<button class="cal-cell${monthOf(d) !== calMonth ? ' out' : ''}${d === today ? ' today' : ''}${d === calDay ? ' sel' : ''}${future ? ' future' : ''}"
      data-date="${d}" aria-label="${esc(label)}" aria-pressed="${d === calDay}">
      <span class="cal-top"><span class="cal-num disp">${Number(d.slice(8))}</span>${ring}</span>
      <span class="cal-bot">${examsOn(d).length ? '<span class="due-tag exam">exam</span>' : st.due ? '<span class="due-tag">due</span>' : ''}<span class="cal-marks">${marks}</span></span>
    </button>`;
  }
  $('#cal-grid').innerHTML = html;
  renderCalDay(stats);
}

// Repeating tasks due on day d that don't have a session there yet (shown faintly, so the habit is visible ahead).
function repeatsOn(d, today, now) {
  if (d < today) return [];
  const wd = PC.weekday(d), blocks = liveRows('blocks');
  return liveRows('tasks').filter(t => {
    const r = t.status === 'open' && PC.cleanRepeat(t.repeat);
    if (!r || !r.days.includes(wd) || blocks.some(b => b.task_id === t.id && b.date === d)) return false;
    return d > today || !r.time || PC.toMin(r.time) > now;
  }).map(t => ({ t, time: PC.cleanRepeat(t.repeat).time })).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
}

function renderCalDay(stats) {
  const d = calDay, today = localDate(), now = nowMin();
  const st = stats[d] || { planned: 0, done: 0, logged: 0, worked: 0, sessions: 0, skipped: 0 };
  const blocks = liveRows('blocks').filter(b => b.date === d).sort((a, b) => a.start_min - b.start_min);
  const due = liveRows('tasks').filter(t => t.deadline === d).sort(byDue);
  const entries = liveRows('entries').filter(e => e.entry_date === d).sort((a, b) => a.created_at - b.created_at);
  const notes = Object.values(data.observations).filter(o => !o.deleted && !o._locked && o.status === 'confirmed' && o.kind === 'activity'
    && entries.some(e => e.id === o.entry_id)).map(parse);

  let sum;
  if (d > today) sum = blocks.length ? `<span class="key-num">${fmtMin(st.planned)}</span> planned · ${blocks.length} session${blocks.length > 1 ? 's' : ''}` : 'Nothing planned yet.';
  else {
    const parts = [];
    if (st.planned || st.done) parts.push(`<span class="key-num good">${fmtMin(st.done) || '0 min'}</span> done of ${fmtMin(st.planned) || '0 min'} planned`);
    if (st.skipped) parts.push(`${st.skipped} skipped`);
    if (st.logged && !st.planned) parts.push(`<span class="key-num">${fmtMin(st.logged)}</span> from your journal`);
    sum = parts.join(' · ') || (entries.length ? 'No sessions this day.' : 'Nothing recorded this day.');
  }

  const chip = b => {
    if (b.status === 'done') return `<span class="chip done">Done · ${fmtMin(b.actual_minutes) || '0 min'}</span>`;
    if (b.status === 'skipped') return `<span class="chip skipped">Skipped${b.reason ? ' · ' + esc(b.reason) : ''}</span>`;
    if (b.started_at) return '<span class="chip done">Running</span>';
    if (d < today || (d === today && b.end_min <= now)) return '<span class="chip missed">No update</span>';
    return '<span class="chip">Planned</span>';
  };

  let h = `<h2>${esc(longDate(d))}${d === today ? ' <span class="chip done">Today</span>' : ''}</h2><p class="cal-sum">${sum}</p>`;
  const movable = b => b.status === 'planned' && !b.started_at && (d > today || (d === today && b.start_min >= now));
  if (blocks.length) {
    h += '<div class="cal-sec"><h3>Sessions</h3>' + blocks.map(b => calForm?.mode === 'edit' && calForm.id === b.id
      ? sessionForm(b)
      : `<div class="cal-row"><span class="main">${esc(taskTitle(b))}</span><span class="sub"><span class="t">${hm(b.start_min)} – ${hm(b.end_min)}</span>${chip(b)}${movable(b)
          ? `<span class="cal-acts"><button data-cal="edit" data-bid="${esc(b.id)}" aria-label="Change time">✎</button><button data-cal="remove" data-bid="${esc(b.id)}" aria-label="Remove">✕</button></span>` : ''}</span></div>`).join('') + '</div>';
  }
  const reps = repeatsOn(d, today, now);
  if (reps.length) {
    h += '<div class="cal-sec"><h3>Repeating</h3>' + reps.map(({ t, time }) =>
      `<div class="cal-row rep"><span class="main">${esc(t.title)}</span><span class="sub"><span class="t">${time || 'any time'}</span><span class="chip">↻ ${esc(repeatShort(t.repeat))}</span></span></div>`).join('')
      + '<p class="muted small">Not in your plan yet. "Make my plan" puts it in at its usual time.</p></div>';
  }
  if (d >= today) {
    h += calForm?.mode === 'add' ? sessionForm(null) : '<button class="link cal-add" data-cal="add">+ Add a session on this day</button>';
  }
  const ex = examsOn(d);
  if (ex.length) {
    h += '<div class="cal-sec"><h3>Exam</h3>' + ex.map(x => `<div class="cal-row"><span class="main">${esc(x.name)}</span><span class="sub">${x.status === 'done' ? '<span class="chip done">Done</span>' : `<span class="chip exam">${d === today ? 'Today' : d > today ? `in ${daysTo(d)} day${daysTo(d) === 1 ? '' : 's'}` : 'How did it go? See Today'}</span>`}${x.subject ? `<span class="chip">#${esc(x.subject)}</span>` : ''}</span></div>`).join('') + '</div>';
  }
  if (due.length) {
    h += '<div class="cal-sec"><h3>Due</h3>' + due.map(t =>
      `<div class="cal-row"><span class="main">${esc(t.title)}</span><span class="sub">${t.status === 'open' ? (d < today ? '<span class="chip skipped">Overdue</span>' : '<span class="chip">Open</span>') : '<span class="chip done">Finished</span>'}</span></div>`).join('') + '</div>';
  }
  if (notes.length && !blocks.length) {
    h += '<div class="cal-sec"><h3>From your journal</h3>' + notes.map(n =>
      `<div class="cal-row"><span class="main">${esc(n.task || '')}</span><span class="sub"><span class="chip">${[fmtMin(n.minutes), OUTCOME[n.outcome]].filter(Boolean).join(' · ') || 'noted'}</span></span></div>`).join('') + '</div>';
  }
  if (entries.length) {
    h += '<div class="cal-sec"><h3>Journal</h3>' + entries.map(e =>
      `<div class="cal-entry" role="button" tabindex="0"><span class="muted small">${timeLabel(e.created_at)}${e.energy ? ' · ' + ENERGY[e.energy] : ''}</span><div class="txt">${e._locked ? '🔒 Private entry. Unlock your journal to read it.' : esc(e.body)}</div></div>`).join('') + '</div>';
  }
  if (!blocks.length && !due.length && !entries.length && !reps.length && !calForm) {
    h += `<p class="muted small">${d > today ? 'Tap "Make my plan" in Plan to fill upcoming days.' : 'A quiet day. Nothing was planned or written.'}</p>`;
  }
  $('#cal-day').innerHTML = h;
}

$('#view-calendar').addEventListener('click', e => {
  const cell = e.target.closest('[data-date]');
  if (cell) {
    calDay = cell.dataset.date;
    if (monthOf(calDay) !== calMonth) calMonth = monthOf(calDay);
    renderCalendar();
    return;
  }
  const entry = e.target.closest('.cal-entry');
  if (entry) { entry.classList.toggle('open'); return; }
  const btn = e.target.closest('[data-cal]');
  if (!btn) return;
  const act = btn.dataset.cal;
  // Changing month moves the day card with it: today in this month, otherwise the 1st.
  if (act === 'prev' || act === 'next') {
    calMonth = shiftMonth(calMonth, act === 'prev' ? -1 : 1);
    calDay = monthOf(localDate()) === calMonth ? localDate() : `${calMonth}-01`;
  }
  if (act === 'today') { calDay = localDate(); calMonth = monthOf(calDay); }
  if (act === 'add') calForm = { mode: 'add' };
  if (act === 'edit') calForm = { mode: 'edit', id: btn.dataset.bid };
  if (act === 'cancel') calForm = null;
  if (act === 'save') { if (!saveSession()) return; }
  if (act === 'remove') {
    const b = data.blocks[btn.dataset.bid];
    const before = { ...b };
    b.deleted = 1;
    put('blocks', b);
    persist(); sync();
    toast('Session removed.', 'Undo', () => { put('blocks', { ...before, deleted: 0, updated_at: data.blocks[b.id].updated_at }); persist(); renderCalendar(); sync(); });
  }
  if (['prev', 'next', 'today'].includes(act)) calForm = null;
  renderCalendar();
});

$('#view-calendar').addEventListener('change', e => {
  if (e.target.id === 'cf-task') $('#cf-new').hidden = e.target.value !== '__new';
});

// Form for adding a session on the selected day, or moving one (b = the session being moved).
function sessionForm(b) {
  const d = calDay, today = localDate();
  let start = b ? b.start_min : null, len = b ? b.end_min - b.start_min : 60;
  if (!b) {
    const slot = PC.nextSlot({ blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'),
      today: d, nowMin: d === today ? nowMin() : 0, length: len });
    start = slot && slot.date === d ? slot.start_min : 18 * 60;
  }
  const tasks = liveRows('tasks').filter(t => t.status === 'open').sort(byDue);
  return `<div class="cal-form">
    ${b ? `<div class="small"><b>${esc(taskTitle(b))}</b></div>` : `<label>Task <select id="cf-task">
      ${tasks.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}<option value="__new"${tasks.length ? '' : ' selected'}>New task…</option></select></label>
      <input id="cf-new" maxlength="120" placeholder="Name of the new task"${tasks.length ? ' hidden' : ''}>`}
    <div class="trow-meta"><label>Start <input type="time" id="cf-start" value="${PC.toHHMM(start)}"></label>
      <label>Length <input type="number" id="cf-len" min="10" max="480" step="5" inputmode="numeric" value="${len}"> min</label></div>
    <p class="error small" id="cf-msg"></p>
    <div class="row"><button class="primary" data-cal="save">${b ? 'Move it' : 'Add'}</button><button data-cal="cancel">Cancel</button></div>
  </div>`;
}

function saveSession() {
  const msg = t => { $('#cf-msg').textContent = t; return false; };
  const startStr = $('#cf-start').value;
  if (!startStr) return msg('Pick a start time.');
  const start = PC.toMin(startStr);
  const len = Math.max(10, Math.min(480, parseInt($('#cf-len').value, 10) || 60));
  if (start + len > 1440) return msg('That runs past midnight. Start earlier or make it shorter.');
  if (calDay === localDate() && start < nowMin() - 5) return msg('That time has already passed today.');
  let b;
  if (calForm.mode === 'edit') {
    b = data.blocks[calForm.id];
    Object.assign(b, { start_min: start, end_min: start + len });
    put('blocks', b);
  } else {
    let taskId = $('#cf-task')?.value;
    if (!taskId || taskId === '__new') {
      const title = ($('#cf-new')?.value || '').trim().slice(0, 120);
      if (!title) return msg('Give the new task a name.');
      const t = fresh({ goal: null, title, notes: null, category: 'other', est_minutes: len, deadline: null, priority: 2, status: 'open', done_at: null, repeat: null });
      put('tasks', t);
      taskId = t.id;
    }
    b = fresh({ task_id: taskId, date: calDay, start_min: start, end_min: start + len, status: 'planned', actual_minutes: null, started_at: null, reason: null });
    put('blocks', b);
  }
  const clash = liveRows('blocks').find(x => x.id !== b.id && x.date === calDay && x.status !== 'skipped' && x.start_min < b.end_min && b.start_min < x.end_min);
  calForm = null;
  persist();
  sync();
  toast(clash ? `Saved. Note: it overlaps "${taskTitle(clash)}" at ${hm(clash.start_min)}.` : `Saved for ${dayLabel(calDay)}, ${hm(start)}.`);
  return true;
}

$('#view-calendar').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.cal-entry')) e.target.classList.toggle('open');
});

// Swipe left/right on the month to change months (phone).
let swipeX = null;
$('#cal-grid').addEventListener('touchstart', e => { swipeX = e.touches[0].clientX; }, { passive: true });
$('#cal-grid').addEventListener('touchend', e => {
  if (swipeX == null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) < 60) return;
  calMonth = shiftMonth(calMonth, dx < 0 ? 1 : -1);
  renderCalendar();
}, { passive: true });
