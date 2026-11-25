// Planner server: accounts, sync for journal entries + preferences, per-user AI settings.
// Static files in /public are served by Cloudflare before this code runs;
// only /api/* requests reach here.

import { generate, providerList, PROVIDERS, AIError } from './ai.js';
import { dropRepeats, SYSTEM as EXTRACT_SYSTEM, buildPrompt, cleanItems, summarize, KINDS } from './extract.js';
import { breakdownRequest, cleanBreakdown, ruleRequest, cleanRule, cleanRoutine, CATEGORIES } from './plan.js';
import { vapidPublicKey, allowedEndpoint, validKeys } from './push.js';
import { runReminders, sendToUser, cleanNotify } from './notify.js';
import { calendarFeed } from './ics.js';
import '../public/planner-core.js';
const { cleanRepeat } = globalThis.PlannerCore;

// Private journal "vault": only locked copies of the key and the settings needed to unlock them.
function cleanVault(v) {
  const s = (x, n) => (typeof x === 'string' && x.length <= n ? x : null);
  const lock = l => (l && s(l.salt, 64) && s(l.iv, 64) && s(l.key, 200) && Number.isInteger(l.iter) && l.iter >= 100000 && l.iter <= 2000000
    ? { salt: l.salt, iv: l.iv, key: l.key, iter: l.iter } : null);
  const out = { v: 1, pass: lock(v?.pass), recovery: lock(v?.recovery), created_at: Number(v?.created_at) || Date.now(), off: v?.off === true };
  if (!out.pass || !out.recovery) throw new HttpError(400, 'Bad private-journal settings.');
  return out;
}

const SESSION_DAYS = 90;
const PBKDF2_ITERATIONS = 100000;      // Workers' maximum
const MAX_BATCH = 200;
const PAGE = 500;
const OVERLAP_MS = 5000;               // re-send the last few seconds on each pull so nothing slips through
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isJson = s => { try { return typeof JSON.parse(s) === 'object'; } catch { return false; } };

