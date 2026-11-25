// Today and Plan screens, the "My week" editor, and turning preferences into planning rules.
// Loaded after app.js and shares its helpers (data, put/sync, esc, dayLabel, fmtMin...).
'use strict';

const PC = window.PlannerCore;
// Times follow your clock setting (Settings → My week): "1:30 pm" or "13:30".
const clock12 = () => PC.cleanRoutine(data.settings?.routine).clock === 12;
function hm(m) {
  if (!clock12()) return PC.toHHMM(m);
  m = Math.round(m); const h = Math.floor(m / 60) % 24, mm = String(m % 60).padStart(2, '0');
  return `${h % 12 || 12}:${mm} ${h < 12 || m >= 1440 ? 'am' : 'pm'}`;
}
const PRI = { 1: 'High', 2: 'Normal', 3: 'Low' };
const SKIP_REASONS = ['No time', 'Too tired', 'Something came up', 'Task unclear', "Didn't feel like it"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
// Sessions belong to a task: once the task is deleted (or missing), its sessions are gone everywhere.
const liveRowsNow = t => Object.values(data[t]).filter(x => !x.deleted
  && (t !== 'blocks' || (data.tasks[x.task_id] && !data.tasks[x.task_id].deleted)));
// While a screen is being drawn nothing changes, so each table is filtered once per draw instead of once per row.
// (A year of data drew the Plan list in about 220 ms before this; see withRows.)
let rowCache = null;
const liveRows = t => {
  if (!rowCache) return liveRowsNow(t);
  let r = rowCache.get(t);
  if (!r) rowCache.set(t, r = liveRowsNow(t));
  return r.slice();
};
// A task's sessions; during a draw, from an index built once.
const blocksOf = id => {
  if (!rowCache) return liveRowsNow('blocks').filter(b => b.task_id === id);
  let m = rowCache.get('byTask');
  if (!m) {
    m = new Map();
    for (const b of liveRows('blocks')) { if (!m.has(b.task_id)) m.set(b.task_id, []); m.get(b.task_id).push(b); }
    rowCache.set('byTask', m);
  }
  return (m.get(id) || []).slice();
};
function withRows(fn) {
  if (rowCache) return fn();
  rowCache = new Map();
  try { return fn(); } finally { rowCache = null; }
}
const elapsed = b => Math.max(1, Math.round((Date.now() - b.started_at) / 60000));
const taskTitle = b => { const t = data.tasks[b.task_id]; return t && !t.deleted ? t.title : 'Deleted task'; };
const shortGoal = g => g.split(/[.\n]/)[0].trim().slice(0, 60);

function put(table, row) {
  row.updated_at = nextTime(row);
  data[table][row.id] = row;
  markDirty(table, row.id);
}
function fresh(fields) {
  return { id: crypto.randomUUID(), created_at: Date.now(), updated_at: 0, deleted: 0, ...fields };
}
const spentNow = id => blocksOf(id).filter(b => b.status === 'done')
  .reduce((s, b) => s + (b.actual_minutes ?? b.end_min - b.start_min), 0);
// Minutes done on a task. During a draw, one pass over the sessions answers it for every task.
const spentOn = id => {
  if (!rowCache) return spentNow(id);
  let m = rowCache.get('spent');
  if (!m) {
    m = new Map();
    for (const b of rowCache.get('blocks') || liveRows('blocks')) if (b.status === 'done') m.set(b.task_id, (m.get(b.task_id) || 0) + (b.actual_minutes ?? b.end_min - b.start_min));
    rowCache.set('spent', m);
  }
  return m.get(id) || 0;
};

// Removes a finished/deleted task's future sessions so the time frees up.
function dropFutureBlocks(taskId) {
  const today = localDate(), now = nowMin(), removed = [];
  for (const b of liveRows('blocks')) {
    if (b.task_id === taskId && b.status === 'planned' && !b.started_at && (b.date > today || (b.date === today && b.start_min >= now))) {
      removed.push({ ...b });
      b.deleted = 1;
      put('blocks', b);
    }
  }
  return removed;
}

function finishTask(id) {
  const t = data.tasks[id];
  if (!t) return;
  Object.assign(t, { status: 'done', done_at: Date.now() });
  put('tasks', t);
  const n = dropFutureBlocks(id).length;
  const msg = n ? `Task finished. Freed up its ${n} other planned session${n > 1 ? 's' : ''}.` : 'Task finished.';
  const spec = cleanRevise(t.revise), isRev = /^revise:/i.test(t.title);
  if (t.repeat || isRev) return toast(msg);
  if (spec) {
    const ids = addRevisions(t, spec);
    return toast(`${msg} Revision planned ${reviseLabel(spec)} from now.`, 'Undo', () => undoRevisions(ids));
  }
  if (t.category === 'study') {
    return toast(`${msg} Revise it later?`, 'Add revision', () => {
      const ids = addRevisions(t, REVISE_DEFAULT);
      persist(); safeRender(); sync();
      toast(`Revision planned ${reviseLabel(REVISE_DEFAULT)} from now.`, 'Undo', () => undoRevisions(ids));
    });
  }
  toast(msg);
}

// ---------- revision ----------
// A study task can ask for short revision sessions after it's finished: 1 day, 1 week and 1 month later by default.
const REVISE_DEFAULT = '1,7,30';
const cleanRevise = v => typeof v === 'string' && /^\d{1,3}(,\d{1,3}){0,5}$/.test(v) ? v : null;
const defaultRevise = cat => cat === 'study' ? REVISE_DEFAULT : null;
function reviseLabel(v) {
  const parts = (cleanRevise(v) || '').split(',').map(Number).map(n => n === 1 ? '1 day' : n % 30 === 0 ? `${n / 30} month${n > 30 ? 's' : ''}`
    : n % 7 === 0 ? `${n / 7} week${n > 7 ? 's' : ''}` : `${n} days`);
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts.join('');
}

function addRevisions(t, spec) {
  const today = localDate(), ids = [];
  for (const n of spec.split(',').map(Number)) {
    const start = PC.addDays(today, n);
    const task = fresh({ goal: t.goal || null, title: ('Revise: ' + t.title).slice(0, 120), notes: null, category: 'study', est_minutes: 30,
      deadline: PC.addDays(start, n < 7 ? 1 : n < 30 ? 2 : 5), start_date: start, priority: 2, status: 'open', done_at: null, repeat: null, revise: null });
    put('tasks', task);
    const slot = PC.nextSlot({ blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'), today: start, nowMin: 0, length: 30 });
    if (slot) put('blocks', fresh({ task_id: task.id, ...slot, status: 'planned', actual_minutes: null, started_at: null, reason: null }));
    ids.push(task.id);
  }
  return ids;
}

function undoRevisions(ids) {
  for (const id of ids) {
    const x = data.tasks[id];
    if (x) { x.deleted = 1; put('tasks', x); }
    for (const b of liveRows('blocks')) if (b.task_id === id) { b.deleted = 1; put('blocks', b); }
  }
  persist(); safeRender(); sync();
}

// ---------- how far ahead "Make my plan" looks ----------
const HORIZONS = [[7, '1 week'], [14, '2 weeks'], [30, '1 month'], [91, '3 months'], [182, '6 months'], [365, '1 year']];
// Plan ahead: stored with your week in Settings, so phone and laptop agree. The old per-device value is only a fallback.
let horizonLocal = (() => { try { const v = Number(localStorage.getItem('pl.horizon')); return HORIZONS.some(h => h[0] === v) ? v : 7; } catch { return 7; } })();
const horizonNow = () => { const v = data.settings?.routine?.horizon; return HORIZONS.some(h => h[0] === v) ? v : horizonLocal; };
const horizonLabel = () => HORIZONS.find(h => h[0] === horizonNow())[1];
const horizonSelect = () => `<label class="horizon">Plan ahead <select id="p-horizon">${HORIZONS.map(([v, l]) =>
  `<option value="${v}"${v === horizonNow() ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;

// ---------- Today ----------

let todayPanel = null;   // { id, kind: 'done' | 'skip' } while answering

// ---------- Today: the day as a 24-hour dial ----------

let openSession = null;
let nextAll = false, needsAll = false, finishedOpen = false;     // the session row whose buttons are showing

const DC = 220, RING = 162;
const f1 = n => n.toFixed(1);
let dialSpan = 1440;
const dialPt = (r, m) => { const a = m / dialSpan * 2 * Math.PI; return [DC + r * Math.sin(a), DC - r * Math.cos(a)]; };
function arcD(r, m1, m2, reverse) {
  const [x1, y1] = dialPt(r, reverse ? m2 : m1), [x2, y2] = dialPt(r, reverse ? m1 : m2);
  return `M${f1(x1)} ${f1(y1)}A${r} ${r} 0 ${m2 - m1 > dialSpan / 2 ? 1 : 0} ${reverse ? 0 : 1} ${f1(x2)} ${f1(y2)}`;
}
const dur = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h${r ? ' ' + String(r).padStart(2, '0') : ''}` : `${r}m`; };
const blen = b => b.end_min - b.start_min;
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  // Under 100 minutes: mm:ss (so an hour reads 60:00, never "1:00"). Longer: h:mm.
  return s >= 6000 ? `${h}:${String(m).padStart(2, '0')}` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

function dialSvg(todays, now, running, focus, routine, empty) {
  const r = PC.cleanRoutine(routine);
  // 12-hour: like a wall clock, showing 2 hours back and 10 ahead. 24-hour: the whole day, midnight at the top.
  const twelve = r.clock === 12;
  dialSpan = twelve ? 720 : 1440;
  const winS = twelve ? Math.max(0, now - 120) : 0, winE = twelve ? Math.min(1440, now + 600) : 1440;
  const clip = (a, b) => [Math.max(a, winS), Math.min(b, winE)];
  const vis = b => b.end_min > winS && b.start_min < winE;
  let s = `<circle cx="220" cy="220" r="140" fill="#14171C" stroke="#1E222A" stroke-width="1.5"/>
    <circle cx="220" cy="220" r="${RING}" fill="none" stroke="#1C2027" stroke-width="20"/>`;
  if (now - winS > 2) s += `<path d="${arcD(RING, winS, now)}" fill="none" stroke="#15181D" stroke-width="20"/>`;
  const [ws, we] = clip(PC.toMin(r.start), PC.toMin(r.end));
  if (we > ws) s += `<path d="${arcD(178, ws, we)}" fill="none" stroke="#4A5160" stroke-width="3" stroke-linecap="round"${empty ? ' stroke-dasharray="2 10"' : ''}/>`;
  for (let h = 0; h < 24; h += twelve ? 1 : 3) {
    if (twelve && h >= 12) break;
    const major = twelve ? h % 3 === 0 : h % 6 === 0, [x1, y1] = dialPt(major ? 184 : 188, h * 60), [x2, y2] = dialPt(major ? 198 : 194, h * 60);
    s += `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${major ? '#9AA0AA' : '#3A4150'}" stroke-width="${major ? 2.5 : 2}" stroke-linecap="round"/>`;
  }
  for (const [h, m] of twelve ? [['12', 0], ['3', 180], ['6', 360], ['9', 540]] : [['00', 0], ['06', 360], ['12', 720], ['18', 1080]]) {
    const [x, y] = dialPt(126, m);
    s += `<text x="${f1(x)}" y="${f1(y)}" text-anchor="middle" dominant-baseline="central" font-family="Geist Mono, monospace" font-size="15" fill="#5B6270">${h}</text>`;
  }
  let arcBid = '';
  const arc = (a1, a2, color, op) => {
    const [m1, m2] = clip(a1, a2);
    if (m2 - m1 < 1) return '';
    const inset = Math.min(dialSpan / 144, (m2 - m1) * 0.3);
    return `<path class="arc"${arcBid ? ` data-bid="${arcBid}"` : ''} d="${arcD(RING, m1 + inset, Math.max(m1 + inset + 0.5, m2 - inset))}" fill="none" stroke="${color}" stroke-width="20" stroke-linecap="round"${op ? ` opacity="${op}"` : ''}/>`;
  };
  for (const b of todays) {
    arcBid = esc(b.id);
    const missed = b.status === 'planned' && !b.started_at && b.end_min <= now;
    if (b.status === 'done') s += arc(b.start_min, b.end_min, '#5CC8A6');
    else if (b.status === 'skipped') s += arc(b.start_min, b.end_min, '#E58A78', .45);
    else if (b === running && b.date === localDate()) {
      s += arc(b.start_min, b.end_min, '#F2A93B', .28);
      s += arc(b.start_min, Math.min(Math.max(now, b.start_min + 5), b.end_min), '#F2A93B');
    } else if (b === focus) s += arc(b.start_min, b.end_min, '#F2A93B', .55);
    else s += arc(b.start_min, b.end_min, missed ? '#3A4150' : '#5B6270');
  }
  // Labels along the outside, for the sessions that matter most, never crowding each other.
  const order = [running, focus, ...todays.filter(b => b.status === 'planned' && b !== running && b !== focus && b.end_min > now), ...todays.filter(b => b.status === 'done')];
  const used = [], defs = [], texts = [];
  const q = dialSpan / 4;
  for (const b of order) {
    if (!b || used.length >= 4 || blen(b) < 20 || !vis(b)) continue;
    const [c1, c2] = clip(b.start_min, b.end_min), mid = (c1 + c2) / 2;
    if (used.some(u => Math.min(Math.abs(u - mid), dialSpan - Math.abs(u - mid)) < dialSpan * 0.12)) continue;
    used.push(mid);
    const ph = ((mid % dialSpan) + dialSpan) % dialSpan, bottom = ph > q && ph < 3 * q, id = 'dl' + used.length, half = dialSpan * 0.104;
    defs.push(`<path id="${id}" d="${arcD(bottom ? 210 : 201, mid - half, mid + half, bottom)}"/>`);
    const t = taskTitle(b), name = t.length > 13 ? t.slice(0, 12).trim() + '…' : t;
    const hot = b === running || b === focus;
    texts.push(`<text font-family="Geist, sans-serif" font-size="17"${hot ? ' font-weight="600"' : ''} fill="${hot ? '#F2C27A' : b.status === 'done' ? '#9AA0AA' : '#ECEAE4'}"><textPath href="#${id}" startOffset="50%" text-anchor="middle">${esc(name)}</textPath></text>`);
  }
  const [hx1, hy1] = dialPt(146, now), [hx2, hy2] = dialPt(200, now), [dx, dy] = dialPt(RING, now);
  s += texts.join('') + `<line x1="${f1(hx1)}" y1="${f1(hy1)}" x2="${f1(hx2)}" y2="${f1(hy2)}" stroke="#ECEAE4" stroke-width="3" stroke-linecap="round"/>
    <circle class="hand-dot${running ? ' running' : ''}" cx="${f1(dx)}" cy="${f1(dy)}" r="10" fill="${running || empty ? '#F2A93B' : '#ECEAE4'}" stroke="#0F1115" stroke-width="4"/>`;
  return `<defs>${defs.join('')}</defs>${s}`;
}

function rowHtml(b, today, now) {
  const t = data.tasks[b.task_id];
  const missed = b.status === 'planned' && !b.started_at && (b.date < today || b.end_min <= now);
  const open = openSession === b.id || missed || todayPanel?.id === b.id;
  let meta = dur(blen(b));
  if (b.date !== today) meta = esc(dayLabel(b.date)) + ' · ' + meta;
  // The due date gets its own line, and only when it's a different day from the session.
  let due = '';
  if (t?.deadline && b.status === 'planned' && t.deadline !== b.date) {
    const soon = t.deadline <= PC.addDays(today, 2);
    due = `<span class="li-due${soon ? ' amber' : ''}">Due ${esc(t.deadline === today ? 'today' : dayLabel(t.deadline))}</span>`;
  }
  let state = '';
  if (b.status === 'done') state = `<span class="chip done">✓ ${dur(b.actual_minutes ?? blen(b))} done</span>`;
  else if (b.status === 'skipped') state = `<span class="chip skipped">skipped</span>`;
  else if (missed) state = '';
  let btns = '';
  if (b.status === 'planned') btns = missed
    ? '<button data-tact="done">Yes, done</button><button class="bare" data-tact="skip">Didn\'t happen</button><button class="bare" data-tact="later">Move it</button>'
    : t?.category === 'reminder'
      ? '<button class="primary" data-tact="done">Done</button><button class="bare" data-tact="later">Later</button>'
    : blocksOf(b.task_id).some(x => x.id !== b.id && x.status === 'planned' && x.started_at)
      ? '<button data-tact="done">Done</button><button class="bare" data-tact="skip">Skip</button><button class="bare" data-tact="later">Later</button>'
      : '<button class="primary" data-tact="start">Start</button><button data-tact="done">Done</button><button class="bare" data-tact="skip">Skip</button><button class="bare" data-tact="later">Later</button>';
  else btns = '<button class="bare" data-tact="undo">↺ Undo</button>';
  const panel = todayPanel?.id === b.id ? (todayPanel.kind === 'done' ? donePanel(b) : skipPanel()) : '';
  const hs = t?.habit ? habitInfo(t) : null;
  if (hs && hs.count > 1 && b.status === 'planned' && !missed) btns = habitPlusBtn(t, hs) + btns.replace('<button class="primary" data-tact="start">Start</button>', '');
  return `<div class="li-row ${b.status}${missed ? ' missed' : ''}${open ? ' open' : ''}" data-bid="${esc(b.id)}">
    <button class="li-main" data-tact="toggle" aria-expanded="${open}">
      <span class="li-time disp">${hm(b.start_min).replace(/ (am|pm)$/, '<small>$1</small>')}</span>
      <span class="li-body"><span class="li-title">${esc(t && !t.deleted ? t.title : 'Deleted task')}</span>${state ? '' : `<span class="li-meta">${meta}</span>`}${due}${state ? `<span class="li-state">${state}</span>` : ''}</span>
    </button>
    ${open && !panel ? `<div class="li-acts">${btns}</div>` : ''}${panel}${hs ? habitStrip(t, hs) : ''}
  </div>`;
}

function weekRings(today) {
  const d0 = new Date(today + 'T00:00:00'), mon = PC.addDays(today, -((d0.getDay() + 6) % 7));
  const blocks = liveRows('blocks');
  return Array.from({ length: 7 }, (_, i) => {
    const d = PC.addDays(mon, i), list = blocks.filter(b => b.date === d && b.status !== 'skipped');
    const plan = list.reduce((s, b) => s + blen(b), 0), done = list.filter(b => b.status === 'done').reduce((s, b) => s + (b.actual_minutes ?? blen(b)), 0);
    const ratio = plan ? Math.min(1, done / plan) : 0, C = 2 * Math.PI * 11;
    const ring = d > today
      ? `<circle cx="14" cy="14" r="11" fill="none" stroke="${plan ? '#3A4150' : '#1E222A'}" stroke-width="3" stroke-dasharray="${plan ? '3 4' : '0'}"/>`
      : `<circle cx="14" cy="14" r="11" fill="none" stroke="#1E222A" stroke-width="3"/>${ratio ? `<circle cx="14" cy="14" r="11" fill="none" stroke="${d === today ? '#F2A93B' : '#5CC8A6'}" stroke-width="3" stroke-dasharray="${f1(ratio * C)} ${f1(C)}" stroke-linecap="round" transform="rotate(-90 14 14)"/>` : ''}`;
    return `<div><svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">${ring}</svg><span class="${d === today ? 'amber' : ''}">${'MTWTFSS'[i]}</span></div>`;
  }).join('');
}

// Today = the main screen, then the extra pieces from more.js (exams, habits, reminders) and a quiet
// request for the AI's suggested times (at most every 10 minutes).
function renderToday() {
  withRows(() => {
    renderTodayMain();
    renderExamStrip();
    renderTodayHabits();
  });
  setTimeout(refreshAiTimes, 1500);
}
function renderTodayMain() {
  const today = localDate(), now = nowMin(), d = new Date();
  $('#today-kicker').textContent = `${d.toLocaleDateString('en-GB', { weekday: 'long' })} · week ${isoWeek(d)}`;
  $('#today-date').textContent = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const blocks = liveRows('blocks');
  const todays = blocks.filter(b => b.date === today).sort((a, b) => a.start_min - b.start_min);
  const from = PC.addDays(today, -3);
  const earlier = blocks.filter(b => b.status === 'planned' && !b.started_at && b.date < today && b.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);

  const running = blocks.find(b => b.status === 'planned' && b.started_at);
  const upcoming = todays.filter(b => b.status === 'planned' && !b.started_at && b.end_min > now);
  const missed = todays.filter(b => b.status === 'planned' && !b.started_at && b.end_min <= now);
  const finished = todays.filter(b => b.status !== 'planned');
  const focus = running || upcoming[0] || null;
  const plannedMin = todays.filter(b => b.status !== 'skipped').reduce((s, b) => s + blen(b), 0);
  const doneMin = todays.filter(b => b.status === 'done').reduce((s, b) => s + (b.actual_minutes ?? blen(b)), 0)
    + (running ? Math.max(0, Math.round((Date.now() - running.started_at) / 60000)) : 0);
  const left = upcoming.filter(b => b !== focus).length + (running ? 0 : upcoming.length ? 1 : 0);

  $('#today-sum').innerHTML = todays.length ? `
    <div><span class="disp good">${dur(doneMin)}</span><span class="mono">done</span></div>
    <div><span class="disp">${dur(plannedMin)}</span><span class="mono">planned</span></div>
    <div><span class="disp">${running ? upcoming.length : left}</span><span class="mono">${running ? 'left after this' : 'left today'}</span></div>` : '';
  $('#today-sum').hidden = !todays.length;
  $('#today-week').innerHTML = `<p class="lbl">This week</p><div class="week-rings">${weekRings(today)}</div>`;

  // The dial and what's in the middle of it.
  const empty = !todays.length;
  const st = running ? 'running' : focus ? 'next' : empty ? 'free' : 'done';
  const base = midnight();
  let center = '', below = '';
  if (st === 'running') {
    const end = running.started_at + blen(running) * 60000, mins = Math.round((Date.now() - running.started_at) / 60000);
    const endMin = Math.round((end - base) / 60000);
    center = `<p class="lbl amber">Now · ${hm(now)}</p><p class="dial-title">${esc(taskTitle(running))}</p>
      <p class="disp dial-big" id="dial-count" data-to="${end}" data-mode="left"></p><p class="mono dial-sub">ends ${endMin < 1440 ? hm(endMin) : 'after midnight'}${mins >= 1 ? ` · ${mins}m in` : ''}</p>`;
    below = `<button data-tact="stop">Stop</button><button class="primary" data-tact="done">Finish</button>`;
  } else if (st === 'next') {
    center = `<p class="lbl">Next · ${hm(focus.start_min)}</p>
      <p class="disp dial-big" id="dial-count" data-to="${base + focus.start_min * 60000}" data-mode="until"></p><p class="mono dial-sub">${focus.start_min <= now ? 'starts now' : 'until it starts'}</p>`;
    below = `<p class="focus-title">${esc(taskTitle(focus))} <span class="muted">· ${dur(blen(focus))}</span></p>
      <div class="focus-btns">${taskOf(focus)?.category === 'reminder' ? '<button data-tact="later">Later</button><button class="primary" data-tact="done">Done</button>' : '<button data-tact="skip">Skip</button><button class="primary" data-tact="start">Start now</button>'}</div>`;
  } else if (st === 'free') {
    const waiting = typeof todoItems === 'function' ? todoItems().length : 0;
    center = `<p class="lbl${waiting ? ' amber' : ''}">${waiting ? 'Nothing on the clock' : 'Free day'}</p><p class="disp dial-big" id="dial-count" data-mode="clock"></p><p class="mono dial-sub${waiting ? ' amber' : ''}">${waiting ? `${waiting} task${waiting > 1 ? 's' : ''} need a time` : 'nothing planned'}</p>`;
    below = `<button class="primary" data-tact="write">Write about today</button>`;
  } else {
    center = `<p class="lbl good">Done for today</p><p class="disp dial-big">${dur(doneMin)}</p><p class="mono dial-sub">of ${dur(plannedMin)} planned</p>`;
    below = `<button class="primary" data-tact="write">Write about today</button>`;
  }
  if (st === 'running' || st === 'free' || st === 'done') below = `<div class="focus-btns">${below}</div>`;
  const fb = st === 'running' ? running : st === 'next' ? focus : null;
  if (fb && todayPanel?.id === fb.id) below = todayPanel.kind === 'done' ? donePanel(fb) : skipPanel();
  const aria = st === 'running' ? `Running now: ${taskTitle(running)}.` : st === 'next' ? `Next: ${taskTitle(focus)} at ${hm(focus.start_min)}.` : st === 'free' ? 'Nothing planned.' : 'Everything for today is done.';
  $('#today-dial').innerHTML = `<div class="dial st-${st}">
      <svg viewBox="-10 -10 460 460" role="img" aria-label="Your day as a 24-hour dial. ${esc(aria)}">${dialSvg(todays, now, running, st === 'next' ? focus : null, data.settings?.routine, empty)}</svg>
      <div class="dial-center">${center}</div>
    </div>`;
  $('#today-focus').innerHTML = below;
  $('#today-focus').dataset.bid = fb ? fb.id : '';
  tickDial();

  // Lists: up next (minus the one in the dial), what still needs an answer, and what's finished.
  const nextList = upcoming.filter(b => b !== focus);
  const needs = [...earlier, ...missed];
  const nShown = nextAll ? nextList : nextList.slice(0, 4), aShown = needsAll ? needs : needs.slice(0, 3);
  const doneMinList = finished.filter(b => b.status === 'done').reduce((s, b) => s + (b.actual_minutes ?? blen(b)), 0);
  $('#today-list').innerHTML = (nextList.length ? `<section class="t-sec"><div class="sec-head"><h2 class="lbl">Up next</h2><button class="link" data-tact="replan">Replan</button></div>
      <div class="list-card">${nShown.map(b => rowHtml(b, today, now)).join('')}</div>
      ${nextList.length > nShown.length ? `<button class="bare more-btn" data-tact="morenext">${nextList.length - nShown.length} more later today</button>` : ''}</section>` : '')
    + (needs.length ? `<section class="t-sec"><div class="sec-head"><h2 class="lbl amber">Needs an answer · ${needs.length}</h2></div>
      <div class="list-card">${aShown.map(b => rowHtml(b, today, now)).join('')}</div>
      ${needs.length > aShown.length ? `<button class="bare more-btn" data-tact="moreneeds">Show ${needs.length - aShown.length} more</button>` : ''}</section>` : '');
  $('#today-earlier').innerHTML = finished.length ? `<section class="t-sec">
      <button class="done-sum" data-tact="togglefinished" aria-expanded="${finishedOpen}"><span class="good">✓</span> ${finished.filter(b => b.status === 'done').length} done today${doneMinList ? ' · ' + dur(doneMinList) : ''}${finished.some(b => b.status === 'skipped') ? ` · ${finished.filter(b => b.status === 'skipped').length} skipped` : ''}<span class="chev">${finishedOpen ? '▴' : '▾'}</span></button>
      ${finishedOpen ? `<div class="list-card quiet">${finished.map(b => rowHtml(b, today, now)).join('')}</div>` : ''}</section>` : '';
  $('#today-next').hidden = true;
  // ("Write about today" lives under the clock now.)
  renderChecklist();
  renderTodo();
}

// Tap a session on the dial: its row opens in the list below (with Start / Done / Skip / Later).
$('#today-dial').addEventListener('click', e => {
  const bid = e.target.closest('[data-bid]')?.dataset.bid;
  if (!bid || bid === $('#today-focus').dataset.bid) return;
  openSession = bid;
  renderToday();
  const row = $(`#view-today .li-row[data-bid="${CSS.escape(bid)}"]`);
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row?.classList.add('flash');
});

// The countdown in the dial ticks every second without redrawing anything else.
const buzz = () => { try { navigator.vibrate?.(12); } catch {} };
function tickDial() {
  const el = $('#dial-count');
  const run = liveRows('blocks').find(b => b.status === 'planned' && b.started_at);
  if (run) {
    const left = run.started_at + blen(run) * 60000 - Date.now();
    document.title = `${left >= 0 ? clock(left) : '+' + clock(-left)} · ${taskTitle(run)}`;
  } else if (document.title !== 'Planner') document.title = 'Planner';
  if (!el) return;
  const mode = el.dataset.mode, to = Number(el.dataset.to);
  if (mode === 'clock') { el.innerHTML = hm(nowMin()).replace(/ (am|pm)$/, '<small>$1</small>'); return; }
  const ms = to - Date.now();
  if (mode === 'left') el.textContent = ms >= 0 ? clock(ms) : '+' + clock(-ms);
  else el.textContent = ms > 0 ? (ms >= 3600000 ? clock(ms) : String(Math.ceil(ms / 60000)) + 'm') : 'now';
  el.classList.toggle('over', mode === 'left' && ms < 0);
}
setInterval(tickDial, 1000);

function donePanel(b) {
  const guess = b.started_at ? elapsed(b) : b.end_min - b.start_min;
  const at = b.started_at ? (() => { const d = new Date(b.started_at); return d.getHours() * 60 + d.getMinutes(); })() : b.start_min;
  return `<div class="panel">
    <div class="fld-row">
      <label class="fld"><span>Started at</span><input type="time" id="dp-at" class="mono" value="${PC.toHHMM(at)}"></label>
      <label class="fld"><span>Time spent (min)</span><input type="number" id="dp-min" class="mono" min="0" max="1440" inputmode="numeric" value="${guess}"></label>
    </div>
    <p class="muted small">Change these if it happened at a different time than planned.</p>
    ${data.tasks[b.task_id]?.repeat ? '' : '<label class="check"><input type="checkbox" id="dp-finished"> The whole task is finished</label>'}
    <div class="row"><button class="primary" data-tact="savedone">Save</button><button data-tact="cancel">Cancel</button></div></div>`;
}
function skipPanel() {
  return `<div class="panel"><div class="small muted">What got in the way? (optional)</div>
    <div class="chips">${SKIP_REASONS.map(r => `<button data-tact="skipwhy" data-why="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    <div class="row"><button data-tact="skipwhy" data-why="">Just skip</button><button data-tact="cancel">Cancel</button></div></div>`;
}

$('#view-today').addEventListener('click', e => {
  const btn = e.target.closest('button[data-tact]');
  if (!btn) return;
  const act = btn.dataset.tact;
  if (act === 'goplan') return show('plan');
  if (act === 'write') { show('journal'); $('#composer').focus(); return; }
  if (act === 'replan') { show('plan'); startProposal(); renderPlan(); $('#proposal-card').scrollIntoView({ block: 'start' }); return; }
  if (act === 'week') return show('log');
  if (act === 'morenext') { nextAll = true; renderToday(); return; }
  if (act === 'planwaiting') {
    const n = planAllTodo(todoItems());
    persist(); renderToday(); sync();
    toast(n ? `Planned ${n} task${n > 1 ? 's' : ''} at the suggested times.` : 'No free time left today. Pick times in "Not on the clock".');
    return;
  }
  if (act === 'moreneeds') { needsAll = true; renderToday(); return; }
  if (act === 'togglefinished') { finishedOpen = !finishedOpen; renderToday(); return; }
  const bid = btn.closest('[data-bid]')?.dataset.bid;
  if (act === 'toggle') { openSession = openSession === bid ? null : bid; renderToday(); return; }
  const b = data.blocks[bid];
  if (!b) return;
  if (act === 'start') {
    const other = liveRows('blocks').find(x => x.status === 'planned' && x.started_at && x.id !== b.id);
    if (other) { toast(`Finish or stop "${taskTitle(other)}" first.`); return; }
    const t0 = nowMin(), len = b.end_min - b.start_min, today = localDate();
    if (b.date !== today || Math.abs(b.start_min - t0) > 5) {
      const was = `${b.date === today ? '' : dayLabel(b.date) + ' '}${hm(b.start_min)}`;
      Object.assign(b, { date: today, start_min: t0, end_min: Math.min(1440, t0 + len) });
      toast(`Started now, so it runs ${hm(b.start_min)}–${hm(b.end_min)} (was ${was}).`);
    }
    b.started_at = Date.now();
    put('blocks', b);
    buzz();
  }
  if (act === 'stop') { b.started_at = null; put('blocks', b); }
  // A reminder is just ticked off: no "how long did it take".
  if (act === 'done' && data.tasks[b.task_id]?.category === 'reminder') {
    const t = data.tasks[b.task_id];
    Object.assign(b, { status: 'done', actual_minutes: 0, started_at: null }); put('blocks', b);
    Object.assign(t, { status: 'done', done_at: Date.now() }); put('tasks', t);
    persist(); sync(); renderToday(); buzz();
    toast(`"${t.title}" done.`);
    return;
  }
  if (act === 'done' || act === 'skip') todayPanel = { id: b.id, kind: act };
  if (act === 'cancel') todayPanel = null;
  if (act === 'savedone') {
    const m = Math.max(0, Math.min(1440, parseInt($('#dp-min').value, 10) || 0));
    // Record when it really happened, so the dial, Calendar and Week show the true time.
    const at = /^\d\d:\d\d$/.test($('#dp-at')?.value || '') ? PC.toMin($('#dp-at').value) : null;
    if (at !== null) Object.assign(b, { start_min: at, end_min: Math.min(1440, at + Math.max(m, 5)) });
    Object.assign(b, { status: 'done', actual_minutes: m, started_at: null });
    put('blocks', b);
    if (data.tasks[b.task_id]?.habit) habitFill(b.task_id, b.date);
    if ($('#dp-finished')?.checked) finishTask(b.task_id);
    buzz();
    todayPanel = null;
  }
  if (act === 'skipwhy') {
    Object.assign(b, { status: 'skipped', reason: btn.dataset.why || null, started_at: null });
    put('blocks', b);
    todayPanel = null;
  }
  if (act === 'undo') {
    Object.assign(b, { status: 'planned', actual_minutes: null, reason: null, started_at: null });
    put('blocks', b);
  }
  if (act === 'later') {
    const slot = PC.nextSlot({
      blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'),
      today: localDate(), nowMin: nowMin(), length: b.end_min - b.start_min, skipId: b.id,
      afterMin: b.date === localDate() ? b.start_min : 0,
    });
    if (!slot) toast('No free slot in the next 7 days. Try "Replan from now" or raise your daily limit.');
    else { Object.assign(b, slot); put('blocks', b); toast(`Moved to ${dayLabel(slot.date)}, ${hm(slot.start_min)}.`); }
  }
  persist();
  renderToday();
  if (!['done', 'skip', 'cancel'].includes(act)) sync();
});

// Keep timers and "next up" fresh.
// Don't redraw while the person is answering something or typing a time in the to-do card.
const todayBusy = () => !!todayPanel || $('#todo').contains(document.activeElement);
setInterval(() => { if (!$('#view-today').hidden && !todayBusy()) renderToday(); }, 30000);

// ---------- Plan ----------

let draft = null;      // goal being turned into tasks: { stage: 'questions' | 'review', goal, questions, goalName, tasks, note }
let proposal = null;   // { r, today, now }
let editTask = null;
let showDone = false;
let goalOpen = false;

const planBusy = () => !!draft || !!editTask || $('#view-plan').contains(document.activeElement);

function renderPlan() {
  withRows(() => {
    renderGoalCard();
    renderProposal();
    renderJournalTasks();
    renderTaskList();
  });
}

function goalDraft() { try { return localStorage.getItem('pl.goal') || ''; } catch { return ''; } }

function renderGoalCard() {
  const aiOn = !!data.settings?.ai_provider;
  let h;
  $('#goal-card').classList.toggle('cta', !draft && !goalOpen && !goalDraft());
  if (!draft && !goalOpen && !goalDraft()) {
    h = `<button class="goal-cta" data-pact="opengoal"><span class="goal-ico" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24"><path d="M4 6h7M4 12h10M4 18h6"/><path d="M16 15l3 3 3-3M19 6v12"/></svg></span>
      <span class="goal-txt"><b>Got a bigger goal?</b><span>${aiOn ? 'Describe it and get it split into tasks' : 'Write it down and add its tasks'}</span></span><span class="goal-go">Break it down</span></button>`;
  } else if (!draft) {
    h = `<p class="lbl">Break it down</p>
      <textarea id="goal-text" rows="3" placeholder="e.g. Finish the machining unit before mid-sems. Notes are half done.">${esc(goalDraft())}</textarea>
      <div class="row">${aiOn ? '<button class="primary" data-pact="breakdown">Break it down</button>' : ''}<button data-pact="manual">Add tasks by hand</button><button class="bare" data-pact="closegoal">Cancel</button></div>
      ${aiOn ? '' : '<p class="muted small">Set up an AI in Settings to get tasks suggested for you.</p>'}`;
  } else if (draft.stage === 'questions') {
    h = `<p class="lbl">Break it down</p><h2 class="big">A few questions</h2><p class="muted small">Answer what you can. Blank is fine.</p><blockquote class="goal-quote">${esc(draft.goal)}</blockquote>`
      + draft.questions.map((q, i) => `<label>${esc(q)}<input data-q="${i}" maxlength="500"></label>`).join('')
      + '<div class="row"><button class="primary" data-pact="answer">Continue</button><button data-pact="skipq">Skip questions</button><button data-pact="canceldraft">Cancel</button></div>';
  } else {
    h = `<p class="lbl">Break it down</p><h2 class="big">Check the tasks</h2>${draft.note ? `<p class="muted small">${esc(draft.note)}</p>` : ''}
      <label>Group name <input id="draft-goal" maxlength="80" value="${esc(draft.goalName || '')}"></label>
      <div id="draft-rows">${draft.tasks.map(taskRowHtml).join('')}</div>
      <button class="link" data-pact="addrow">+ Add a task</button>
      <label class="small check"><input type="checkbox" id="draft-revise" checked> Add revision to study tasks after you finish them (1 day, 1 week and 1 month later)</label>
      <div class="row"><button class="primary" data-pact="savedraft">Save tasks</button><button data-pact="canceldraft">Cancel</button></div>`;
  }
  $('#goal-card').innerHTML = h;
}

const EFFORT = { 1: 'Light', 2: 'Normal', 3: 'Hard' };
const effortSelect = (cls, v) => `<select class="${cls}" aria-label="Effort">${[1, 2, 3].map(e => `<option value="${e}"${e === (v || 2) ? ' selected' : ''}>${EFFORT[e]}</option>`).join('')}</select>`;
// #thermo in a title -> subject "thermo"; the tag is taken out of the title.
function splitTag(text) {
  const m = String(text || '').match(/#([\p{L}\p{N}_-]{1,40})/u);
  return { subject: m ? m[1].toLowerCase() : null, title: m ? String(text).replace(m[0], '').replace(/\s{2,}/g, ' ').trim() : String(text || '').trim() };
}
const subjectRatesNow = () => {
  if (rowCache?.has('rates')) return rowCache.get('rates');
  const r = PC.subjectRates(liveRows('tasks'), Object.values(data.blocks).filter(b => !b.deleted), localDate());
  rowCache?.set('rates', r);
  return r;
};

function taskRowHtml(t) {
  return `<div class="trow">
    <input class="t-title" maxlength="120" value="${esc(t.title || '')}" placeholder="Task">
    <div class="t-meta">
      <input class="t-min" type="number" min="5" max="480" inputmode="numeric" value="${t.minutes || 60}" aria-label="Minutes"> min
      <input class="t-due" type="date" value="${esc(t.deadline || '')}" aria-label="Deadline">
      <select class="t-pri" aria-label="Priority">${[1, 2, 3].map(p => `<option value="${p}"${p === (t.priority || 2) ? ' selected' : ''}>${PRI[p]}</option>`).join('')}</select>
      ${effortSelect('t-eff', t.effort)}
      <button data-pact="rmrow" aria-label="Remove task">✕</button>
    </div>
    ${t.done_when ? `<div class="muted small">Done when: ${esc(t.done_when)}</div>` : ''}
    <input type="hidden" class="t-cat" value="${esc(t.category || 'other')}"><input type="hidden" class="t-notes" value="${esc(t.done_when || '')}">
  </div>`;
}

function readDraftRows() {
  return $$('#draft-rows .trow').map(el => ({
    title: el.querySelector('.t-title').value.trim().slice(0, 120),
    minutes: Math.min(480, Math.max(5, parseInt(el.querySelector('.t-min').value, 10) || 60)),
    deadline: el.querySelector('.t-due').value || null,
    priority: Number(el.querySelector('.t-pri').value) || 2,
    category: PC.CATEGORIES.includes(el.querySelector('.t-cat').value) ? el.querySelector('.t-cat').value : 'other',
    done_when: el.querySelector('.t-notes').value || null,
    effort: Number(el.querySelector('.t-eff')?.value) || 2,
  }));
}
function keepDraftEdits() {
  draft.tasks = readDraftRows();
  draft.goalName = $('#draft-goal').value;
}

// "Break it down" on a journal plan: send the whole entry to the goal breakdown, then plan the topics.
// The single task the ✓ made (e.g. "Machining topics") is replaced by the topic tasks when you save them.
let splitSource = null;
function splitFromJournal(o, entry) {
  if (!entry || entry._locked) return;
  if (!data.settings?.ai_provider) { toast('Set up AI in Settings first.'); return; }
  splitSource = { taskId: parse(o).task_id || null, obsId: o.id };
  draft = null;
  goalOpen = true;
  try { localStorage.setItem('pl.goal', entry.body.slice(0, 6000)); } catch {}
  show('plan');
  const box = $('#goal-text');
  if (box) box.value = entry.body.slice(0, 6000);
  $('#goal-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  breakDown();
}

async function breakDown(opts = {}) {
  const goal = draft?.goal || $('#goal-text')?.value.trim() || goalDraft().trim();
  if (!goal) { $('#goal-text')?.focus(); return; }
  const btn = $('#goal-card button.primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  try {
    const r = await api('/api/plan/breakdown', {
      method: 'POST',
      body: { goal, today: localDate(), answers: opts.answers || [], noQuestions: !!opts.noQuestions },
    });
    if (r.questions) draft = { stage: 'questions', goal, questions: r.questions };
    else draft = {
      stage: 'review', goal, goalName: r.goal || shortGoal(goal), subject: r.subject || splitTag(goal).subject,
      tasks: r.tasks.length ? r.tasks : [{ title: '' }],
      note: r.tasks.length ? 'Change anything that looks off, then save.' : 'No tasks were suggested. Add them here.',
    };
  } catch (err) {
    toast(err.message === 'Failed to fetch' ? 'You need internet for this.' : err.message);
  }
  renderPlan();
}

function saveGoalTasks() {
  const rows = readDraftRows().filter(r => r.title);
  if (!rows.length) { toast('Add at least one task.'); return; }
  const goal = ($('#draft-goal')?.value || '').trim().slice(0, 80) || null;
  const base = Date.now(), rev = !!$('#draft-revise')?.checked;
  // Topics in order with their own deadlines: each waits until the one before is due, so the work spreads over the period.
  let prevDue = null;
  const subj = draft?.subject || null;
  const fromEntry = splitSource ? data.observations[splitSource.obsId]?.entry_id || null : null;
  rows.forEach((r, i) => put('tasks', fresh({ entry_id: fromEntry, revise: rev ? defaultRevise(r.category) : null, subject: subj, effort: r.effort === 2 ? null : r.effort,
    start_date: (() => { const s = prevDue && r.deadline && prevDue < r.deadline && prevDue > localDate() ? prevDue : null; if (r.deadline) prevDue = r.deadline; return s; })(),
    goal, title: r.title, notes: r.done_when ? 'Done when: ' + r.done_when : null, category: r.category,
    est_minutes: r.minutes, deadline: r.deadline, priority: r.priority, status: 'open', done_at: null, repeat: null, created_at: base + i,
  })));
  draft = null;
  try { localStorage.removeItem('pl.goal'); } catch {}
  // Came from a journal plan: retire its one big task, and point the note at the new topics.
  const src = splitSource; splitSource = null;
  if (src) {
    const old = src.taskId && data.tasks[src.taskId];
    if (old && !blocksOf(old.id).some(b => b.status === 'done')) { dropFutureBlocks(old.id); old.deleted = 1; put('tasks', old); }
    const o = data.observations[src.obsId];
    if (o) { const d = parse(o); d.task_id = 'split'; setObs(o, { data: JSON.stringify(d), status: 'confirmed' }); }
  }
  persist();
  sync();
  renderPlan();
  toast(`${rows.length} task${rows.length > 1 ? 's' : ''} saved.`, 'Make my plan', () => { startProposal(); renderProposal(); $('#proposal-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}

// --- proposal ---

function startProposal(maxMinutes) {
  const today = localDate(), now = nowMin();
  const r = PC.makePlan({
    tasks: liveRows('tasks'), blocks: liveRows('blocks'), routine: data.settings?.routine,
    prefs: liveRows('prefs'), today, nowMin: now, days: horizonNow(), maxMinutes, subjectMult: Object.fromEntries(Object.entries(subjectRatesNow()).map(([k, v]) => [k, v.rate])),
  });
  proposal = { r, today, now, last: PC.addDays(today, horizonNow() - 1) };
}

async function saveHorizon(v) {
  const routine = { ...(data.settings?.routine || {}), horizon: v };
  data.settings = { ...(data.settings || {}), routine };
  persist();
  try { data.settings = (await api('/api/settings', { method: 'PUT', body: { routine } })).settings; persist(); }
  catch { toast("Saved on this device. It'll reach your other devices once you're online."); }
}

// Seven bars: finished time in green, planned time in grey (or the plan you're previewing in amber), against your daily limit.
function weekBars(perDay, kicker) {
  const today = localDate(), routine = PC.cleanRoutine(data.settings?.routine);
  const lim = proposal?.r?.maxMinutes || routine.maxMinutes;
  const days = Array.from({ length: 7 }, (_, i) => PC.addDays(today, i));
  const done = {}, planned = {};
  for (const b of liveRows('blocks')) {
    if (!days.includes(b.date)) continue;
    if (b.status === 'done') done[b.date] = (done[b.date] || 0) + (b.actual_minutes ?? blen(b));
    else if (b.status === 'planned' && !perDay) planned[b.date] = (planned[b.date] || 0) + blen(b);
  }
  const plan = perDay || planned;
  const sum = o => days.reduce((n, d) => n + (o[d] || 0), 0);
  const tDone = sum(done), tPlan = sum(plan), used = days.filter(d => done[d] || plan[d]).length;
  const wd = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase();
  const md = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const pct = m => Math.min(100, Math.round(m / lim * 100));
  const bars = days.map(d => {
    const dm = done[d] || 0, pm = plan[d] || 0, m = dm + pm, full = m >= lim - 5, off = routine.daysOff.includes(PC.weekday(d));
    return `<div class="gauge"><div class="tube${full ? ' full' : ''}${!m && off ? ' off' : ''}"><div class="lvl-stack">
      <div class="lvl plan${perDay ? ' new' : ''}" style="height:${pct(pm)}%"></div><div class="lvl done" style="height:${pct(dm)}%"></div></div></div>
      <span class="mono${dm && !pm ? ' good' : full ? ' amber' : ''}">${m ? dur(m) : '—'}</span><span class="mono muted">${d === today ? 'TODAY' : wd(d)}</span></div>`;
  }).join('');
  const aria = days.map(d => `${wd(d)} ${done[d] ? dur(done[d]) + ' done' : ''} ${plan[d] ? dur(plan[d]) + ' planned' : ''}`.trim()).join(', ');
  return `<div class="pw-head"><div><p class="lbl">${kicker}</p>
      <p class="pw-total"><span class="disp good">${dur(tDone) || '0m'}</span> <span class="muted">done</span> <span class="muted">·</span> <span class="disp${perDay ? ' amber' : ''}">${dur(tPlan) || '0m'}</span> <span class="muted">${perDay ? 'in this plan' : 'planned'}</span></p>
      <p class="muted small">across ${used} day${used === 1 ? '' : 's'} · limit ${dur(lim)} a day</p></div><span class="mono muted">${md(days[0])} – ${md(days[6])}</span></div>
    <div class="gauges" role="img" aria-label="Time per day against your ${dur(lim)} limit: ${aria}">${bars}</div>
    <div class="gauge-key mono"><span><i class="k done"></i>done</span><span><i class="k plan${perDay ? ' new' : ''}"></i>${perDay ? 'this plan' : 'planned'}</span></div>`;
}

function renderProposal() {
  const open = liveRows('tasks').filter(t => t.status === 'open').length;
  const defaults = data.settings?.routine ? '' : '<p class="muted small">Using default hours (09:00–22:00, 6 h a day). Set your real week in Settings → My week.</p>';
  if (!proposal) {
    $('#proposal-card').innerHTML = `${weekBars(null, 'Next 7 days')}
      <p class="muted small">${open
        ? `${open} open task${open > 1 ? 's' : ''}. The planner fits them into your free time over the next ${horizonLabel()}, following My week and Things to know about me.`
        : 'Add tasks first, then make a plan.'}</p>
      ${open ? horizonSelect() + '<button class="primary" data-pact="makeplan">Make my plan</button>' : ''}${defaults}`;
    return;
  }
  const { r } = proposal;
  const name = id => `"${esc(data.tasks[id]?.title || 'Task')}"`;
  const warns = r.warnings.map(w => {
    if (w.kind === 'overdue') return `${name(w.task_id)} was due ${esc(dayLabel(w.deadline))}. Planned as soon as possible.`;
    if (w.kind === 'avoid') return `${name(w.task_id)} uses ${esc(dayLabel(w.date))}, a time you'd rather not work, to make its deadline.`;
    if (w.kind === 'short') return `${name(w.task_id)}: about ${fmtMin(w.minutes)} won't fit before ${esc(dayLabel(w.deadline))}. Raise the daily limit, move the deadline or cut the task down.`;
    return `${name(w.task_id)}: ${fmtMin(w.minutes)} didn't fit in the next ${horizonLabel()}.`;
  });
  const days = new Map();
  for (const b of r.blocks) { if (!days.has(b.date)) days.set(b.date, []); days.get(b.date).push(b); }
  let h = `${weekBars(r.perDay, 'Proposed week')}
    <div class="stepper"><span>Daily limit</span><button data-pact="less" aria-label="Lower the daily limit">−</button><b>${fmtMin(r.maxMinutes)}</b><button data-pact="more" aria-label="Raise the daily limit">+</button></div>
    <p class="muted small">Lower it for a lighter week, raise it to push harder.</p>${horizonSelect()}${defaults}`;
  if (warns.length) h += `<ul class="warns">${warns.map(x => `<li>${x}</li>`).join('')}</ul>`;
  h += `<div class="row pw-btns"><button class="primary" data-pact="apply"${r.blocks.length ? '' : ' disabled'}>Save this plan</button><button data-pact="less">Lower daily limit</button><button class="bare" data-pact="cancelplan">Cancel</button></div><p class="lbl pw-days">Day by day</p>`;
  if (!r.blocks.length) h += `<p class="muted small">Nothing to schedule in the next ${horizonLabel()}.</p>`;
  // Long plans: the first two weeks in detail, then one line per month.
  const detailEnd = PC.addDays(proposal.today, 14), later = new Map();
  for (const b of r.blocks) {
    if (b.date < detailEnd) continue;
    const m = b.date.slice(0, 7), x = later.get(m) || { n: 0, min: 0, tasks: {} };
    const title = data.tasks[b.task_id]?.title || 'Task';
    x.n++; x.min += b.end_min - b.start_min; x.tasks[title] = (x.tasks[title] || 0) + 1;
    later.set(m, x);
  }
  for (const [d, list] of days) {
    if (d >= detailEnd) continue;
    h += `<div class="pday"><div class="day-label">${esc(dayLabel(d))} · ${fmtMin(r.perDay[d])}</div>`
      + list.map(b => `<div class="pblock"><span class="muted">${hm(b.start_min)}–${hm(b.end_min)}</span>${esc(data.tasks[b.task_id]?.title || '')}</div>`).join('') + '</div>';
  }
  if (later.size) {
    h += '<div class="pday"><div class="day-label">After that</div>' + [...later].map(([m, x]) =>
      `<div class="pblock"><span class="muted">${esc(new Date(m + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }))}</span>${x.n} sessions · ${fmtMin(x.min)} · ${
        Object.entries(x.tasks).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${esc(t)} ×${n}`).join(', ')}</div>`).join('') + '</div>';
  }
  $('#proposal-card').innerHTML = h;
}

function applyProposal() {
  const { r, today, now, last } = proposal;
  // Replace exactly what the proposal was allowed to replace: future sessions in its range that haven't started.
  for (const b of liveRows('blocks')) {
    if (b.status === 'planned' && !b.started_at && b.date <= last && (b.date > today || (b.date === today && b.start_min >= now))) {
      b.deleted = 1;
      put('blocks', b);
    }
  }
  for (const nb of r.blocks) put('blocks', fresh({ ...nb, status: 'planned', actual_minutes: null, started_at: null, reason: null }));
  proposal = null;
  persist();
  sync();
  show('today');
  toast(`Plan saved: ${r.blocks.length} session${r.blocks.length === 1 ? '' : 's'} over the next ${horizonLabel()}.`);
}

// --- plans mentioned in the journal ---

function journalIntentions() {
  const since = PC.addDays(localDate(), -1);
  return Object.values(data.observations)
    .filter(o => !o.deleted && !o._locked && o.kind === 'intention' && o.status === 'confirmed' && data.entries[o.entry_id] && !data.entries[o.entry_id].deleted)
    .map(o => ({ o, d: parse(o) }))
    .filter(x => !x.d.task_id && (!x.d.date || x.d.date >= since));
}

function renderJournalTasks() {
  const list = journalIntentions();
  const card = $('#journal-tasks');
  card.hidden = !list.length;
  card.innerHTML = list.length ? '<h2>From your journal</h2><p class="muted small">Plans you mentioned. Add them as tasks so they get time.</p>'
    + list.map(x => `<div class="jt" data-oid="${esc(x.o.id)}"><span>${esc(x.d.task || '')}${x.d.date ? ` <span class="muted small">· ${esc(dayLabel(x.d.date))}</span>` : ''}</span>
      <span class="row-inline"><button data-pact="jadd">Add as task</button><button data-pact="jdismiss" aria-label="Dismiss">✕</button></span></div>`).join('') : '';
}

// --- task list ---

const byDue = (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.priority - b.priority || a.created_at - b.created_at;

// Plan: Today (everything happening today, finished ones ticked), This week (repeating tasks and their progress),
// Other tasks (open one-offs), Finished (folded).
function weekProgress(t) {
  const r = PC.cleanRepeat(t.repeat);
  if (!r) return null;
  const today = localDate(), ws = PC.weekStart(today), we = PC.addDays(ws, 6);
  const mine = blocksOf(t.id).filter(b => b.date >= ws && b.date <= we);
  const done = mine.filter(b => b.status === 'done').length;
  const target = r.per_week || r.days.length;
  return { done, target, text: `${done} of ${target} this week` };
}

function renderTaskList() {
  const tasks = liveRows('tasks'), today = localDate(), soon = PC.addDays(today, 7);
  const todays = liveRows('blocks').filter(b => b.date === today);
  const onToday = new Set(todays.map(b => b.task_id));
  const open = tasks.filter(t => t.status === 'open').sort(byDue);
  const doneToday = tasks.filter(t => t.status === 'done' && t.done_at && new Date(t.done_at).toLocaleDateString('en-CA') === today);
  const todayList = [...open.filter(t => onToday.has(t.id) || (!t.repeat && t.deadline === today)), ...doneToday.filter(t => !onToday.has(t.id) || true)]
    .filter((t, i, a) => a.indexOf(t) === i)
    .sort((x, y) => (firstToday(x, todays) ?? 9999) - (firstToday(y, todays) ?? 9999));
  const inToday = new Set(todayList.map(t => t.id));
  const rep = open.filter(t => t.repeat && !inToday.has(t.id));
  const other = open.filter(t => !t.repeat && !inToday.has(t.id));
  const done = tasks.filter(t => t.status !== 'open' && !inToday.has(t.id));
  $('#p-kicker').textContent = open.length ? `${open.filter(t => !t.repeat).length} task${open.filter(t => !t.repeat).length === 1 ? '' : 's'} · ${open.filter(t => t.repeat).length} repeating` : 'Nothing open';
  const sec = (title, list, sub = '') => list.length ? `<section class="tgroup"><h2 class="lbl">${esc(title)}${sub ? ` <span class="muted">${sub}</span>` : ''}</h2><div class="list-card">${list.join('')}</div></section>` : '';
  let h = '';
  h += sec('Today', todayList.map(t => taskHtml(t, todays.filter(b => b.task_id === t.id))), todayList.length ? `${todayList.filter(t => t.status === 'done' || todays.some(b => b.task_id === t.id && b.status === 'done')).length} of ${todayList.length} done` : '');
  h += sec('This week', rep.map(t => taskHtml(t)));
  const groups = new Map([['Due soon', []]]);
  for (const t of other) {
    const g = t.deadline && t.deadline <= soon ? 'Due soon' : t.goal || (t.deadline ? 'Later' : 'No deadline');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  for (const k of ['Later', 'No deadline']) if (groups.has(k)) { const v = groups.get(k); groups.delete(k); groups.set(k, v); }
  if (other.length) {
    h += '<h2 class="lbl tgroup-head">Other tasks</h2>';
    for (const [g, list] of groups) if (list.length) h += `<section class="tgroup sub"><h3 class="lbl">${esc(g)}</h3><div class="list-card">${list.map(t => taskHtml(t)).join('')}</div></section>`;
  }
  if (!h) h = '<div class="card empty-card"><p>No open tasks.</p><p class="muted small">Add one above, or break down a bigger goal.</p></div>';
  if (done.length) {
    h += `<button class="bare" data-pact="toggledone">${showDone ? 'Hide' : 'Show'} finished (${done.length})</button>`;
    if (showDone) {
      h += '<div class="list-card quiet">' + done.sort((a, b) => (b.done_at || 0) - (a.done_at || 0)).slice(0, 50).map(t =>
        `<div class="task done-task" data-tid="${esc(t.id)}"><span class="ring-ok" aria-hidden="true">✓</span><div class="task-main"><div class="t-title">${esc(t.title)}</div></div><button class="bare" data-pact="reopen">Reopen</button></div>`).join('') + '</div>';
    }
  }
  $('#task-list').innerHTML = h;
}
function firstToday(t, todays) { const m = todays.filter(b => b.task_id === t.id).map(b => b.start_min); return m.length ? Math.min(...m) : null; }

function ringSvg(ratio, color, dashed) {
  const C = 87.96;
  return `<svg class="ring" viewBox="0 0 36 36" width="34" height="34" aria-hidden="true">${dashed
    ? '<circle cx="18" cy="18" r="14" fill="none" stroke="#6B5428" stroke-width="2" stroke-dasharray="3 4"/>'
    : `<circle cx="18" cy="18" r="14" fill="none" stroke="${color === '#F2A93B' ? '#2E2614' : '#1E222A'}" stroke-width="4"/>${ratio > 0 ? `<circle cx="18" cy="18" r="14" fill="none" stroke="${color}" stroke-width="4" stroke-dasharray="${(Math.min(1, ratio) * C).toFixed(1)} ${C}" stroke-linecap="round" transform="rotate(-90 18 18)"/>` : ''}`}</svg>`;
}

function taskHtml(t, todayBlocks) {
  if (editTask === t.id) return taskEditHtml(t);
  // In the Today section: today's session time and whether it's done.
  if (todayBlocks) {
    const wp = weekProgress(t);
    const finished = t.status === 'done' || (todayBlocks.length && todayBlocks.every(b => b.status === 'done'));
    const times = todayBlocks.filter(b => b.status !== 'skipped').map(b => `${hm(b.start_min)}${b.status === 'done' ? ' ✓' : b.started_at ? ' · now' : ''}`).join(', ');
    const nxt = !times && blocksOf(t.id).filter(b => b.status === 'planned' && b.date > localDate()).sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min)[0];
    const doneB = todayBlocks.filter(b => b.status === 'done');
    const dueToday = t.deadline === localDate();
    const when = finished
      ? `<span class="good">done${doneB.length ? ` · ${hm(Math.min(...doneB.map(b => b.start_min)))}–${hm(Math.max(...doneB.map(b => b.end_min)))}` : ''}</span>`
      : t.category === 'reminder' ? `reminder${times ? ' · ' + times : ''}`
      : times || (nxt ? `${dueToday ? 'due today · ' : ''}<span class="amber">booked ${esc(dayLabel(nxt.date))}, ${hm(nxt.start_min)}</span>` : dueToday ? 'due today · <span class="amber">no time yet</span>' : '');
    const meta = [when, wp ? wp.text : '', t.subject ? `<span class="subj">#${esc(t.subject)}</span>` : ''].filter(Boolean).join(' · ');
    return `<div class="task${finished ? ' today-done' : ''}" data-tid="${esc(t.id)}" data-pact="edit" role="button" tabindex="0">
      ${finished ? '<span class="ring-ok" aria-hidden="true">✓</span>' : ringSvg(spentOn(t.id) / Math.max(1, t.est_minutes), '#5CC8A6', !todayBlocks.length)}
      <div class="task-main"><div class="t-title">${esc(t.title)}</div><div class="meta">${meta}</div></div></div>`;
  }
  const today = localDate(), spent = spentOn(t.id);
  const mine = blocksOf(t.id).filter(b => b.status === 'planned');
  const running = mine.some(b => b.started_at), planned = mine.filter(b => b.date >= today).length;
  let icon, meta, pill = '';
  if (t.repeat) {
    const r = PC.cleanRepeat(t.repeat), n = r ? r.days.length : 0;
    icon = '<span class="rep-ico" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"/></svg></span>';
    const wp = weekProgress(t);
    meta = `${esc(repeatShort(t.repeat))}${r?.time ? ' · ' + hm(PC.toMin(r.time)) : ''} · ${dur(t.est_minutes)} each`;
    pill = wp ? `<span class="due-pill${wp.done >= wp.target ? ' ok' : ''}">${wp.done}/${wp.target}</span>` : '';
  } else {
    icon = running || planned || spent ? ringSvg(spent / Math.max(1, t.est_minutes), running ? '#F2A93B' : '#5CC8A6') : ringSvg(0, '', true);
    const rate = t.subject && subjectRatesNow()[t.subject]?.rate;
    meta = (t.subject ? `<span class="subj">#${esc(t.subject)}</span> · ` : '') + (t.effort === 3 ? '<span class="eff hard">hard</span> · ' : t.effort === 1 ? '<span class="eff light">light</span> · ' : '')
      + (spent ? `${dur(spent)} of ~${dur(t.est_minutes)}` : `~${dur(t.est_minutes)}`) + (rate ? ` <span class="muted">(you: ~${dur(Math.round(t.est_minutes * rate))})</span>` : '')
      + (running ? ' · <span class="amber">running now</span>' : planned ? ` · ${planned} planned` : ' · <span class="amber">not planned yet</span>')
      + (t.start_date && t.start_date > today ? ` · from ${esc(dayLabel(t.start_date))}` : '')
      + (cleanRevise(t.revise) ? ' · revision after' : '');
    if (t.deadline) {
      const over = t.deadline < today, near = t.deadline <= PC.addDays(today, 2);
      const lab = over ? 'overdue' : t.deadline === today ? 'today' : new Date(t.deadline + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
      pill = `<span class="due-pill${over ? ' over' : near ? ' soon' : ''}">${lab}</span>`;
    }
  }
  return `<div class="task" data-tid="${esc(t.id)}" data-pact="edit" role="button" tabindex="0">
    ${icon}<div class="task-main"><div class="t-title">${esc(t.title)}</div><div class="meta">${meta}</div></div>${pill}</div>`;
}

function taskEditHtml(t) {
  const f = (label, input, cls = '') => `<label class="fld${cls}"><span>${label}</span>${input}</label>`;
  const rep = !!PC.cleanRepeat(t.repeat);
  return `<div class="task editing" data-tid="${esc(t.id)}" data-repeat="${rep ? 'yes' : 'no'}">
    <p class="lbl">Edit task${spentOn(t.id) ? ` · <span class="mono">${dur(spentOn(t.id))} done</span>` : ''}</p>
    ${f('Task', `<input class="e-title" maxlength="120" value="${esc(t.title)}">`)}
    <div class="fld"><span>How often</span>${howOftenHtml({ repeat: t.repeat, time: true, streak: true, habit: t.habit })}</div>
    <div class="fld-row">
      ${f('How long (min)', `<input class="e-min mono" type="number" min="5" max="1440" inputmode="numeric" value="${t.est_minutes}">`)}
      ${f('Due', `<input class="e-due mono" type="date" value="${esc(t.deadline || '')}">`, ' once-only')}
      ${f('Subject', `<input class="e-subj mono" list="subject-list" maxlength="40" placeholder="e.g. thermo" value="${esc(t.subject ? '#' + t.subject : '')}">`)}
    </div>
    <datalist id="subject-list">${[...new Set(liveRows('tasks').map(x => x.subject).filter(Boolean))].map(x => `<option value="#${esc(x)}">`).join('')}</datalist>
    ${(() => { const r = t.subject && subjectRatesNow()[t.subject]; return r ? `<p class="muted small learned">#${esc(t.subject)} usually takes you ${r.rate}× the plan (from ${r.n} sessions), so the planner allows ~${dur(Math.round(t.est_minutes * r.rate))}.</p>` : ''; })()}
    ${rep ? '' : `<div class="once-only">${whenHtml(t)}</div>`}
    <details class="more-opts"><summary>More options</summary>
      <div class="fld-row">
        ${f('Not before', `<input class="e-start mono" type="date" value="${esc(t.start_date || '')}">`, ' once-only')}
        ${f('Priority', `<select class="e-pri">${[1, 2, 3].map(p => `<option value="${p}"${p === t.priority ? ' selected' : ''}>${PRI[p]}</option>`).join('')}</select>`)}
        ${f('Type', `<select class="e-cat">${PC.CATEGORIES.map(c => `<option${c === t.category ? ' selected' : ''}>${c}</option>`).join('')}</select>`)}
        ${f('Effort', effortSelect('e-eff', t.effort))}
      </div>
      <label class="check-row once-only"><input type="checkbox" class="e-rev"${cleanRevise(t.revise) ? ' checked' : ''}><span>Add revision after I finish it <span class="muted">(${reviseLabel(cleanRevise(t.revise) || REVISE_DEFAULT)} later)</span></span></label>
    </details>
    ${t.notes ? `<p class="muted small">${esc(t.notes)}</p>` : ''}
    <div class="row edit-btns"><button class="primary" data-pact="savetask">Save</button><button data-pact="finishtask">${rep ? 'Stop repeating' : 'Finished'}</button><button class="bare" data-pact="canceledit">Cancel</button><button class="bare danger-text" data-pact="deltask">Delete</button></div>
  </div>`;
}

// "When": the sessions this task has, a suggested free slot, and your own day + time.
function whenInfo(t) {
  const today = localDate(), now = nowMin();
  const upcoming = blocksOf(t.id).filter(b => b.status === 'planned' && !b.started_at && (b.date > today || (b.date === today && b.start_min >= now)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  const planned = upcoming.reduce((s, b) => s + blen(b), 0);
  const len = upcoming[0] ? blen(upcoming[0]) : Math.max(15, Math.min(PC.cleanRoutine(data.settings?.routine).session, t.est_minutes - spentOn(t.id) - planned) || t.est_minutes);
  const slot = suggestSlot(t, { today, nowMin: now, length: len, skipId: upcoming[0]?.id });
  return { upcoming, len, slot };
}
function whenHtml(t) {
  const { upcoming, len, slot } = whenInfo(t), today = localDate();
  const list = upcoming.slice(0, 4).map(b => `<div class="when-row" data-bid="${esc(b.id)}"><span class="mono">${esc(dayLabel(b.date))} · ${hm(b.start_min)}–${hm(b.end_min)}</span><button type="button" class="bare" data-pact="whendrop" aria-label="Remove this session">✕</button></div>`).join('');
  return `<div class="when">
    <p class="fld-title">When ${upcoming.length ? `<span class="muted">· ${upcoming.length} session${upcoming.length > 1 ? 's' : ''} planned</span>` : '<span class="amber">· not planned yet</span>'}</p>
    ${list}
    ${slot ? `<button type="button" class="suggest-btn" data-pact="whenaccept" data-date="${slot.date}" data-start="${slot.start_min}" data-len="${len}">
      <span class="lbl">Suggested</span><span>${esc(dayLabel(slot.date))}, ${hm(slot.start_min)}–${hm(slot.start_min + len)}${slot.why ? `<span class="why">${esc(slot.why)}</span>` : ''}</span><span class="go">${upcoming.length ? 'Move here' : 'Plan it'}</span></button>` : '<p class="muted small">No free slot in the next 7 days. Pick a time below.</p>'}
    <div class="when-pick"><input type="date" class="w-date mono" value="${esc(upcoming[0]?.date || slot?.date || today)}" aria-label="Day"><input type="time" class="w-time mono" value="${upcoming[0] ? PC.toHHMM(upcoming[0].start_min) : slot ? PC.toHHMM(slot.start_min) : '09:00'}" aria-label="Start time"><input type="number" class="w-len mono" min="5" max="480" value="${len}" aria-label="Minutes"><button type="button" data-pact="whenset">Set</button></div>
  </div>`;
}
function setWhen(t, date, start, len) {
  const { upcoming } = whenInfo(t);
  const b = upcoming[0];
  const end = Math.min(1440, start + len);
  if (b) { Object.assign(b, { date, start_min: start, end_min: end }); put('blocks', b); }
  else put('blocks', fresh({ task_id: t.id, date, start_min: start, end_min: end, status: 'planned', actual_minutes: null, started_at: null, reason: null }));
  toast(`"${t.title}" ${b ? 'moved to' : 'planned for'} ${dayLabel(date)}, ${hm(start)}–${hm(end)}.`);
}

function deleteTask(id) {
  const t = data.tasks[id];
  if (!t) return;
  const before = { ...t };
  t.deleted = 1;
  put('tasks', t);
  // Every session that isn't done goes with it (past "did it happen?" ones too); done ones stay as history.
  const removed = [];
  for (const b of Object.values(data.blocks)) {
    if (b.task_id === id && !b.deleted && b.status !== 'done') { removed.push({ ...b }); b.deleted = 1; put('blocks', b); }
  }
  toast('Task deleted.', 'Undo', () => {
    put('tasks', { ...before, deleted: 0, updated_at: data.tasks[id].updated_at });
    for (const b of removed) put('blocks', { ...b, deleted: 0, updated_at: data.blocks[b.id].updated_at });
    persist();
    renderPlan();
    sync();
  });
}

$('#view-plan').addEventListener('click', e => {
  const el = e.target.closest('[data-pact]');
  if (!el) return;
  const act = el.dataset.pact;
  const tid = el.closest('[data-tid]')?.dataset.tid;
  const t = tid ? data.tasks[tid] : null;
  const obs = data.observations[el.closest('[data-oid]')?.dataset.oid];
  switch (act) {
    case 'breakdown': return breakDown();
    case 'opengoal': goalOpen = true; renderGoalCard(); $('#goal-text')?.focus(); return;
    case 'closegoal': goalOpen = false; try { localStorage.removeItem('pl.goal'); } catch {} renderGoalCard(); return;
    case 'answer': return breakDown({ answers: draft.questions.map((q, i) => ({ q, a: ($(`[data-q="${i}"]`)?.value || '').trim() })) });
    case 'skipq': return breakDown({ noQuestions: true });
    case 'manual': {
      const g = $('#goal-text').value.trim();
      draft = { stage: 'review', goal: g, goalName: g ? shortGoal(g) : '', tasks: [{ title: g.length <= 120 ? g : '' }] };
      break;
    }
    case 'canceldraft': draft = null; splitSource = null; break;
    case 'addrow': keepDraftEdits(); draft.tasks.push({ title: '' }); break;
    case 'rmrow': {
      const i = $$('#draft-rows .trow').indexOf(el.closest('.trow'));
      keepDraftEdits();
      draft.tasks.splice(i, 1);
      if (!draft.tasks.length) draft.tasks.push({ title: '' });
      break;
    }
    case 'savedraft': return saveGoalTasks();
    case 'makeplan': startProposal(); break;
    case 'less': startProposal(proposal.r.maxMinutes - 30); break;
    case 'more': startProposal(proposal.r.maxMinutes + 30); break;
    case 'apply': return applyProposal();
    case 'cancelplan': proposal = null; break;
    case 'jadd': {
      const d = parse(obs);
      const task = fresh({
        goal: null, title: (d.repeat ? planTitle(d.task) : String(d.task || 'Task')).slice(0, 120) || 'Task', notes: null, entry_id: o.entry_id || null,
        category: PC.CATEGORIES.includes(d.category) ? d.category : 'other', est_minutes: 60,
        deadline: d.date || null, priority: 2, status: 'open', done_at: null, repeat: null, revise: defaultRevise(d.category),
      });
      put('tasks', task);
      d.task_id = task.id;
      setObs(obs, { data: JSON.stringify(d) });
      toast('Added as a task (1 h guess). Tap it to change.');
      break;
    }
    case 'jdismiss': { const d = parse(obs); d.task_id = 'none'; setObs(obs, { data: JSON.stringify(d) }); break; }
    case 'edit': editTask = tid; break;
    case 'whenaccept': setWhen(t, el.dataset.date, Number(el.dataset.start), Number(el.dataset.len)); break;
    case 'whenset': {
      const box = el.closest('.when'), date = box.querySelector('.w-date').value, time = box.querySelector('.w-time').value;
      const len = Math.max(5, Math.min(480, parseInt(box.querySelector('.w-len').value, 10) || 60));
      if (!date || !/^\d\d:\d\d$/.test(time)) { toast('Pick a day and a start time.'); return; }
      setWhen(t, date, PC.toMin(time), len);
      break;
    }
    case 'whendrop': { const b = data.blocks[el.closest('[data-bid]').dataset.bid]; if (b) { b.deleted = 1; put('blocks', b); toast('Session removed.'); } break; }
    case 'canceledit': editTask = null; break;
    case 'savetask': {
      const box = el.closest('.task'), before = { ...t };
      const title = box.querySelector('.e-title').value.trim().slice(0, 120);
      if (!title) { toast('The task needs a name.'); return; }
      Object.assign(t, {
        title,
        est_minutes: Math.min(1440, Math.max(5, parseInt(box.querySelector('.e-min').value, 10) || t.est_minutes)),
        deadline: box.querySelector('.e-due').value || null,
        priority: Number(box.querySelector('.e-pri').value) || 2,
        category: box.querySelector('.e-cat').value,
        repeat: (() => { const r = readHowOften(box); return r ? JSON.stringify(r) : null; })(),
        effort: (n => n === 2 ? null : n)(Number(box.querySelector('.e-eff')?.value) || 2),
        subject: (v => /^[\p{L}\p{N}_-]{1,40}$/u.test(v) ? v : null)((box.querySelector('.e-subj')?.value || '').trim().replace(/^#/, '').toLowerCase()),
        start_date: box.querySelector('.e-start')?.value || null,
        revise: box.querySelector('.e-rev')?.checked ? (cleanRevise(t.revise) || REVISE_DEFAULT) : null,
        habit: readHabit(box, t, readHowOften(box)),
      });
      if (t.repeat) Object.assign(t, { deadline: null, start_date: null, revise: null });
      // A new length resizes the session already booked (one session: the whole of what's left).
      if (!t.repeat && t.est_minutes !== before.est_minutes) {
        const { upcoming } = whenInfo(t);
        if (upcoming.length === 1) {
          const b = upcoming[0], left = Math.max(5, t.est_minutes - spentOn(t.id));
          b.end_min = Math.min(1440, b.start_min + left); put('blocks', b);
        }
      }
      put('tasks', t);
      editTask = null;
      if (t.repeat && t.repeat !== before.repeat) {
        // New schedule: clear the old one's upcoming sessions and book the next week on the new one.
        dropFutureBlocks(t.id);
        const n = placeRepeating(t);
        toast(`Repeats ${repeatShort(t.repeat)}. ${n ? `Next ${n} session${n > 1 ? 's are' : ' is'} booked.` : 'No free time found this week. Check My week.'}`);
      } else if (!t.repeat && before.repeat) dropFutureBlocks(t.id);
      break;
    }
    case 'finishtask': finishTask(tid); editTask = null; break;
    case 'deltask': deleteTask(tid); editTask = null; break;
    case 'reopen': Object.assign(t, { status: 'open', done_at: null }); put('tasks', t); break;
    case 'toggledone': showDone = !showDone; break;
  }
  persist();
  renderPlan();
  if (['jadd', 'jdismiss', 'savetask', 'finishtask', 'deltask', 'reopen', 'whenaccept', 'whenset', 'whendrop'].includes(act)) sync();
  if (act === 'makeplan') $('#proposal-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#view-plan').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.task[data-pact="edit"]')) e.target.click();
});

$('#view-plan').addEventListener('submit', e => {
  if (e.target.id !== 'quick-add') return;
  e.preventDefault();
  const tag = splitTag($('#quick-title').value.trim().slice(0, 160));
  const title = tag.title.slice(0, 120);
  if (!title) return;
  put('tasks', fresh({ goal: null, title, notes: null, category: tag.subject ? 'study' : 'other', est_minutes: 60, deadline: null, priority: 2, status: 'open', done_at: null, repeat: null, subject: tag.subject, effort: null }));
  persist();
  sync();
  renderPlan();
  $('#quick-title').focus();
  toast('Added (1 h guess). Tap the task to set time or a deadline.');
});

$('#view-plan').addEventListener('change', e => {
  if (e.target.id !== 'p-horizon') return;
  const v = Number(e.target.value) || 7;
  horizonLocal = v;
  try { localStorage.setItem('pl.horizon', String(v)); } catch {}
  saveHorizon(v);
  if (proposal) startProposal(proposal.r.maxMinutes);
  renderProposal();
});

$('#view-plan').addEventListener('input', e => {
  if (e.target.id === 'goal-text') { try { localStorage.setItem('pl.goal', e.target.value); } catch {} }
});

// ---------- My week (Settings) ----------

let routineTouched = false;

function dayButtons(selected) {
  return WEEK_ORDER.map(i => `<button type="button" class="dbtn${selected.includes(i) ? ' on' : ''}" data-day="${i}" aria-pressed="${selected.includes(i)}">${PC.DAY_NAMES[i].slice(0, 2)}</button>`).join('');
}
function busyRow(b) {
  return `<div class="busy">
    <div class="busy-top"><input class="b-label" maxlength="40" placeholder="What, e.g. College" value="${esc(b.label || '')}" aria-label="What">
    <button type="button" class="bare" data-ract="rmbusy" aria-label="Remove">✕</button></div>
    <div class="dbtns">${dayButtons(b.days)}</div>
    <div class="busy-time trange"><input type="time" class="b-start" value="${b.start}" aria-label="From"><span class="unit">to</span><input type="time" class="b-end" value="${b.end === '24:00' ? '23:59' : b.end}" aria-label="To"></div>
  </div>`;
}

// One settings layout everywhere: name and a one-line hint on the left, the control on the right.
function frow(title, hint, control, o = {}) {
  return `<div class="frow${o.wide ? ' wide' : ''}${o.stack ? ' stack' : ''}"><div class="frow-l">${o.for ? `<label class="frow-t" for="${o.for}">${title}</label>` : `<span class="frow-t">${title}</span>`}${hint ? `<span class="frow-h">${hint}</span>` : ''}</div><div class="frow-c">${control}</div></div>`;
}

function renderRoutine() {
  const r = PC.cleanRoutine(data.settings?.routine);
  $('#routine').innerHTML = `<div class="frows">
    ${frow('Working hours', '', `<div class="trange"><input type="time" id="r-start" value="${r.start}" aria-label="From"><span class="unit">to</span><input type="time" id="r-end" value="${r.end === '24:00' ? '23:59' : r.end}" aria-label="To"></div>`, { wide: true })}
    ${frow('Days off', 'Nothing gets planned on these days.', `<div class="dbtns" id="r-off">${dayButtons(r.daysOff)}</div>`, { wide: true })}
    ${frow('Busy times', 'College, classes, travel.', `<div id="r-busy">${r.busy.map(busyRow).join('')}</div><button type="button" class="link" data-ract="addbusy">+ Add busy time</button>`, { wide: true })}
    ${frow('Focus limit', 'Most hours of work in a day.', `<input type="number" id="r-max" min="0.5" max="16" step="0.5" value="${r.maxMinutes / 60}"><span class="unit">h / day</span>`, { for: 'r-max' })}
    ${frow('Sessions up to', 'Longer tasks are split.', `<input type="number" id="r-session" min="15" max="240" step="5" value="${r.session}"><span class="unit">min</span>`, { for: 'r-session' })}
    ${frow('Break', 'Between sessions.', `<input type="number" id="r-break" min="0" max="60" step="5" value="${r.breakMin}"><span class="unit">min</span>`, { for: 'r-break' })}
    ${frow('Clock', '', `<select id="r-clock"><option value="12"${r.clock === 12 ? ' selected' : ''}>12-hour (1:30 pm)</option><option value="24"${r.clock === 24 ? ' selected' : ''}>24-hour (13:30)</option></select>`, { for: 'r-clock' })}
    ${frow('When the journal finds a plan', 'Straight away: clear plans (a day, a time, or "twice a week") and "I finished…" notes go in by themselves. Vague ones still ask.', `<select id="r-jauto"><option value="ask"${r.journalAuto === 'ask' ? ' selected' : ''}>Ask me first</option><option value="add"${r.journalAuto === 'add' ? ' selected' : ''}>Add it straight away</option></select>`, { for: 'r-jauto', stack: true })}
    ${frow('Carry over missed sessions', 'Each morning, move what you missed into today\'s free time.', `<input type="checkbox" class="switch" id="r-carry"${r.carry ? ' checked' : ''}>`, { for: 'r-carry' })}
    </div>
    <div class="row"><button class="primary" type="button" data-ract="save">Save my week</button></div>
    <p class="small" id="r-msg" role="status"></p>`;
}

$('#routine').addEventListener('input', () => { routineTouched = true; });
$('#routine').addEventListener('click', async e => {
  const day = e.target.closest('button.dbtn');
  if (day) {
    day.classList.toggle('on');
    day.setAttribute('aria-pressed', day.classList.contains('on'));
    routineTouched = true;
    return;
  }
  const btn = e.target.closest('[data-ract]');
  if (!btn) return;
  const act = btn.dataset.ract;
  if (act === 'addbusy') { $('#r-busy').insertAdjacentHTML('beforeend', busyRow({ label: '', days: [1, 2, 3, 4, 5], start: '09:00', end: '16:00' })); routineTouched = true; }
  if (act === 'rmbusy') { btn.closest('.busy').remove(); routineTouched = true; }
  if (act !== 'save') return;
  const days = el => [...el.querySelectorAll('button.dbtn.on')].map(b => Number(b.dataset.day));
  const end = v => (v === '23:59' ? '24:00' : v);
  const routine = {
    start: $('#r-start').value, end: end($('#r-end').value), daysOff: days($('#r-off')),
    busy: $$('#r-busy .busy').map(el => ({
      label: el.querySelector('.b-label').value, days: days(el),
      start: el.querySelector('.b-start').value, end: end(el.querySelector('.b-end').value),
    })),
    maxMinutes: Math.round(parseFloat($('#r-max').value) * 60), session: Number($('#r-session').value), breakMin: Number($('#r-break').value),
    autoPlan: true,
    journalAuto: $('#r-jauto').value,
    carry: $('#r-carry').checked,
    clock: Number($('#r-clock')?.value) === 24 ? 24 : 12,
    horizon: horizonNow(),   // keep Plan ahead when saving My week
  };
  try {
    data.settings = (await api('/api/settings', { method: 'PUT', body: { routine } })).settings;
    persist();
    routineTouched = false;
    renderRoutine();
    $('#r-msg').textContent = 'Saved. Make a new plan to use it.';
  } catch (err) {
    $('#r-msg').textContent = err.message === 'Failed to fetch' ? 'You need internet to save this.' : err.message;
  }
});

// ---------- preferences -> planning rules ----------

let readingRules = false;

// Reads new "Things to know about me" lines into rules. Uses the AI if set, otherwise a simple reader.
async function readPrefRules() {
  if (readingRules) return;
  readingRules = true;
  try {
    for (const p of liveRows('prefs').filter(x => x.rule_json == null)) {
      const guess = PC.guessRule(p.text);
      let rule = guess;
      if (data.settings?.ai_provider) {
        try { rule = (await api('/api/prefs/parse', { method: 'POST', body: { text: p.text } })).rule || guess; }
        catch (err) { if (!err.status) break; }          // offline: try again later
      }
      const cur = data.prefs[p.id];
      if (!cur || cur.deleted || cur.rule_json != null) continue;
      cur.rule_json = JSON.stringify(rule || {});
      put('prefs', cur);
      persist();
      renderPrefs();
    }
  } finally {
    readingRules = false;
  }
}

// ---------- repeating tasks ----------


// ---------- one tap from journal to plan ----------

// ✓ on a "Plan: …" note: it becomes a task straight away, and gets a slot if auto-plan is on.
// Backup for when the AI misses them: "at 5 pm", "5:30pm", "at 17:30" and "2 hrs", "for 1 hour", "45 min".
// Only used when the entry has a single plan in it, so a time can't land on the wrong task.
function timeInText(t) {
  let m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i.exec(t);
  if (m) { let h = +m[1] % 12; if (/^p/i.test(m[3])) h += 12; const mm = +(m[2] || 0); return h < 24 && mm < 60 ? `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : null; }
  // "at 4:15" or just "at 10" (not "at 10 topics" or "at 3 hrs").
  m = /\b(?:at|@)\s*(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:hrs?|hours?|mins?|minutes?|days?|weeks?|[a-z]))/i.exec(t);
  if (!m) return null;
  m[2] = m[2] || '00';
  if (+m[1] > 23 || +m[2] > 59) return null;
  // "at 4:15" with no am/pm: nobody plans study for 4 in the morning, so 1–7 means afternoon/evening.
  const h = +m[1] >= 1 && +m[1] <= 7 ? +m[1] + 12 : +m[1];
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
// "about 2 hrs" -> 120, "1-2 hrs" -> 90 (the middle of a range), "45 min" -> 45.
const RANGE = '(\\d+(?:\\.\\d+)?)(?:\\s*(?:-|–|to)\\s*(\\d+(?:\\.\\d+)?))?\\s*';
function minutesInText(t) {
  t = String(t || '');
  let m = new RegExp(RANGE + '(?:hours?|hrs?|h)\\b', 'i').exec(t);
  if (m) return Math.round((m[2] ? (parseFloat(m[1]) + parseFloat(m[2])) / 2 : parseFloat(m[1])) * 60) || null;
  m = new RegExp(RANGE + '(?:minutes?|mins?|m)\\b', 'i').exec(t);
  return m ? Math.round(m[2] ? (+m[1] + +m[2]) / 2 : +m[1]) || null : null;
}
// Length of ONE part: "a module would take about 1-2 hrs", "each topic takes 45 min", "1 hr per chapter".
const PART_WORD = '(?:module|topic|chapter|unit|part|lecture|subject|section|lesson)s?';
function perPartMinutes(t) {
  t = String(t || '');
  const a = new RegExp(`\\b(?:a|an|each|one|every|per)\\s+${PART_WORD}\\b[^.\\n]{0,40}?\\b(?:takes?|would take|will take|should take|might take|is|=|needs?)\\b[^.\\n]{0,25}`, 'i').exec(t);
  if (a) return minutesInText(a[0]);
  const b = new RegExp(`[^.\\n]{0,30}\\b(?:per|each|a|for each|every)\\s+${PART_WORD}\\b`, 'i').exec(t);
  return b ? minutesInText(b[0]) : null;
}

// Backup for the day when the AI gets it wrong: "tomorrow" (also "tommorow", "tmrw"), "day after tomorrow",
// "today"/"tonight", "on Friday", "this Friday", "next Friday".
function dateInText(t, today = localDate()) {
  t = String(t || '').toLowerCase();
  if (/\bday after (tomm?orr?ow|tmrw|tmr|tomo)\b/.test(t)) return PC.addDays(today, 2);
  if (/\b(tomm?orr?ow|tommorrow|tmrw|tmr|tomo|2moro|tomorow)\b/.test(t)) return PC.addDays(today, 1);
  if (/\b(today|tonight|this evening|this morning|this afternoon)\b/.test(t)) return today;
  const m = /\b(?:(next|this|on|by)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/.exec(t);
  if (m && (m[1] || /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.test(m[2]))) {
    const want = DAY_RE[m[2].slice(0, 3)];
    let diff = (want - PC.weekday(today) + 7) % 7;
    if (diff === 0 && m[1] !== 'this') diff = 7;   // "Friday" said on a Friday means next week, "this Friday" means today
    return PC.addDays(today, diff);
  }
  return null;
}

// Backup for repeats the AI misses: "twice a week", "3 times a week", "every day", "weekdays", "every Monday and Thursday".
const DAY_RE = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const NUM_RE = { once: 1, twice: 2, thrice: 3, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const FREQ_RE = /\b(?:(once|twice|thrice)|(\d|one|two|three|four|five|six)\s*(?:x|times?))\s*(?:a|per|every|each|in a)\s*week\b/i;
function repeatInText(t) {
  t = String(t || '');
  const time = timeInText(t);
  let m = FREQ_RE.exec(t);
  if (m) { const n = NUM_RE[(m[1] || m[2]).toLowerCase()] || +(m[1] || m[2]); if (n >= 1 && n <= 7) return PC.cleanRepeat({ days: [], per_week: n, time }); }
  if (/\b(every\s*day|everyday|daily|each day)\b/i.test(t)) return { days: [0, 1, 2, 3, 4, 5, 6], time };
  if (/\bweekdays\b/i.test(t)) return { days: [1, 2, 3, 4, 5], time };
  if (/\bweekends\b/i.test(t)) return { days: [0, 6], time };
  m = /\b(?:every|on)\s+((?:sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s*(?:,|and|&)\s*(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)*)/i.exec(t);
  if (m && /\bevery\b|s\b/i.test(m[0])) {
    const days = [...new Set(m[1].toLowerCase().match(/sun|mon|tue|wed|thu|fri|sat/g).map(x => DAY_RE[x]))].sort();
    if (days.length) return { days, time };
  }
  return null;
}
// "I want to exercise twice a week at 6 pm" -> "Exercise".
function planTitle(t) {
  const out = String(t || '').replace(FREQ_RE, ' ')
    .replace(/^\s*(?:also|and|then|plus)\b,?\s*/i, ' ')
    .replace(/\b(i\s+(?:really\s+)?(?:want|need|plan|have|would like|wanna)\s+to|i'?ll|i will|i'?m going to|going to|gonna|i should|start(?:ing)? to)\b/gi, ' ')
    .replace(/\b(every\s*day|everyday|daily|each day|weekdays|weekends)\b/gi, ' ')
    .replace(/\b(?:every|on)\s+(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s*(?:,|and|&)\s*(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)*/gi, ' ')
    .replace(/\b(?:at|@|by|around)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/gi, ' ')
    .replace(/\b(?:for\s+)?(?:about\s+)?\d+(?:\.\d+)?\s*(?:hrs?|hours?|mins?|minutes?)\b/gi, ' ')
    .replace(/\b(today|tomorrow|tonight|this week)\b/gi, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();
  return out ? out[0].toUpperCase() + out.slice(1) : String(t || '').trim();
}

function journalToTask(o) {
  const d = parse(o);
  if (d.task_id) return;
  const e = data.entries[o.entry_id];
  if (e && !e._locked && obsFor(o.entry_id).filter(x => !x.deleted && x.kind === 'intention').length === 1) {
    if (!d.repeat) { const r = repeatInText(e.body); if (r) { d.repeat = r; d.date = null; } }
    // The day you wrote wins over the AI's guess (it read "tommorow" as today once).
    if (!d.repeat) { const td = dateInText(e.body); if (td) d.date = td; }
    if (d.repeat && !PC.cleanRepeat(d.repeat).time) { const tm = timeInText(e.body); if (tm) d.repeat = { ...PC.cleanRepeat(d.repeat), time: tm }; }
    if (!d.time && !d.repeat) d.time = timeInText(e.body);
    // A length you wrote ("about 2 hrs") wins over the AI's guess.
    { const m = minutesInText(e.body); if (m >= 5 && m <= 720) d.minutes = m; }
  }
  // A reminder (a birthday, a call, a meeting) is not work: no hour-long session, no moving it to a "free" day.
  if (isReminder(d, e, o)) return reminderTask(o, d, e);
  // Several topics or parts in one plan: split it into sessions right away, and say how to change it.
  if (!d.repeat && isComplexPlan(d, e, o)) return splitPlan(o, d, e);
  const task = fresh({
    goal: null, title: (d.repeat ? planTitle(d.task) : String(d.task || 'Task')).slice(0, 120) || 'Task', notes: null, entry_id: o.entry_id || null,
    category: PC.CATEGORIES.includes(d.category) ? d.category : 'other', est_minutes: d.minutes || 60,
    deadline: d.repeat ? null : d.date || null, priority: 2, status: 'open', done_at: null, repeat: d.repeat && PC.cleanRepeat(d.repeat) ? JSON.stringify(PC.cleanRepeat(d.repeat)) : null, revise: d.repeat ? null : defaultRevise(d.category),
    subject: d.subject || splitTag(data.entries[o.entry_id]?._locked ? '' : data.entries[o.entry_id]?.body).subject, effort: [1, 3].includes(d.effort) ? d.effort : null,
  });
  put('tasks', task);
  d.task_id = task.id;
  if (d.repeat) d.task = task.title;
  o.data = JSON.stringify(d);
  const undo = () => undoJournalTask(task.id, o);
  if (task.repeat) {
    const n = placeRepeating(task);
    const r = PC.cleanRepeat(task.repeat), when = `${repeatShort(r)}${r.time ? ' at ' + hm(PC.toMin(r.time)) : ''}`;
    toast(n ? `"${task.title}" repeats ${when}. ${n} session${n > 1 ? 's' : ''} booked for the next 7 days.`
      : `"${task.title}" repeats ${when}. No free time found yet. Check My week.`, 'Undo', undo);
    return;
  }
  // You gave a time ("at 4 pm", or in Fix): put it exactly there.
  if (d.time) {
    const today = localDate(), at = PC.toMin(d.time);
    const day = d.date && d.date >= today ? d.date : at > nowMin() ? today : PC.addDays(today, 1);
    const p = placeAt(task.id, day, at, task.est_minutes);
    toast(`"${task.title}" planned for ${dayLabel(day)}, ${hm(at)}–${hm(p.end)}${p.n > 1 ? ` (${p.n} sessions with breaks)` : ''}.`, 'Undo', undo);
    return;
  }
  if (PC.cleanRoutine(data.settings?.routine).autoPlan) {
    const today = localDate(), r = PC.cleanRoutine(data.settings?.routine);
    // You named the day ("today", "tomorrow", "on Friday"): it goes on that day, even a usual day off.
    const named = d.date && d.date >= today ? d.date : null;
    const placed = [];
    let left = task.est_minutes;
    while (left >= 10 && placed.length < 6) {
      const len = Math.min(left, r.session);
      const slot = suggestSlot(task, { length: len, onDate: named || undefined, today: named && named > today ? named : today, nowMin: named && named > today ? 0 : nowMin(), aiTime: d.best_time });
      if (!slot) break;
      put('blocks', fresh({ task_id: task.id, date: slot.date, start_min: slot.start_min, end_min: slot.end_min, status: 'planned', actual_minutes: null, started_at: null, reason: null }));
      placed.push(slot); left -= len;
      if (!named) break;      // no day given: one session now, the rest when you plan
    }
    if (placed.length) {
      const a = placed[0], z = placed[placed.length - 1];
      toast(`"${task.title}" planned for ${dayLabel(a.date)}, ${hm(a.start_min)}–${hm(z.end_min)}${placed.length > 1 ? ` (${placed.length} sessions)` : ''}${a.why ? ` · ${a.why}` : ''}.`, 'Undo', undo);
      return;
    }
    if (named) {
      toast(`No free time left on ${dayLabel(named)} for "${task.title}". It's in Today's list to place by hand.`, 'Undo', undo);
      return;
    }
  }
  toast(`Added "${task.title}" to your tasks.`, 'Undo', undo);
}

// A journal plan you fix after it already became a task: change the task and move its session to match,
// so Today's dial, the Calendar and reminders all follow.
function syncTaskFromNote(o) {
  const d = parse(o), t = data.tasks[d.task_id];
  if (!t || t.deleted) { delete d.task_id; o.data = JSON.stringify(d); return journalToTask(o); }
  const today = localDate(), rep = d.repeat && PC.cleanRepeat(d.repeat);
  Object.assign(t, {
    title: String(d.task || t.title).slice(0, 120),
    category: PC.CATEGORIES.includes(d.category) ? d.category : t.category,
    est_minutes: d.minutes || t.est_minutes,
    deadline: rep ? null : d.date || t.deadline,
    repeat: rep ? JSON.stringify(rep) : null,
  });
  put('tasks', t);
  const upcoming = blocksOf(t.id).filter(b => b.status === 'planned' && !b.started_at && b.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  // Already running: stretch or shorten the running session instead of adding a second one.
  const running = liveRows('blocks').find(b => b.task_id === t.id && b.status === 'planned' && b.started_at);
  if (running && !rep && d.minutes) {
    running.end_min = Math.min(1440, running.start_min + Math.max(5, d.minutes));
    put('blocks', running);
    toast(`Updated "${t.title}": running until ${hm(running.end_min)}.`);
    return;
  }
  if (rep) {
    for (const b of upcoming) { b.deleted = 1; put('blocks', b); }
    const n = placeRepeating(t);
    toast(`"${t.title}" now repeats ${repeatShort(t.repeat)}${n ? `; ${n} session${n > 1 ? 's' : ''} planned` : ''}.`);
    return;
  }
  const len = d.minutes || (upcoming[0] ? blen(upcoming[0]) : t.est_minutes);
  let date = d.date && d.date >= today ? d.date : upcoming[0]?.date || today, start = null;
  if (d.time) { start = PC.toMin(d.time); if (!d.date && date === today && start <= nowMin()) date = PC.addDays(today, 1); }
  else if (upcoming[0] && upcoming[0].date === date) start = upcoming[0].start_min;   // same day, keep its time
  else {
    const slot = PC.nextSlot({ blocks: liveRows('blocks'), routine: data.settings?.routine, prefs: liveRows('prefs'), today: date, nowMin: date === today ? nowMin() : 0, length: len, skipId: upcoming[0]?.id });
    if (slot) { date = slot.date; start = slot.start_min; }
  }
  if (start === null) { toast(`Updated "${t.title}".`); return; }
  // Replace the sessions it had on that day (and the one being moved) with fresh ones at the new time.
  for (const b of upcoming) if (b === upcoming[0] || b.date === date) { b.deleted = 1; put('blocks', b); }
  const p = placeAt(t.id, date, start, d.minutes || t.est_minutes || len);
  toast(`Updated "${t.title}": ${dayLabel(date)}, ${hm(start)}–${hm(p.end)}${p.n > 1 ? ` (${p.n} sessions)` : ''}.`);
}

// Puts a new repeating task into the next 7 days straight away, at its usual time when that's free.
// A short tag for a repeat schedule, so changing the schedule gives its sessions new ids.
function repSig(r) { let h = 7; for (const c of String(r || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36).slice(0, 5); }
function placeRepeating(task) {
  const r = PC.makePlan({ tasks: [task], blocks: liveRows('blocks').map(b => ({ ...b, started_at: b.started_at || 1 })),
    routine: data.settings?.routine, prefs: liveRows('prefs'), today: localDate(), nowMin: nowMin(), days: 7 });
  let n = 0;
  for (const b of r.blocks || []) {
    if (b.task_id !== task.id) continue;
    // One id per task and day: two devices topping up the week make the same session, and one you removed never comes back.
    const id = `${task.id}-${b.date.replace(/-/g, '')}-${repSig(task.repeat)}`;
    if (data.blocks[id]) continue;
    put('blocks', { ...fresh({ task_id: task.id, date: b.date, start_min: b.start_min, end_min: b.end_min, status: 'planned', actual_minutes: null, started_at: null, reason: null }), id });
    n++;
  }
  return n;
}

// "I finished my French assignment" in the journal: find the task it's about and update that,
// instead of leaving the old task open (and its running session still ticking).
const STOP = new Set(['a', 'an', 'the', 'my', 'of', 'to', 'for', 'on', 'in', 'and', 'do', 'did', 'done', 'doing', 'finish', 'finished', 'complete', 'completed', 'work', 'some']);
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).map(w => w.replace(/s$/, ''));
function matchTask(name) {
  const want = words(name);
  if (!want.length) return null;
  const today = localDate();
  let best = null, bestScore = 0;
  for (const t of liveRows('tasks')) {
    if (t.status !== 'open' || /^revise:/i.test(t.title) && !/^revise/i.test(name)) continue;
    const have = words(t.title);
    if (!have.length) continue;
    const common = want.filter(w => have.includes(w)).length;
    let score = common / Math.max(want.length, have.length);
    if (common && (want.every(w => have.includes(w)) || have.every(w => want.includes(w)))) score = Math.max(score, 0.75);
    const blocks = blocksOf(t.id);
    if (blocks.some(b => b.started_at)) score += 0.3;            // running right now: almost surely this one
    else if (blocks.some(b => b.date === today)) score += 0.1;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore >= 0.6 ? best : null;
}

function journalDone(o) {
  const d = parse(o);
  if (d.task_id || !['done', 'partly'].includes(d.outcome)) return;
  const t = matchTask(d.task);
  if (!t) return;
  const today = localDate(), before = { task: { ...t }, blocks: [] };
  // The session it belongs to: the running one, else today's first unfinished one.
  const b = liveRows('blocks').find(x => x.task_id === t.id && x.started_at)
    || blocksOf(t.id).filter(x => x.date === today && x.status === 'planned').sort((a, c) => a.start_min - c.start_min)[0];
  if (b) {
    before.blocks.push({ ...b });
    const ran = b.started_at ? Math.round((Date.now() - b.started_at) / 60000) : null;
    const mins = d.minutes && !d.estimated ? d.minutes : ran || d.minutes || (b.end_min - b.start_min);
    Object.assign(b, { status: 'done', actual_minutes: Math.max(1, Math.min(1440, mins)), started_at: null });
    put('blocks', b);
    d.block_id = b.id;
    d.minutes = b.actual_minutes; d.estimated = false;   // the session knows the real time
  }
  d.task_id = t.id;
  o.data = JSON.stringify(d);
  if (t.repeat || d.outcome === 'partly') {
    toast(`Logged on "${t.title}"${b ? ' and closed its session' : ''}.`, 'Undo', () => undoJournalDone(o, before));
    return;
  }
  const gone = blocksOf(t.id).filter(x => x.id !== b?.id && x.status === 'planned' && !x.started_at && x.date >= today);
  before.blocks.push(...gone.map(x => ({ ...x })));
  Object.assign(t, { status: 'done', done_at: Date.now() });
  put('tasks', t);
  for (const x of gone) { x.deleted = 1; put('blocks', x); }
  toast(`Marked "${t.title}" as finished${b ? ' and stopped its session' : ''}.`, 'Undo', () => undoJournalDone(o, before));
}

function undoJournalDone(o, before) {
  Object.assign(data.tasks[before.task.id], before.task, { updated_at: nextTime(data.tasks[before.task.id]) });
  put('tasks', data.tasks[before.task.id]);
  for (const x of before.blocks) { const cur = data.blocks[x.id]; Object.assign(cur, x, { updated_at: nextTime(cur) }); put('blocks', cur); }
  const d = parse(o); delete d.task_id; delete d.block_id;
  setObs(o, { data: JSON.stringify(d) });
  persist(); safeRender(); sync();
}

const REMIND_RE = /\b(remind(?:er)?\b|birthday|b'?day|anniversary|wish\s+\w+|call\s+(?:mom|mum|dad|papa|mummy|\w+)\b|appointment|meeting|interview|pay\s+(?:the\s+)?(?:rent|fees?|bill))/i;
function isReminder(d, e, o) {
  if (d.repeat) return false;
  if (d.category === 'reminder') return true;
  const solo = e && !e._locked && obsFor(o.entry_id).filter(x => !x.deleted && x.kind === 'intention').length === 1;
  return REMIND_RE.test(String(d.task || '')) || (solo && /\bremind me\b|\bbirthday\b/i.test(e.body));
}
function reminderTime(day, time) {
  if (time) return PC.toMin(time);
  const n = data.settings?.notify?.todo;
  let at = /^\d\d:\d\d$/.test(n || '') ? PC.toMin(n) : 9 * 60;
  if (day === localDate() && at <= nowMin()) at = Math.min(1425, Math.ceil((nowMin() + 5) / 15) * 15);
  return at;
}
// Reminders made before they always got a time: give them one (once a day, with the repeat top-up).
function timeReminders() {
  const today = localDate();
  let n = 0;
  for (const t of liveRows('tasks')) {
    if (t.category !== 'reminder' || t.status !== 'open' || !t.deadline || t.deadline < today) continue;
    if (liveRows('blocks').some(b => b.task_id === t.id)) continue;
    const at = reminderTime(t.deadline, null);
    put('blocks', fresh({ task_id: t.id, date: t.deadline, start_min: at, end_min: Math.min(1440, at + 15), status: 'planned', actual_minutes: null, started_at: null, reason: null }));
    n++;
  }
  return n;
}
function reminderTask(o, d, e) {
  const today = localDate();
  const day = d.date && d.date >= today ? d.date : today;
  const title = String(d.task || 'Reminder').replace(/^remind(?:\s+me)?\s+(?:of|about|to)\s+/i, '').replace(/^\w/, c => c.toUpperCase()).slice(0, 120);
  const task = fresh({ goal: null, title, notes: null, category: 'reminder', est_minutes: 15, deadline: day, priority: 1, status: 'open', done_at: null,
    repeat: null, start_date: null, revise: null, entry_id: o.entry_id || null, subject: null, effort: null });
  put('tasks', task);
  // Always a 15-minute slot, so it's on the clock and the Calendar and the usual "starting soon" notification
  // reminds you: at the time you said, else at your morning to-do time (9 am if that's off).
  const at = reminderTime(day, d.time);
  put('blocks', fresh({ task_id: task.id, date: day, start_min: at, end_min: Math.min(1440, at + 15), status: 'planned', actual_minutes: null, started_at: null, reason: null }));
  d.time = PC.toHHMM(at);
  Object.assign(d, { task_id: task.id, task: title, category: 'reminder' });
  o.data = JSON.stringify(d);
  toast(`Reminder set: "${title}" on ${dayLabel(day)}${d.time ? ', ' + hm(PC.toMin(d.time)) : ''}.`, 'Undo', () => undoJournalTask(task.id, o));
}

// Puts `len` minutes of a task at a set time, cut into sessions of your "Sessions up to" length with your break between.
const taskOf = b => (b ? data.tasks[b.task_id] : null);

function placeAt(taskId, date, at, len) {
  const r = PC.cleanRoutine(data.settings?.routine);
  let start = at, left = len, n = 0, end = at;
  while (left > 0 && start < 1440) {
    const l = Math.min(left, r.session, 1440 - start);
    if (l < 5) break;
    put('blocks', fresh({ task_id: taskId, date, start_min: start, end_min: start + l, status: 'planned', actual_minutes: null, started_at: null, reason: null }));
    n++; end = start + l; left -= l; start = end + r.breakMin;
  }
  return { n, end };
}

// Deleting a journal entry takes the plans it made with it: their tasks and any session that isn't done.
// Finished sessions stay, so Week and subject times don't change. Returns an undo.
function dropEntryTasks(entryId) {
  const ids = new Set(liveRows('tasks').filter(t => t.entry_id === entryId).map(t => t.id));
  for (const o of Object.values(data.observations)) {
    if (o.entry_id === entryId && o.kind === 'intention' && !o._locked) { const id = parse(o).task_id; if (id && data.tasks[id]) ids.add(id); }
  }
  const tasks = [], blocks = [];
  for (const id of ids) {
    const t = data.tasks[id];
    // A finished task stays exactly as it is: in the finished list, the Calendar and Week.
    if (!t || t.deleted || t.status === 'done') continue;
    tasks.push({ ...t });
    t.deleted = 1; put('tasks', t);
    for (const b of Object.values(data.blocks)) {
      if (b.task_id !== t.id || b.deleted) continue;
      // Unfinished: it goes everywhere, part-done sessions too. A repeating task keeps the sessions you finished (they were real work).
      if (b.status === 'done' && t.repeat) continue;
      blocks.push({ ...b }); Object.assign(b, { deleted: 1, started_at: null }); put('blocks', b);
    }
  }
  return {
    count: tasks.length,
    undo() {
      for (const t of tasks) put('tasks', { ...t, deleted: 0, updated_at: data.tasks[t.id].updated_at });
      for (const b of blocks) put('blocks', { ...b, deleted: 0, updated_at: data.blocks[b.id].updated_at });
    },
  };
}

function undoJournalTask(taskId, o) {
  const t = data.tasks[taskId];
  if (t) { t.deleted = 1; put('tasks', t); }
  dropFutureBlocks(taskId);
  const d = parse(o);
  delete d.task_id;
  // source 'user': you took it back, so it never gets added by itself again.
  setObs(o, { data: JSON.stringify(d), status: 'pending', source: 'user' });
  persist();
  safeRender();
  sync();
}

// Week page: time per subject this week, and how each subject's real time compares with the plan.
function renderSubjects() {
  const box = $('#subj-card');
  if (!box) return;
  const today = localDate(), from = PC.addDays(today, -6);
  const per = {};
  for (const b of liveRows('blocks')) {
    const t = data.tasks[b.task_id];
    if (b.status !== 'done' || b.date < from || b.date > today || !t?.subject) continue;
    per[t.subject] = (per[t.subject] || 0) + (b.actual_minutes ?? blen(b));
  }
  const rates = subjectRatesNow();
  const rows = Object.entries(per).sort((a, b) => b[1] - a[1]), top = rows[0]?.[1] || 1;
  if (!rows.length && !Object.keys(rates).length) {
    box.hidden = false;
    box.innerHTML = '<h2>By subject</h2><p class="muted small">Add a subject to tasks with a #tag (e.g. "Revise LMTD #thermo") and your time shows up here per subject. After a few sessions the planner also learns how long each subject really takes you.</p>';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<h2>By subject <span>last 7 days</span></h2>
    <div class="j-bars">${rows.map(([k, m]) => `<span class="subj">#${esc(k)}</span><div class="bar"><i style="width:${Math.round(m / top * 100)}%"></i></div><span class="mono">${dur(m)}</span>`).join('')}</div>
    ${Object.entries(rates).map(([k, r]) => `<p class="small learned">#${esc(k)} takes you <b>${r.rate}×</b> the planned time <span class="muted">(${r.n} sessions)</span>. New #${esc(k)} tasks get planned with that.</p>`).join('')}`;
}
