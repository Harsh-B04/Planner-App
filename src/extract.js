// Turns one journal entry into structured facts ("observations") via the AI layer.
// The AI only proposes. cleanItems() checks every field in code, and the user confirms in the app.

export const KINDS = ['activity', 'intention', 'preference', 'update'];
export const OUTCOMES = ['done', 'partly', 'not_done', 'unknown'];
export const CATEGORIES = ['study', 'work', 'project', 'exercise', 'chores', 'social', 'rest', 'other', 'reminder'];

export const SYSTEM = `You read one entry from a person's private journal and pull out facts a planning app can use.

Return {"items": [...]}. Each item is one of:
- {"kind":"activity","task":"short name","category":"<category>","minutes":<number or null>,"estimated":<true or false>,"outcome":"done|partly|not_done|unknown","reason":"<why it didn't go to plan, or null>"}
  Something the writer did or tried to do.
- {"kind":"update","plan":"name of the existing plan exactly as listed","add":["new parts to add"],"which":["existing parts the new finish day applies to, [] for all"],"deadline":"YYYY-MM-DD or null","drop":["parts to remove"],"each_minutes":<number or null>}
  A change to one of the plans listed under "Plans they already have" ("I also have to study a 5th module", "the 4 modules need to be done before Tuesday" -> add ["Module 5"], which ["Module 1","Module 2","Module 3","Module 4"], deadline = the last allowed day, so before Tuesday means Monday's date). Use this only for plans in that list; anything else is a new intention.
- {"kind":"intention","task":"short name","category":"<category>","date":"YYYY-MM-DD or null","time":"HH:MM or null","repeat":null or {"days":["mon","tue",...],"time":"HH:MM or null"} or {"per_week":<1-6>,"time":"HH:MM or null"},"minutes":<number or null>,"each_minutes":<number or null>,"best_time":"HH:MM or null","parts":<number>,"topics":["names of the topics or parts, if they listed them"],"subject":"one lowercase word or null","effort":"light|normal|hard"}
  Something the writer plans to do later. If they plan to do it regularly, fill "repeat": on set days ("gym every Monday and Tuesday at 6 pm", "run on weekdays") give those days (mon, tue, wed, thu, fri, sat, sun); every day or daily gives all seven days; a number of times a week without set days ("exercise twice a week", "3 times a week", "once a week") gives {"per_week": n}. Add the 24-hour time if given. For a repeat, "task" is just the activity in a few words, without how often or when ("I want to exercise twice a week at 6 pm" -> task "Exercise", repeat {"per_week":2,"time":"18:00"}). A regular habit with set days is an intention with "repeat", not a preference. A reminder ("remind me of X's birthday tomorrow", "call mom on Sunday", "pay rent on the 1st", a meeting or event) is an intention with category "reminder", the date (and time if given), "minutes" null, and "task" written as the thing to remember ("Rahul's birthday", "Call mom"). "minutes" is how long each time, only if stated. "time" is the 24-hour clock time if they said one ("at 4 pm" -> "16:00"). "subject" is the course or topic area in one lowercase word if clear (thermo, machining, ctme, french), else null. "effort" is how demanding the work is: hard for heavy problem-solving or a tough chapter, light for quick admin or easy review, normal otherwise. "topics" lists the names of those pieces only when the writer named them ("thermo, fluids and SOM" -> ["Thermo","Fluids","SOM"]), else []. "minutes" for a plan with several parts is the total time they said for all of it; "each_minutes" is how long one part takes if they said that ("a module would take about 1-2 hrs" -> 90, the middle of a range). "best_time": when they gave no time, the time of day you'd suggest for it from what the entry says about them and common sense (hard study when fresh, light tasks later), else null. When one entry has plans for different subjects, keep each plan's details (its subject, days, window, topics) to its own sentence. "parts" is how many separate pieces of work it involves: 1 for a single job like "complete my CTME assignment", more for a list of topics or chapters.
- {"kind":"preference","text":"first-person sentence, e.g. I focus better in the morning"}
  A lasting liking or rule about how they work that the writer states clearly ("I focus better in the morning", "no work on Fridays"). Never a one-off event, and never an activity they want to do on set days (that is an intention with "repeat").

Categories: ${CATEGORIES.join(', ')}.

Rules:
- Only use what the entry says. Do not invent tasks.
- "activity" is only for work that already happened, said in the past tense ("did", "finished", "studied", "went"). Anything still to do, including today ("exam study today", "finish the paper today", "need to call the lab"), is an "intention" with today's date. When unsure, use "intention".
- Never list the same thing twice.
- minutes: use the stated time. For vague phrases like "ages" or "all afternoon", give your best guess and set "estimated": true. If there is nothing to go on, use null.
- Work out relative dates ("tomorrow", "on Monday") from the entry date given. For a span ("in the next 2 weeks", "by end of month", "this week") use the last day of it as the date.
- Several topics or parts the writer wants to finish together: one intention named after the whole (e.g. "Machining topics"); the app can split it later.
- Task names: 2 to 6 words, in the writer's own terms.
- Leave out feelings, health details and private details about other people.
- If nothing is useful, return {"items": []}.`;