// Which tables sync, and which columns the device may write.
const SYNC = {
  entries: {
    cols: ['body', 'entry_date', 'energy'],
    check(r) {
      // Private-journal entries arrive encrypted ("enc:v1:..."), which makes them longer.
      if (typeof r.body !== 'string' || r.body.length > (r.body.startsWith('enc:') ? 60000 : 20000)) return 'body';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.entry_date || '')) return 'entry_date';
      if (r.energy != null && ![1, 2, 3].includes(r.energy)) return 'energy';
    },
    wipe: { body: '', energy: null },
  },
  prefs: {
    cols: ['text', 'rule_json'],
    check(r) {
      if (typeof r.text !== 'string' || r.text.length > 500) return 'text';
      if (r.rule_json != null) {
        if (typeof r.rule_json !== 'string' || r.rule_json.length > 1000) return 'rule_json';
        try { JSON.parse(r.rule_json); } catch { return 'rule_json'; }
      }
    },
    wipe: { text: '', rule_json: null },
  },
  tasks: {
    cols: ['goal', 'title', 'notes', 'category', 'est_minutes', 'deadline', 'priority', 'status', 'done_at', 'repeat', 'start_date', 'revise', 'subject', 'effort', 'habit', 'entry_id'],
    check(r) {
      if (typeof r.title !== 'string' || !r.title.trim() || r.title.length > 200) return 'title';
      if (r.goal != null && (typeof r.goal !== 'string' || r.goal.length > 80)) return 'goal';
      if (r.notes != null && (typeof r.notes !== 'string' || r.notes.length > 1000)) return 'notes';
      if (!CATEGORIES.includes(r.category)) return 'category';
      if (!Number.isInteger(r.est_minutes) || r.est_minutes < 1 || r.est_minutes > 1440) return 'est_minutes';
      if (r.deadline != null && !DATE_RE.test(r.deadline)) return 'deadline';
      if (![1, 2, 3].includes(r.priority)) return 'priority';
      if (!['open', 'done', 'dropped'].includes(r.status)) return 'status';
      if (r.done_at != null && !Number.isFinite(r.done_at)) return 'done_at';
      if (r.repeat != null && (typeof r.repeat !== 'string' || r.repeat.length > 300 || !cleanRepeat(r.repeat))) return 'repeat';
      if (r.start_date != null && !DATE_RE.test(r.start_date)) return 'start_date';
      if (r.subject != null && (typeof r.subject !== 'string' || !/^[\p{L}\p{N}_-]{1,40}$/u.test(r.subject))) return 'subject';
      if (r.effort != null && ![1, 2, 3].includes(r.effort)) return 'effort';
      if (r.revise != null && (typeof r.revise !== 'string' || !/^\d{1,3}(,\d{1,3}){0,5}$/.test(r.revise))) return 'revise';
      if (r.entry_id != null && (typeof r.entry_id !== 'string' || !ID_RE.test(r.entry_id))) return 'entry_id';
      if (r.habit != null && (typeof r.habit !== 'string' || r.habit.length > 3000 || !isJson(r.habit))) return 'habit';
    },
    wipe: { title: '(deleted)', notes: null, goal: null, repeat: null, habit: null },
  },
  habit_logs: {
    cols: ['task_id', 'date', 'amount'],
    check(r) {
      if (typeof r.task_id !== 'string' || !ID_RE.test(r.task_id)) return 'task_id';
      if (!DATE_RE.test(r.date || '')) return 'date';
      if (!Number.isInteger(r.amount) || r.amount < 1 || r.amount > 1000) return 'amount';
    },
    wipe: {},
  },
  exams: {
    cols: ['name', 'date', 'subject', 'status', 'note'],
    check(r) {
      if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 80) return 'name';
      if (!DATE_RE.test(r.date || '')) return 'date';
      if (r.subject != null && (typeof r.subject !== 'string' || r.subject.length > 40)) return 'subject';
      if (!['upcoming', 'done'].includes(r.status)) return 'status';
      if (r.note != null && (typeof r.note !== 'string' || r.note.length > 300)) return 'note';
    },
    wipe: { name: '(deleted)', note: null, subject: null },
  },
  blocks: {
    cols: ['task_id', 'date', 'start_min', 'end_min', 'status', 'actual_minutes', 'started_at', 'reason'],
    check(r) {
      if (typeof r.task_id !== 'string' || !ID_RE.test(r.task_id)) return 'task_id';
      if (!DATE_RE.test(r.date || '')) return 'date';
      if (!Number.isInteger(r.start_min) || r.start_min < 0 || r.start_min > 1439) return 'start_min';
      if (!Number.isInteger(r.end_min) || r.end_min <= r.start_min || r.end_min > 1440) return 'end_min';
      if (!['planned', 'done', 'skipped'].includes(r.status)) return 'status';
      if (r.actual_minutes != null && (!Number.isInteger(r.actual_minutes) || r.actual_minutes < 0 || r.actual_minutes > 1440)) return 'actual_minutes';
      if (r.started_at != null && !Number.isFinite(r.started_at)) return 'started_at';
      if (r.reason != null && (typeof r.reason !== 'string' || r.reason.length > 200)) return 'reason';
    },
    wipe: { reason: null },
  },
  observations: {
    cols: ['entry_id', 'kind', 'data', 'status', 'source'],
    check(r) {
      if (typeof r.entry_id !== 'string' || !ID_RE.test(r.entry_id)) return 'entry_id';
      if (!KINDS.includes(r.kind)) return 'kind';
      if (!['pending', 'confirmed', 'rejected'].includes(r.status)) return 'status';
      if (!['ai', 'user'].includes(r.source)) return 'source';
      if (typeof r.data !== 'string' || r.data.length > 8000) return 'data';
      try { JSON.parse(r.data); } catch { return 'data'; }
    },
    wipe: { data: '{}' },
  },
};

export default {
  // Cron (every 5 minutes, see wrangler.toml): session reminders and check-ins.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, event.scheduledTime));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/cal/')) return calendarFeed(env, url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof AIError) return json({ error: err.message, busy: err.busy }, err.busy ? 503 : 502);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

async function route(req, env, url, ctx) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/signup' && m === 'POST') return signup(req, env);
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return logout(req, env);

  const user = await requireUser(req, env);

  if (p === '/api/me' && m === 'GET') return json({ user: { id: user.id, username: user.username }, settings: await publicSettings(env, user.id) });
  if (p === '/api/settings' && m === 'PUT') return saveSettings(req, env, user);
  if (p === '/api/ai/providers' && m === 'GET') return json({ providers: providerList(env) });
  if (p === '/api/ai/test' && m === 'POST') return aiTest(env, user);
  if (p === '/api/extract' && m === 'POST') return extract(req, env, user, ctx);
  if (p === '/api/ask' && m === 'POST') return ask(req, env, user);
  if (p === '/api/times' && m === 'POST') return aiTimes(req, env, user);
  if (p === '/api/plan/breakdown' && m === 'POST') return planBreakdown(req, env, user);
  if (p === '/api/prefs/parse' && m === 'POST') return prefParse(req, env, user);
  if (p === '/api/calendar/link' && m === 'POST') return calendarLink(req, env, user);
  if (p === '/api/push/key' && m === 'GET') return pushKey(env, user);
  if (p === '/api/push/subscribe' && m === 'POST') return pushSubscribe(req, env, user);
  if (p === '/api/push/unsubscribe' && m === 'POST') return pushUnsubscribe(req, env, user);
  if (p === '/api/push/test' && m === 'POST') return pushTest(env, user);
  // Local testing only: run the reminder check as if it were a given time.
  if (p === '/api/dev/run-reminders' && m === 'POST' && env.LOCAL_TESTING === '1') {
    const { now } = await body(req);
    return json(await runReminders(env, Number(now) || Date.now()));
  }
  if (p === '/api/sync/head' && m === 'GET') return syncHead(env, user);
  if (p === '/api/sync' && m === 'GET') return pull(env, user, url);
  if (p === '/api/sync' && m === 'POST') return push(req, env, user);
  if (p === '/api/export' && m === 'GET') return exportAll(env, user);
  if (p === '/api/account' && m === 'DELETE') return deleteAccount(req, env, user);

  throw new HttpError(404, 'Not found.');
}

