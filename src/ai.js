// The AI layer. Every AI feature in the app calls generate(), never a provider directly,
// so providers can be swapped or added without touching the rest of the code.
//
// To add a new provider: add one entry to PROVIDERS with a call(cfg, req, env) function
// that returns plain text. That's it.

const OPENAI_PRESETS = [
  { id: 'openai',     label: 'OpenAI',             baseUrl: 'https://api.openai.com/v1' },
  { id: 'gemini',     label: 'Google Gemini',      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'groq',       label: 'Groq',               baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'openrouter', label: 'OpenRouter',         baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek',   label: 'DeepSeek',           baseUrl: 'https://api.deepseek.com/v1' },
];

// Cloudflare retired the Llama 3.1 models on 30 May 2026. This one is still listed as available.
const WORKERS_AI_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const RETIRED_WORKERS_MODELS = ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.1-8b-instruct-awq', '@cf/meta/llama-3-8b-instruct', '@cf/meta/llama-3.1-70b-instruct'];

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    needsKey: true,
    modelHint: 'claude-haiku-5-5',
    async call(cfg, req) {
      const res = await postWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model || 'claude-haiku-5-5',
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
        }),
      });
      const data = await readJson(res);
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    },
  },

  // One adapter covers every service that speaks the OpenAI chat format.
  openai_compat: {
    label: 'OpenAI-compatible (OpenAI, Gemini, Groq, OpenRouter, DeepSeek…)',
    needsKey: true,
    needsBaseUrl: true,
    presets: OPENAI_PRESETS,
    modelHint: 'model name from your provider, e.g. gemini-3.6-flash',
    async call(cfg, req) {
      if (!cfg.model) throw new AIError('Set a model name in Settings.');
      const base = checkUrl(cfg.baseUrl);
      const url = base.replace(/\/+$/, '') + '/chat/completions';
      const body = {
        model: cfg.model.trim().replace(/^models\//, ''),
        max_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      };
      // Gemini's newer models "think" before answering. Keep that short so the answer itself fits.
      const gemini = new URL(url).hostname === 'generativelanguage.googleapis.com';
      // "minimal" is Gemini 3's near-off setting (Google's Gemini 3 guide); older models get "low" or nothing.
      if (gemini) body.reasoning_effort = 'minimal';
      const send = b => postWithRetry(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify(b),
      });
      let res = await send(body);
      if (gemini && res.status === 400) {
        // A model that doesn't accept the thinking setting: ask again without it.
        const peek = await res.clone().text();
        if (/reasoning|thinking/i.test(peek)) {
          body.reasoning_effort = 'low'; res = await send(body);
          if (res.status === 400 && /reasoning|thinking/i.test(await res.clone().text())) { delete body.reasoning_effort; res = await send(body); }
        }
      }
      const data = await readJson(res);
      const content = data.choices?.[0]?.message?.content ?? '';
      return Array.isArray(content) ? content.map(c => c?.text || '').join('') : content;
    },
  },

  // Free option that needs no key: runs on the Cloudflare account that hosts the app.
  // Everyone using this option shares that account's free daily allowance.
  workers_ai: {
    label: 'Free built-in (Cloudflare Workers AI)',
    needsKey: false,
    modelHint: WORKERS_AI_DEFAULT,
    async call(cfg, req, env) {
      if (!env.AI) throw new AIError('The free built-in AI is not switched on for this app.');
      // Old saved model names that Cloudflare has retired are swapped for the current default.
      const model = !cfg.model || RETIRED_WORKERS_MODELS.includes(cfg.model) ? WORKERS_AI_DEFAULT : cfg.model;
      const out = await env.AI.run(model, {
        max_tokens: Math.min(req.maxTokens, 2048),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      });
      // Older models answer { response }, newer ones answer in the OpenAI shape { choices: [...] }.
      const r = out?.response ?? out?.result?.response ?? out?.choices?.[0]?.message?.content ?? '';
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  },
};

export class AIError extends Error {
  constructor(message, { busy = false, slow = false } = {}) { super(message); this.busy = busy; this.slow = slow; }
}

