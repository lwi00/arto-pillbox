/**
 * End-to-end tests against the bundled Arto firmware running in the AVR8js emulator.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { TestClock, startPillbox } from './helpers.js';

let clock: TestClock;
let env: Awaited<ReturnType<typeof startPillbox>>;

beforeEach(async () => {
  clock = new TestClock(new Date('2026-10-20T09:30:00Z'));
  env = await startPillbox(clock);
  await env.settle();
});
afterEach(async () => { await env.close(); });

test('the lid polarity comes from the manifest interlock', () => {
  assert.equal(env.pillbox.lidOpenValue, 1);
  assert.equal(env.pillbox.tracker.lidOpen, false);
});

test('a reminder lights the LED and sounds the buzzer, then opening the lid stops both', async () => {
  const started = await env.pillbox.triggerReminder('morning', 20, 'alexa');
  assert.deepEqual(started.outputs, { reminder_led: 1, buzzer: 1 });
  assert.equal(env.pillbox.history.find('2026-10-20', 'morning', 'reminder')[0].requestedBy, 'alexa');

  env.setLid(true);
  await env.settle();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(env.pillbox.status().reminderActive, null);
  assert.equal(env.device.values.buzzer.value, 0);
  assert.equal(env.device.values.reminder_led.value, 0);
});

test('the firmware interlock refuses the buzzer while the lid is open, independently of the server', async () => {
  env.setLid(true);
  await new Promise(r => setTimeout(r, 30));
  await assert.rejects(env.device.write('buzzer', 1), /interlock_active/);
});

test('a reminder is refused when the lid is already open', async () => {
  env.setLid(true);
  await env.settle();
  await assert.rejects(env.pillbox.triggerReminder('morning', 20, 'alexa'), /already open/);
});

test('a reminder is refused when the dose is not due or already done', async () => {
  await assert.rejects(env.pillbox.triggerReminder('evening', 20, 'alexa'), /upcoming/);
  env.setLid(true); await env.settle();
  clock.advance(3000); await env.pillbox.poll();
  env.setLid(false); await env.settle();
  assert.equal(env.pillbox.status().slots[0].state, 'opened');
  await assert.rejects(env.pillbox.triggerReminder('morning', 20, 'alexa'), /opened/);
});

test('reminders are rate limited per slot and bounded in duration', async () => {
  await assert.rejects(env.pillbox.triggerReminder('morning', 120, 'alexa'), /5 to 60/);
  await env.pillbox.triggerReminder('morning', 5, 'agent');
  await env.pillbox.stopReminder();
  clock.advance(60_000);
  await assert.rejects(env.pillbox.triggerReminder('morning', 5, 'agent'), /already played/);
  clock.advance(300_000);
  await env.pillbox.triggerReminder('morning', 5, 'agent');
  await env.pillbox.stopReminder();
});

test('a qualifying opening is reported through status with its local time', async () => {
  env.setLid(true); await env.settle();
  clock.advance(2500); await env.pillbox.poll();
  const morning = env.pillbox.status().slots[0];
  assert.equal(morning.state, 'opened');
  assert.equal(morning.openedAt, '09:30');
  assert.equal(morning.late, false);
});