// ---------- accounts ----------

async function signup(req, env) {
  const { username, password, invite } = await body(req);
  if (!env.INVITE_CODE) throw new HttpError(500, 'Sign-up is closed: the server has no invite code set.');
  if (!safeEqual(String(invite || ''), env.INVITE_CODE)) throw new HttpError(403, 'Wrong invite code.');
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(name)) throw new HttpError(400, 'Username: 3–32 letters, numbers, . _ or -');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(name).first();
  if (exists) throw new HttpError(409, 'That username is taken.');
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)').bind(id, name, await hashPassword(password), now),
    env.DB.prepare('INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)').bind(id, now),
  ]);
  return startSession(env, id, { id, username: name });
}

async function login(req, env) {
  const { username, password } = await body(req);
  const u = await env.DB.prepare('SELECT id, username, pass_hash FROM users WHERE username = ?').bind(String(username || '').trim()).first();
  // Same work whether or not the user exists, so timing doesn't reveal valid usernames.
  const ok = await verifyPassword(String(password || ''), u?.pass_hash || 'pbkdf2$100000$AAAA$AAAA');
  if (!u || !ok) throw new HttpError(401, 'Wrong username or password.');
  return startSession(env, u.id, { id: u.id, username: u.username });
}

async function logout(req, env) {
  const token = getCookie(req, 'pl_session');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
}

async function startSession(env, userId, user) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), userId, now, now + SESSION_DAYS * 864e5),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
  ]);
  return json({ user, settings: await publicSettings(env, userId) }, 200, { 'set-cookie': cookie(token, SESSION_DAYS * 86400) });
}

