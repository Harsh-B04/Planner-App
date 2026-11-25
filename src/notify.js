// What to send and when. Runs every 5 minutes (cron). Each person gets, in their own time zone:
//  - a reminder before each planned session (with a "Start timer" button)
//  - an optional morning summary
//  - one evening check-in that asks only for what's missing: session outcomes, unconfirmed notes, or a journal line
import { sendPush } from './push.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const NOTIFY_DEFAULT = { lead: 10, evening: '21:00', morning: null, weekly: true, todo: '08:00' };

export function cleanNotify(n) {
  n = n && typeof n === 'object' ? n : {};
  const time = (v, dflt) => (v === null ? null : typeof v === 'string' && HHMM.test(v) ? v : dflt);
  return {
    lead: n.lead === null ? null : [0, 5, 10, 15, 30].includes(n.lead) ? n.lead : NOTIFY_DEFAULT.lead,
    evening: time(n.evening, NOTIFY_DEFAULT.evening),
    morning: time(n.morning, NOTIFY_DEFAULT.morning),
    weekly: n.weekly === false ? false : true,
    todo: time(n.todo, NOTIFY_DEFAULT.todo),
  };
}

export function localNow(tz, ms) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
  } catch {
    return localNow('UTC', ms);
  }
  const get = t => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, min: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMin = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
// Times in messages follow the person's clock setting (set per user at the start of remindUser).
let clock12 = true;
const hm = n => clock12
  ? `${Math.floor(n / 60) % 12 || 12}:${String(n % 60).padStart(2, '0')} ${Math.floor(n / 60) % 24 < 12 ? 'am' : 'pm'}`
  : `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const dur = m => (m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} h`);
