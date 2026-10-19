import type { ArtoDevice } from 'arto-mcp';
import { HistoryStore } from './history.js';
import { localTime, previousDates, type Schedule } from './schedule.js';
import { IntakeTracker, type SlotStatus } from './tracker.js';

/** Component identifiers the pillbox expects in its manifest. */
export const COMPONENTS = { lid: 'lid', led: 'reminder_led', buzzer: 'buzzer' } as const;

/** Runtime options for {@link Pillbox}. */
export interface PillboxOptions {
  /** Lid polling period in milliseconds. Defaults to 250. */
  pollMs?: number;
  /** Minimum continuous open time for an opening to count. Defaults to 2000. */
  minOpenMs?: number;
  /** Minimum time between two reminders for the same slot, in seconds. Defaults to 300. */
  reminderCooldownSeconds?: number;
  /** Clock, injectable for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Summary returned by {@link Pillbox.status}. */
export interface IntakeStatus {
  date: string;
  localTime: string;
  timeZone: string;
  lidOpen: boolean | null;
  reminderActive: { slot: string; endsAt: string } | null;
  slots: SlotStatus[];
  device: { status: string; transport: string };
}

/**
 * Domain service that connects an Arto device to the intake tracker and reminders.
 *
 * It owns the polling loop, enforces reminder limits and is the only component that
 * writes outputs. MCP tools call this class; they never call the device directly.
 */
export class Pillbox {
  readonly tracker: IntakeTracker;
  /** Lid reading that means "open", derived from the manifest interlock. */
  readonly lidOpenValue: 0 | 1;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly cooldownMs: number;
  private poller?: NodeJS.Timeout;
  private polling = false;
  private reminder?: { slot: string; endsAt: Date; timer: NodeJS.Timeout };

  /**
   * Creates a pillbox service. Call {@link Pillbox.start} to begin polling.
   *
   * Args:
   *   device: A connected Arto device whose manifest declares `lid`, `reminder_led`
   *     and `buzzer`.
   *   schedule: Validated dose schedule.
   *   history: Intake history store, already loaded.
   *   options: Runtime options.
   *
   * Throws:
   *   Error: If a required component is missing or has the wrong kind.
   */
  constructor(readonly device: ArtoDevice, readonly schedule: Schedule, readonly history: HistoryStore, options: PillboxOptions = {}) {
    const kinds = { [COMPONENTS.lid]: 'digital-input', [COMPONENTS.led]: 'digital-output', [COMPONENTS.buzzer]: 'digital-output' };
    for (const [id, kind] of Object.entries(kinds)) {
      const component = device.manifest.components.find(c => c.id === id);
      if (component?.kind !== kind) throw new Error(`Manifest must declare ${id} as ${kind}`);
    }
    const interlock = device.manifest.interlocks.find(rule => rule.input === COMPONENTS.lid && rule.output === COMPONENTS.buzzer);
    this.lidOpenValue = interlock?.blockedValue ?? 1;
    this.now = options.now ?? (() => new Date());
    this.pollMs = options.pollMs ?? 250;
    this.cooldownMs = (options.reminderCooldownSeconds ?? 300) * 1000;
    this.tracker = new IntakeTracker(schedule, history, { minOpenMs: options.minOpenMs });
    this.tracker.on('lid', (open: boolean) => { if (open) void this.stopReminder('lid opened'); });
  }

  /** Starts the lid polling loop. */
  start(): void {
    if (this.poller) return;
    this.poller = setInterval(() => { void this.poll(); }, this.pollMs);
    this.poller.unref();
  }

  /**
   * Stops polling and any active reminder.
   *
   * Returns:
   *   A promise that settles once outputs are cleared or the attempt failed.
   */
  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    await this.stopReminder('service stopping');
  }

  /**
   * Reads the lid once and feeds the tracker. Exposed for tests; the loop calls it.
   *
   * Returns:
   *   A promise that settles after the reading has been processed.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (this.device.status !== 'ready') { await this.tracker.observe(null, this.now(), `device ${this.device.status}`); return; }
      const reading = await this.device.read(COMPONENTS.lid);
      await this.tracker.observe(reading.value === this.lidOpenValue, this.now());
    } catch (error) {
      await this.tracker.observe(null, this.now(), (error as Error).message);
    } finally { this.polling = false; }
  }

  /**
   * Reports today's dose windows, or those of another date.
   *
   * Args:
   *   date: Optional local date `YYYY-MM-DD`. Defaults to today in the schedule's time zone.
   *
   * Returns:
   *   Per-slot statuses plus lid, reminder and device state.
   */
  status(date?: string): IntakeStatus {
    const now = this.now();
    const local = localTime(now, this.schedule.timeZone);
    const snapshot = this.device.snapshot();
    return {
      date: date ?? local.date,
      localTime: local.clock,
      timeZone: this.schedule.timeZone,
      lidOpen: this.tracker.lidOpen ?? null,
      reminderActive: this.reminder ? { slot: this.reminder.slot, endsAt: this.reminder.endsAt.toISOString() } : null,
      slots: this.tracker.statusFor(date ?? local.date, now),
      device: { status: snapshot.status, transport: snapshot.transport },
    };
  }

