// Planner web app. Offline-first: everything is saved on the device first,
// then sent to the server. Other devices pick it up on their next sync.
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
// Demo mode ("Try the demo" on the landing page): sample data kept only in this browser, under its own key,
// so it never touches a real account. Nothing is sent to the server while it's on.
const DEMO = (() => { try { return localStorage.getItem('pl.demo') === '1'; } catch { return false; } })();
let STORE = DEMO ? 'pl.demo.v1' : 'pl.data.v1';
const TABLES = ['entries', 'prefs', 'observations', 'tasks', 'blocks', 'habit_logs', 'exams'];

// ---------- local storage ----------

let data = load();

function blank() {
  return {
    user: null, settings: null, entries: {}, prefs: {}, observations: {}, tasks: {}, blocks: {}, habit_logs: {}, exams: {}, toExtract: [],
    cursors: { entries: 0, prefs: 0, observations: 0, tasks: 0, blocks: 0, habit_logs: 0, exams: 0 },
    dirty: { entries: [], prefs: [], observations: [], tasks: [], blocks: [], habit_logs: [], exams: [] },
  };
}
function load() {
  const b = blank();
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || '{}');
    return { ...b, ...s, cursors: { ...b.cursors, ...s.cursors }, dirty: { ...b.dirty, ...s.dirty } };
  } catch { return b; }
}
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(data)); }
  catch { toast('Could not save on this device (storage full or blocked).'); }
}
function markDirty(table, id) {
  if (!data.dirty[table].includes(id)) data.dirty[table].push(id);
}
function waitingCount() { return TABLES.reduce((n, t) => n + data.dirty[t].length, 0); }

// ---------- server calls ----------

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, opts = {}) {
  if (DEMO) return demoApi(path, opts);
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let out = null;
  try { out = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, out?.error || `Error ${res.status}`);
  return out;
}

// ---------- sync ----------

let syncing = false, again = false, lastError = '';

async function sync() {
  await syncNow();
  afterSync();
}
async function syncNow() {
  if (!data.user || DEMO) return;
  if (syncing) { again = true; return; }
  syncing = true; lastError = '';
  const dirtyBefore = data.dirty.entries.join();
  renderStatus();
  try {
    await refreshSettings();
    await pushAll();
    // Reading a new entry starts as soon as it's on the server, alongside fetching changes, instead of after them.
    const reads = runExtractions();
    // Ask once which tables changed, then fetch only those. (If the check fails, fetch them all as before.)
    let heads = null;
    try { heads = await api('/api/sync/head'); } catch (e) { if (e.status === 401) throw e; }
    const stale = t => !heads || (heads.heads[t] || 0) > (data.cursors[t] || 0) - (heads.overlap || 0);
    await Promise.all(TABLES.filter(stale).map(t => pullTable(t)));
    sweepOrphanBlocks();
    resendDeletesOnce();
    if (V.needSettings) { V.needSettings = false; await refreshSettings(true); renderVaultBanner(); }
    await reads;
    if (data.toExtract.length) await runExtractions();
    await readPrefRules();
    if (waitingCount()) await pushAll();
  } catch (e) {
    if (e.status === 401) return loggedOut('Your session ended. Log in again; nothing on this device was lost.');
    if (e.status === 409) V.settingsAt = 0;   // private mode turned on elsewhere: re-check settings on the next sync
    lastError = navigator.onLine ? e.message : 'offline';
  } finally {
    syncing = false;
    persist();
    renderStatus();
    // Clear "not synced" labels, but never redraw over an edit in progress.
    if (data.dirty.entries.join() !== dirtyBefore) safeRender();
    if (again) { again = false; setTimeout(sync, 50); }
  }
}

// One-time repair: deletes made before the sync fix may have been ignored by the server (a device clock
// slightly behind). Send every local delete once more; the server now always applies deletes.
function resendDeletesOnce() {
  try { if (localStorage.getItem('pl.redelete.v1')) return; } catch { return; }
  for (const t of TABLES) for (const r of Object.values(data[t])) if (r.deleted && !data.dirty[t].includes(r.id)) data.dirty[t].push(r.id);
  try { localStorage.setItem('pl.redelete.v1', '1'); } catch {}
}

function sweepOrphanBlocks() {
  for (const b of Object.values(data.blocks)) {
    const t = data.tasks[b.task_id];
    if (!b.deleted && b.status === 'planned' && !b.started_at && t && t.deleted) { b.deleted = 1; b.updated_at = nextTime(b); markDirty('blocks', b.id); }
  }
}

async function pushAll() {
  while (waitingCount()) {
    const batch = {}, sent = {};
    let n = 0;
    for (const t of TABLES) {
      batch[t] = [];
      for (const id of data.dirty[t]) {
        if (n >= 150) break;
        const row = data[t][id];
        if (!row) continue;
        // Repair: an earlier version saved repeat days as an object; the server wants text.
        if (t === 'tasks' && row.repeat && typeof row.repeat === 'object') row.repeat = PlannerCore.cleanRepeat(row.repeat) ? JSON.stringify(PlannerCore.cleanRepeat(row.repeat)) : null;
        const out = await sealRow(t, row);   // private journal: encrypt here; null = hold until unlocked
        if (!out) continue;
        batch[t].push(out);
        sent[`${t}:${id}`] = row.updated_at;
        n++;
      }
    }
    // Nothing sendable right now: keep held rows waiting, only drop ids whose rows are gone.
    if (!n) { for (const t of TABLES) data.dirty[t] = data.dirty[t].filter(id => data[t][id]); break; }
    const res = await api('/api/sync', { method: 'POST', body: batch });
    if (res?.rejected?.length) {
      console.warn('Rows the server refused:', res.rejected);
      toast(`${res.rejected.length} change${res.rejected.length > 1 ? 's' : ''} couldn't be saved online (bad ${res.rejected[0].field}). They stay on this device.`);
    }
    // Only clear rows that weren't edited again while the request was in flight.
    for (const t of TABLES) {
      data.dirty[t] = data.dirty[t].filter(id => data[t][id] && data[t][id].updated_at !== sent[`${t}:${id}`]);
    }
    persist();
  }
}

async function pullTable(t) {
  let q = `table=${t}&since=${data.cursors[t] || 0}`;
  let changed = false;
  for (;;) {
    const res = await api(`/api/sync?${q}`);
    for (const raw of res.rows) {
      const r = await openRow(t, raw);
      const local = data[t][r.id];
      if (local && data.dirty[t].includes(r.id) && local.updated_at >= r.updated_at) continue;
      if (local && local.server_ts === r.server_ts) continue;
      data[t][r.id] = r;
      changed = true;
    }
    if (!res.more) { data.cursors[t] = res.now; break; }
    q = `table=${t}&since=${data.cursors[t] || 0}&after_ts=${res.next.after_ts}&after_id=${encodeURIComponent(res.next.after_id)}`;
  }
  if (changed) { if (t === 'prefs') renderPrefs(); else safeRender(); }
}

