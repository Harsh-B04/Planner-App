// Notifications: turn them on per device, choose when they come, and open the right screen when tapped.
'use strict';

const LEADS = [[null, 'Off'], [0, 'At the start'], [5, '5 min before'], [10, '10 min before'], [15, '15 min before'], [30, '30 min before']];

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;

function keyBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /android/i.test(ua) ? 'Android' : isIOS() ? 'iPhone' : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : 'Device';
  return `${kind}${standalone() ? ' app' : ' browser'}`;
}

async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function pushOn() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied'
    ? 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.'
    : 'You need to allow notifications for this to work.');
  const { key } = await api('/api/push/key');
  if (!key) throw new Error('Notifications aren\'t set up on the server yet (see "Notifications" in the README).');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  return api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: deviceLabel() } });
}

async function pushOff() {
  const sub = await currentSub();
  if (!sub) return;
  try { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch {}
  await sub.unsubscribe();
}

// On each start: make sure the server still has this device (it may have been cleaned up).
async function refreshPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await currentSub();
    if (sub) await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: deviceLabel() } });
  } catch {}
}

let notifyTouched = false;

async function renderNotify() {
  const box = $('#notify');
  const n = data.settings?.notify || { lead: 10, evening: '21:00', morning: null };
  let state = 'unsupported', devices = 0;
  if (pushSupported()) {
    state = Notification.permission === 'denied' ? 'blocked' : (await currentSub()) ? 'on' : 'off';
  }
  try { devices = (await api('/api/push/key')).devices; } catch {}

  let top;
  if (state === 'unsupported') {
    top = isIOS() && !standalone()
      ? '<p class="small">On iPhone, add the app to your Home Screen first (Share → Add to Home Screen), then open it from there and turn notifications on.</p>'
      : '<p class="small">This browser can\'t show notifications. Try Chrome or Edge.</p>';
  } else if (state === 'blocked') {
    top = '<p class="small">Notifications are blocked for this site. Allow them in your browser or phone settings, then come back here.</p>';
  } else if (state === 'on') {
    top = '<p class="small">On for this device.</p><div class="row"><button data-nact="test">Send a test</button><button data-nact="off">Turn off here</button></div>';
  } else {
    top = '<div class="row"><button class="primary" data-nact="on">Turn on for this device</button></div>';
  }
  const devText = devices ? `<p class="muted small">${devices} device${devices > 1 ? 's' : ''} get${devices > 1 ? '' : 's'} your notifications.</p>` : '';
  const timeCtl = (id, value) => `<input type="time" id="${id}" value="${value || ({ 'n-evening': '21:00', 'n-morning': '07:30', 'n-todo': '08:00' })[id]}"${value ? '' : ' disabled'} aria-label="Time"><input type="checkbox" class="switch" id="${id}-on"${value ? ' checked' : ''} aria-label="On">`;

  box.innerHTML = `${top}${devText}
    <div class="frows">
    ${frow('Session reminder', "Before each planned session; when it's over you get Done / +15 min.", `<select id="n-lead">${LEADS.map(([v, l]) => `<option value="${v}"${v === n.lead ? ' selected' : ''}>${l}</option>`).join('')}</select>`, { for: 'n-lead', stack: true })}
    ${frow('Evening check-in', "Asks only about what's missing. Silent when there's nothing.", timeCtl('n-evening', n.evening), { stack: true })}
    ${frow('Morning to-do check', 'Suggests a time for things due today with none yet.', timeCtl('n-todo', n.todo === undefined ? '08:00' : n.todo), { stack: true })}
    ${frow('Morning summary', "Today's plan in one notification.", timeCtl('n-morning', n.morning), { stack: true })}
    ${frow('Week in review', 'Sunday evenings.', `<input type="checkbox" class="switch" id="n-weekly"${n.weekly === false ? '' : ' checked'} aria-label="On">`, { for: 'n-weekly' })}
    </div>
    <div class="row"><button class="primary" data-nact="save">Save</button></div>
    <p class="small" id="n-msg" role="status"></p>`;
  notifyTouched = false;
}