async function requireUser(req, env) {
  const token = getCookie(req, 'pl_session');
  if (!token) throw new HttpError(401, 'Not logged in.');
  const row = await env.DB.prepare(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(await sha256(token), Date.now()).first();
  if (!row) throw new HttpError(401, 'Session expired. Log in again.');
  return row;
}

async function deleteAccount(req, env, user) {
  const { password } = await body(req);
  const u = await env.DB.prepare('SELECT pass_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!(await verifyPassword(String(password || ''), u.pass_hash))) throw new HttpError(401, 'Wrong password.');
  // Explicit deletes (don't rely on foreign-key cascade being switched on).
  await env.DB.batch(['push_subs', 'notify_log', 'habit_logs', 'exams', 'blocks', 'tasks', 'observations', 'ai_usage', 'entries', 'prefs', 'user_settings', 'sessions', 'users'].map(t =>
    env.DB.prepare(`DELETE FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = ?`).bind(user.id)));
  return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
}

// ---------- settings + AI ----------

async function publicSettings(env, userId) {
  const s = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first() || {};
  return {
    ai_provider: s.ai_provider || null,
    ai_model: s.ai_model || '',
    ai_base_url: s.ai_base_url || '',
    ai_has_key: !!s.ai_key_enc,          // the key itself never leaves the server
    timezone: s.timezone || '',
    routine: s.routine ? safeParse(s.routine) : null,
    notify: cleanNotify(s.notify ? safeParse(s.notify) : {}),
    vault: s.vault ? safeParse(s.vault) : null,
    cal_token: s.cal_token || null,
  };
}

async function saveSettings(req, env, user) {
  const b = await body(req);
  const cur = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(user.id).first() || {};
  const next = { ...cur };
  if ('ai_provider' in b) {
    if (b.ai_provider !== null && !PROVIDERS[b.ai_provider]) throw new HttpError(400, 'Unknown AI provider.');
    next.ai_provider = b.ai_provider;
  }
  if ('ai_model' in b) next.ai_model = String(b.ai_model || '').slice(0, 200);
  if ('ai_base_url' in b) next.ai_base_url = String(b.ai_base_url || '').slice(0, 300);
  if ('timezone' in b) next.timezone = String(b.timezone || '').slice(0, 64);
  if ('routine' in b) next.routine = b.routine ? JSON.stringify(cleanRoutine(b.routine)) : null;
  if ('notify' in b) next.notify = JSON.stringify(cleanNotify(b.notify));
  if ('vault' in b) next.vault = b.vault === null ? null : JSON.stringify(cleanVault(b.vault));
  if ('ai_key' in b) {
    // "" clears the key; a non-empty string replaces it; leaving the field out keeps the old one.
    if (b.ai_key && !env.KEY_SECRET) throw new HttpError(500, 'The server has no KEY_SECRET set, so it cannot store API keys safely.');
    next.ai_key_enc = b.ai_key ? await encrypt(env, String(b.ai_key).trim()) : null;
  }
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, ai_provider, ai_model, ai_base_url, ai_key_enc, timezone, routine, notify, vault, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET ai_provider = excluded.ai_provider, ai_model = excluded.ai_model,
       ai_base_url = excluded.ai_base_url, ai_key_enc = excluded.ai_key_enc, timezone = excluded.timezone,
       routine = excluded.routine, notify = excluded.notify, vault = excluded.vault, updated_at = excluded.updated_at`
  ).bind(user.id, next.ai_provider ?? null, next.ai_model ?? null, next.ai_base_url ?? null,
         next.ai_key_enc ?? null, next.timezone ?? null, next.routine ?? null, next.notify ?? null, next.vault ?? null, Date.now()).run();
  return json({ settings: await publicSettings(env, user.id) });
}

// Everything AI-related goes through here, so later features just call aiFor(env, user).
export async function aiConfig(env, userId) {
  const s = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first() || {};
  return {
    provider: s.ai_provider,
    model: s.ai_model,
    baseUrl: s.ai_base_url,
    key: s.ai_key_enc ? await decrypt(env, s.ai_key_enc) : null,
  };
}

async function aiTest(env, user) {
  const cfg = await aiConfig(env, user.id);
  await countAiCall(env, user.id);
  const t0 = Date.now();
  const reply = await generate(env, cfg, {
    system: 'You are a connection test.',
    prompt: 'Reply with exactly: {"ok": true}',
    json: true,
    maxTokens: 200,
  });
  return json({ ok: reply?.ok === true, ms: Date.now() - t0, reply });
}

// ---------- sync ----------

// GET /api/sync?since=<ms>&table=<name>&after_ts=&after_id=
// Returns rows changed since `since`, one page at a time (keyset paging on server_ts, id).
// GET /api/sync/head -> { heads: { table: newest server_ts }, now }
// One small query so a device can skip tables with nothing new, instead of asking each table every 20 seconds.
async function syncHead(env, user) {
  const tables = Object.keys(SYNC);
  // One batch (one round trip); D1 doesn't allow this many UNION terms in a single statement.
  const res = await env.DB.batch(tables.map(t =>
    env.DB.prepare(`SELECT COALESCE(MAX(server_ts), 0) AS ts FROM ${t} WHERE user_id = ?`).bind(user.id)));
  return json({ heads: Object.fromEntries(tables.map((t, i) => [t, res[i].results[0]?.ts || 0])), overlap: OVERLAP_MS, now: Date.now() });
}

async function pull(env, user, url) {
  const table = url.searchParams.get('table') || 'entries';
  if (!SYNC[table]) throw new HttpError(400, 'Unknown table.');
  const since = Number(url.searchParams.get('since') || 0);
  let afterTs = url.searchParams.get('after_ts');
  let afterId = url.searchParams.get('after_id') || '';
  afterTs = afterTs == null ? Math.max(0, since - OVERLAP_MS) : Number(afterTs);
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE user_id = ? AND (server_ts > ? OR (server_ts = ? AND id > ?))
     ORDER BY server_ts, id LIMIT ?`
  ).bind(user.id, afterTs, afterTs, afterId, PAGE).all();
  const rows = results.map(({ user_id, ...r }) => r);
  const last = rows[rows.length - 1];
  return json({
    rows,
    more: rows.length === PAGE,
    next: last ? { after_ts: last.server_ts, after_id: last.id } : null,
    now: Date.now(),
  });
}

// POST /api/sync  { entries: [...], prefs: [...] }
// Upserts rows. The newer edit (by updated_at) wins. Rows belonging to someone else are never touched.
async function push(req, env, user) {
  const b = await body(req);
  const now = Date.now();
  const stmts = [];
  let count = 0;
  // Private journal on: refuse readable journal text, so nothing private is ever stored by accident.
  const vs = await env.DB.prepare('SELECT vault FROM user_settings WHERE user_id = ?').bind(user.id).first();
  const vault = vs?.vault ? safeParse(vs.vault) : null;
  if (vault && !vault.off) {
    const plainEntry = (b.entries || []).some(r => !r.deleted && typeof r.body === 'string' && !r.body.startsWith('enc:'));
    const plainNote = (b.observations || []).some(r => !r.deleted && typeof r.data === 'string' && !r.data.startsWith('{"enc"'));
    if (plainEntry || plainNote) throw new HttpError(409, 'Your journal is private now. Unlock it on this device to save journal changes.');
  }
  const rejected = [];
  for (const [table, spec] of Object.entries(SYNC)) {
    const rows = Array.isArray(b[table]) ? b[table] : [];
    count += rows.length;
    if (count > MAX_BATCH) throw new HttpError(413, `Send at most ${MAX_BATCH} rows at a time.`);
    for (const r of rows) {
      if (typeof r.id !== 'string' || !ID_RE.test(r.id)) throw new HttpError(400, `Bad id in ${table}.`);
      if (!Number.isFinite(r.created_at) || !Number.isFinite(r.updated_at)) throw new HttpError(400, `Bad timestamps in ${table}.`);
      const deleted = r.deleted ? 1 : 0;
      const vals = { ...r, ...(deleted ? spec.wipe : {}) };
      if (deleted && table === 'entries' && !DATE_RE.test(vals.entry_date || '')) vals.entry_date = '1970-01-01';
      // One bad row must not block everything else: skip it and tell the app.
      const bad = spec.check(vals);
      if (bad) { rejected.push({ table, id: r.id, field: bad }); continue; }
      if (deleted && table === 'entries') {
        stmts.push(env.DB.prepare(
          `UPDATE observations SET deleted = 1, data = '{}', updated_at = ?, server_ts = ?
           WHERE user_id = ? AND entry_id = ? AND deleted = 0`
        ).bind(now, now, user.id, r.id));
      }
      const cols = spec.cols;
      stmts.push(env.DB.prepare(
        `INSERT INTO ${table} (id, user_id, ${cols.join(', ')}, created_at, updated_at, deleted, server_ts)
         VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(', ')},
           updated_at = excluded.updated_at, deleted = excluded.deleted, server_ts = excluded.server_ts
         WHERE ${table}.user_id = excluded.user_id
           AND (excluded.updated_at > ${table}.updated_at
                -- A delete always wins, even if this device's clock is behind the one that made the row.
                OR (excluded.deleted = 1 AND ${table}.deleted = 0))`
      ).bind(r.id, user.id, ...cols.map(c => vals[c] ?? null), r.created_at, r.updated_at, deleted, now));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, saved: stmts.length, now, rejected });
}

async function exportAll(env, user) {
  const [entries, prefs, obs, tasks, blocks, habitLogs, exams] = await Promise.all(['entries', 'prefs', 'observations', 'tasks', 'blocks', 'habit_logs', 'exams'].map(t =>
    env.DB.prepare(`SELECT * FROM ${t} WHERE user_id = ? AND deleted = 0 ORDER BY created_at`).bind(user.id).all()));
  const strip = rs => rs.results.map(({ user_id, server_ts, deleted, ...r }) => r);
  return json({
    exported_at: new Date().toISOString(),
    username: user.username,
    settings: await publicSettings(env, user.id),
    entries: strip(entries),
    prefs: strip(prefs),
    noted: strip(obs).map(o => ({ ...o, data: JSON.parse(o.data) })),
    tasks: strip(tasks),
    blocks: strip(blocks),
    habit_logs: strip(habitLogs),
    exams: strip(exams),
  }, 200, { 'content-disposition': `attachment; filename="journal-export-${new Date().toISOString().slice(0, 10)}.json"` });
}

// ---------- "Ask your journal" ----------

// POST /api/ask { question, today, entries: [{id, date, text}], sessions: [{date, title, subject, minutes}] }
// The device picks the relevant entries and finished sessions itself (it can read the private journal too),
// so the server only passes them to the AI and stores nothing.
const ASK_SYSTEM = `You answer questions about one person's own journal and planner history.
Use ONLY the entries and sessions given. If they don't contain the answer, say so plainly.
Do arithmetic carefully from the sessions list (minutes per session). Give dates like "Tue 10 Nov".
Answer in 1-3 short, plain sentences, speaking to the person as "you".
Return JSON: {"answer": "...", "used": ["<entry id>", ...]} where used lists at most 5 entry ids you relied on.`;

async function ask(req, env, user) {
  const b = await body(req);
  const q = String(b.question || '').trim().slice(0, 300);
  if (!q) throw new HttpError(400, 'Type a question first.');
  const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 60)
    .map(e => ({ id: String(e.id || '').slice(0, 64), date: String(e.date || '').slice(0, 10), text: String(e.text || '').slice(0, 1500) }));
  const sessions = (Array.isArray(b.sessions) ? b.sessions : []).slice(0, 400)
    .map(x => `${String(x.date || '').slice(0, 10)} | ${String(x.title || '').slice(0, 80)} | ${String(x.subject || '').slice(0, 40)} | ${Math.max(0, Math.min(1440, x.minutes | 0))}`);
  const prompt = `Today is ${String(b.today || '').slice(0, 10)}.\n\nQuestion: ${q}\n\nJournal entries:\n` +
    (entries.map(e => `[${e.id}] ${e.date}: ${e.text}`).join('\n') || '(none)') +
    `\n\nFinished sessions (date | task | subject | minutes):\n${sessions.join('\n') || '(none)'}`;
  const cfg = await aiConfig(env, user.id);
  await countAiCall(env, user.id);
  const r = await generate(env, cfg, { system: ASK_SYSTEM, prompt, json: true, maxTokens: 500 });
  const ids = new Set(entries.map(e => e.id));
  return json({
    answer: String(r?.answer || '').slice(0, 1000) || "I couldn't find an answer in your journal.",
    used: (Array.isArray(r?.used) ? r.used : []).map(String).filter(id => ids.has(id)).slice(0, 5),
  });
}

