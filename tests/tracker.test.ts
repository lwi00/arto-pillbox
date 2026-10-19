import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryStore } from '../src/history.js';
import { localTime, parseSchedule, previousDates } from '../src/schedule.js';
import { IntakeTracker } from '../src/tracker.js';
import { UTC_SCHEDULE } from './helpers.js';

const at = (iso: string) => new Date(iso);
const state = (tracker: IntakeTracker, now: string, slot = 0) => tracker.statusFor(now.slice(0, 10), at(now))[slot].state;

/**
 * Feeds closed-lid readings every `stepMs` between two instants.
 */
async function watchClosed(tracker: IntakeTracker, from: string, to: string, stepMs = 5000) {
  for (let t = Date.parse(from); t <= Date.parse(to); t += stepMs) await tracker.observe(false, new Date(t));
}

test('slot states follow the clock: upcoming, pending, overdue', () => {
  const tracker = new IntakeTracker(UTC_SCHEDULE, new HistoryStore());
  assert.equal(state(tracker, '2026-10-20T06:59:00Z'), 'upcoming');
  assert.equal(state(tracker, '2026-10-20T07:00:00Z'), 'pending');
  assert.equal(state(tracker, '2026-10-20T09:00:00Z'), 'overdue');
  assert.equal(tracker.statusFor('2026-10-21', at('2026-10-20T12:00:00Z'))[0].state, 'upcoming');
});

test('a window that was never monitored is unknown, not missed', () => {
  const tracker = new IntakeTracker(UTC_SCHEDULE, new HistoryStore());
  const morning = tracker.statusFor('2026-10-20', at('2026-10-20T11:00:00Z'))[0];
  assert.equal(morning.state, 'unknown');
  assert.equal(morning.trackingInterrupted, true);
});

test('a window monitored without gaps from before it opened until it closed is missed', async () => {
  const history = new HistoryStore();
  const tracker = new IntakeTracker(UTC_SCHEDULE, history);
  await watchClosed(tracker, '2026-10-20T06:59:00Z', '2026-10-20T11:00:05Z');
  assert.equal(history.find('2026-10-20', 'morning', 'covered').length, 1);
  assert.equal(history.find('2026-10-20', 'morning', 'interrupted').length, 0);
  const morning = tracker.statusFor('2026-10-20', at('2026-10-20T11:00:10Z'))[0];
  assert.equal(morning.state, 'missed');
  assert.equal(morning.trackingInterrupted, false);
});

test('monitoring that starts during a window cannot assert a missed dose', async () => {
  const tracker = new IntakeTracker(UTC_SCHEDULE, new HistoryStore());
  await watchClosed(tracker, '2026-10-20T08:00:00Z', '2026-10-20T11:00:05Z');
  assert.equal(state(tracker, '2026-10-20T11:00:10Z'), 'unknown');
});

test('a gap longer than maxGapMs inside a window makes it unknown', async () => {
  const tracker = new IntakeTracker(UTC_SCHEDULE, new HistoryStore(), { maxGapMs: 10_000 });
  await watchClosed(tracker, '2026-10-20T06:59:00Z', '2026-10-20T08:00:00Z');
  await watchClosed(tracker, '2026-10-20T08:30:00Z', '2026-10-20T11:00:05Z');
  assert.equal(state(tracker, '2026-10-20T11:00:10Z'), 'unknown');
});

test('a gap outside every window does not affect the next window', async () => {
  const tracker = new IntakeTracker(UTC_SCHEDULE, new HistoryStore(), { maxGapMs: 10_000 });
  await watchClosed(tracker, '2026-10-20T05:00:00Z', '2026-10-20T05:01:00Z');
  await watchClosed(tracker, '2026-10-20T06:30:00Z', '2026-10-20T11:00:05Z');
  assert.equal(state(tracker, '2026-10-20T11:00:10Z'), 'missed');
});

test('an opening counts after two identical readings and the minimum open time', async () => {
  const tracker = new IntakeTracker(UTC_SCHEDULE, new HistoryStore(), { minOpenMs: 2000 });
  await tracker.observe(false, at('2026-10-20T09:40:00.000Z'));
  await tracker.observe(false, at('2026-10-20T09:40:00.250Z'));
  await tracker.observe(true, at('2026-10-20T09:42:00.000Z'));
  assert.equal(tracker.lidOpen, false, 'a single reading does not change the state');
  await tracker.observe(true, at('2026-10-20T09:42:00.250Z'));
  assert.equal(tracker.lidOpen, true);
  await tracker.observe(true, at('2026-10-20T09:42:01.000Z'));
  assert.equal(state(tracker, '2026-10-20T09:42:01Z'), 'overdue', 'too short to count');
  await tracker.observe(true, at('2026-10-20T09:42:02.300Z'));
  const morning = tracker.statusFor('2026-10-20', at('2026-10-20T09:43:00Z'))[0];
  assert.equal(morning.state, 'opened');
  assert.equal(morning.openedAt, '09:42');
  assert.equal(morning.late, true, '09:42 is more than 30 minutes after 09:00');
});

