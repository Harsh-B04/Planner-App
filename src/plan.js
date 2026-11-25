// What the AI is asked for planning help, and the code that checks its answers.
// The AI only suggests tasks and reads preference sentences. The schedule itself is made by planner-core.js.
import '../public/planner-core.js';

const PC = globalThis.PlannerCore;
export const { cleanRule, cleanRoutine, CATEGORIES } = PC;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const BREAKDOWN_SYSTEM = `You help a person turn a goal into concrete tasks for their planner.

If information that would change the plan a lot is missing (the deadline, how big the work is, what is already done), ask up to 3 short questions:
{"questions": ["...", "..."]}

Otherwise return:
{"goal": "short name, 2-5 words", "tasks": [{"title": "...", "minutes": 60, "deadline": "YYYY-MM-DD or null", "priority": 1, "category": "...", "effort": "light|normal|hard", "done_when": "..."}], "subject": "one lowercase word for the course or topic area, or null"}

Rules for tasks:
- 1 to 20 tasks, in the order they should be done. If the goal is one piece of work that can be done in a sitting or two, return just that one task: don't split it for the sake of splitting. For a list of topics, one task per topic (or per part of a big topic), named after the topic.
- title: starts with a verb, concrete, 3 to 10 words, in the person's own terms.
- minutes: a realistic estimate between 20 and 180. Split anything bigger.
- deadline: only if the person gave one or it clearly follows from what they said. Earlier steps can have earlier deadlines. When the person gives a period ("in the next 2 weeks", "by the 15th"), spread the tasks evenly over it: each task gets its own deadline, in order, the last one on the final day.
- priority: 1 = must happen soon, 2 = normal, 3 = nice to have.
- category: one of ${PC.CATEGORIES.join(', ')}.
- done_when: one short line saying how they'll know it's finished.
- effort: hard for heavy problem-solving or a tough chapter, light for quick or easy work, normal otherwise.
- No generic advice tasks like "take breaks" or "stay motivated". Skip things they already did.`;

export function breakdownRequest({ goal, answers, today, noQuestions }) {
  const day = PC.DAY_NAMES[PC.weekday(today)];
  let prompt = `Today is ${today} (${day}).\n\nGoal:\n"""\n${goal}\n"""`;
  if (answers.length) prompt += '\n\nAnswers to your questions:\n' + answers.map(a => `Q: ${a.q}\nA: ${a.a || '(no answer)'}`).join('\n');
  const noMore = noQuestions || answers.length;
  return {
    system: BREAKDOWN_SYSTEM + (noMore ? '\n\nDo not ask questions now. Return tasks, using sensible guesses where needed.' : ''),
    prompt,
    json: true,
    maxTokens: 1200,
  };
}

export function cleanBreakdown(out, allowQuestions) {
  const tasks = (Array.isArray(out?.tasks) ? out.tasks : []).slice(0, 25).map(t => {
    const title = str(t?.title, 120);
    if (title.length < 2) return null;
    const m = Math.round(Number(t.minutes));
    return {
      title,
      minutes: Number.isFinite(m) && m > 0 ? Math.min(Math.max(m, 10), 480) : 60,
      deadline: PC.DATE.test(t.deadline || '') ? t.deadline : null,
      priority: [1, 2, 3].includes(Number(t.priority)) ? Number(t.priority) : 2,
      category: PC.CATEGORIES.includes(t.category) ? t.category : 'other',
      done_when: str(t.done_when, 150) || null,
      effort: { light: 1, normal: 2, hard: 3 }[String(t.effort || '').toLowerCase()] || 2,
    };
  }).filter(Boolean).slice(0, 20);
  const subject = String(out?.subject || '').toLowerCase().replace(/^#/, '').trim();
  if (tasks.length) return { goal: str(out.goal, 60) || null, subject: /^[\p{L}\p{N}_-]{1,40}$/u.test(subject) ? subject : null, tasks };
  const questions = (Array.isArray(out?.questions) ? out.questions : []).map(q => str(q, 200)).filter(Boolean).slice(0, 3);
  if (allowQuestions && questions.length) return { questions };
  return { goal: null, tasks: [] };
}

const RULE_SYSTEM = `Turn one sentence a person wrote about how they like to work into a scheduling rule. Return {"rule": <rule or null>}.

Rule shapes (days: 0 = Sunday ... 6 = Saturday):
{"type": "day_off", "days": [5], "strict": false}
{"type": "no_work_between", "start": "HH:MM", "end": "HH:MM", "days": [optional], "strict": true}
{"type": "max_hours", "hours": 4, "days": [optional]}
{"type": "prefer_time", "start": "HH:MM", "end": "HH:MM", "days": [optional]}

strict is true only for "never", "can't", "no work" and similar. "Don't like" or "prefer not to" is false.
"I focus better at night" -> prefer_time 20:00 to 24:00. "Mornings are best" -> prefer_time 07:00 to 12:00.
If the sentence isn't about when or how much to work, return {"rule": null}.`;

export function ruleRequest(text) {
  return { system: RULE_SYSTEM, prompt: `Sentence: "${text}"`, json: true, maxTokens: 200 };
}
