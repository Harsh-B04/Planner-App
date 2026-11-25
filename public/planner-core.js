// Planner logic shared by the app (browser) and the server: rules, routine and the scheduler.
// Plain code, no AI: the same inputs always give the same plan, so it can be tested and explained.
(function (root) {
  'use strict';

  const CATEGORIES = ['study', 'work', 'project', 'exercise', 'chores', 'social', 'rest', 'other', 'reminder'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DEFAULT_ROUTINE = { start: '09:00', end: '22:00', daysOff: [], busy: [], maxMinutes: 360, session: 90, breakMin: 15 };
  const MIN_CHUNK = 25;
  const HHMM = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const toHHMM = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const weekday = iso => new Date(iso + 'T00:00:00Z').getUTCDay();
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const cleanDays = d => Array.isArray(d) ? [...new Set(d.filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b) : [];
  const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return v != null && v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

  // ---------- rules from "Things to know about me" ----------

  function cleanRule(r) {
    if (!r || typeof r !== 'object') return null;
    const days = cleanDays(r.days);
    const withDays = days.length ? { days } : {};
    switch (r.type) {
      case 'day_off':
        return days.length ? { type: 'day_off', days, strict: r.strict === true } : null;
      case 'no_work_between':
      case 'prefer_time':
        if (!HHMM.test(r.start || '') || !HHMM.test(r.end || '') || r.start === r.end) return null;
        return r.type === 'prefer_time'
          ? { type: 'prefer_time', start: r.start, end: r.end, ...withDays }
          : { type: 'no_work_between', start: r.start, end: r.end, ...withDays, strict: r.strict === true };
      case 'max_hours': {
        const h = Number(r.hours);
        if (!(h > 0 && h <= 16)) return null;
        return { type: 'max_hours', hours: Math.round(h * 2) / 2, ...withDays };
      }
      default:
        return null;
    }
  }

  function daysText(days) {
    const names = days.map(d => DAY_NAMES[d] + 's');
    return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  }

  function describeRule(r) {
    if (!r || !r.type) return 'Not used for planning';
    const on = r.days && r.days.length ? ' on ' + daysText(r.days) : '';
    switch (r.type) {
      case 'day_off': return r.strict ? `No work on ${daysText(r.days)}` : `Avoid work on ${daysText(r.days)} unless a deadline needs it`;
      case 'no_work_between': return `${r.strict ? 'No work' : 'Avoid work'} between ${r.start} and ${r.end}${on}`;
      case 'max_hours': return `At most ${r.hours} h of focused work a day${on}`;
      case 'prefer_time': return `Prefer working ${r.start}–${r.end}${on}`;
      default: return 'Not used for planning';
    }
  }

  // Simple reading without AI, for people who haven't set one up.
  function guessRule(text) {
    const t = String(text || '').toLowerCase();
    const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const days = [];
    full.forEach((n, i) => { if (new RegExp('\\b' + n + 's?\\b').test(t)) days.push(i); });
    if (/\bweekends?\b/.test(t)) days.push(0, 6);
    if (days.length && /\b(no|not|never|don'?t|do not|hate|avoid|off|free|rest)\b/.test(t)) {
      return cleanRule({ type: 'day_off', days, strict: /\b(never|no work|off|can'?t|cannot)\b/.test(t) });
    }
    const m = t.match(/(?:max(?:imum)?|at most|no more than|only)\s*(\d+(?:\.\d+)?)\s*(?:h\b|hrs?\b|hours?\b)/);
    if (m) return cleanRule({ type: 'max_hours', hours: Number(m[1]) });
    return null;
  }

  function cleanRoutine(r) {
    r = r && typeof r === 'object' ? r : {};
    const out = { ...DEFAULT_ROUTINE };
    if (HHMM.test(r.start || '') && HHMM.test(r.end || '') && toMin(r.end) > toMin(r.start)) { out.start = r.start; out.end = r.end; }
    out.daysOff = cleanDays(r.daysOff);
    out.busy = (Array.isArray(r.busy) ? r.busy : []).slice(0, 20)
      .map(b => ({ days: cleanDays(b && b.days), start: b && b.start, end: b && b.end, label: b && typeof b.label === 'string' ? b.label.trim().slice(0, 40) : '' }))
      .filter(b => b.days.length && HHMM.test(b.start || '') && HHMM.test(b.end || '') && toMin(b.end) > toMin(b.start));
    out.maxMinutes = clampInt(r.maxMinutes, 30, 960, DEFAULT_ROUTINE.maxMinutes);
    out.session = clampInt(r.session, 15, 240, DEFAULT_ROUTINE.session);
    out.breakMin = clampInt(r.breakMin, 0, 60, DEFAULT_ROUTINE.breakMin);
    out.autoPlan = r.autoPlan !== false;   // journal plans go straight onto the schedule (on unless turned off)
    out.carry = r.carry !== false;
    out.journalAuto = r.journalAuto === 'add' ? 'add' : 'ask';   // add clear journal plans straight away, or ask first         // missed sessions move to the next free time each morning
    // How far ahead "Make my plan" looks; kept in your account so every device uses the same.
    if ([7, 14, 30, 91, 182, 365].includes(r.horizon)) out.horizon = r.horizon;
    out.clock = r.clock === 24 ? 24 : 12;   // how times are shown: 12-hour (default) or 24-hour
    return out;
  }

  // Repeating task: { days: [0-6], time: 'HH:MM' | null }. null = not repeating.
  function cleanRepeat(r) {
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
    if (!r || typeof r !== 'object') return null;
    const days = cleanDays(r.days);
    const time = HHMM.test(r.time || '') && r.time !== '24:00' ? r.time : null;
    // "Twice a week", any days: { days: [], per_week: 2 }. Seven a week is just every day.
    const per = parseInt(r.per_week, 10);
    if (!days.length && per >= 1 && per <= 7) return per === 7 ? { days: [0, 1, 2, 3, 4, 5, 6], time } : { days: [], per_week: per, time };
    if (!days.length) return null;
    return { days, time };
  }

  function describeRepeat(r) {
    r = cleanRepeat(r);
    if (!r) return '';
    if (r.per_week) return `${r.per_week === 1 ? 'once' : r.per_week === 2 ? 'twice' : r.per_week + ' times'} a week` + (r.time ? ' at ' + r.time : '');
    const d = r.days.join();
    const when = d === '0,1,2,3,4,5,6' ? 'every day' : d === '1,2,3,4,5' ? 'weekdays' : d === '0,6' ? 'weekends'
      : [1, 2, 3, 4, 5, 6, 0].filter(x => r.days.includes(x)).map(x => DAY_NAMES[x].slice(0, 3)).join(', ');
    return when + (r.time ? ' at ' + r.time : '');
  }

  // ---------- time intervals ----------

  // A window like 23:00–07:00 crosses midnight: split it in two.
  function windows(start, end) {
    const s = toMin(start), e = toMin(end);
    return e > s ? [[s, e]] : [[s, 1440], [0, e]];
  }

  function cut(ivs, s, e) {
    const out = [];
    for (const iv of ivs) {
      if (e <= iv.s || s >= iv.e) { out.push(iv); continue; }
      if (s > iv.s) out.push({ ...iv, e: s });
      if (e < iv.e) out.push({ ...iv, s: e });
    }
    return out;
  }

  function flag(ivs, s, e, key) {
    const out = [];
    for (const iv of ivs) {
      if (e <= iv.s || s >= iv.e) { out.push(iv); continue; }
      if (s > iv.s) out.push({ ...iv, e: s });
      out.push({ ...iv, s: Math.max(s, iv.s), e: Math.min(e, iv.e), [key]: true });
      if (e < iv.e) out.push({ ...iv, s: e });
    }
    return out;
  }

  function parseRules(prefs) {
    return (prefs || []).filter(p => p && !p.deleted && p.rule_json).map(p => {
      try { return cleanRule(JSON.parse(p.rule_json)); } catch { return null; }
    }).filter(Boolean);
  }

  // Free time on one day: working hours, minus busy times and "no work" rules.
  function dayFrame(date, routine, rules, fromMin) {
    const wd = weekday(date);
    const frame = { ivs: [], cap: routine.maxMinutes, avoidDay: false };
    if (routine.daysOff.includes(wd)) return frame;
    let ivs = [{ s: toMin(routine.start), e: toMin(routine.end) }];
    for (const b of routine.busy) if (b.days.includes(wd)) ivs = cut(ivs, toMin(b.start), toMin(b.end));
    for (const r of rules) {
      const applies = !r.days || !r.days.length || r.days.includes(wd);
      if (r.type === 'day_off' && r.days.includes(wd)) {
        if (r.strict) return frame;
        frame.avoidDay = true;
      }
      if (r.type === 'no_work_between' && applies) {
        for (const [s, e] of windows(r.start, r.end)) ivs = r.strict ? cut(ivs, s, e) : flag(ivs, s, e, 'avoid');
      }
      if (r.type === 'max_hours' && applies) frame.cap = Math.min(frame.cap, Math.round(r.hours * 60));
      if (r.type === 'prefer_time' && applies) {
        for (const [s, e] of windows(r.start, r.end)) ivs = flag(ivs, s, e, 'prefer');
      }
    }
    if (fromMin != null) ivs = cut(ivs, 0, fromMin);
    if (frame.avoidDay) ivs = ivs.map(iv => ({ ...iv, avoid: true }));
    frame.ivs = ivs.filter(iv => iv.e - iv.s >= 5);
    return frame;
  }

  // A gap that fits the whole session first; only if none, a shorter one.
  // Within that: preferred time, then normal time, then (only if allowed) time you'd rather not work.
  // mode 'yield': when hard work is waiting, other tasks leave your focus hours for it.
  function findSlot(ivs, want, minLen, allowAvoid, mode) {
    const ok = ivs.filter(iv => allowAvoid || !iv.avoid);
    const pref = mode === 'yield' ? (a, b) => (a.prefer ? 1 : 0) - (b.prefer ? 1 : 0) : (a, b) => (b.prefer ? 1 : 0) - (a.prefer ? 1 : 0);
    const order = (a, b) => pref(a, b) || (a.avoid ? 1 : 0) - (b.avoid ? 1 : 0) || a.s - b.s;
    return ok.filter(iv => iv.e - iv.s >= want).sort(order)[0]
      || ok.filter(iv => iv.e - iv.s >= minLen).sort(order)[0] || null;
  }

  const startAfter = nowMin => Math.ceil((nowMin + 10) / 15) * 15;   // a few minutes to get going, on a quarter hour
  const blockLen = b => b.end_min - b.start_min;

  // ---------- the planner ----------

  // o: { tasks, blocks, routine, prefs, today, nowMin, days?, maxMinutes?, multiplier? }
  // Returns { blocks, warnings, maxMinutes, perDay }. Nothing is saved: the app shows this as a proposal.
  function makePlan(o) {
    const routine = cleanRoutine(o.routine);
    if (o.maxMinutes) routine.maxMinutes = clampInt(o.maxMinutes, 30, 960, routine.maxMinutes);
    const rules = parseRules(o.prefs);
    const today = o.today, nowMin = o.nowMin;
    const dates = Array.from({ length: o.days || 7 }, (_, i) => addDays(today, i));
    const last = dates[dates.length - 1];
    const blocks = (o.blocks || []).filter(b => !b.deleted);

    // Future blocks that haven't started get replaced by the new plan. Everything else stays.
    // Only inside the planning range: sessions further out (a revision next month, one added by hand) stay put.
    const replaceable = b => b.status === 'planned' && !b.started_at && b.date <= last && (b.date > today || (b.date === today && b.start_min >= nowMin));
    const kept = blocks.filter(b => !replaceable(b));

    const state = {};
    for (const d of dates) {
      const f = dayFrame(d, routine, rules, d === today ? startAfter(nowMin) : null);
      let used = 0;
      for (const b of kept) {
        if (b.date !== d || b.status === 'skipped') continue;
        f.ivs = cut(f.ivs, b.start_min - routine.breakMin, b.end_min + routine.breakMin);
        used += b.status === 'done' ? (b.actual_minutes ?? blockLen(b)) : blockLen(b);
      }
      state[d] = { ...f, used };
    }

    // Time already spent on each task, and time already booked that we're keeping.
    const spent = {}, booked = {};
    for (const b of blocks) {
      if (b.status === 'done') spent[b.task_id] = (spent[b.task_id] || 0) + (b.actual_minutes ?? blockLen(b));
      else if (b.status === 'planned' && !replaceable(b) && (b.date > today || (b.date === today && (b.started_at || b.end_min > nowMin)))) {
        booked[b.task_id] = (booked[b.task_id] || 0) + blockLen(b);
      }
    }

    const out = [], warnings = [];

    // Repeating tasks go first, like fixed habits: one session on each matching day,
    // at their usual time when it's free, otherwise the first gap that fits.
    for (const t of (o.tasks || []).filter(x => x && !x.deleted && x.status === 'open' && x.repeat)) {
      const rep = cleanRepeat(t.repeat);
      if (!rep) continue;
      const len = Math.max(10, Math.min(t.est_minutes || 30, 480));
      let missed = 0;
      for (const d of dates) {
        if (!rep.days.includes(weekday(d))) continue;
        if (blocks.some(b => b.task_id === t.id && b.date === d && !replaceable(b))) continue;
        const st = state[d];
        let s = null;
        if (st.cap - st.used >= len) {
          if (rep.time) {
            const want = toMin(rep.time);
            if (st.ivs.some(iv => !iv.avoid && iv.s <= want && want + len <= iv.e)) s = want;
          }
          if (s === null) { const f = findSlot(st.ivs, len, len, false); if (f) s = f.s; }
        }
        if (s === null) {
          // Today's usual time may simply be over already; only count real misses.
          if (!(d === today && rep.time && toMin(rep.time) < nowMin)) missed++;
          continue;
        }
        out.push({ task_id: t.id, date: d, start_min: s, end_min: s + len });
        st.ivs = cut(st.ivs, s, s + len + routine.breakMin);
        st.used += len;
      }
      if (missed) warnings.push({ kind: 'repeat', task_id: t.id, days: missed });
    }

    // "N times a week": top each week up to N sessions, spread over the days still free that week.
    for (const t of (o.tasks || []).filter(x => x && !x.deleted && x.status === 'open' && x.repeat)) {
      const rep = cleanRepeat(t.repeat);
      if (!rep || !rep.per_week) continue;
      const len = Math.max(10, Math.min(t.est_minutes || 30, 480));
      const weeks = {};
      for (const d of dates) (weeks[addDays(d, -((weekday(d) + 6) % 7))] ||= []).push(d);
      for (const [ws, wdays] of Object.entries(weeks)) {
        const we = addDays(ws, 6);
        const have = blocks.filter(b => b.task_id === t.id && b.date >= ws && b.date <= we && !replaceable(b)
          && (b.status === 'done' || (b.status === 'planned' && b.date >= today))).length
          + out.filter(b => b.task_id === t.id && b.date >= ws && b.date <= we).length;
        let need = rep.per_week - have;
        if (need <= 0) continue;
        const free = wdays.filter(d => state[d] && state[d].cap > 0 && !blocks.some(b => b.task_id === t.id && b.date === d && !replaceable(b))
          && !(d === today && rep.time && toMin(rep.time) < nowMin));
        // Spread them out: with 2 needed over 6 free days, take days 1 and 4, not 1 and 2.
        const order = [];
        const step = free.length / need;
        for (let i = 0; i < need && i * step < free.length; i++) { const d = free[Math.floor(i * step)]; if (!order.includes(d)) order.push(d); }
        for (const d of free) if (!order.includes(d)) order.push(d);   // never two on the same day
        for (const d of order) {
          if (need <= 0) break;
          const st = state[d];
          if (st.cap - st.used < len) continue;
          let s = null;
          if (rep.time) { const want = toMin(rep.time); if (st.ivs.some(iv => !iv.avoid && iv.s <= want && want + len <= iv.e)) s = want; }
          if (s === null) { const f = findSlot(st.ivs, len, len, false); if (f) s = f.s; }
          if (s === null) continue;
          out.push({ task_id: t.id, date: d, start_min: s, end_min: s + len });
          st.ivs = cut(st.ivs, s, s + len + routine.breakMin);
          st.used += len;
          need--;
        }
        if (need > 0 && ws === addDays(today, -((weekday(today) + 6) % 7)) && wdays.length >= 3) warnings.push({ kind: 'repeat', task_id: t.id, days: need });
      }
    }

    const mult = o.multiplier || 1;
    const open = (o.tasks || []).filter(t => t && !t.deleted && t.status === 'open' && !t.repeat && t.category !== 'reminder').map(t => {
      // What this subject really takes you (learned from your sessions), else the general multiplier.
      const est = Math.round((t.est_minutes || 60) * ((o.subjectMult && o.subjectMult[t.subject]) || mult));
      let left = est - (spent[t.id] || 0) - (booked[t.id] || 0);
      if (left <= 0) left = booked[t.id] ? 0 : 30;   // over the estimate but not finished: one more session
      return { t, left };
    }).filter(x => x.left > 0);

    // Earliest deadline first, then priority, then oldest.
    open.sort((a, b) => (a.t.deadline || '9999').localeCompare(b.t.deadline || '9999')
      || (a.t.priority || 2) - (b.t.priority || 2) || (a.t.created_at || 0) - (b.t.created_at || 0));

    const hasHard = open.some(x => x.t.effort === 3);
    const hardCap = Math.round(routine.maxMinutes * 0.6);
    for (const x of open) {
      const t = x.t;
      // Effort: hard work gets focus hours first, sessions of an hour at most, room around it, and no more than 60% of a day.
      const hard = t.effort === 3;
      const sessionMax = hard ? Math.min(routine.session, 60) : routine.session;
      const gap = hard ? routine.breakMin + 15 : routine.breakMin;
      const mode = hard ? 'hard' : hasHard ? 'yield' : 'normal';
      if (t.start_date && t.start_date > last) continue;   // starts after this plan ends: nothing to do yet
      const overdue = t.deadline && t.deadline < today;
      const due = overdue ? today : t.deadline;
      if (overdue) warnings.push({ kind: 'overdue', task_id: t.id, deadline: t.deadline });
      const lastDay = due && due < last ? due : last;
      const dueInRange = !!due && due <= last;
      let left = x.left;
      const avoidDays = new Set();
      // First try normal time only. If a deadline would be missed, allow time you'd rather not work.
      for (const allowAvoid of [false, true]) {
        if (left <= 0 || (allowAvoid && !dueInRange)) break;
        for (const d of dates) {
          if (d > lastDay || left <= 0) break;
          if (t.start_date && d < t.start_date) continue;   // not before its start date
          const st = state[d];
          while (left > 0) {
            const room = hard ? Math.min(st.cap - st.used, hardCap - (st.hard || 0)) : st.cap - st.used;
            const minLen = Math.min(MIN_CHUNK, left);
            if (room < minLen) break;
            const want = Math.min(left, sessionMax, room);
            const slot = findSlot(st.ivs, want, minLen, allowAvoid, mode);
            if (!slot) break;
            let len = Math.min(want, slot.e - slot.s);
            // Don't leave a tiny scrap for later: shorten this session so the rest is at least MIN_CHUNK.
            const rest = left - len;
            if (rest > 0 && rest < MIN_CHUNK && len - (MIN_CHUNK - rest) >= MIN_CHUNK) len -= MIN_CHUNK - rest;
            out.push({ task_id: t.id, date: d, start_min: slot.s, end_min: slot.s + len });
            st.ivs = cut(st.ivs, hard ? slot.s - 15 : slot.s, slot.s + len + gap);
            st.used += len;
            if (hard) st.hard = (st.hard || 0) + len;
            left -= len;
            if (slot.avoid) avoidDays.add(d);
          }
        }
      }
      for (const d of avoidDays) warnings.push({ kind: 'avoid', task_id: t.id, date: d, deadline: due });
      if (left > 0) warnings.push({ kind: dueInRange ? 'short' : 'later', task_id: t.id, minutes: left, deadline: dueInRange ? due : null });
    }

    out.sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
    const perDay = {};
    for (const b of out) perDay[b.date] = (perDay[b.date] || 0) + blockLen(b);
    return { blocks: out, warnings, maxMinutes: routine.maxMinutes, perDay };
  }

  // Next free slot of a given length, for the "Later" button. Skips times you'd rather not work.
  // How long each subject really takes you: actual ÷ planned over finished sessions (at least 3, last 60 days).
  function subjectRates(tasks, blocks, today) {
    const subj = {}, from = addDays(today, -60);
    for (const t of tasks || []) if (t && t.subject) subj[t.id] = t.subject;
    const acc = {};
    for (const b of blocks || []) {
      if (!b || b.deleted || b.status !== 'done' || b.actual_minutes == null || b.date < from || !subj[b.task_id]) continue;
      const a = acc[subj[b.task_id]] || (acc[subj[b.task_id]] = { plan: 0, real: 0, n: 0 });
      a.plan += blockLen(b); a.real += b.actual_minutes; a.n++;
    }
    const out = {};
    for (const [k, a] of Object.entries(acc)) {
      if (a.n < 3 || !a.plan) continue;
      const r = Math.min(2, Math.max(0.6, a.real / a.plan));
      if (Math.abs(r - 1) >= 0.1) out[k] = { rate: Math.round(r * 10) / 10, n: a.n };
    }
    return out;
  }

  function nextSlot(o) {
    const routine = cleanRoutine(o.routine);
    const rules = parseRules(o.prefs);
    const others = (o.blocks || []).filter(b => !b.deleted && b.status !== 'skipped' && b.id !== o.skipId);
    for (let i = 0; i < (o.onDate ? 400 : 7); i++) {
      const d = addDays(o.today, i);
      if (o.onDate && d > o.onDate) break;
      // onDate: only that day. A day you asked for by name ("today") counts even if it's normally a day off.
      if (o.onDate && d !== o.onDate) continue;
      const rt = o.onDate ? { ...routine, daysOff: routine.daysOff.filter(x => x !== weekday(d)) } : routine;
      const f = dayFrame(d, rt, o.onDate ? rules.filter(r => r.type !== 'day_off') : rules, i === 0 ? startAfter(Math.max(o.nowMin, o.afterMin || 0)) : null);
      let used = 0;
      for (const b of others) {
        if (b.date !== d) continue;
        f.ivs = cut(f.ivs, b.start_min - routine.breakMin, b.end_min + routine.breakMin);
        used += blockLen(b);
      }
      if (f.cap - used < o.length) continue;
      const slot = f.ivs.filter(iv => !iv.avoid && iv.e - iv.s >= o.length).sort((a, b) => a.s - b.s)[0];
      if (slot) return { date: d, start_min: slot.s, end_min: slot.s + o.length };
    }
    return null;
  }


  // ---------- suggested time: your history blended with the AI's pick ----------
  // The day is the first one with room (same as nextSlot). Within that day every free start (15-min steps) gets:
  //   app score = when you usually do this kind of work (finished sessions, by hour) + a small pull towards earlier
  //   AI score  = how close it is to the time the AI suggested
  // The AI's share starts at 60% with no history and slides to 30% at 30+ finished sessions.
  function aiShare(n) { return Math.max(0.3, Math.min(0.6, 0.6 - 0.01 * (n || 0))); }
  function bestSlot(o) {
    const first = nextSlot(o);
    if (!first) return null;
    const routine0 = cleanRoutine(o.routine), d = first.date;
    const routine = o.onDate ? { ...routine0, daysOff: routine0.daysOff.filter(x => x !== weekday(d)) } : routine0;
    const rules = parseRules(o.prefs).filter(r => !o.onDate || r.type !== 'day_off');
    const f = dayFrame(d, routine, rules, d === o.today ? startAfter(Math.max(o.nowMin, o.afterMin || 0)) : null);
    for (const b of (o.blocks || []).filter(b => !b.deleted && b.status !== 'skipped' && b.id !== o.skipId && b.date === d)) {
      f.ivs = cut(f.ivs, b.start_min - routine.breakMin, b.end_min + routine.breakMin);
    }
    const starts = [];
    for (const iv of f.ivs.filter(iv => !iv.avoid && iv.e - iv.s >= o.length)) {
      for (let s = iv.s; s + o.length <= iv.e; s += 15) starts.push(s);
    }
    if (starts.length < 2) return { ...first, share: 0, n: 0 };
    // History: finished sessions (same subject when there are enough), by start hour.
    const hist = (o.history || []).filter(h => h && Number.isFinite(h.start_min));
    const mine = o.subject ? hist.filter(h => h.subject === o.subject) : [];
    const use = mine.length >= 3 ? mine : hist;
    const n = use.length;
    const habit = s => n ? use.reduce((a, h) => a + Math.exp(-((h.start_min - s) ** 2) / (2 * 60 * 60)), 0) / n : 0;
    const hmax = Math.max(1e-9, ...starts.map(habit));
    const lo = starts[0], hi = starts[starts.length - 1];
    const ai = Number.isFinite(o.aiMin) ? o.aiMin : null;
    const a = ai === null ? 0 : aiShare(n);
    let best = starts[0], bestScore = -1;
    for (const s of starts) {
      const early = 1 - Math.min(1, (s - lo) / 720);   // a gentle pull to earlier: 12 hours later costs the full point
      const app = n ? 0.85 * (habit(s) / hmax) + 0.15 * early : early;
      const aiScore = ai === null ? 0 : 1 - Math.min(1, Math.abs(s - ai) / 240);
      const score = (1 - a) * app + a * aiScore;
      if (score > bestScore + 1e-9) { bestScore = score; best = s; }
    }
    return { date: d, start_min: best, end_min: best + o.length, share: a, n, moved: best !== first.start_min };
  }

  // ---------- habits ----------
  // A habit lives on a task as JSON: { changes: [{ from, kind, days, per_week, count, unit }], paused: [{ from, to }] }.
  // Each schedule change starts on a date, so old weeks keep the target they had at the time.
  // kind: 'daily' (every working day), 'days' (set weekdays), 'flex' (any N days a week).
  const KINDS = ['daily', 'days', 'flex'];
  function cleanHabitStep(c) {
    if (!c || !DATE.test(c.from || '') || !KINDS.includes(c.kind)) return null;
    const days = [...new Set((Array.isArray(c.days) ? c.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
    if (c.kind === 'days' && !days.length) return null;
    const per = Math.max(1, Math.min(7, parseInt(c.per_week, 10) || 3));
    const count = Math.max(1, Math.min(100, parseInt(c.count, 10) || 1));
    const unit = typeof c.unit === 'string' ? c.unit.trim().slice(0, 20) : '';
    return { from: c.from, kind: c.kind, days: c.kind === 'days' ? days : [], per_week: c.kind === 'flex' ? per : null, count, unit: count > 1 ? unit : '' };
  }
  function cleanHabit(h) {
    if (typeof h === 'string') { try { h = JSON.parse(h); } catch { return null; } }
    if (!h || !Array.isArray(h.changes)) return null;
    const changes = h.changes.map(cleanHabitStep).filter(Boolean).sort((a, b) => a.from.localeCompare(b.from)).slice(-20);
    if (!changes.length) return null;
    const paused = (Array.isArray(h.paused) ? h.paused : []).filter(p => p && DATE.test(p.from || '') && (p.to == null || DATE.test(p.to)))
      .map(p => ({ from: p.from, to: p.to || null })).slice(-20);
    return { changes, paused };
  }
  const habitNow = h => h.changes[h.changes.length - 1];
  function habitCfg(h, date) { let c = null; for (const x of h.changes) if (x.from <= date) c = x; return c; }
  const isPaused = (h, date) => h.paused.some(p => p.from <= date && (!p.to || date < p.to));
  const weekStart = d => addDays(d, -((weekday(d) + 6) % 7));

  // One day: 'before' (habit not started), 'paused', 'off' (not meant to happen), 'done', 'miss', or 'today'.
  function habitDay(h, amounts, date, today, daysOff) {
    const c = habitCfg(h, date);
    if (!c) return { state: 'before', amount: 0, target: 1 };
    const amount = amounts[date] || 0, done = amount >= c.count;
    const base = { amount, target: c.count, done };
    if (isPaused(h, date)) return { ...base, state: done ? 'done' : 'paused' };
    if (date === today) return { ...base, state: done ? 'done' : 'today', scheduled: c.kind === 'flex' || scheduledOn(c, date, daysOff) };
    if (done) return { ...base, state: 'done' };
    if (c.kind === 'flex' || !scheduledOn(c, date, daysOff)) return { ...base, state: 'off' };
    return { ...base, state: 'miss' };
  }
  function scheduledOn(c, date, daysOff) {
    const wd = weekday(date);
    if (c.kind === 'days') return c.days.includes(wd);
    if (c.kind === 'daily') return !(daysOff || []).includes(wd);
    return false;
  }

  // A week (for 'flex'): how many days were done and what the target was. Days before the start or paused lower the target.
  function habitWeek(h, amounts, ws, today, daysOff) {
    let done = 0, active = 0, sched = 0, cfg = null;
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      if (d > today) break;
      const c = habitCfg(h, d);
      if (!c) continue;
      cfg = c;
      if ((amounts[d] || 0) >= c.count) done++;
      if (isPaused(h, d)) continue;
      active++;
      if (c.kind !== 'flex' && scheduledOn(c, d, daysOff)) sched++;
    }
    // Days still to come this week also count as chances.
    const end = addDays(ws, 6);
    for (let d = addDays(today, 1); d <= end; d = addDays(d, 1)) {
      const c = habitCfg(h, today);
      if (c && !isPaused(h, today)) { active++; if (c.kind !== 'flex' && scheduledOn(c, d, daysOff)) sched++; }
    }
    if (!cfg) return null;
    const target = cfg.kind === 'flex' ? Math.min(cfg.per_week, active) : sched;
    return { done, target, met: done >= target };
  }

  function habitStats(o) {
    const h = cleanHabit(o.habit);
    if (!h) return null;
    const today = o.today, daysOff = o.daysOff || [], nowMin = o.nowMin ?? 0;
    const amounts = {};
    for (const l of o.logs || []) if (!l.deleted) amounts[l.date] = (amounts[l.date] || 0) + (l.amount || 1);
    const cur = habitNow(h), first = h.changes[0].from;
    const day = d => habitDay(h, amounts, d, today, daysOff);
    const ticks = [];
    for (let i = (o.window || 14) - 1; i >= 0; i--) { const d = addDays(today, -i); ticks.push({ date: d, ...day(d) }); }
    const t = day(today);
    const out = { kind: cur.kind, unit: cur.unit, count: cur.count, days: cur.days, per_week: cur.per_week, paused: isPaused(h, today),
      amount: t.amount, todayDone: !!t.done, ticks, first };

    if (cur.kind === 'flex') {
      // Streak in weeks: this week counts once it's met; it can't break until it's over.
      const ws = weekStart(today);
      const wk = habitWeek(h, amounts, ws, today, daysOff);
      let streak = wk && wk.met && wk.target > 0 ? 1 : 0;
      for (let w = addDays(ws, -7); w >= weekStart(first); w = addDays(w, -7)) {
        const r = habitWeek(h, amounts, w, today, daysOff);
        if (!r) break;
        if (r.target === 0) continue;       // a fully paused week neither counts nor breaks
        if (!r.met) break;
        streak++;
      }
      let best = 0, run = 0, met = 0, ended = 0, met90 = 0, ended90 = 0;
      for (let w = weekStart(first); w <= ws; w = addDays(w, 7)) {
        const r = habitWeek(h, amounts, w, today, daysOff);
        if (!r || r.target === 0) continue;
        if (r.met) { run++; best = Math.max(best, run); } else if (w < ws) run = 0;
        if (w < ws) {
          if (w >= addDays(ws, -28)) { ended++; if (r.met) met++; }
          if (w >= addDays(ws, -91)) { ended90++; if (r.met) met90++; }
        }
      }
      let daysLeft = 0;
      for (let d = today; d <= addDays(ws, 6); d = addDays(d, 1)) if (!isPaused(h, d)) daysLeft++;
      const need = wk ? Math.max(0, wk.target - wk.done) : 0;
      Object.assign(out, { streak, best: Math.max(best, streak), streakUnit: 'week', weekDone: wk?.done || 0, weekTarget: wk?.target || cur.per_week, daysLeft,
        atRisk: !out.paused && !t.done && need > 0 && need >= daysLeft,
        rate30: ended ? { done: met, of: ended } : null, rate90: ended90 ? { done: met90, of: ended90 } : null });
    } else {
      // Streak in days: scheduled days in a row. Today only counts once done, and can't break the streak before midnight.
      let streak = t.done ? 1 : 0;
      for (let i = 1; i < 3700; i++) {
        const r = day(addDays(today, -i));
        if (r.state === 'before' || r.state === 'miss') break;
        if (r.state === 'done') streak++;
      }
      let best = 0, run = 0, d30 = 0, s30 = 0, d90 = 0, s90 = 0;
      for (let d = first; d <= today; d = addDays(d, 1)) {
        const r = day(d);
        if (r.state === 'done') run++;
        else if (r.state === 'miss') run = 0;
        best = Math.max(best, run);
        const back = d >= addDays(today, -29), back90 = d >= addDays(today, -89);
        if (r.state === 'done' || r.state === 'miss') {
          if (back) { s30++; if (r.state === 'done') d30++; }
          if (back90) { s90++; if (r.state === 'done') d90++; }
        }
      }
      Object.assign(out, { streak, best: Math.max(best, streak), streakUnit: 'day',
        atRisk: !out.paused && !t.done && t.scheduled && streak > 0 && nowMin >= 18 * 60,
        rate30: s30 ? { done: d30, of: s30 } : null, rate90: s90 ? { done: d90, of: s90 } : null });
      // "Streak" only shows days that were done, so the run must also include today's done-ness correctly.
    }
    const total = Object.entries(amounts).filter(([d]) => d >= first && d <= today).reduce((n, [, a]) => n + a, 0);
    out.total = total;
    return out;
  }

  root.PlannerCore = {
    CATEGORIES, DAY_NAMES, DEFAULT_ROUTINE, DATE,
    toMin, toHHMM, weekday, addDays,
    cleanRule, describeRule, guessRule, cleanRoutine, makePlan, nextSlot, cleanRepeat, describeRepeat, subjectRates,
    cleanHabit, habitStats, habitDay, habitCfg, weekStart, bestSlot, aiShare,
  };
})(typeof window !== 'undefined' ? window : globalThis);