export function buildPrompt(entry, timezone, alreadyRecorded, plans = []) {
  const weekday = new Date(entry.entry_date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  let time;
  try {
    time = new Date(entry.created_at).toLocaleTimeString('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit' });
  } catch {
    time = new Date(entry.created_at).toISOString().slice(11, 16) + ' UTC';
  }
  const parts = [`Entry date: ${entry.entry_date} (${weekday}). Written at ${time}.`];
  if (alreadyRecorded.length) {
    parts.push('Already recorded from this entry, do not repeat:\n' + alreadyRecorded.map(a => '- ' + a).join('\n'));
  }
  if (plans.length) {
    parts.push('Plans they already have (if the entry adds to or changes one of these, return an "update" for it instead of a new intention):\n' + plans.map(p => '- ' + p).join('\n'));
  }
  parts.push('Entry:\n"""\n' + entry.body + '\n"""');
  return parts.join('\n\n');
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// {"days":["mon","tue"],"time":"18:00"} -> {days:[1,2],time:'18:00'}, or null.
export function cleanRepeatItem(r) {
  if (!r || typeof r !== 'object') return null;
  const t0 = /^(\d{1,2}):(\d{2})$/.exec(String(r.time || '').trim());
  const time0 = t0 && +t0[1] < 24 && +t0[2] < 60 ? `${t0[1].padStart(2, '0')}:${t0[2]}` : null;
  const per = parseInt(r.per_week, 10);
  if ((!Array.isArray(r.days) || !r.days.length) && per >= 1 && per <= 7) return per === 7 ? { days: [0, 1, 2, 3, 4, 5, 6], time: time0 } : { days: [], per_week: per, time: time0 };
  if (!Array.isArray(r.days)) return null;
  const days = [...new Set(r.days.map(d => typeof d === 'number' ? d : DAYS.indexOf(String(d).trim().toLowerCase().slice(0, 3))))]
    .filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!days.length) return null;
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(r.time || '').trim());
  const time = t && +t[1] < 24 && +t[2] < 60 ? `${t[1].padStart(2, '0')}:${t[2]}` : null;
  return { days, time };
}

