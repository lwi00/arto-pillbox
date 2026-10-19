import { EventEmitter } from 'node:events';
import type { HistoryStore, OpenedRecord } from './history.js';
import { localTime, slotAt, toMinutes, type DoseSlot, type Schedule } from './schedule.js';

/** Status of one dose window on one date. */
export type SlotState = 'upcoming' | 'pending' | 'overdue' | 'opened' | 'missed' | 'unknown';

/** Computed status of one dose window. */
export interface SlotStatus {
  slot: string;
  label: string;
  date: string;
  window: { opens: string; due: string; closes: string };
  state: SlotState;
  /** Local `HH:MM` of the qualifying opening, when `state` is `opened`. */
  openedAt?: string;
  /** Whether the opening happened more than `lateAfterMinutes` after `due`. */
  late?: boolean;
  /** Whether monitoring had a gap during this window, so an absence of opening cannot be asserted. */
  trackingInterrupted: boolean;
  /** Number of reminders played for this window. */
  reminders: number;
}

/** Tuning for lid observation. */
export interface TrackerOptions {
  /** Minimum continuous open time, in milliseconds, for an opening to count. Defaults to 2000. */
  minOpenMs?: number;
  /** Longest tolerated delay between two readings before monitoring counts as interrupted. Defaults to 10000. */
  maxGapMs?: number;
}

/**
 * Turns periodic lid readings into intake records and slot statuses.
 *
 * The tracker never talks to hardware. Callers feed it observations with
 * {@link IntakeTracker.observe}, which keeps it deterministic and testable with
 * an injected clock.
 *
 * A window is reported as `missed` only when the lid was monitored without gaps from
 * before the window opened until it closed (a `covered` record). Otherwise a window
 * without an opening is `unknown`: the service never claims an absence it did not observe.
 *
 * Events:
 *   `lid` (open: boolean, at: Date): The debounced lid state changed.
 *   `opened` (record: OpenedRecord): A qualifying opening was attributed to a slot.
 */
export class IntakeTracker extends EventEmitter {
  private lastRaw?: boolean;
  private stable?: boolean;
  private openSince?: Date;
  private counted = false;
  private lastValidAt?: Date;
  private readonly minOpenMs: number;
  private readonly maxGapMs: number;

  /**
   * Creates a tracker.
   *
   * Args:
   *   schedule: Validated dose schedule.
   *   history: Store that receives `opened`, `interrupted` and `covered` records.
   *   options: Observation tuning.
   */
  constructor(readonly schedule: Schedule, readonly history: HistoryStore, options: TrackerOptions = {}) {
    super();
    this.minOpenMs = options.minOpenMs ?? 2000;
    this.maxGapMs = options.maxGapMs ?? 10_000;
  }

  /**
   * Forgets the lid state and monitoring continuity, as after a restart.
   * Intended for demonstrations that move the clock.
   *
   * Args:
   *   monitoredSince: If given, treat the lid as monitored without gaps up to this
   *     time, so the window in progress is not marked as interrupted. Only the demo,
   *     whose whole day is simulated, should pass it.
   */
  reset(monitoredSince?: Date): void {
    this.lastRaw = undefined; this.stable = undefined; this.openSince = undefined; this.counted = false;
    this.lastValidAt = monitoredSince;
  }

  /** Debounced lid state: `true` open, `false` closed, `undefined` not yet known. */
  get lidOpen(): boolean | undefined { return this.stable; }

  /**
   * Feeds one lid reading.
   *
   * A reading must be seen twice in a row before the lid state changes (debounce).
   * An opening counts once it has stayed open for `minOpenMs`, and is attributed to
   * the dose window that contains the moment the lid opened, if that window has no
   * opening yet. Monitoring gaps (failed readings, a restart, or more than
   * `maxGapMs` between readings) inside a window mark it as interrupted.
   *
   * Args:
   *   open: `true` if the lid reads open, `false` if closed, `null` if the reading
   *     failed or the device is not ready.
   *   at: Time of the reading. Readings must be fed in chronological order.
   *   reason: Explanation recorded when `open` is `null`.
   *
   * Returns:
   *   A promise that settles once any resulting history record is stored.
   */
  async observe(open: boolean | null, at: Date, reason = 'device unavailable'): Promise<void> {
    if (open === null) {
      this.lastRaw = undefined; this.stable = undefined; this.openSince = undefined; this.counted = false;
      this.lastValidAt = undefined;
      await this.markInterrupted(at, reason);
      return;
    }
    await this.trackCoverage(at);
    const previous = this.lastRaw;
    this.lastRaw = open;
    if (previous !== open || this.stable === open) {
      if (this.stable === true && this.openSince && !this.counted && at.getTime() - this.openSince.getTime() >= this.minOpenMs) await this.count(this.openSince);
      return;
    }
    this.stable = open;
    this.emit('lid', open, at);
    if (open) { this.openSince = at; this.counted = false; } else { this.openSince = undefined; this.counted = false; }
  }