// ---------- AI's preferred times ----------

// POST /api/times { today, tasks: [{id, title, subject, minutes}], notes: ["recent journal lines"], usual: "habits summary" }
// -> { times: [{ id, time: "HH:MM", why }] }. The app blends these with your history; it never books anything itself.
const TIMES_SYSTEM = `You suggest a good time of day for each task for one student, from what their journal says about how they work
(when they focus best, gym or class times, sleep, energy) and common sense (hard study when fresh, light tasks later, nothing after midnight).
Return JSON: {"times":[{"id":"<task id>","time":"HH:MM","why":"under 8 words, in second person"}]}. One entry per task. 24-hour time.`;

async function aiTimes(req, env, user) {
  const b = await body(req);
  const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 15)
    .map(t => ({ id: String(t.id || '').slice(0, 64), title: String(t.title || '').slice(0, 120), subject: String(t.subject || '').slice(0, 40), minutes: Math.max(5, Math.min(600, t.minutes | 0)) }));
  if (!tasks.length) return json({ times: [] });
  const notes = (Array.isArray(b.notes) ? b.notes : []).slice(0, 30).map(n => String(n || '').slice(0, 300));
  const prompt = `Today is ${String(b.today || '').slice(0, 10)}.\n\nWhat they usually do: ${String(b.usual || 'no history yet').slice(0, 500)}\n\nRecent journal:\n${notes.join('\n') || '(none)'}\n\nTasks:\n` +
    tasks.map(t => `- id ${t.id}: ${t.title}${t.subject ? ' #' + t.subject : ''} (${t.minutes} min)`).join('\n');
  const cfg = await aiConfig(env, user.id);
  await countAiCall(env, user.id);
  const r = await generate(env, cfg, { system: TIMES_SYSTEM, prompt, json: true, maxTokens: 400 });
  const ids = new Set(tasks.map(t => t.id));
  const times = (Array.isArray(r?.times) ? r.times : []).filter(x => ids.has(String(x?.id)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x?.time)))
    .map(x => ({ id: String(x.id), time: String(x.time), why: String(x.why || '').slice(0, 60) }));
  return json({ times });
}