// Same wording all day, different wording on different days, so it doesn't read like a robot.
const pick = (options, seed) => options[[...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % options.length];
const quote = t => `“${t || 'your session'}”`;

export async function runReminders(env, nowMs = Date.now()) {
  if (!env.VAPID_PRIVATE_JWK) return { users: 0, sent: 0 };
  await env.DB.prepare('DELETE FROM notify_log WHERE sent_at < ?').bind(nowMs - 3 * 864e5).run();
  const { results: users } = await env.DB.prepare(
    `SELECT DISTINCT p.user_id, s.timezone, s.notify, s.routine FROM push_subs p LEFT JOIN user_settings s ON s.user_id = p.user_id`
  ).all();
  let sent = 0;
  for (const u of users) {
    try { sent += await remindUser(env, u, nowMs); } catch (err) { console.error('reminders failed for a user', err); }
  }
  return { users: users.length, sent };
}

async function remindUser(env, u, nowMs) {
  let cfg;
  try { cfg = cleanNotify(u.notify ? JSON.parse(u.notify) : {}); } catch { cfg = cleanNotify({}); }
  try { clock12 = (u.routine ? JSON.parse(u.routine) : {}).clock !== 24; } catch { clock12 = true; }
  const { date, min } = localNow(u.timezone, nowMs);
  const { results: blocks } = await env.DB.prepare(
    `SELECT b.id, b.start_min, b.end_min, b.started_at, t.title FROM blocks b
     JOIN tasks t ON t.id = b.task_id AND t.user_id = b.user_id AND t.deleted = 0
     WHERE b.user_id = ? AND b.date = ? AND b.deleted = 0 AND b.status = 'planned' ORDER BY b.start_min`
  ).bind(u.user_id, date).all();

  const out = [];

  // Before each session. A late cron run still sends, up to 10 minutes after the reminder time.
  if (cfg.lead !== null) {
    for (const b of blocks) {
      const at = b.start_min - cfg.lead;
      if (b.started_at || !b.title || at > min || at <= min - 10) continue;
      out.push({
        key: `b:${b.id}:${date}:${b.start_min}`,
        msg: {
          title: cfg.lead === 0 ? 'Time to start' : `In ${cfg.lead} min`,
          body: `${b.title} · ${hm(b.start_min)}–${hm(b.end_min)}`,
          tag: `b-${b.id}`,
          url: '/?view=today',
          actions: [{ action: 'start', title: 'Start timer' }],
          startUrl: `/?view=today&start=${b.id}`,
        },
      });
    }
  }

  // A running session has reached its length: ask if it's done, or give it 15 more minutes.
  if (cfg.lead !== null) {
    for (const b of blocks) {
      if (!b.started_at || !b.title) continue;
      const len = b.end_min - b.start_min, endMs = b.started_at + len * 60000;
      if (nowMs < endMs || nowMs > endMs + 10 * 60000) continue;
      out.push({
        key: `end:${b.id}:${b.started_at}:${len}`,
        msg: {
          title: "Time's up",
          body: `${b.title} · ${dur(len)}. Done, or need a bit more?`,
          tag: `b-${b.id}`, url: '/?view=today',
          actions: [{ action: 'done', title: 'Done' }, { action: 'more', title: '+15 min' }],
          actionUrls: { done: `/?view=today&finish=${b.id}`, more: `/?view=today&extend=${b.id}` },
        },
      });
    }
  }

  // Morning summary (off unless the person sets a time).
  if (cfg.morning && min >= toMin(cfg.morning) && min < toMin(cfg.morning) + 60 && blocks.length) {
    const total = blocks.reduce((s, b) => s + b.end_min - b.start_min, 0);
    const first = blocks.find(b => b.start_min >= min) || blocks[0];
    out.push({
      key: `mor:${date}`,
      msg: {
        title: "Today's plan",
        body: `${blocks.length} session${blocks.length > 1 ? 's' : ''}, ${dur(total)}. First: ${first.title || 'a session'} at ${hm(first.start_min)}.`,
        tag: 'morning', url: '/?view=today',
      },
    });
  }

  // Morning to-do check: things due today (or overdue) that have no time yet. Suggest a free slot, or ask.
  if (cfg.todo && min >= toMin(cfg.todo) && min < toMin(cfg.todo) + 60) {
    const items = await todoToday(env, u.user_id, date, min);
    if (items.length) out.push({ key: `todo:${date}`, msg: todoMessage(items) });
  }

  // Evening check-in: ask for one missing thing, the most useful first. Nothing missing, nothing sent.
  if (cfg.evening && min >= toMin(cfg.evening) && min < toMin(cfg.evening) + 60) {
    const open = blocks.filter(b => !b.started_at && b.end_min <= min);
    let msg = null;
    if (open.length === 1) {
      msg = { title: pick([`How did ${quote(open[0].title)} go?`, `Did ${quote(open[0].title)} happen today?`], date),
              body: 'Tap to mark it done or skipped.', url: '/?view=today' };
    } else if (open.length > 1) {
      msg = { title: pick([`${open.length} sessions today have no update yet`, `Quick one: how did today's ${open.length} sessions go?`], date),
              body: 'Tap to fill them in. It takes a minute.', url: '/?view=today' };
    } else {
      const pending = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM observations o JOIN entries e ON e.id = o.entry_id AND e.user_id = o.user_id
         WHERE o.user_id = ? AND o.status = 'pending' AND o.deleted = 0 AND e.deleted = 0`
      ).bind(u.user_id).first();
      if (pending.n > 0) {
        msg = { title: 'A few notes to check', body: `${pending.n} thing${pending.n > 1 ? 's' : ''} from your journal ${pending.n > 1 ? 'are' : 'is'} waiting for a ✓.`, url: '/?view=journal' };
      } else {
        const wrote = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = ? AND entry_date = ? AND deleted = 0')
          .bind(u.user_id, date).first();
        if (!wrote.n) msg = { title: pick(['Anything about today?', 'How was today?', 'One line about today?'], date), body: 'A line or two is enough.', url: '/?view=journal' };
      }
    }
    if (msg) out.push({ key: `eve:${date}`, msg: { ...msg, tag: 'evening' } });
  }

  // Reminders due today (birthdays, calls...) with no time of their own: one notification at the morning
  // to-do time (08:00 if that's off). Ones with a time get the normal session reminder instead.
  const remAt = cfg.todo ? toMin(cfg.todo) : 8 * 60;
  if (min >= remAt && min < remAt + 60) {
    const { results: rem } = await env.DB.prepare(
      `SELECT t.id, t.title FROM tasks t WHERE t.user_id = ? AND t.deleted = 0 AND t.status = 'open' AND t.category = 'reminder' AND t.deadline = ?
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.task_id = t.id AND b.user_id = t.user_id AND b.deleted = 0 AND b.date = ?) LIMIT 5`
    ).bind(u.user_id, date, date).all();
    if (rem.length) {
      out.push({ key: `remind:${date}`, msg: {
        title: rem.length === 1 ? `Today: ${rem[0].title}` : `${rem.length} reminders today`,
        body: rem.length === 1 ? "Tap when it's done." : rem.map(r => r.title).join(' · '),
        tag: 'remind', url: '/?view=today',
      } });
    }
  }

  // Sunday: the week in review, an hour before the evening check-in (19:00 if the check-in is off).
  const sunday = new Date(date + 'T00:00:00Z').getUTCDay() === 0;
  const reviewAt = cfg.evening ? Math.max(0, toMin(cfg.evening) - 60) : 19 * 60;
  if (cfg.weekly && sunday && min >= reviewAt && min < reviewAt + 60) {
    const from = new Date(Date.parse(date + 'T00:00:00Z') - 6 * 864e5).toISOString().slice(0, 10);
    const wk = await env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'done' THEN COALESCE(actual_minutes, end_min - start_min) ELSE 0 END) AS done
       FROM blocks WHERE user_id = ? AND deleted = 0 AND date BETWEEN ? AND ?
         AND task_id IN (SELECT id FROM tasks WHERE user_id = ? AND deleted = 0)`
    ).bind(u.user_id, from, date, u.user_id).first();
    if (wk.n > 0) {
      out.push({ key: `week:${date}`, msg: {
        title: 'Your week in review',
        body: `${dur(wk.done || 0)} of focused work this week. Tap to see what went well and one thing to try next week.`,
        tag: 'weekly', url: '/?view=log&review=1',
      } });
    }
  }

  let sent = 0;
  for (const { key, msg } of out) {
    const fresh = await env.DB.prepare('INSERT OR IGNORE INTO notify_log (user_id, key, sent_at) VALUES (?, ?, ?)')
      .bind(u.user_id, key, nowMs).run();
    if (!fresh.meta.changes) continue;   // already sent
    sent += await sendToUser(env, u.user_id, msg);
  }
  return sent;
}

