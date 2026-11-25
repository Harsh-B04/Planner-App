// The free built-in AI path, with a fake Cloudflare AI. No server needed: node test/ai.test.mjs
import assert from 'node:assert/strict';
import { generate, AIError } from '../src/ai.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };
const cfg = model => ({ provider: 'workers_ai', model });
const fakeEnv = reply => { const env = { calls: [], AI: { run: async (model, input) => { env.calls.push(model); return typeof reply === 'function' ? reply(model) : reply; } } }; return env; };

await test('retired model names are swapped for the current default', async () => {
  const env = fakeEnv({ response: '{"ok": true}' });
  await generate(env, cfg('@cf/meta/llama-3.1-8b-instruct'), { system: 's', prompt: 'p', json: true });
  await generate(env, cfg(''), { system: 's', prompt: 'p', json: true });
  assert.deepEqual(env.calls, ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
});
await test('a model the person typed is used as is', async () => {
  const env = fakeEnv({ response: '{"ok": true}' });
  await generate(env, cfg('@cf/zai-org/glm-4.7-flash'), { system: 's', prompt: 'p', json: true });
  assert.deepEqual(env.calls, ['@cf/zai-org/glm-4.7-flash']);
});
await test('newer reply shape (choices) is understood', async () => {
  const env = fakeEnv({ choices: [{ message: { content: '{"ok": true}' } }] });
  assert.deepEqual(await generate(env, cfg(''), { system: 's', prompt: 'p', json: true }), { ok: true });
});
await test('JSON already parsed by Cloudflare is understood', async () => {
  const env = fakeEnv({ response: { ok: true } });
  assert.deepEqual(await generate(env, cfg(''), { system: 's', prompt: 'p', json: true }), { ok: true });
});
await test('a failure shows the real reason', async () => {
  const env = fakeEnv(() => { throw new Error('5007: No such model @cf/x/y'); });
  await assert.rejects(generate(env, cfg('@cf/x/y'), { system: 's', prompt: 'p' }),
    e => e instanceof AIError && /AI service failed: 5007: No such model/.test(e.message));
});
await test('free AI switched off gives a clear message', async () => {
  await assert.rejects(generate({}, cfg(''), { system: 's', prompt: 'p' }), e => e instanceof AIError && /not switched on/.test(e.message));
});
// OpenAI-style service that misbehaves on purpose.
import http from 'node:http';
const script = [];
let hits = 0;
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    hits++;
    const [status, content] = script.shift() || [200, '{"ok": true}'];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : JSON.stringify({ error: { message: 'overloaded' } }));
  });
}).listen(9918);
const oc = { provider: 'openai_compat', model: 'm', baseUrl: 'http://127.0.0.1:9918/v1', key: 'k' };

await test('busy service is retried and then works', async () => {
  script.push([503], [503], [200, '{"ok": true}']);
  hits = 0;
  assert.deepEqual(await generate({}, oc, { system: 's', prompt: 'p', json: true }), { ok: true });
  assert.equal(hits, 3);
});
await test('still busy after 3 tries: clear "busy" message', async () => {
  script.push([503], [503], [503]);
  await assert.rejects(generate({}, oc, { system: 's', prompt: 'p' }), e => e.busy === true && /busy/.test(e.message));
});
await test('a reply that is not JSON gets one more try', async () => {
  script.push([200, 'Sure! Here is what I found: the report'], [200, '{"items": []}']);
  assert.deepEqual(await generate({}, oc, { system: 's', prompt: 'p', json: true }), { items: [] });
});
await test('an empty reply says so plainly', async () => {
  script.push([200, '']);
  await assert.rejects(generate({}, oc, { system: 's', prompt: 'p' }), e => /empty reply/.test(e.message));
});
srv.close();

console.log(`\nAll ${passed} AI checks passed.`);