// Sync when the app opens, regains focus, comes back online, and every minute while visible.
addEventListener('online', sync);
addEventListener('offline', renderStatus);
addEventListener('focus', sync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) sync(); }, 20000);   // changes from your other device show up within ~20 s

// Another tab of the app on this device changed the data: reload it.
addEventListener('storage', e => {
  if (e.key !== STORE) return;
  data = load();
  if (data.user) { renderEntries(); renderPrefs(); renderStatus(); } else showAuth();
});

function renderStatus() {
  const el = $('#status');
  const n = waitingCount();
  el.classList.remove('warn');
  el.title = '';
  if (syncing) el.textContent = 'Syncing…';
  else if (!navigator.onLine || lastError === 'offline') el.textContent = n ? `Offline · ${n} waiting` : 'Offline';
  else if (lastError) { el.textContent = n ? `Not synced · ${n} waiting` : 'Sync problem'; el.classList.add('warn'); el.title = lastError; }
  else el.textContent = n ? `${n} waiting` : 'Synced';
  if (DEMO) el.textContent = 'Demo';
  // The avatar's dot tells the same story on phones, where the text is hidden.
  const av = $('#avatar');
  if (av) {
    av.dataset.sync = lastError && lastError !== 'offline' ? 'warn' : (!navigator.onLine || lastError === 'offline') ? 'off' : (syncing || n) ? 'wait' : 'ok';
    av.setAttribute('aria-label', 'Settings · ' + el.textContent);
    $('#avatar-letter').textContent = (data.user?.username || '·').slice(0, 1).toUpperCase();
  }
}

// ---------- dates ----------

const pad = n => String(n).padStart(2, '0');
function localDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dayLabel(iso) {
  const today = localDate();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (iso === today) return 'Today';
  if (iso === localDate(y)) return 'Yesterday';
  const t = new Date(); t.setDate(t.getDate() + 1);
  if (iso === localDate(t)) return 'Tomorrow';
  const [Y, M, D] = iso.split('-').map(Number);
  const d = new Date(Y, M - 1, D);
  const sameYear = Y === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).replace(',', '');
}
// Entry times follow the 12/24-hour setting, like the rest of the app.
function timeLabel(ms) { const d = new Date(ms); return hm(d.getHours() * 60 + d.getMinutes()); }

function promptForNow() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late. Anything on your mind?';
  if (h < 12) return "What's the plan for today?";
  if (h < 17) return "How's the day going?";
  if (h < 22) return 'How did today go? What got done, what didn\'t?';
  return 'Anything to note before you sleep?';
}

// ---------- views ----------

function show(view) {
  $$('.view').forEach(v => v.hidden = v.id !== `view-${view}`);
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('.top').hidden = view === 'auth';
  document.body.dataset.view = view;
  $('#fab').hidden = view === 'auth' || view === 'journal' || view === 'settings';
  $('#avatar').classList.toggle('active', view === 'settings');
  if (view === 'settings') renderSettings();
  if (view === 'log') { renderLog(); renderSubjects(); const d = new Date(), m = new Date(d); m.setDate(d.getDate() - 6); $('#log-kicker').textContent = `${m.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`; }
  if (view === 'settings') $('#set-kicker').textContent = data.user?.username ? 'Signed in as ' + data.user.username : 'Settings';
  if (view === 'today') { todayPanel = null; renderToday(); }
  if (view === 'plan') renderPlan();
  if (view === 'calendar') renderCalendar();
  if (view === 'journal') $('#composer').placeholder = promptForNow();
}
$$('.tab').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
// Logo, avatar (Settings) and the phone's write button.
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]')?.dataset.go;
  if (!g) return;
  if (g === 'write') { show('journal'); $('#composer').focus(); return; }
  show(g);
});

// ---------- auth ----------

let signingUp = false;

function showAuth(msg = '') {
  show('auth');
  $('#auth-error').textContent = msg;
}
$('#auth-toggle').addEventListener('click', () => {
  signingUp = !signingUp;
  $('#invite-row').hidden = !signingUp;
  $('#auth-form').invite.required = signingUp;
  $('#auth-form').password.autocomplete = signingUp ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = signingUp ? 'Create account' : 'Log in';
  $('#auth-title').textContent = signingUp ? 'Create an account' : 'Log in';
  $('#auth-toggle').textContent = signingUp ? 'Have an account? Log in' : 'New here? Create an account';
  $('#auth-error').textContent = '';
});
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const res = await api(signingUp ? '/api/signup' : '/api/login', {
      method: 'POST',
      body: { username: f.username.value, password: f.password.value, invite: f.invite.value },
    });
    // A different person logging in on this device must not see the previous person's cache.
    const prev = data.user?.id || data.lastUserId;
    if (prev && prev !== res.user.id) data = blank();
    data.user = res.user;
    data.settings = res.settings;
    persist();
    f.password.value = '';
    startApp();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && res.settings.timezone !== tz) api('/api/settings', { method: 'PUT', body: { timezone: tz } }).catch(() => {});
  } catch (err) {
    $('#auth-error').textContent = err.message === 'Failed to fetch' ? "Can't reach the server. Check your connection." : err.message;
  } finally {
    btn.disabled = false;
  }
});

function loggedOut(msg) {
  // Keep the cache and unsent edits: logging back in as the same person sends them.
  data.lastUserId = data.user?.id || data.lastUserId;
  data.user = null;
  persist();
  showAuth(msg);
}

$('#logout').addEventListener('click', async e => {
  if (DEMO) { e.stopImmediatePropagation(); return exitDemo(); }
  if (waitingCount() && !confirm(`${waitingCount()} change(s) haven't reached the server yet. Log out anyway? They'll be lost.`)) return;
  try { await pushOff(); } catch {}
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  await keyForget(data.user?.id);
  V.key = null;
  data = blank();
  persist();
  localStorage.removeItem('pl.draft');
  showAuth('Logged out.');
});

// ---------- composer ----------

const composer = $('#composer');
let energy = null;

function autosize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, 480) + 'px'; }

function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem('pl.draft') || 'null');
    if (d) { composer.value = d.text || ''; setEnergy(d.energy ?? null); autosize(composer); }
  } catch {}
}
function saveDraft() {
  try { localStorage.setItem('pl.draft', JSON.stringify({ text: composer.value, energy })); } catch {}
}
function setEnergy(v) {
  energy = v;
  $$('.energy button').forEach(b => b.classList.toggle('on', Number(b.dataset.energy) === v));
}
$$('.energy button').forEach(b => b.addEventListener('click', () => {
  const v = Number(b.dataset.energy);
  setEnergy(energy === v ? null : v);
  saveDraft();
}));
composer.addEventListener('input', () => { autosize(composer); saveDraft(); });
composer.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEntry(); }
});
$('#save-entry').addEventListener('click', saveEntry);