// Sends to every device the person turned notifications on for. Forgets devices that turned them off.
export async function sendToUser(env, userId, msg) {
  const { results: subs } = await env.DB.prepare('SELECT * FROM push_subs WHERE user_id = ?').bind(userId).all();
  let ok = 0;
  for (const s of subs) {
    try {
      const status = await sendPush(env, s, msg);
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run();
      else if (status >= 200 && status < 300) ok++;
      else console.error('push service said', status);
    } catch (err) {
      console.error('push failed', err);
    }
  }
  return ok;
}

// Tasks due today or earlier with no upcoming session, each with a suggested free slot today (or null).
export async function todoToday(env, userId, date, min) {
  const PC = globalThis.PlannerCore;
  const { results: tasks } = await env.DB.prepare(
    `SELECT id, title, est_minutes FROM tasks WHERE user_id = ? AND deleted = 0 AND status = 'open' AND repeat IS NULL AND category != 'reminder'
     AND deadline IS NOT NULL AND deadline <= ? ORDER BY deadline, priority, created_at LIMIT 10`
  ).bind(userId, date).all();
  if (!tasks.length) return [];
  const { results: blocks } = await env.DB.prepare(
    `SELECT id, task_id, date, start_min, end_min, status, started_at FROM blocks WHERE user_id = ? AND deleted = 0 AND date >= ?`
  ).bind(userId, date).all();
  const waiting = tasks.filter(t => !blocks.some(b => b.task_id === t.id && b.status === 'planned'));
  if (!waiting.length) return [];
  const st = await env.DB.prepare('SELECT routine FROM user_settings WHERE user_id = ?').bind(userId).first();
  const { results: prefs } = await env.DB.prepare('SELECT rule_json FROM prefs WHERE user_id = ? AND deleted = 0').bind(userId).all();
  let routine = null;
  try { routine = st?.routine ? JSON.parse(st.routine) : null; } catch {}
  const taken = [...blocks];
  return waiting.map(t => {
    const len = Math.min(Math.max(t.est_minutes || 60, 15), 120);
    const slot = PC.nextSlot({ blocks: taken, routine, prefs, today: date, nowMin: min, length: len });
    const ok = slot && slot.date === date ? slot : null;
    if (ok) taken.push({ id: 'suggest-' + t.id, task_id: t.id, date, start_min: ok.start_min, end_min: ok.end_min, status: 'planned' });
    return { id: t.id, title: t.title, len, slot: ok };
  });
}

export function todoMessage(items) {
  if (items.length === 1) {
    const [t] = items;
    const s = t.slot;
    return {
      title: `Today: ${t.title}`,
      body: s ? `You're free ${hm(s.start_min)}–${hm(s.end_min)}. Plan it then, or pick another time.` : 'No free time left in your hours today. Tap to pick a time.',
      tag: 'todo', url: '/?view=today&todo=pick',
      actions: s ? [{ action: 'accept', title: `Plan at ${hm(s.start_min)}` }, { action: 'pick', title: 'Pick a time' }] : [{ action: 'pick', title: 'Pick a time' }],
      actionUrls: {
        accept: s ? `/?view=today&todo=accept&task=${t.id}&at=${s.start_min}&len=${t.len}` : null,
        pick: '/?view=today&todo=pick',
      },
    };
  }
  const names = items.slice(0, 3).map(t => t.title).join(', ') + (items.length > 3 ? '…' : '');
  return {
    title: `${items.length} things for today have no time yet`,
    body: `${names}. I can fit them into your free time.`,
    tag: 'todo', url: '/?view=today&todo=pick',
    actions: [{ action: 'all', title: 'Plan them all' }, { action: 'pick', title: 'Choose times' }],
    actionUrls: { all: '/?view=today&todo=all', pick: '/?view=today&todo=pick' },
  };
}
