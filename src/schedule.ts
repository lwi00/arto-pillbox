import { z } from 'zod';

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');

/** Zod schema for one dose window. */
export const slotSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().min(1).max(60),
  opens: clockTime,
  due: clockTime,
  closes: clockTime,
});

/** Zod schema for `schedule.json`. */
export const scheduleSchema = z.object({
  timeZone: z.string().refine(isValidTimeZone, 'Unknown IANA time zone'),
  lateAfterMinutes: z.number().int().min(0).max(240).default(30),
  slots: z.array(slotSchema).min(1).max(4),
}).superRefine((schedule, ctx) => {
  const ids = new Set<string>();
  const windows: Array<[number, number]> = [];
  schedule.slots.forEach((slot, index) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['slots', index], message });
    if (ids.has(slot.id)) issue('Slot identifiers must be unique');
    ids.add(slot.id);
    const [opens, due, closes] = [slot.opens, slot.due, slot.closes].map(toMinutes);
    if (!(opens <= due && due < closes)) issue('Expected opens <= due < closes within one day');
    if (windows.some(([start, end]) => opens < end && start < closes)) issue('Dose windows must not overlap');
    windows.push([opens, closes]);
  });
});

export type DoseSlot = z.infer<typeof slotSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;

/** Local calendar date and minute of day in a given time zone. */
export interface LocalTime {
  /** Local date as `YYYY-MM-DD`. */
  date: string;
  /** Minutes since local midnight, from 0 to 1439. */
  minutes: number;
  /** Local time as `HH:MM`. */
  clock: string;
}

/**
 * Validates and normalizes a schedule document.
 *
 * Args:
 *   value: Parsed JSON content of `schedule.json`.
 *
 * Returns:
 *   The validated schedule with defaults applied.
 *
 * Throws:
 *   ZodError: If the document is malformed, a time zone is unknown, a window is
 *     inverted or two windows overlap.
 */
export function parseSchedule(value: unknown): Schedule {
  return scheduleSchema.parse(value);
}

/**
 * Converts `HH:MM` into minutes since midnight.
 *
 * Args:
 *   clock: A 24-hour time such as `"09:30"`.
 *
 * Returns:
 *   The number of minutes since midnight, for example `570`.
 */
export function toMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Expresses an instant in the schedule's local time.
 *
 * Args:
 *   instant: The instant to convert.
 *   timeZone: An IANA time zone such as `"Europe/Paris"`.
 *
 * Returns:
 *   The local date, minute of day and clock string.
 */
export function localTime(instant: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(part => [part.type, part.value]));
  const clock = `${parts.hour}:${parts.minute}`;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: toMinutes(clock), clock };
}

/**
 * Finds the dose window that contains a local minute.
 *
 * Args:
 *   schedule: The validated schedule.
 *   minutes: Minutes since local midnight.
 *
 * Returns:
 *   The slot whose `[opens, closes)` interval contains `minutes`, or `undefined`.
 */
export function slotAt(schedule: Schedule, minutes: number): DoseSlot | undefined {
  return schedule.slots.find(slot => toMinutes(slot.opens) <= minutes && minutes < toMinutes(slot.closes));
}

/**
 * Lists the local dates of the last `days` days, most recent first.
 *
 * Args:
 *   today: Local date `YYYY-MM-DD` to start from.
 *   days: Number of dates to return, including `today`.
 *
 * Returns:
 *   Dates in `YYYY-MM-DD` form.
 */
export function previousDates(today: string, days: number): string[] {
  const start = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: days }, (_, offset) => new Date(start - offset * 86_400_000).toISOString().slice(0, 10));
}

function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}
