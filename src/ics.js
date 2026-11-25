// Private calendar link: /cal/<secret>.ics
// Google Calendar, Apple Calendar and Outlook can subscribe to it. Read-only, one-way: Planner -> calendar.

const pad = n => String(n).padStart(2, '0');

// Minutes after local midnight on a local date, in an IANA time zone -> UTC milliseconds.
function tzOffsetMs(tz, utcMs) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = t => Number(p.find(x => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}
export function localToUtc(date, min, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);            // second pass for daylight-saving edges
  return t;
}
const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = iso => iso.replace(/-/g, '');
const nextDay = iso => new Date(Date.parse(iso + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 characters are folded (continued on the next line after a space).
function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 73) { out.push(rest.slice(0, 73)); rest = ' ' + rest.slice(73); }
  out.push(rest);
  return out.join('\r\n');
}

export async function calendarFeed(env, url) {
  const m = /^\/cal\/([A-Za-z0-9_-]{20,64})\.ics$/.exec(url.pathname);
  if (!m) return new Response('Not found', { status: 404 });
  const s = await env.DB.prepare('SELECT user_id, timezone, notify FROM user_settings WHERE cal_token = ?').bind(m[1]).first();
  if (!s) return new Response('Not found', { status: 404 });
  const tz = s.timezone || 'UTC';
  let lead = 10;
  try { const n = s.notify ? JSON.parse(s.notify) : {}; lead = n.lead === null ? null : Number.isInteger(n.lead) ? n.lead : 10; } catch {}

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10);
  const { results: blocks } = await env.DB.prepare(
    `SELECT b.id, b.date, b.start_min, b.end_min, b.status, t.title, t.goal FROM blocks b
     JOIN tasks t ON t.id = b.task_id AND t.user_id = b.user_id
     WHERE b.user_id = ? AND b.deleted = 0 AND t.deleted = 0 AND b.status != 'skipped' AND b.date BETWEEN ? AND ?
     ORDER BY b.date, b.start_min`
  ).bind(s.user_id, from, to).all();
  const { results: due } = await env.DB.prepare(
    `SELECT id, title, deadline FROM tasks WHERE user_id = ? AND deleted = 0 AND status = 'open' AND deadline BETWEEN ? AND ?`
  ).bind(s.user_id, from, to).all();

  const now = stamp(Date.now());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planner//Planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Planner', `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const b of blocks) {
    const done = b.status === 'done';
    lines.push('BEGIN:VEVENT', `UID:${b.id}@planner`, `DTSTAMP:${now}`,
      `DTSTART:${stamp(localToUtc(b.date, b.start_min, tz))}`, `DTEND:${stamp(localToUtc(b.date, b.end_min, tz))}`,
      `SUMMARY:${esc((done ? '✓ ' : '') + b.title)}`,
      `DESCRIPTION:${esc([b.goal, done ? 'Done' : 'Planned in Planner'].filter(Boolean).join(' · '))}`,
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE');
    if (!done && lead !== null && b.date >= today) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(b.title)}`, `TRIGGER:-PT${lead}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  for (const t of due) {
    lines.push('BEGIN:VEVENT', `UID:due-${t.id}@planner`, `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${dateOnly(t.deadline)}`, `DTEND;VALUE=DATE:${dateOnly(nextDay(t.deadline))}`,
      `SUMMARY:${esc('Due: ' + t.title)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'inline; filename="planner.ics"' },
  });
}