function saveEntry() {
  const text = composer.value.trim();
  if (!text) { composer.focus(); return; }
  if (vaultLocked()) { toast('Unlock your private journal first.'); renderVaultBanner(); return; }
  const now = Date.now();
  const id = crypto.randomUUID();
  data.entries[id] = { id, body: text, entry_date: localDate(), energy, created_at: now, updated_at: now, deleted: 0 };
  markDirty('entries', id);
  writtenHere(id);
  queueExtract(id);
  persist();
  composer.value = '';
  setEnergy(null);
  autosize(composer);
  localStorage.removeItem('pl.draft');
  renderEntries();
  sync();
}

// ---------- entry list ----------

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ENERGY = { 1: 'Low energy', 2: 'Okay energy', 3: 'High energy' };
let editing = null;

function bodyHtml(text) {
  return esc(text).replace(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu, (m, sp, tag) => `${sp}<button class="tag" data-tag="${tag}">#${tag}</button>`);
}

function renderEntries() {
  const q = $('#search').value.trim().toLowerCase();
  $('#clear-search').hidden = !q;
  const list = Object.values(data.entries)
    .filter(e => !e.deleted && (!q || (!e._locked && e.body.toLowerCase().includes(q))))
    .sort((a, b) => b.created_at - a.created_at);

  const byDay = new Map();
  for (const e of list) {
    if (!byDay.has(e.entry_date)) byDay.set(e.entry_date, []);
    byDay.get(e.entry_date).push(e);
  }
  const dirty = new Set(data.dirty.entries);
  let html = '', first = true;
  const newest = [...byDay.keys()][0];
  for (const [day, items] of byDay) {
    const open = q || (!closedDays.has(day) && (day === localDate() || openDays.has(day) || (day === newest && !byDay.has(localDate()))));
    if (!open) {
      html += `<div class="day folded"><button class="day-fold" data-day="${esc(day)}" aria-expanded="false"><span class="day-label">${esc(dayLabel(day))}</span><span class="muted">${items.length} entr${items.length > 1 ? 'ies' : 'y'}</span><span class="chev">▾</span></button></div>`;
      continue;
    }
    html += `<div class="day"><div class="day-label">${esc(dayLabel(day))}${day !== localDate() && !q ? `<button class="link day-fold" data-day="${esc(day)}" aria-expanded="true">Hide</button>` : ''}</div>`;
    for (const e of items) {
      const edited = e.updated_at - e.created_at > 60000 ? ' · edited' : '';
      const time = timeLabel(e.created_at);
      html += `<article class="entry" data-id="${esc(e.id)}">
        <div class="e-time mono">${time}</div>
        <div class="e-rail" aria-hidden="true"><i class="e-dot${first ? ' on' : ''}"></i><i class="e-line"></i></div>
        <div class="e-main">
        <div class="entry-meta">
          <span class="e-when mono">${esc(dayLabel(day))} · ${time}${edited}</span>
          ${e.energy ? `<span class="e-energy mono lv${e.energy}">${ENERGY[e.energy].toLowerCase()}</span>` : ''}
          ${dirty.has(e.id) && !DEMO ? '<span class="unsynced" title="Saved on this device, not yet on the server">not synced</span>' : ''}
          <span class="actions">${editing === e.id ? '' : e._locked ? '<button data-act="delete">Delete</button>' : readBtn(e) + '<button data-act="edit">Edit</button><button data-act="delete">Delete</button>'}</span>
        </div>
        ${editing === e.id
          ? `<textarea class="edit-box">${esc(e.body)}</textarea>
             <div class="row"><button class="primary" data-act="save">Save</button><button data-act="cancel">Cancel</button></div>`
          : e._locked ? '<div class="entry-body locked"><i></i><i></i><span class="sr">Private entry. Unlock your journal to read it.</span></div>'
          : `<div class="entry-body">${bodyHtml(e.body)}</div>${obsHtml(e)}`}
        </div>
      </article>`;
      first = false;
    }
    html += '</div>';
  }
  $('#entries').innerHTML = html;
  $('#empty').hidden = list.length > 0 || !!q;
  if (q && !list.length) $('#entries').innerHTML = '<p class="muted empty">No entries match.</p>';
  renderStrips();
  renderTagFilter(q);
  renderJournalSide();
  const box = $('.edit-box');
  if (box) { autosize(box); box.focus(); box.addEventListener('input', () => autosize(box)); }
}

$('#entries').addEventListener('click', e => {
  const tag = e.target.closest('.tag');
  if (tag) { $('#search').value = '#' + tag.dataset.tag; renderEntries(); return; }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.entry').dataset.id;
  const entry = data.entries[id];
  const act = btn.dataset.act;
  if (act === 'edit') { editing = id; renderEntries(); }
  if (act === 'cancel') { editing = null; renderEntries(); }
  if (act === 'save') {
    const text = $('.edit-box').value.trim();
    if (!text) return;
    if (text !== entry.body) {
      Object.assign(entry, { body: text, updated_at: nextTime(entry) });
      markDirty('entries', id);
      queueExtract(id);
      persist();
      sync();
    }
    editing = null;
    renderEntries();
  }
  if (act === 'delete') {
    const before = { ...entry };
    Object.assign(entry, { deleted: 1, updated_at: nextTime(entry) });
    markDirty('entries', id);
    const gone = dropEntryTasks(id);
    persist();
    safeRender();
    toast(gone.count ? `Entry deleted, with ${gone.count === 1 ? 'the plan' : `${gone.count} plans`} it made.` : 'Entry deleted.', 'Undo', () => {
      data.entries[id] = { ...before, deleted: 0, updated_at: nextTime(data.entries[id]) };
      markDirty('entries', id);
      gone.undo();
      persist();
      safeRender();
      sync();
    });
    // Give Undo a moment before telling the server (the server wipes deleted text).
    setTimeout(sync, 6500);
  }
});

$('#search').addEventListener('input', renderEntries);
$('#clear-search').addEventListener('click', () => { $('#search').value = ''; renderEntries(); });

// ---------- preferences ----------