const BUSY = [429, 500, 502, 503, 504, 524, 529];
const wait = ms => new Promise(r => setTimeout(r, ms));

// AI services are sometimes overloaded for a moment. Try up to 3 times before giving up.
// Each try gives up after 40 s, so a slow model can't leave you waiting until the service's own
// gateway times out (that was the "error 524"). A timeout isn't retried here; the caller can ask again for less.
const SLOW_MS = 40000;
async function postWithRetry(url, init) {
  let last, timeouts = 0;
  for (const delay of [0, 1500, 4000]) {
    if (delay) await wait(delay);
    try {
      last = await fetch(url, { ...init, signal: AbortSignal.timeout(SLOW_MS) });
      if (!BUSY.includes(last.status)) return last;
      if (last.status === 524 && ++timeouts >= 1) break;
    } catch (err) {
      last = err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        if (++timeouts >= 1) throw new AIError('The AI took too long to answer. Try again, or pick a faster model in Settings → AI.', { busy: true, slow: true });
      }
    }
  }
  if (last && !(last instanceof Error) && last.status === 524) throw new AIError('The AI took too long to answer. Try again, or pick a faster model in Settings → AI.', { busy: true, slow: true });
  if (last instanceof Error) throw new AIError("Couldn't reach the AI service. Try again in a minute.", { busy: true });
  return last;
}

export function providerList(env) {
  return Object.entries(PROVIDERS)
    .filter(([id]) => id !== 'workers_ai' || env.AI)
    .map(([id, p]) => ({
      id, label: p.label, needsKey: p.needsKey, needsBaseUrl: !!p.needsBaseUrl,
      presets: p.presets || [], modelHint: p.modelHint,
    }));
}

// req: { system, prompt, maxTokens?, json? }
// When json is true the reply is parsed and returned as an object.
export async function generate(env, cfg, req) {
  const provider = PROVIDERS[cfg?.provider];
  if (!provider) throw new AIError('No AI chosen yet. Pick one in Settings.');
  if (provider.needsKey && !cfg.key) throw new AIError('Add your API key in Settings.');
  const full = {
    system: req.system + (req.json ? '\nReply with JSON only. No extra words, no code fences.' : ''),
    prompt: req.prompt,
    // Generous room: you only pay for what the model actually writes, and "thinking" models need space.
    maxTokens: Math.max(req.maxTokens || 0, 4096),
  };
  const ask = async r => {
    try {
      const text = await provider.call(cfg, r, env);
      if (!String(text || '').trim()) throw new AIError('The AI sent back an empty reply. Try again, or pick a lighter model in Settings.');
      return text;
    } catch (err) {
      // Show the real reason in the app instead of a vague server error.
      if (err instanceof AIError) throw err;
      throw new AIError(`The AI service failed: ${String(err?.message || err).slice(0, 200)}`);
    }
  };
  const text = await ask(full);
  if (!req.json) return text;
  try {
    return parseJsonLoose(text);
  } catch {
    // One more go, telling the model what went wrong.
    return parseJsonLoose(await ask({ ...full, prompt: full.prompt + '\n\nYour last reply could not be read. Reply again with only the JSON.' }));
  }
}

// Models sometimes wrap JSON in ```json fences or add a sentence. Pull out the JSON part.
export function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.search(/[\[{]/);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw new AIError('The AI reply was not valid JSON.');
}

function checkUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new AIError('The base URL is not valid.'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) throw new AIError('The base URL must start with https://');
  return u.toString();
}

async function readJson(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || text.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new AIError('The AI service rejected the API key.');
    if (res.status === 429) throw new AIError('The AI service says too many requests, or your free quota is used up for now. Try again later.', { busy: true });
    if (BUSY.includes(res.status)) throw new AIError('The AI service is busy right now. It will be tried again shortly.', { busy: true });
    throw new AIError(`AI service error ${res.status}: ${String(msg).slice(0, 200)}`);
  }
  if (!data) throw new AIError('The AI service sent an unreadable reply.');
  return data;
}
