import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A qualifying lid opening attributed to a dose window. */
export interface OpenedRecord { type: 'opened'; date: string; slot: string; at: string; late: boolean }
/** Tracking was impossible for part of a dose window (device not ready or read failed). */
export interface InterruptedRecord { type: 'interrupted'; date: string; slot: string; at: string; reason: string }
/** The lid was observed without gaps from before the window opened until it closed. */
export interface CoveredRecord { type: 'covered'; date: string; slot: string; at: string }
/** A reminder was started on the LED and buzzer. */
export interface ReminderRecord { type: 'reminder'; date: string; slot: string; at: string; seconds: number; requestedBy: string }

export type HistoryRecord = OpenedRecord | InterruptedRecord | CoveredRecord | ReminderRecord;

/**
 * Append-only intake history, kept in memory and optionally mirrored to a JSONL file.
 *
 * The file is the only persistence. Lines that cannot be parsed are skipped on load,
 * so a truncated last line after a crash does not prevent startup.
 */
export class HistoryStore {
  private readonly items: HistoryRecord[] = [];

  /**
   * Creates a store.
   *
   * Args:
   *   path: JSONL file to load from and append to. `undefined` keeps history in memory only.
   */
  constructor(readonly path?: string) {}

  /**
   * Loads existing records from the JSONL file, if any.
   *
   * Returns:
   *   The number of records loaded.
   */
  async load(): Promise<number> {
    if (!this.path) return 0;
    let text = '';
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as HistoryRecord;
        if (['opened', 'interrupted', 'covered', 'reminder'].includes(record.type)) this.items.push(record);
      } catch { /* skip a corrupt line */ }
    }
    return this.items.length;
  }

  /**
   * Appends a record in memory and to the file.
   *
   * Args:
   *   record: The record to store.
   *
   * Returns:
   *   A promise that settles once the line is written. Write failures are reported
   *   to the caller but the in-memory record is kept.
   */
  async add(record: HistoryRecord): Promise<void> {
    this.items.push(record);
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`);
  }

  /**
   * Returns records matching a date and, optionally, a slot and type.
   *
   * Args:
   *   date: Local date `YYYY-MM-DD`.
   *   slot: Optional slot identifier.
   *   type: Optional record type.
   *
   * Returns:
   *   Matching records in insertion order.
   */
  find<T extends HistoryRecord['type']>(date: string, slot?: string, type?: T): Extract<HistoryRecord, { type: T }>[] {
    return this.items.filter(r => r.date === date && (slot === undefined || r.slot === slot) && (type === undefined || r.type === type)) as Extract<HistoryRecord, { type: T }>[];
  }

  /** All records in insertion order. */
  all(): readonly HistoryRecord[] { return this.items; }
}
