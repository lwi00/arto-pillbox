/**
 * Tests of the demo site's assistant: an OpenAI-compatible model loop that calls the
 * pillbox tools through the real MCP endpoint.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PillboxAssistant, modelConfigFromEnv } from '../src/demo/assistant.js';
import { DemoClock } from '../src/demo/site.js';
import { localTime } from '../src/schedule.js';
import { TOKENS, TestClock, startPillbox } from './helpers.js';

let env: Awaited<ReturnType<typeof startPillbox>>;
before(async () => { env = await startPillbox(new TestClock(new Date('2026-10-20T09:30:00Z'))); await env.settle(); });
after(async () => { await env.close(); });

/** A fake model that requests one tool call, then answers with the tool's summary. */
function fakeModel(tool: string, args: Record<string, unknown>, seen: unknown[]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push(body);
    const last = body.messages.at(-1);
    const message = last.role === 'tool'
      ? { role: 'assistant', content: `<think>reasoning</think>${JSON.parse(last.content).summary ?? last.content}` }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;
}

test('the assistant answers through MCP tools and strips reasoning blocks', async () => {
  const seen: Array<{ tools?: Array<{ function: { name: string; parameters: object } }> }> = [];
  const assistant = new PillboxAssistant(env.url, TOKENS.alexa, { baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'm' }, fakeModel('get_intake_status', {}, seen));
  const { reply, trace } = await assistant.ask('Did she open her pillbox?');
  assert.match(reply, /^Morning pills: not opened yet/);
  assert.deepEqual(trace.map(t => t.tool), ['get_intake_status']);
  const names = seen[0].tools!.map(t => t.function.name).sort();
  assert.deepEqual(names, ['get_device_health', 'get_intake_history', 'get_intake_status', 'stop_reminder', 'trigger_reminder']);
  assert.ok(!JSON.stringify(seen[0].tools).includes('$schema'), 'tool parameters omit $schema');
});

test('a reminder requested through the assistant is recorded for the alexa role', async () => {
  const assistant = new PillboxAssistant(env.url, TOKENS.alexa, { baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'm' }, fakeModel('trigger_reminder', { slot: 'morning', seconds: 5 }, []));
  const { trace } = await assistant.ask('Remind her');
  assert.equal(trace[0].isError, false);
  assert.equal(env.pillbox.history.find('2026-10-20', 'morning', 'reminder').at(-1)?.requestedBy, 'alexa');
  await env.pillbox.stopReminder();
});

test('a model endpoint error is reported', async () => {
  const failing = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
  const assistant = new PillboxAssistant(env.url, TOKENS.alexa, { baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'm' }, failing);
  await assert.rejects(assistant.ask('Hello'), /429/);
});

test('model settings come from the variables Nerdit injects', () => {
  assert.equal(modelConfigFromEnv({ OPENAI_BASE_URL: 'https://gw/v1/', OPENAI_API_KEY: 'k' }), undefined);
  assert.deepEqual(modelConfigFromEnv({ OPENAI_BASE_URL: 'https://gw/v1/', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }), { baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm' });
});

test('the demo clock jumps to a local time and back', () => {
  const clock = new DemoClock();
  clock.jumpTo('09:45', 'Europe/Paris');
  assert.equal(localTime(clock.now(), 'Europe/Paris').clock, '09:45');
  assert.equal(clock.shifted, true);
  clock.reset();
  assert.equal(clock.shifted, false);
});