$('#notify').addEventListener('change', e => {
  notifyTouched = true;
  if (e.target.id?.endsWith('-on')) $('#' + e.target.id.slice(0, -3)).disabled = !e.target.checked;
});

$('#notify').addEventListener('click', async e => {
  const btn = e.target.closest('[data-nact]');
  if (!btn) return;
  const msg = t => { const el = $('#n-msg'); if (el) el.textContent = t; };
  btn.disabled = true;
  try {
    const act = btn.dataset.nact;
    if (act === 'on') { await pushOn(); await renderNotify(); msg('Turned on. Tap "Send a test" to check.'); }
    if (act === 'off') { await pushOff(); await renderNotify(); msg('Turned off for this device.'); }
    if (act === 'test') { const r = await api('/api/push/test', { method: 'POST', body: {} }); msg(r.sent ? 'Sent. It should appear in a few seconds.' : 'No device got it. Try turning notifications off and on again.'); }
    if (act === 'save') {
      const leadVal = $('#n-lead').value;
      const notify = {
        lead: leadVal === 'null' ? null : Number(leadVal),
        evening: $('#n-evening-on').checked ? $('#n-evening').value : null,
        morning: $('#n-morning-on').checked ? $('#n-morning').value : null,
        weekly: $('#n-weekly').checked,
        todo: $('#n-todo-on').checked ? $('#n-todo').value : null,
      };
      data.settings = (await api('/api/settings', { method: 'PUT', body: { notify } })).settings;
      persist();
      notifyTouched = false;
      msg('Saved.');
    }
  } catch (err) {
    msg(err.message === 'Failed to fetch' ? 'You need internet for this.' : err.message);
  } finally {
    btn.disabled = false;
  }
});

// Opening the app from a notification: /?view=today or /?view=today&start=<session id>
function handleLaunch() {
  const q = new URLSearchParams(location.search);
  const view = q.get('view'), start = q.get('start');
  // Shared from another app (Android share menu): ?share_title=&share_text=&share_url=
  const shared = [...new Set(['share_title', 'share_text', 'share_url'].map(k => (q.get(k) || '').trim()).filter(Boolean))].join('\n');
  if (!view && !start && !shared) return;
  history.replaceState(null, '', '/');
  if (shared) openShareSheet(shared);
  if (q.get('new')) setTimeout(() => $('#composer').focus(), 60);
  if (q.get('quick')) setTimeout(() => $('#quick-title')?.focus(), 60);
  if (q.get('review')) setTimeout(() => $('#review')?.scrollIntoView({ block: 'start' }), 60);
  if (q.get('todo')) setTimeout(() => handleTodoLaunch(q.get('todo'), q), 80);
  // From the "Time's up" notification: Done opens the done panel; +15 min stretches the running session.
  const fin = data.blocks[q.get('finish')], ext = data.blocks[q.get('extend')];
  if (fin && !fin.deleted && fin.status === 'planned') setTimeout(() => { todayPanel = { id: fin.id, kind: 'done' }; renderToday(); }, 80);
  if (ext && !ext.deleted && ext.status === 'planned' && ext.started_at) {
    ext.end_min = Math.min(1440, ext.end_min + 15);
    put('blocks', ext); persist(); sync();
    setTimeout(() => { renderToday(); toast(`15 more minutes on "${taskTitle(ext)}".`); }, 80);
  }
  if (['today', 'journal', 'plan', 'calendar', 'log', 'settings'].includes(view)) show(view);
  if (start) {
    const b = data.blocks[start];
    const running = liveRows('blocks').find(x => x.status === 'planned' && x.started_at && x.id !== start);
    if (b && !b.deleted && b.status === 'planned' && !b.started_at && !running) {
      b.started_at = Date.now();
      put('blocks', b);
      persist();
      sync();
      renderToday();
      toast(`Timer started: ${taskTitle(b)}`);
    }
  }
  if (view === 'journal') setTimeout(() => $('#composer').focus(), 50);
}

// The service worker tells an already-open app where to go when a notification is tapped.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open' && typeof e.data.url === 'string') {
      history.replaceState(null, '', e.data.url);
      if (data.user) handleLaunch();
    }
  });
}