function renderPrefs() {
  const items = Object.values(data.prefs).filter(p => !p.deleted).sort((a, b) => a.created_at - b.created_at);
  $('#prefs').innerHTML = items.length
    ? items.map(p => {
        let rule = null;
        try { rule = p.rule_json ? JSON.parse(p.rule_json) : null; } catch {}
        const reading = p.rule_json == null ? 'reading…' : PlannerCore.describeRule(rule);
        const canToggle = rule && (rule.type === 'day_off' || rule.type === 'no_work_between');
        return `<li data-id="${esc(p.id)}"><div class="pref-body"><span>${esc(p.text)}</span>
          <small class="muted">Planner: ${esc(reading)}${canToggle ? ` · <button class="link" data-pref="strict">${rule.strict ? 'Make it a preference' : 'Make it a must'}</button>` : ''}${rule && rule.type ? ' · <button class="link" data-pref="ignore">Ignore</button>' : ''}</small></div>
          <button data-pref="remove" aria-label="Remove">✕</button></li>`;
      }).join('')
    : '<li class="muted small">Nothing yet.</li>';
}
$('#pref-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#pref-input').value.trim();
  if (!text) return;
  const now = Date.now(), id = crypto.randomUUID();
  data.prefs[id] = { id, text, rule_json: null, created_at: now, updated_at: now, deleted: 0 };
  markDirty('prefs', id);
  persist();
  $('#pref-input').value = '';
  renderPrefs();
  sync();
});
$('#prefs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-pref]');
  const li = e.target.closest('li[data-id]');
  if (!btn || !li) return;
  const p = data.prefs[li.dataset.id];
  const act = btn.dataset.pref;
  if (act === 'remove') p.deleted = 1;
  if (act === 'ignore') p.rule_json = '{}';
  if (act === 'strict') { const r = JSON.parse(p.rule_json); r.strict = !r.strict; p.rule_json = JSON.stringify(r); }
  p.updated_at = nextTime(p);
  markDirty('prefs', p.id);
  persist();
  renderPrefs();
  sync();
});

// ---------- settings: AI ----------

let providers = null;
let aiTouched = false;   // don't overwrite the AI form while the user is filling it in
$('#ai-form').addEventListener('input', () => { aiTouched = true; });
$('#ai-form').addEventListener('change', () => { aiTouched = true; });

async function renderSettings() {
  await renderSettingsMain();
  renderBlendLine();
}
async function renderSettingsMain() {
  renderExams();
  aiTouched = false;
  $('#who').textContent = data.user?.username || '';
  $('#avatar-letter').textContent = (data.user?.username || '·').slice(0, 1).toUpperCase();
  renderPrefs();
  routineTouched = false;
  renderRoutine();
  renderVault();
  renderCalLink();
  if (!notifyTouched) renderNotify();
  renderInstall();
  if (!providers) {
    try { providers = (await api('/api/ai/providers')).providers; } catch { $('#ai-msg').textContent = 'Connect to the internet to change AI settings.'; return; }
    $('#ai-provider').innerHTML = '<option value="">None yet</option>' +
      providers.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  }
  try { data.settings = (await api('/api/me')).settings; persist(); } catch {}
  if (!routineTouched) renderRoutine();
  if (aiTouched) return;
  const s = data.settings || {};
  $('#ai-provider').value = s.ai_provider || '';
  $('#ai-model').value = s.ai_model || '';
  $('#ai-base').value = s.ai_base_url || '';
  $('#ai-key').value = '';
  $('#ai-key').placeholder = s.ai_has_key ? 'Saved. Type a new key to replace it.' : 'Paste your API key';
  updateAiForm();
}

function updateAiForm() {
  const p = providers?.find(x => x.id === $('#ai-provider').value);
  $('#ai-key-row').hidden = !p || !p.needsKey;
  $('#ai-model-row').hidden = !p;
  $('#ai-test').hidden = !p;
  $('#ai-base-row').hidden = !p || !p.needsBaseUrl;
  $('#ai-preset-row').hidden = !p || !p.presets.length;
  $('#ai-model').placeholder = p?.modelHint || '';
  if (p?.presets.length) {
    $('#ai-preset').innerHTML = p.presets.map(x => `<option value="${esc(x.baseUrl)}">${esc(x.label)}</option>`).join('') + '<option value="">Other (type the URL)</option>';
    const match = p.presets.find(x => x.baseUrl === $('#ai-base').value);
    $('#ai-preset').value = match ? match.baseUrl : ($('#ai-base').value ? '' : p.presets[0].baseUrl);
    if (!$('#ai-base').value) $('#ai-base').value = $('#ai-preset').value;
  }
}
$('#ai-provider').addEventListener('change', () => { $('#ai-base').value = ''; updateAiForm(); });
$('#ai-preset').addEventListener('change', () => { $('#ai-base').value = $('#ai-preset').value; });

$('#ai-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    ai_provider: $('#ai-provider').value || null,
    ai_model: $('#ai-model').value.trim(),
    ai_base_url: $('#ai-base').value.trim(),
  };
  if ($('#ai-key').value.trim()) body.ai_key = $('#ai-key').value.trim();
  try {
    data.settings = (await api('/api/settings', { method: 'PUT', body })).settings;
    persist();
    $('#ai-key').value = '';
    $('#ai-key').placeholder = data.settings.ai_has_key ? 'Saved. Type a new key to replace it.' : 'Paste your API key';
    $('#ai-msg').textContent = 'Saved.';
  } catch (err) { $('#ai-msg').textContent = err.message; }
});

$('#ai-test').addEventListener('click', async () => {
  $('#ai-msg').textContent = 'Testing… (save first if you changed anything)';
  try {
    const r = await api('/api/ai/test', { method: 'POST', body: {} });
    $('#ai-msg').textContent = r.ok ? `Working. Reply took ${(r.ms / 1000).toFixed(1)} s.` : 'The AI answered, but not in the expected format. Try a different model.';
  } catch (err) { $('#ai-msg').textContent = err.message; }
});

// ---------- settings: data ----------

$('#sync-now').addEventListener('click', () => { sync(); toast('Syncing…'); });