// ---------- AI reading of journal entries ----------

// POST /api/extract { entry_id }
// Reads one entry with the person's chosen AI and stores what it found as pending observations.
// Calling it again for the same version of the entry returns the stored result without calling the AI.
async function extract(req, env, user, ctx) {
  const b = await body(req);
  const e = await env.DB.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').bind(String(b.entry_id || ''), user.id).first();
  if (!e || e.deleted) throw new HttpError(404, 'Entry not found. It may not have synced yet.');

  // Private journal: the device sends the text for this one reading. It goes to the AI and back,
  // and nothing readable is stored. The device saves the notes itself, encrypted.
  if (typeof b.text === 'string') {
    if (b.text.length > 20000) throw new HttpError(400, 'Entry too long.');
    const already = (Array.isArray(b.already) ? b.already : []).slice(0, 30).map(x => String(x).slice(0, 200));
    const plans = (Array.isArray(b.plans) ? b.plans : []).slice(0, 15).map(x => String(x).slice(0, 400));
    const settings = await env.DB.prepare('SELECT timezone FROM user_settings WHERE user_id = ?').bind(user.id).first();
    const cfg = await aiConfig(env, user.id);
    await countAiCall(env, user.id);
    const items = dropRepeats(cleanItems(await generate(env, cfg, {
      system: EXTRACT_SYSTEM,
      prompt: buildPrompt({ ...e, body: b.text }, settings?.timezone, already, plans),
      json: true,
      maxTokens: 1000,
    })), already);
    await env.DB.prepare('UPDATE entries SET extracted_version = ?, server_ts = ? WHERE id = ? AND user_id = ? AND updated_at = ?')
      .bind(e.updated_at, Date.now(), e.id, user.id, e.updated_at).run();
    return json({ extracted_version: e.updated_at, items });
  }
  if (e.body.startsWith('enc:')) throw new HttpError(400, 'This entry is private. Unlock your journal on this device to read it with AI.');

  const plans = (Array.isArray(b.plans) ? b.plans : []).slice(0, 15).map(x => String(x).slice(0, 400));
  if (e.extracted_version !== e.updated_at) {
    // Keep going even if the app is closed or put in the background mid-read: the notes are saved here,
    // and the app picks them up on its next sync.
    const work = readAndStore(env, user, e, plans);
    ctx?.waitUntil?.(work.catch(() => {}));
    await work;
  }

  const rows = (await env.DB.prepare('SELECT * FROM observations WHERE user_id = ? AND entry_id = ? ORDER BY created_at')
    .bind(user.id, e.id).all()).results.map(({ user_id, ...r }) => r);
  return json({ extracted_version: e.updated_at, rows });
}

