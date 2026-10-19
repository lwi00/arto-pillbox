import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Pillbox } from './pillbox.js';
import type { SlotStatus } from './tracker.js';

/** MCP client roles. Each role authenticates with its own bearer token. */
export const ROLES = ['alexa', 'agent'] as const;
export type Role = (typeof ROLES)[number];

/** One tool invocation, reported to {@link PillboxServerOptions.onToolCall}. */
export interface ToolCallEntry {
  at: string;
  role: Role;
  tool: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  /** The result's `summary`, or the error message. */
  summary: string;
}

/** Options for {@link createPillboxServer}. */
export interface PillboxServerOptions {
  /** Called after every tool invocation, for activity logs and the demo page. */
  onToolCall?: (entry: ToolCallEntry) => void;
}

/** Server identity reported in the MCP `initialize` result. */
export const SERVER_INFO = { name: 'arto-pillbox', title: 'Arto Pillbox', version: '0.1.0' } as const;

const INSTRUCTIONS = `This server is a connected pillbox for one person, built on an Arduino.
It reports whether the pillbox LID WAS OPENED during each dose window and can play a short reminder (light and buzzer).
An opened lid does not prove the medication was swallowed: say "the pillbox was opened", never "the medication was taken".
Call get_intake_status before answering questions about today. Use each result's "summary" field for spoken answers.
Only call trigger_reminder when the user asks for a reminder and the dose is pending or overdue.
This is not a medical device.`;

const slotStatusSchema = z.object({
  slot: z.string(), label: z.string(), date: z.string(),
  window: z.object({ opens: z.string(), due: z.string(), closes: z.string() }),
  state: z.enum(['upcoming', 'pending', 'overdue', 'opened', 'missed', 'unknown']),
  openedAt: z.string().optional(), late: z.boolean().optional(),
  trackingInterrupted: z.boolean(), reminders: z.number().int(),
});

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * Describes one slot in a short sentence suitable for speech.
 *
 * Args:
 *   s: Computed slot status.
 *
 * Returns:
 *   A sentence such as "Morning pills: the pillbox was opened at 09:42."
 */
export function describeSlot(s: SlotStatus): string {
  switch (s.state) {
    case 'opened': return `${s.label}: the pillbox was opened at ${s.openedAt}${s.late ? ', later than planned' : ''}.`;
    case 'pending': return `${s.label}: not opened yet; due at ${s.window.due}.`;
    case 'overdue': return `${s.label}: not opened yet; it was due at ${s.window.due} and the window closes at ${s.window.closes}.`;
    case 'missed': return `${s.label}: the pillbox was not opened between ${s.window.opens} and ${s.window.closes}.`;
    case 'unknown': return `${s.label}: unknown, because the pillbox was not monitored for the whole window.`;
    default: return `${s.label}: not due yet; the window opens at ${s.window.opens}.`;
  }
}