$('#export').addEventListener('click', async () => {
  try {
    await sync();
    const blob = new Blob([JSON.stringify(decryptExport(await api('/api/export')), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `journal-export-${localDate()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (err) { toast(err.message); }
});

$('#delete-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!confirm('Delete your account and everything in it? This cannot be undone.')) return;
  try {
    await api('/api/account', { method: 'DELETE', body: { password: $('#delete-pass').value } });
    try { (await currentSub())?.unsubscribe(); } catch {}
    await keyForget(data.user?.id);
    V.key = null;
    data = blank();
    persist();
    localStorage.removeItem('pl.draft');
    showAuth('Account deleted.');
  } catch (err) { toast(err.message); }
});

// ---------- install ----------

let installEvent = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; renderInstall(); });
function renderInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#install').hidden = !installEvent || standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('#install-hint').textContent = standalone ? 'Running as an installed app.'
    : ios ? 'On iPhone: tap Share, then "Add to Home Screen".'
    : installEvent ? '' : 'To install: open the browser menu and choose "Install app" or "Add to Home screen".';
}
$('#install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  renderInstall();
});

// ---------- toast ----------

let toastTimer = null;
function toast(msg, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : '');
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ---------- AI reading: confirm cards ----------

const CATS = ['study', 'work', 'project', 'exercise', 'chores', 'social', 'rest', 'other'];
const OUTCOME = { done: 'done', partly: 'partly done', not_done: 'not done', unknown: '' };
const reading = new Set();      // entries the AI is reading right now
const forced = new Set();       // older entries the user asked the AI to read
let fixing = null;              // observation being corrected by hand
let aiNote = '';

const parse = o => { try { return JSON.parse(o.data) || {}; } catch { return {}; } };
const fmtMin = m => !m ? '' : m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} h`;
// Never let a device's clock make a newer change look older than the server's copy.
const nextTime = row => Math.max(Date.now(), (row.updated_at || 0) + 1);

function queueExtract(id) {
  if (DEMO) return demoRead(id);
  // Automatic reading only happens for entries written while an AI is set up.
  if (!data.settings?.ai_provider && !forced.has(id)) return;
  if (!data.toExtract.includes(id)) data.toExtract.push(id);
}

async function runExtractions() {
  if (!data.settings?.ai_provider) return;
  for (const id of [...data.toExtract]) {
    const e = data.entries[id];
    const drop = () => { data.toExtract = data.toExtract.filter(x => x !== id); };
    const old = e && Date.now() - e.created_at > 3 * 864e5 && !forced.has(id);
    if (!e || e.deleted || e.extracted_version === e.updated_at || old) { drop(); continue; }
    if (data.dirty.entries.includes(id)) continue;   // not on the server yet
    const priv = vaultOn();
    if (priv && (e._locked || !V.key)) continue;     // private and not unlocked here: can't read it
    reading.add(id);
    safeRender();
    try {
      if (priv) {
        // Private journal: send the text for this one reading; the notes come back and are saved encrypted.
        const r = await api('/api/extract', { method: 'POST', body: { entry_id: id, text: e.body, already: alreadyFor(id), plans: plansForAI() } });
        storePrivateNotes(id, r.items);
        if (data.entries[id]?.updated_at === r.extracted_version) data.entries[id].extracted_version = r.extracted_version;
        drop();
        aiNote = '';
        continue;
      }
      const r = await api('/api/extract', { method: 'POST', body: { entry_id: id, plans: plansForAI() } });
      for (const o of r.rows) {
        if (!data.dirty.observations.includes(o.id)) data.observations[o.id] = o;
      }
      if (data.entries[id]?.updated_at === r.extracted_version) data.entries[id].extracted_version = r.extracted_version;
      drop();
      aiNote = '';
    } catch (err) {
      if (!err.status || err.status === 503) break;  // offline or the AI is busy: try again on the next sync
      drop();                                         // AI problem: show it once, don't keep retrying
      aiNote = err.message;
    } finally {
      reading.delete(id);
      forced.delete(id);
      persist();
      safeRender();
    }
  }
}

// Redraw unless the user is in the middle of typing an edit or a correction.
function safeRender() {
  if (!editing && !fixing) {
    renderEntries();
    if (!$('#view-log').hidden) renderLog();
  }
  if (!$('#view-today').hidden && !todayBusy()) renderToday();
  if (!$('#view-plan').hidden && !planBusy()) renderPlan();
  if (!$('#view-calendar').hidden && !calForm) renderCalendar();
}

function obsFor(entryId) {
  return Object.values(data.observations)
    .filter(o => o.entry_id === entryId && !o.deleted && !o._locked && o.status !== 'rejected')
    .sort((a, b) => a.created_at - b.created_at);
}

function obsLine(o, d) {
  if (o.kind === 'preference') return `Remember: “${esc(d.text || '')}”`;
  if (o.kind === 'update') return updateLine(d);
  if (o.kind === 'intention') {
    if (d.task_id === 'split' && d.split_ids) return splitLine(d);
    const rep = PC.cleanRepeat(d.repeat);
    if (rep) return `<b>${esc(planTitle(d.task))}</b> · ${esc(repeatShort(rep))}${rep.time ? ' · ' + esc(hm(PC.toMin(rep.time))) : ''}`;
    return `${d.category === 'reminder' ? 'Reminder' : 'Plan'}: <b>${esc(d.category === 'reminder' ? d.task : planTitle(d.task) || d.task || '')}</b>${d.date ? ' · ' + esc(dayLabel(d.date)) : ''}${d.time ? ' · ' + esc(hm(PC.toMin(d.time))) : ''}`;
  }
  return [esc(d.task || ''), d.minutes ? fmtMin(d.minutes) + (d.estimated ? ' (guess)' : '') : '',
          OUTCOME[d.outcome] || '', d.reason ? esc(d.reason) : ''].filter(Boolean).join(' · ');
}

function readBtn(e) {
  const can = data.settings?.ai_provider && !reading.has(e.id) && e.extracted_version !== e.updated_at && !data.toExtract.includes(e.id);
  return can ? '<button data-oact="read">Read with AI</button>' : '';
}

function obsHtml(e) {
  if (reading.has(e.id)) return '<div class="noted muted small">Reading…</div>';
  const list = obsFor(e.id);
  if (!list.length) return '';
  const pending = list.filter(o => o.status === 'pending');
  const done = list.filter(o => o.status === 'confirmed');
  let h = '<div class="noted">';
  if (pending.length) {
    h += `<div class="noted-head"><span>Noted. Is this right?</span>${pending.length > 1 ? '<button class="link" data-oact="all">Confirm all</button>' : ''}</div>`;
    for (const o of pending) {
      const d = parse(o);
      if (fixing === o.id) { h += fixForm(o, d); continue; }
      h += `<div class="ob" data-oid="${esc(o.id)}"><span class="ob-text">${obsLine(o, d)}</span>`;
      if (o.kind === 'activity' && !d.minutes) {
        h += `<span class="ask">How long? ${[15, 30, 60, 120, 180].map(m => `<button data-oact="min" data-min="${m}">${fmtMin(m)}</button>`).join('')}</span>`;
      }
      h += o.kind === 'preference'
        ? '<span class="ob-btns"><button data-oact="ok">Add to my list</button><button data-oact="no">No</button></span>'
        : `<span class="ob-btns"><button data-oact="ok" title="Correct" aria-label="Correct">✓</button>${o.kind === 'intention' && needsSplit(o) ? '<button data-oact="split" title="Split into topics and plan them">Break it down</button>' : ''}<button data-oact="fix">Fix</button><button data-oact="no" title="Not right" aria-label="Not right">✕</button></span>`;
      h += '</div>';
    }
  }
  // A confirmed note can be fixed in place (✎); the task and its session follow.
  for (const o of done) if (fixing === o.id) h += fixForm(o, parse(o));
  const chips = done.filter(o => fixing !== o.id);
  if (chips.length) {
    h += '<div class="ob-done">' + chips.map(o =>
      `<span class="ob-card" data-oid="${esc(o.id)}"><span class="ob-t"><span class="ob-tick" aria-hidden="true">✓</span> ${obsLine(o, parse(o))}</span><span class="ob-acts">${o.kind === 'intention' && needsSplit(o) ? '<button class="ob-split" data-oact="split" title="Split into topics and plan them">Break down</button>' : ''}${!['preference', 'update'].includes(o.kind) && parse(o).task_id !== 'split' ? '<button data-oact="fix" title="Change it" aria-label="Change it">✎</button>' : ''}<button data-oact="undo" title="Undo" aria-label="Undo">↺</button></span></span>`).join('') + '</div>';
  }
  return h + '</div>';
}

// "Break it down" only makes sense for a plan with several parts: the AI says so, the entry lists
// several things, or it's a big piece of work. A single task ("Complete my CTME assignment") doesn't get it.
function needsSplit(o) {
  const d = parse(o);
  if (d.repeat || d.task_id === 'split') return false;
  if ((d.parts || 0) >= 2 || (d.minutes || 0) >= 240) return true;
  const e = data.entries[o.entry_id], text = (e && !e._locked ? e.body : '') + ' ' + (d.task || '');
  if (/\b(topics|chapters|units|modules|syllabus|portions?|subjects|lectures|everything|all of)\b/i.test(text)) return true;
  const items = text.split(/[,;\n•]|\band\b/).map(x => x.trim()).filter(x => x.length > 2);
  return items.length >= 4;
}

function fixForm(o, d) {
  const kind = o.kind === 'activity' ? 'what you did' : o.kind === 'intention' ? 'plan' : 'note';
  const fld = (label, input, cls = '') => `<label class="fld${cls}"><span>${label}</span>${input}</label>`;
  let f = `<div class="ob fix" data-oid="${esc(o.id)}" data-repeat="${o.kind === 'intention' && PlannerCore.cleanRepeat(d.repeat) ? 'yes' : 'no'}"><p class="lbl amber">Fixing · ${kind}</p>`;
  f += fld('Task', `<input name="task" value="${esc(d.task || '')}" maxlength="120" placeholder="What is it?">`);
  if (o.kind === 'activity') {
    f += '<div class="fld-row">'
      + fld('Minutes', `<input name="minutes" class="mono" type="number" min="1" max="960" inputmode="numeric" value="${d.minutes ?? ''}" placeholder="e.g. 60">`)
      + fld('How it went', `<select name="outcome">${[['done', 'Done'], ['partly', 'Partly'], ['not_done', 'Not done'], ['unknown', 'Not sure']]
        .map(([v, l]) => `<option value="${v}"${v === d.outcome ? ' selected' : ''}>${l}</option>`).join('')}</select>`) + '</div>';
    f += fld('Why, if it didn\'t go to plan', `<input name="reason" value="${esc(d.reason || '')}" maxlength="200" placeholder="Optional">`);
    f += '<label class="check-row"><input type="checkbox" name="asplan"><span>I haven\'t done this yet. It\'s a plan.</span></label>';
  }
  const cat = fld('Type', `<select name="category">${CATS.map(c => `<option${c === d.category ? ' selected' : ''}>${c}</option>`).join('')}</select>`);
  if (o.kind === 'intention') {
    const rep = PlannerCore.cleanRepeat(d.repeat);
    f += '<div class="fld-row">' + fld('Day', `<input name="date" class="mono" type="date" value="${esc(rep ? '' : d.date || '')}">`)
      + fld('At (optional)', `<input name="time" class="mono" type="time" value="${esc(d.time || rep?.time || '')}">`) + '</div>';
    f += '<div class="fld-row">' + fld('How long (min)', `<input name="minutes" class="mono" type="number" min="5" max="480" inputmode="numeric" value="${d.minutes ?? ''}" placeholder="60">`) + cat + '</div>';
    f += `<div class="fld"><span>How often</span>${howOftenHtml({ repeat: d.repeat })}</div>`;
  }
  else f += cat;
  return f + '<div class="fix-btns"><button class="primary" data-oact="savefix">Save</button><button class="bare" data-oact="cancelfix">Cancel</button></div></div>';
}

function setObs(o, patch) {
  Object.assign(o, patch, { updated_at: nextTime(o) });
  markDirty('observations', o.id);
}

function confirmObs(o) {
  if (o.kind === 'preference') addPref(parse(o).text);
  if (o.kind === 'intention') journalToTask(o);
  if (o.kind === 'activity') journalDone(o);
  if (o.kind === 'update') applyPlanUpdate(o);
  setObs(o, { status: 'confirmed' });
}

// Private journal: notes from the AI are saved by this device (and encrypted on upload).
function storePrivateNotes(entryId, items) {
  for (const o of obsFor(entryId)) if (o.status === 'pending') { o.deleted = 1; o.updated_at = nextTime(o); markDirty('observations', o.id); }
  const base = Date.now();
  items.forEach((it, i) => {
    const o = { id: crypto.randomUUID(), entry_id: entryId, kind: it.kind, data: JSON.stringify(it.data), status: 'pending', source: 'ai', created_at: base + i, updated_at: base + i, deleted: 0 };
    data.observations[o.id] = o;
    markDirty('observations', o.id);
  });
}
const alreadyFor = id => obsFor(id).filter(o => o.status === 'confirmed').map(o => {
  const d = parse(o);
  return o.kind === 'preference' ? d.text : o.kind === 'intention' ? `${d.task} (plan)` : d.task;
}).filter(Boolean);

$('#entries').addEventListener('click', e => {
  const b = e.target.closest('button[data-oact]');
  if (!b) return;
  const act = b.dataset.oact;
  const entryId = b.closest('.entry')?.dataset.id;
  const o = data.observations[b.closest('[data-oid]')?.dataset.oid];
  if (act === 'read') { forced.add(entryId); queueExtract(entryId); }
  if (act === 'all') obsFor(entryId).filter(x => x.status === 'pending').forEach(confirmObs);
  if (act === 'ok') confirmObs(o);
  if (act === 'split') return splitFromJournal(o, data.entries[entryId]);
  if (act === 'no') setObs(o, { status: 'rejected' });
  if (act === 'undo') {
    // ↺ takes back what the note did: the task and sessions it made (or the split), not just the tick.
    const d = parse(o);
    if (o.kind === 'intention' && d.task_id === 'split' && d.split_ids) return undoSplit(o);
    if (o.kind === 'update' && d.applied) return undoPlanUpdate(o);
    if (o.kind === 'intention' && d.task_id && d.task_id !== 'split' && data.tasks[d.task_id]) return undoJournalTask(d.task_id, o);
    setObs(o, { status: 'pending' });
  }
  if (act === 'min') {
    const d = parse(o);
    Object.assign(d, { minutes: Number(b.dataset.min), estimated: false });
    setObs(o, { data: JSON.stringify(d), status: 'confirmed' });
  }
  if (act === 'fix') fixing = o.id;
  if (act === 'cancelfix') fixing = null;
  if (act === 'fday') { b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); return; }
  if (act === 'savefix') {
    const box = b.closest('.fix');
    const val = n => box.querySelector(`[name=${n}]`)?.value.trim() || '';
    const d = parse(o);
    d.task = val('task') || d.task;
    d.category = val('category') || d.category;
    if (o.kind === 'activity' && box.querySelector('[name=asplan]')?.checked) {
      // Read as "done" by mistake: make it a plan for today, so it becomes a task.
      const m = parseInt(val('minutes'), 10);
      o.kind = 'intention';
      for (const k of ['outcome', 'reason', 'estimated']) delete d[k];
      Object.assign(d, { date: localDate(), minutes: m > 0 ? Math.min(m, 480) : null });
    } else if (o.kind === 'activity') {
      const m = parseInt(val('minutes'), 10);
      Object.assign(d, { minutes: m > 0 ? Math.min(m, 960) : null, estimated: false, outcome: val('outcome') || 'unknown', reason: val('reason') || null });
    }
    if (o.kind === 'intention') {
      const time = /^\d\d:\d\d$/.test(val('time')) ? val('time') : null, m = parseInt(val('minutes'), 10);
      const rep = readHowOften(box);
      d.repeat = rep ? { ...rep, time } : null;
      if (rep) d.task = planTitle(val('task') || d.task);
      d.date = rep ? null : val('date') || (box.querySelector('[name=date]') ? null : d.date) || null;
      d.time = time;
      d.minutes = m > 0 ? Math.min(m, 480) : d.minutes || null;
    }
    // Saving a fix confirms the note, so it does what ✓ does (it used to skip making the task).
    o.data = JSON.stringify(d);
    if (o.kind === 'intention') { if (parse(o).task_id && parse(o).task_id !== 'split') syncTaskFromNote(o); else journalToTask(o); }
    if (o.kind === 'activity') journalDone(o);
    if (o.kind === 'preference') addPref(parse(o).text);
    setObs(o, { data: o.data, status: 'confirmed', source: 'user' });
    fixing = null;
  }
  persist();
  renderEntries();
  if (act !== 'fix' && act !== 'cancelfix') sync();
});

function addPref(text) {
  text = String(text || '').trim();
  if (!text) return;
  const now = Date.now(), id = crypto.randomUUID();
  data.prefs[id] = { id, text, rule_json: null, created_at: now, updated_at: now, deleted: 0 };
  markDirty('prefs', id);
  renderPrefs();
}

function pendingCount() {
  return Object.values(data.observations).filter(o =>
    !o.deleted && !o._locked && o.status === 'pending' && data.entries[o.entry_id] && !data.entries[o.entry_id].deleted).length;
}

function privateOn() {
  let v = data.settings?.vault;
  try { if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return !!(v && !v.off);
}

function renderStrips() {
  const n = pendingCount();
  const kick = $('#j-kicker');
  kick.textContent = n ? (n === 1 ? '1 note to confirm' : `${n} notes to confirm`) : privateOn() ? 'Private journal' : 'Your journal';
  kick.classList.toggle('amber', !!n);
  $('#confirm-strip').hidden = !n;
  $('#confirm-strip').textContent = n === 1 ? '1 thing to confirm' : `${n} things to confirm`;
  $('#ai-note').hidden = !aiNote;
  $('#ai-note span').textContent = aiNote ? `The AI couldn't read your entry: ${aiNote}` : '';
}
// Tag chips: the tags you use most, one tap to filter.
const openDays = new Set(), closedDays = new Set();
$('#entries').addEventListener('click', e => {
  const b = e.target.closest('.day-fold');
  if (!b) return;
  const d = b.dataset.day;
  // "Hide" folds a day that's open (even the newest one, which opens by itself); tapping a folded day opens it.
  if (b.getAttribute('aria-expanded') === 'true') { openDays.delete(d); closedDays.add(d); }
  else { closedDays.delete(d); openDays.add(d); }
  renderEntries();
});

function renderTagFilter(q) {
  const count = new Map();
  for (const e of Object.values(data.entries)) {
    if (e.deleted || e._locked) continue;
    for (const t of new Set((e.body.match(/#[\p{L}\p{N}_-]+/gu) || []).map(x => x.toLowerCase()))) count.set(t, (count.get(t) || 0) + 1);
  }
  const tags = [...count].sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
  const box = $('#tag-filter');
  box.hidden = !tags.length;
  box.innerHTML = tags.length ? `<button class="tagf${!q ? ' on' : ''}" data-tag="" aria-pressed="${!q}">All</button>` + tags.map(t =>
    `<button class="tagf mono${q === t ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${q === t}">${esc(t)}</button>`).join('') : '';
}
$('#tag-filter').addEventListener('click', e => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  $('#search').value = b.dataset.tag;
  renderEntries();
});
$('#j-search-btn').addEventListener('click', () => {
  const on = !$('#view-journal').classList.toggle('searching') ? false : true;
  $('#j-search-btn').setAttribute('aria-expanded', on);
  if (on) $('#search').focus();
});

// PC side column: what the journal logged in the last 7 days.
function renderJournalSide() {
  const box = $('#j-stats');
  const from = PC.addDays(localDate(), -6);
  const acts = Object.values(data.observations).filter(o => !o.deleted && !o._locked && o.status === 'confirmed' && o.kind === 'activity'
    && data.entries[o.entry_id] && !data.entries[o.entry_id].deleted && data.entries[o.entry_id].entry_date >= from).map(parse);
  if (!acts.length) { box.hidden = true; return; }
  const byCat = {}, n = { done: 0, partly: 0, not_done: 0 };
  let total = 0;
  for (const d of acts) { const m = d.minutes || 0; total += m; byCat[d.category || 'other'] = (byCat[d.category || 'other'] || 0) + m; if (d.outcome in n) n[d.outcome]++; }
  const cats = Object.entries(byCat).filter(x => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 4), top = cats[0]?.[1] || 1;
  const hm2 = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + m % 60 : ''}` : `${m}m`;
  box.hidden = false;
  box.innerHTML = `<h2>From your journal <span>last 7 days</span></h2>
    <p class="disp j-total">${hm2(total)} logged</p>
    <p class="muted small">${[n.done && n.done + ' done', n.partly && n.partly + ' partly', n.not_done && n.not_done + ' not done'].filter(Boolean).join(' · ')}</p>
    <div class="j-bars">${cats.map(([c, m]) => `<span>${esc(c)}</span><div class="bar"><i style="width:${Math.round(m / top * 100)}%"></i></div><span class="mono">${hm2(m)}</span>`).join('')}</div>`;
}

$('#confirm-strip').addEventListener('click', () => {
  $('.noted .ob')?.closest('.entry').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#ai-note-settings').addEventListener('click', () => show('settings'));
$('#ai-note-dismiss').addEventListener('click', () => { aiNote = ''; renderStrips(); });

// ---------- Log tab ----------

function renderLog() {
  renderReview();
  const live = o => !o.deleted && !o._locked && o.status === 'confirmed' && data.entries[o.entry_id] && !data.entries[o.entry_id].deleted;
  const all = Object.values(data.observations).filter(live)
    .map(o => ({ o, d: parse(o), date: data.entries[o.entry_id].entry_date }));
  const today = localDate();
  const start = new Date(); start.setDate(start.getDate() - 6);
  const from = localDate(start);
  const acts = all.filter(x => x.o.kind === 'activity' && !x.d.block_id);   // ones that closed a session are counted with sessions
  const week = acts.filter(x => x.date >= from && x.date <= today);

  const byCat = {};
  const counts = { done: 0, partly: 0, not_done: 0 };
  let total = 0;
  for (const x of week) {
    const m = x.d.minutes || 0;
    byCat[x.d.category || 'other'] = (byCat[x.d.category || 'other'] || 0) + m;
    total += m;
    if (x.d.outcome in counts) counts[x.d.outcome]++;
  }
  const max = Math.max(1, ...Object.values(byCat));
  $('#week').innerHTML = !week.length
    ? '<p class="muted small">No time logged from your journal in the last 7 days. When you write what you did and confirm the notes, it shows up here.</p>'
    : `<p class="small">${fmtMin(total) || '0 min'} logged · ${counts.done} done · ${counts.partly} partly · ${counts.not_done} not done</p>` +
      Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, m]) =>
        `<div class="bar-row"><span>${esc(c)}</span><div class="bar"><i style="width:${(m / max) * 100}%"></i></div><span>${fmtMin(m) || '–'}</span></div>`).join('');

  // A plan whose task you deleted (or that came from a deleted entry) doesn't belong here any more.
  const plans = all.filter(x => x.o.kind === 'intention' && (!x.d.date || x.d.date >= today) && !(x.d.task_id && (data.tasks[x.d.task_id]?.deleted || data.tasks[x.d.task_id]?.status === 'done')))
    .sort((a, b) => (a.d.date || '9999').localeCompare(b.d.date || '9999'));
  // Show whether each plan actually has a time in the schedule yet.
  const nextSession = taskId => blocksOf(taskId).filter(b => b.status === 'planned' && (b.date > today || (b.date === today && (b.end_min > nowMin() || b.started_at))))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min)[0];
  const planStatus = x => {
    const t = data.tasks[x.d.task_id], b = t ? nextSession(t.id) : null;
    const rep = t?.repeat ? `<span class="chip">↻ ${esc(repeatShort(t.repeat))}</span>` : '';
    if (b) return `<span class="chip next">Next: ${esc(dayLabel(b.date))}, ${hm(b.start_min)}</span>${rep}`;
    if (rep) return `<span class="chip missed">not booked yet</span>${rep}`;
    return `<span class="chip missed">${x.d.date ? esc(dayLabel(x.d.date)) + ' · ' : ''}not scheduled yet</span>`;
  };
  $('#plans').innerHTML = plans.length
    ? plans.map(x => `<li class="r2"><span class="main">${esc(data.tasks[x.d.task_id]?.title || x.d.task || '')}</span><span class="sub">${planStatus(x)}</span></li>`).join('')
      + (waitingToPlan().count ? '<li><button class="primary" data-rv="plan">Plan them now</button></li>' : '')
    : '<li class="muted small">No plans noted yet.</li>';

  const days = new Map();
  for (const x of acts.sort((a, b) => b.date.localeCompare(a.date) || b.o.created_at - a.o.created_at)) {
    if (!days.has(x.date)) days.set(x.date, []);
    days.get(x.date).push(x);
  }
  let h = '';
  for (const [day, items] of [...days].slice(0, 30)) {
    const sum = items.reduce((s, x) => s + (x.d.minutes || 0), 0);
    h += `<div class="day"><div class="day-label">${esc(dayLabel(day))}${sum ? ' · ' + fmtMin(sum) : ''}</div><div class="card log-day">` +
      items.map(x => `<div class="log-row"><span>${esc(x.d.task || '')}</span><span class="muted small">${[fmtMin(x.d.minutes), OUTCOME[x.d.outcome]].filter(Boolean).join(' · ')}</span></div>`).join('') +
      '</div></div>';
  }
  $('#log').innerHTML = h;
}

// ---------- start ----------

function startApp() {
  if (DEMO) { document.body.classList.add('demo'); show('today'); renderEntries(); renderPrefs(); renderStatus(); return; }
  api('/api/me').then(r => { data.settings = r.settings; persist(); safeRender(); }).catch(() => {});
  show('today');
  restoreDraft();
  renderEntries();
  renderPrefs();
  renderStatus();
  sync().finally(() => setTimeout(carryOver, 800));
  vaultInit().then(() => { handleLaunch(); });
  refreshPush();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Start once plan.js has loaded too.
document.addEventListener('DOMContentLoaded', () => { if (data.user) startApp(); else showAuth(); });

// Tap the sync pill: say what's wrong (the reason was only in a hover tooltip, which phones never show) and try again.
$('#status').addEventListener('click', () => {
  if (lastError && lastError !== 'offline') toast('Sync problem: ' + lastError);
  else if (lastError === 'offline' || !navigator.onLine) toast("You're offline. Changes are saved here and will sync when you're back online.");
  sync();
});

// Keyboard shortcuts on a computer: 1–5 switch tabs, N writes, A adds a task, / searches the journal, Esc closes.
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || $('.top').hidden) return;
  const t = e.target;
  if (t.closest('input, textarea, select, [contenteditable]')) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  const tabs = { 1: 'today', 2: 'journal', 3: 'plan', 4: 'calendar', 5: 'log' };
  if (tabs[e.key]) { show(tabs[e.key]); e.preventDefault(); }
  else if (e.key === 'n' || e.key === 'N') { show('journal'); $('#composer').focus(); e.preventDefault(); }
  else if (e.key === 'a' || e.key === 'A') { show('plan'); $('#quick-title').focus(); e.preventDefault(); }
  else if (e.key === '/') { show('journal'); $('#view-journal').classList.add('searching'); $('#search').focus(); e.preventDefault(); }
});