async function readAndStore(env, user, e, plans) {
  {
    const kept = (await env.DB.prepare(
      `SELECT kind, data FROM observations WHERE user_id = ? AND entry_id = ? AND status = 'confirmed' AND deleted = 0`
    ).bind(user.id, e.id).all()).results;
    const already = kept.map(o => summarize(o.kind, safeParse(o.data))).filter(Boolean);
    const settings = await env.DB.prepare('SELECT timezone FROM user_settings WHERE user_id = ?').bind(user.id).first();
    const cfg = await aiConfig(env, user.id);
    await countAiCall(env, user.id);
    const items = dropRepeats(cleanItems(await generate(env, cfg, {
      system: EXTRACT_SYSTEM,
      prompt: buildPrompt(e, settings?.timezone, already, plans),
      json: true,
      maxTokens: 1000,
    })), already);
    const now = Date.now();
    await env.DB.batch([
      // The entry was re-read: replace what's still unconfirmed, keep what the user already confirmed or rejected.
      env.DB.prepare(
        `UPDATE observations SET deleted = 1, data = '{}', updated_at = ?, server_ts = ?
         WHERE user_id = ? AND entry_id = ? AND status = 'pending' AND deleted = 0`
      ).bind(now, now, user.id, e.id),
      ...items.map((it, i) => env.DB.prepare(
        `INSERT INTO observations (id, user_id, entry_id, kind, data, status, source, created_at, updated_at, deleted, server_ts)
         VALUES (?, ?, ?, ?, ?, 'pending', 'ai', ?, ?, 0, ?)`
      ).bind(crypto.randomUUID(), user.id, e.id, it.kind, JSON.stringify(it.data), now + i, now + i, now)),
      // Only mark as read if nobody edited the entry while the AI was working.
      env.DB.prepare('UPDATE entries SET extracted_version = ?, server_ts = ? WHERE id = ? AND user_id = ? AND updated_at = ?')
        .bind(e.updated_at, now, e.id, user.id, e.updated_at),
    ]);
  }

  const rows = (await env.DB.prepare('SELECT * FROM observations WHERE user_id = ? AND entry_id = ? ORDER BY created_at')
    .bind(user.id, e.id).all()).results.map(({ user_id, ...r }) => r);
  return json({ extracted_version: e.updated_at, rows });
}

// ---------- private calendar link ----------

// POST /api/calendar/link { action: 'create' | 'reset' | 'off' }
async function calendarLink(req, env, user) {
  const { action } = await body(req);
  const cur = await env.DB.prepare('SELECT cal_token FROM user_settings WHERE user_id = ?').bind(user.id).first();
  if (!['create', 'reset', 'off'].includes(action)) throw new HttpError(400, 'Unknown action.');
  if (!(action === 'create' && cur?.cal_token)) {
    const token = action === 'off' ? null : b64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await env.DB.prepare('UPDATE user_settings SET cal_token = ?, updated_at = ? WHERE user_id = ?').bind(token, Date.now(), user.id).run();
  }
  return json({ settings: await publicSettings(env, user.id) });
}

// ---------- notifications ----------