function result<T extends Record<string, unknown>>(value: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

function failure(error: unknown) {
  return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
}

/**
 * Builds an MCP server exposing task-level pillbox tools.
 *
 * Raw pin access (`set_component`) is deliberately not exposed: clients can only
 * perform the bounded actions implemented by {@link Pillbox}.
 *
 * Args:
 *   pillbox: The running pillbox service.
 *   role: Authenticated client role. It is recorded with reminders and selects
 *     the tool set.
 *   options: Optional hooks.
 *
 * Returns:
 *   A configured `McpServer`, not yet connected to a transport.
 */
export function createPillboxServer(pillbox: Pillbox, role: Role, options: PillboxServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  // Same signature as server.registerTool, with every result reported to onToolCall.
  // A tool without inputSchema receives the request context instead of arguments.
  type Result = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  const register = (name: string, config: object, handler: (args: Record<string, unknown>) => Promise<Result>) =>
    (server.registerTool as (n: string, c: object, h: (args: Record<string, unknown>) => Promise<Result>) => unknown)(name, config, async (args = {}) => {
      const outcome = await handler(args);
      options.onToolCall?.({
        at: new Date().toISOString(), role, tool: name, arguments: 'inputSchema' in config ? args : {}, isError: Boolean(outcome.isError),
        summary: String(outcome.structuredContent?.summary ?? outcome.content[0]?.text ?? ''),
      });
      return outcome;
    });
  const slotIds = pillbox.schedule.slots.map(s => s.id) as [string, ...string[]];

  register('get_intake_status', {
    title: 'Pillbox status',
    description: 'Report whether the pillbox lid was opened during each dose window today (or on a given date), what is still due, and whether a reminder is playing. An opening does not prove the medication was taken.',
    inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Local date YYYY-MM-DD. Defaults to today.') },
    outputSchema: {
      summary: z.string(), date: z.string(), localTime: z.string(), timeZone: z.string(),
      lidOpen: z.boolean().nullable(),
      reminderActive: z.object({ slot: z.string(), endsAt: z.string() }).nullable(),
      slots: z.array(slotStatusSchema),
      device: z.object({ status: z.string(), transport: z.string() }),
    },
    annotations: readOnly,
  }, async args => {
    const { date } = args as { date?: string };
    try {
      const status = pillbox.status(date);
      const offline = status.device.status === 'ready' ? '' : ' Warning: the pillbox is currently not connected.';
      return result({ summary: status.slots.map(describeSlot).join(' ') + offline, ...status });
    } catch (error) { return failure(error); }
  });

  register('get_intake_history', {
    title: 'Pillbox history',
    description: 'Summarize the last days of dose windows: when the pillbox was opened, missed windows and windows that could not be tracked.',
    inputSchema: { days: z.number().int().min(1).max(14).default(7).describe('Number of days including today.') },
    outputSchema: {
      summary: z.string(),
      days: z.array(z.object({ date: z.string(), slots: z.array(slotStatusSchema) })),
      totals: z.object({ opened: z.number().int(), missed: z.number().int(), unknown: z.number().int() }),
    },
    annotations: readOnly,
  }, async args => {
    const { days } = args as { days: number };
    try {
      const history = pillbox.historyFor(days);
      const { opened, missed, unknown } = history.totals;
      const summary = `Over the last ${days} day${days > 1 ? 's' : ''}: ${opened} dose window${opened === 1 ? '' : 's'} with the pillbox opened, ${missed} missed${unknown ? `, ${unknown} not tracked` : ''}.`;
      return result({ summary, ...history });
    } catch (error) { return failure(error); }
  });

  register('trigger_reminder', {
    title: 'Play a reminder',
    description: 'Turn on the pillbox light and buzzer for a few seconds to remind the person to take a dose. Only allowed while the dose is pending or overdue; it stops by itself, when the lid opens, or with stop_reminder.',
    inputSchema: {
      slot: z.enum(slotIds).describe('Dose window to remind about.'),
      seconds: z.number().int().min(5).max(60).default(20).describe('Duration in seconds.'),
    },
    outputSchema: { summary: z.string(), slot: z.string(), endsAt: z.string(), outputs: z.object({ reminder_led: z.number().optional(), buzzer: z.number().optional() }) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async args => {
    const { slot, seconds } = args as { slot: string; seconds: number };
    try {
      const started = await pillbox.triggerReminder(slot, seconds, role);
      return result({ summary: `The reminder is playing for ${seconds} seconds.`, ...started });
    } catch (error) { return failure(error); }
  });

  register('stop_reminder', {
    title: 'Stop the reminder',
    description: 'Turn off the pillbox light and buzzer immediately.',
    outputSchema: { summary: z.string(), stopped: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const { stopped } = await pillbox.stopReminder(`requested by ${role}`);
      return result({ summary: stopped ? 'The reminder was stopped.' : 'No reminder was playing; the light and buzzer are off.', stopped });
    } catch (error) { return failure(error); }
  });

  register('get_device_health', {
    title: 'Pillbox connection',
    description: 'Check whether the pillbox hardware is connected, whether it is emulated, and when each sensor was last read.',
    outputSchema: {
      summary: z.string(), status: z.string(), transport: z.string(), emulated: z.boolean(), polling: z.boolean(),
      lidOpen: z.boolean().nullable(),
      observations: z.record(z.string(), z.object({ value: z.number(), observedAt: z.string(), source: z.string() })),
    },
    annotations: readOnly,
  }, async () => {
    try {
      const health = pillbox.health();
      const summary = health.status === 'ready' ? `The pillbox is connected${health.emulated ? ' (emulated board)' : ''}.` : `The pillbox is ${health.status}.`;
      return result({ summary, ...health });
    } catch (error) { return failure(error); }
  });

  return server;
}