  /**
   * Reports the last `days` days of dose windows, most recent first.
   *
   * Args:
   *   days: Number of days including today, from 1 to 14.
   *
   * Returns:
   *   Per-day statuses and counts of opened, missed and unknown windows. Windows that
   *   have not closed yet are excluded from the counts.
   */
  historyFor(days: number) {
    const now = this.now();
    const dates = previousDates(localTime(now, this.schedule.timeZone).date, days);
    const daysOut = dates.map(date => ({ date, slots: this.tracker.statusFor(date, now) }));
    const states = daysOut.flatMap(day => day.slots.map(s => s.state));
    const count = (state: string) => states.filter(s => s === state).length;
    return { days: daysOut, totals: { opened: count('opened'), missed: count('missed'), unknown: count('unknown') } };
  }

  /**
   * Starts a bounded reminder: LED on and buzzer on, for `seconds`.
   *
   * The reminder stops when its time elapses, when the lid opens, or on
   * {@link Pillbox.stopReminder}. The firmware interlock also silences the buzzer
   * on its own as soon as the lid opens.
   *
   * Args:
   *   slot: Slot identifier. Its state must be `pending` or `overdue`.
   *   seconds: Duration, from 5 to 60.
   *   requestedBy: MCP client role, recorded in history.
   *
   * Returns:
   *   The slot, the end time and the firmware-acknowledged output values.
   *
   * Throws:
   *   Error: If the slot is unknown or not due, a reminder is already active, the
   *     slot's cooldown has not elapsed, the lid is open, or the device is not ready.
   */
  async triggerReminder(slot: string, seconds: number, requestedBy: string) {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) throw new Error('seconds must be an integer from 5 to 60');
    const current = this.status().slots.find(s => s.slot === slot);
    if (!current) throw new Error(`Unknown slot ${slot}`);
    if (!['pending', 'overdue'].includes(current.state)) throw new Error(`No reminder needed: ${current.label} is ${current.state}`);
    if (this.reminder) throw new Error(`A reminder is already playing for ${this.reminder.slot}`);
    if (this.tracker.lidOpen) throw new Error('The lid is already open');
    const now = this.now();
    const last = this.history.find(current.date, slot, 'reminder').at(-1);
    if (last && now.getTime() - Date.parse(last.at) < this.cooldownMs) {
      throw new Error(`A reminder was already played at ${localTime(new Date(last.at), this.schedule.timeZone).clock}; wait before repeating it`);
    }
    const endsAt = new Date(now.getTime() + seconds * 1000);
    const timer = setTimeout(() => { void this.stopReminder('elapsed'); }, seconds * 1000);
    timer.unref();
    this.reminder = { slot, endsAt, timer };
    try {
      const led = await this.device.write(COMPONENTS.led, 1);
      const buzzer = await this.device.write(COMPONENTS.buzzer, 1);
      await this.history.add({ type: 'reminder', date: current.date, slot, at: now.toISOString(), seconds, requestedBy });
      return { slot, endsAt: endsAt.toISOString(), outputs: { reminder_led: led.value, buzzer: buzzer.value } };
    } catch (error) {
      await this.stopReminder('start failed');
      throw error;
    }
  }

  /**
   * Turns the LED and buzzer off and cancels the reminder timer.
   *
   * Args:
   *   reason: Recorded in the device event log.
   *
   * Returns:
   *   Whether a reminder was active.
   */
  async stopReminder(reason = 'requested'): Promise<{ stopped: boolean }> {
    const active = this.reminder;
    if (active) clearTimeout(active.timer);
    this.reminder = undefined;
    if (this.device.status === 'ready') {
      await this.device.write(COMPONENTS.buzzer, 0).catch(() => {});
      await this.device.write(COMPONENTS.led, 0).catch(() => {});
    }
    if (active) this.device.record('reminder_stopped', { slot: active.slot, reason });
    return { stopped: Boolean(active) };
  }

  /**
   * Describes connection health and the freshness of observations.
   *
   * Returns:
   *   Device status, transport, polling state and last observation per component.
   */
  health() {
    const snapshot = this.device.snapshot();
    return {
      status: snapshot.status,
      transport: snapshot.transport,
      emulated: snapshot.transport === 'avr8js',
      polling: Boolean(this.poller),
      lidOpen: this.tracker.lidOpen ?? null,
      observations: snapshot.values,
    };
  }
}