async function pushKey(env, user) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').bind(user.id).first();
  return json({ key: vapidPublicKey(env), devices: n.n });
}

// POST /api/push/subscribe { subscription: { endpoint, keys: { p256dh, auth } }, label }
async function pushSubscribe(req, env, user) {
  const { subscription, label } = await body(req);
  const endpoint = String(subscription?.endpoint || '');
  const { p256dh, auth } = subscription?.keys || {};
  if (endpoint.length > 1000 || !allowedEndpoint(env, endpoint)) throw new HttpError(400, 'That push address is not allowed.');
  if (!validKeys(p256dh, auth)) throw new HttpError(400, 'Bad push keys.');
  // One device = one row. If someone else used to be logged in on this device, it now belongs to this person.
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`
  ).bind(endpoint, user.id, p256dh, auth, String(label || '').slice(0, 60) || null, Date.now()).run();
  return pushKey(env, user);
}

async function pushUnsubscribe(req, env, user) {
  const { endpoint } = await body(req);
  await env.DB.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').bind(user.id, String(endpoint || '')).run();
  return pushKey(env, user);
}

async function pushTest(env, user) {
  if (!vapidPublicKey(env)) throw new HttpError(500, 'Notifications are not set up on the server yet (VAPID_PRIVATE_JWK is missing).');
  const sent = await sendToUser(env, user.id, { title: 'Notifications work', body: 'This is how your reminders will look.', tag: 'test', url: '/?view=today' });
  return json({ sent });
}

// ---------- planning help ----------

async function useAi(env, userId) {
  const cfg = await aiConfig(env, userId);
  if (!PROVIDERS[cfg.provider]) throw new AIError('No AI chosen yet. Pick one in Settings.');
  await countAiCall(env, userId);
  return cfg;
}

// POST /api/plan/breakdown { goal, today, answers?, noQuestions? } -> { questions } or { goal, tasks }
async function planBreakdown(req, env, user) {
  const b = await body(req);
  const goal = String(b.goal || '').trim().slice(0, 6000);
  if (!goal) throw new HttpError(400, 'Write the goal first.');
  const today = DATE_RE.test(b.today || '') ? b.today : new Date().toISOString().slice(0, 10);
  const answers = (Array.isArray(b.answers) ? b.answers : []).slice(0, 3)
    .map(a => ({ q: String(a?.q || '').slice(0, 200), a: String(a?.a || '').slice(0, 500) }));
  const cfg = await useAi(env, user.id);
  let out;
  try {
    out = await generate(env, cfg, breakdownRequest({ goal, answers, today, noQuestions: !!b.noQuestions }));
  } catch (err) {
    if (!err?.slow) throw err;
    // Too slow: ask once more for a shorter answer, with no questions round.
    const r = breakdownRequest({ goal, answers, today, noQuestions: true });
    out = await generate(env, cfg, { ...r, system: r.system + '\n\nKeep it short: at most 8 tasks.', maxTokens: 800 });
  }
  return json(cleanBreakdown(out, !answers.length && !b.noQuestions));
}

// POST /api/prefs/parse { text } -> { rule } (rule is null when the sentence isn't about scheduling)
async function prefParse(req, env, user) {
  const { text } = await body(req);
  const t = String(text || '').trim().slice(0, 500);
  if (!t) throw new HttpError(400, 'Nothing to read.');
  const cfg = await useAi(env, user.id);
  const out = await generate(env, cfg, ruleRequest(t));
  return json({ rule: cleanRule(out?.rule) });
}

async function countAiCall(env, userId) {
  const limit = Number(env.AI_DAILY_LIMIT || 150);
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    `INSERT INTO ai_usage (user_id, day, calls) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1 RETURNING calls`
  ).bind(userId, day).first();
  if (r.calls > limit) throw new HttpError(429, `Daily AI limit reached (${limit} a day). It resets at midnight UTC (5:30 am in India).`);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
}

function getCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

function cookie(value, maxAge) {
  return `pl_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

async function verifyPassword(password, stored) {
  const [, iter, salt, hash] = stored.split('$');
  const got = b64(await pbkdf2(password, unb64(salt), Number(iter)));
  return safeEqual(got, hash);
}

// AES-GCM with a key derived from the KEY_SECRET server secret. Stored as "iv.ciphertext" (base64).
async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(env.KEY_SECRET));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text));
  return `${b64(iv)}.${b64(ct)}`;
}

async function decrypt(env, stored) {
  if (!env.KEY_SECRET) throw new HttpError(500, 'The server has no KEY_SECRET set.');
  const [iv, ct] = stored.split('.');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new HttpError(500, 'Could not unlock the saved API key. Was KEY_SECRET changed? Save the key again in Settings.');
  }
}