const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
// Accepts whatever the model sent back and keeps only well-formed items.
export function cleanItems(out) {
  const list = Array.isArray(out) ? out : Array.isArray(out?.items) ? out.items : [];
  const items = [];
  for (const x of list.slice(0, 25)) {
    if (!x || !KINDS.includes(x.kind)) continue;
    if (x.kind === 'preference') {
      const text = str(x.text, 200);
      if (text) items.push({ kind: 'preference', data: { text } });
      continue;
    }
    if (x.kind === 'update') {
      // A change to a plan they already have: add parts, set an earlier finish, drop parts, or say how long each takes.
      const plan = str(x.plan, 80);
      const list = v => (Array.isArray(v) ? v : []).map(t => str(t, 80)).filter(Boolean).slice(0, 20);
      const data = { task: plan, plan, add: list(x.add), which: list(x.which), drop: list(x.drop) };
      if (DATE_OK.test(x.deadline || '')) data.deadline = x.deadline;
      const each = Number(x.each_minutes);
      if (x.each_minutes != null && Number.isFinite(each) && each >= 5) data.each_minutes = Math.min(Math.round(each), 480);
      if (plan && (data.add.length || data.drop.length || data.deadline || data.each_minutes)) items.push({ kind: 'update', data });
      continue;
    }
    const task = str(x.task, 120);
    if (!task) continue;
    const data = { task, category: CATEGORIES.includes(x.category) ? x.category : 'other' };
    if (x.kind === 'activity') {
      const m = Number(x.minutes);
      data.minutes = x.minutes != null && Number.isFinite(m) && m > 0 ? Math.min(Math.round(m), 960) : null;
      data.estimated = data.minutes != null && x.estimated === true;
      data.outcome = OUTCOMES.includes(x.outcome) ? x.outcome : 'unknown';
      data.reason = str(x.reason, 200) || null;
    } else {
      data.date = DATE.test(x.date || '') ? x.date : null;
      const rep = cleanRepeatItem(x.repeat);
      if (rep) { data.repeat = rep; data.date = null; }
      const m = Number(x.minutes);
      if (x.minutes != null && Number.isFinite(m) && m >= 5) data.minutes = Math.min(Math.round(m), 720);
      const tm = /^(\d{1,2}):(\d{2})$/.exec(String(x.time || '').trim());
      if (tm && +tm[1] < 24 && +tm[2] < 60) data.time = `${tm[1].padStart(2, '0')}:${tm[2]}`;
      const subj = String(x.subject || '').toLowerCase().replace(/^#/, '').trim();
      if (/^[\p{L}\p{N}_-]{1,40}$/u.test(subj)) data.subject = subj;
      const eff = { light: 1, normal: 2, hard: 3 }[String(x.effort || '').toLowerCase()];
      if (eff && eff !== 2) data.effort = eff;
      const each = Number(x.each_minutes);
      if (x.each_minutes != null && Number.isFinite(each) && each >= 5) data.each_minutes = Math.min(Math.round(each), 480);
      const bt = /^(\d{1,2}):(\d{2})$/.exec(String(x.best_time || '').trim());
      if (bt && +bt[1] < 24 && +bt[2] < 60) data.best_time = `${bt[1].padStart(2, '0')}:${bt[2]}`;
      const parts = Math.round(Number(x.parts));
      if (parts >= 2 && parts <= 40) data.parts = parts;
      const topics = (Array.isArray(x.topics) ? x.topics : []).map(t => str(t, 60)).filter(Boolean).slice(0, 20);
      if (topics.length >= 2) { data.topics = topics; data.parts = Math.max(data.parts || 0, topics.length); }
    }
    items.push({ kind: x.kind, data });
  }
  return items.slice(0, 20);
}

// Drops repeats: the same note twice in one reply, or one the person already confirmed for this entry.
export function dropRepeats(items, already = []) {
  const key = (kind, d) => kind + ':' + String(kind === 'preference' ? d.text : d.task).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Set(), taken = new Set(already.map(a => String(a).toLowerCase().replace(/ \(plan\)$/, '').replace(/[^a-z0-9]+/g, ' ').trim()));
  return items.filter(it => {
    const k = key(it.kind, it.data), name = k.slice(k.indexOf(':') + 1);
    if (seen.has(k) || taken.has(name)) return false;
    seen.add(k);
    return true;
  });
}

export function summarize(kind, data) {
  if (kind === 'preference') return data.text;
  return kind === 'intention' ? `${data.task} (plan)` : data.task;
}