  /**
   * Computes the status of every slot on a local date.
   *
   * Args:
   *   date: Local date `YYYY-MM-DD`.
   *   now: Current time, used to place `date` in the past, present or future.
   *
   * Returns:
   *   One status per slot, in schedule order.
   */
  statusFor(date: string, now: Date): SlotStatus[] {
    const local = localTime(now, this.schedule.timeZone);
    return this.schedule.slots.map(slot => this.slotStatus(slot, date, local.date, local.minutes));
  }

  private slotStatus(slot: DoseSlot, date: string, today: string, minutes: number): SlotStatus {
    const opened = this.history.find(date, slot.id, 'opened')[0];
    const covered = this.history.find(date, slot.id, 'covered').length > 0;
    const interrupted = this.history.find(date, slot.id, 'interrupted').length > 0;
    const reminders = this.history.find(date, slot.id, 'reminder').length;
    const base = { slot: slot.id, label: slot.label, date, window: { opens: slot.opens, due: slot.due, closes: slot.closes }, reminders };
    if (opened) return { ...base, trackingInterrupted: interrupted, state: 'opened', openedAt: localTime(new Date(opened.at), this.schedule.timeZone).clock, late: opened.late };
    const past = date < today || (date === today && minutes >= toMinutes(slot.closes));
    if (past) return { ...base, trackingInterrupted: !covered, state: covered ? 'missed' : 'unknown' };
    if (date > today || minutes < toMinutes(slot.opens)) return { ...base, trackingInterrupted: false, state: 'upcoming' };
    return { ...base, trackingInterrupted: interrupted, state: minutes < toMinutes(slot.due) ? 'pending' : 'overdue' };
  }

  /**
   * Records gaps and completed windows from the time between two valid readings.
   *
   * Args:
   *   at: Time of the current valid reading.
   */
  private async trackCoverage(at: Date): Promise<void> {
    const previous = this.lastValidAt;
    this.lastValidAt = at;
    const now = localTime(at, this.schedule.timeZone);
    if (!previous) {
      // First reading after startup or after a failure: the window in progress was not watched from its start.
      await this.markInterrupted(at, 'monitoring started during the window');
      return;
    }
    const before = localTime(previous, this.schedule.timeZone);
    const gap = at.getTime() - previous.getTime() > this.maxGapMs;
    for (const slot of this.schedule.slots) {
      const [opens, closes] = [toMinutes(slot.opens), toMinutes(slot.closes)];
      // Windows on the previous reading's date, then on the current date if the day changed.
      for (const date of before.date === now.date ? [now.date] : [before.date, now.date]) {
        const start = date === before.date ? before.minutes : -1;
        const end = date === now.date ? now.minutes : 24 * 60;
        const overlaps = start < closes && end >= opens;
        if (gap && overlaps) await this.addInterruption(date, slot.id, at, 'monitoring gap');
        else if (start < closes && end >= closes) await this.addCovered(date, slot.id, at);
      }
    }
  }

  private async count(openedAt: Date): Promise<void> {
    this.counted = true;
    const local = localTime(openedAt, this.schedule.timeZone);
    const slot = slotAt(this.schedule, local.minutes);
    if (!slot || this.history.find(local.date, slot.id, 'opened').length > 0) return;
    const record: OpenedRecord = {
      type: 'opened', date: local.date, slot: slot.id, at: openedAt.toISOString(),
      late: local.minutes > toMinutes(slot.due) + this.schedule.lateAfterMinutes,
    };
    await this.history.add(record);
    this.emit('opened', record);
  }

  private async markInterrupted(at: Date, reason: string): Promise<void> {
    const local = localTime(at, this.schedule.timeZone);
    const slot = slotAt(this.schedule, local.minutes);
    if (slot) await this.addInterruption(local.date, slot.id, at, reason);
  }

  private async addInterruption(date: string, slot: string, at: Date, reason: string): Promise<void> {
    if (this.history.find(date, slot, 'interrupted').length > 0) return;
    await this.history.add({ type: 'interrupted', date, slot, at: at.toISOString(), reason });
  }

  /** Records that a window closed while monitored, unless an opening or a gap already decided it. */
  private async addCovered(date: string, slot: string, at: Date): Promise<void> {
    if (['opened', 'interrupted', 'covered'].some(type => this.history.find(date, slot, type as 'opened').length > 0)) return;
    await this.history.add({ type: 'covered', date, slot, at: at.toISOString() });
  }
}