test('a brief bump below the minimum open time is ignored', async () => {
  const tracker = new IntakeTracker(UTC_SCHEDULE, new HistoryStore(), { minOpenMs: 2000 });
  for (const [open, time] of [[false, '08:00:00.0'], [false, '08:00:00.2'], [true, '08:00:01.0'], [true, '08:00:01.2'], [false, '08:00:02.0'], [false, '08:00:02.2'], [false, '08:00:05.0']] as const) {
    await tracker.observe(open, at(`2026-10-20T${time}Z`));
  }
  assert.equal(state(tracker, '2026-10-20T08:01:00Z'), 'pending');
});

test('an opening outside every window is not attributed', async () => {
  const history = new HistoryStore();
  const tracker = new IntakeTracker(UTC_SCHEDULE, history, { minOpenMs: 0 });
  for (const t of ['13:00:00.0', '13:00:00.2', '13:00:00.4']) await tracker.observe(true, at(`2026-10-20T${t}Z`));
  assert.equal(history.all().length, 0);
});

test('only the first opening of a window is recorded', async () => {
  const history = new HistoryStore();
  const tracker = new IntakeTracker(UTC_SCHEDULE, history, { minOpenMs: 0 });
  const cycle = async (minute: string) => {
    for (const [open, s] of [[true, '00'], [true, '01'], [true, '02'], [false, '03'], [false, '04']] as const) await tracker.observe(open, at(`2026-10-20T08:${minute}:${s}Z`));
  };
  await cycle('10'); await cycle('20');
  assert.equal(history.find('2026-10-20', 'morning', 'opened').length, 1);
});

test('a failed reading during a window turns a missed dose into unknown', async () => {
  const history = new HistoryStore();
  const tracker = new IntakeTracker(UTC_SCHEDULE, history);
  await watchClosed(tracker, '2026-10-20T06:59:00Z', '2026-10-20T07:59:55Z');
  await tracker.observe(null, at('2026-10-20T08:00:00Z'), 'unplugged');
  await tracker.observe(null, at('2026-10-20T08:00:01Z'), 'unplugged');
  assert.equal(history.find('2026-10-20', 'morning', 'interrupted').length, 1, 'recorded once');
  await watchClosed(tracker, '2026-10-20T08:00:05Z', '2026-10-20T11:00:05Z');
  const morning = tracker.statusFor('2026-10-20', at('2026-10-20T11:30:00Z'))[0];
  assert.equal(morning.state, 'unknown');
  assert.equal(morning.trackingInterrupted, true);
});

test('local time honours the schedule time zone, including daylight saving time', () => {
  assert.deepEqual(localTime(at('2026-07-01T07:30:00Z'), 'Europe/Paris'), { date: '2026-07-01', minutes: 570, clock: '09:30' });
  assert.deepEqual(localTime(at('2026-12-01T07:30:00Z'), 'Europe/Paris'), { date: '2026-12-01', minutes: 510, clock: '08:30' });
  assert.equal(localTime(at('2026-10-20T23:30:00Z'), 'Europe/Paris').date, '2026-10-21');
});

test('previous dates cross month boundaries', () => {
  assert.deepEqual(previousDates('2026-03-01', 3), ['2026-03-01', '2026-02-28', '2026-02-27']);
});

test('the schedule rejects inverted and overlapping windows and unknown time zones', () => {
  const slot = (id: string, opens: string, due: string, closes: string) => ({ id, label: id, opens, due, closes });
  assert.throws(() => parseSchedule({ timeZone: 'UTC', slots: [slot('a', '10:00', '09:00', '11:00')] }));
  assert.throws(() => parseSchedule({ timeZone: 'UTC', slots: [slot('a', '07:00', '08:00', '10:00'), slot('b', '09:00', '09:30', '12:00')] }));
  assert.throws(() => parseSchedule({ timeZone: 'Mars/Olympus', slots: [slot('a', '07:00', '08:00', '10:00')] }));
});
