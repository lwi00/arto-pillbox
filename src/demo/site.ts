import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeviceTransport } from 'arto-mcp';
import type { ToolCallEntry } from '../mcp.js';
import { COMPONENTS, type Pillbox } from '../pillbox.js';
import { localTime, toMinutes } from '../schedule.js';
import type { ChatTurn, PillboxAssistant } from './assistant.js';

/**
 * Wall clock with an adjustable offset, so the demo can jump to a scenario time.
 */
export class DemoClock {
  private offsetMs = 0;

  /** Current demo time. */
  now = (): Date => new Date(Date.now() + this.offsetMs);

  /**
   * Moves the clock so that the local time in `timeZone` reads `clock` today.
   *
   * Args:
   *   clock: Target local time `HH:MM`.
   *   timeZone: IANA time zone of the schedule.
   */
  jumpTo(clock: string, timeZone: string): void {
    const current = localTime(this.now(), timeZone);
    const seconds = this.now().getUTCSeconds() * 1000 + this.now().getUTCMilliseconds();
    this.offsetMs += (toMinutes(clock) - current.minutes) * 60_000 - seconds;
  }

  /** Returns to real time. */
  reset(): void { this.offsetMs = 0; }

  /** Whether the clock is shifted from real time. */
  get shifted(): boolean { return this.offsetMs !== 0; }
}

/** Dependencies of {@link createDemoHandler}. */
export interface DemoSiteOptions {
  pillbox: Pillbox;
  /** Emulated transport, used to move the virtual lid. */
  transport: DeviceTransport;
  clock: DemoClock;
  /** Chat assistant, or `undefined` when no model is configured. */
  assistant?: PillboxAssistant;
  /** Recent MCP tool calls, newest last. */
  activity: ToolCallEntry[];
  /** Model name shown on the page. */
  modelName?: string;
}

const PAGE = new URL('../../public/index.html', import.meta.url);
const MAX_BODY = 8 * 1024;
const CHAT_LIMIT_PER_MINUTE = 12;

/**
 * Creates the request handler of the public demo site.
 *
 * Routes:
 *   `GET /`: the demo page.
 *   `GET /api/state`: pillbox, outputs, schedule and recent MCP activity.
 *   `POST /api/lid` `{ open: boolean }`: open or close the emulated lid.
 *   `POST /api/scenario` `{ time: "HH:MM" | null }`: jump the clock and reset the day; null returns to real time.
 *   `POST /api/chat` `{ message, history }`: ask the simulated assistant.
 *
 * Args:
 *   options: Pillbox, emulator, clock, assistant and activity log.
 *
 * Returns:
 *   A handler that answers demo routes and returns `false` for any other path.
 */
export function createDemoHandler(options: DemoSiteOptions) {
  const { pillbox, transport, clock, assistant, activity } = options;
  const lidPin = pillbox.device.manifest.components.find(c => c.id === COMPONENTS.lid)!.pin;
  const chatTimes: number[] = [];
  let page: string | undefined;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw new Error('Body too large'); chunks.push(chunk as Buffer); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a JSON object');
    return value;
  };
  const state = () => {
    const values = pillbox.device.values;
    return {
      status: pillbox.status(),
      health: pillbox.health(),
      outputs: { reminderLed: values[COMPONENTS.led]?.value ?? 0, buzzer: values[COMPONENTS.buzzer]?.value ?? 0 },
      clockShifted: clock.shifted,
      schedule: pillbox.schedule,
      activity: activity.slice(-15).reverse(),
      assistant: assistant ? { available: true, model: options.modelName ?? assistant.model.model } : { available: false },
    };
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        page ??= await readFile(PAGE, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page);
        return true;
      }
      if (req.method === 'GET' && path === '/api/state') { json(res, 200, state()); return true; }
      if (req.method === 'POST' && path === '/api/lid') {
        const { open } = await readJson(req);
        if (typeof open !== 'boolean') { json(res, 400, { error: 'open must be a boolean' }); return true; }
        transport.setInput?.(lidPin, open === (pillbox.lidOpenValue === 1));
        json(res, 200, { open });
        return true;
      }
      if (req.method === 'POST' && path === '/api/scenario') {
        const { time } = await readJson(req);
        if (time !== null && (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) { json(res, 400, { error: 'time must be HH:MM or null' }); return true; }
        transport.setInput?.(lidPin, pillbox.lidOpenValue !== 1); // lid closed
        if (time === null) clock.reset(); else clock.jumpTo(time, pillbox.schedule.timeZone);
        await pillbox.resetState();
        activity.length = 0;
        json(res, 200, state());
        return true;
      }
      if (req.method === 'POST' && path === '/api/chat') {
        if (!assistant) { json(res, 503, { error: 'No chat model is configured on this server.' }); return true; }
        const now = Date.now();
        while (chatTimes.length && now - chatTimes[0] > 60_000) chatTimes.shift();
        if (chatTimes.length >= CHAT_LIMIT_PER_MINUTE) { json(res, 429, { error: 'The demo is busy; try again in a minute.' }); return true; }
        chatTimes.push(now);
        const { message, history } = await readJson(req);
        if (typeof message !== 'string' || !message.trim() || message.length > 500) { json(res, 400, { error: 'message must be 1 to 500 characters' }); return true; }
        const turns: ChatTurn[] = Array.isArray(history)
          ? history.slice(-8).filter((t): t is ChatTurn => (t?.role === 'user' || t?.role === 'assistant') && typeof t?.content === 'string')
            .map(t => ({ role: t.role, content: t.content.slice(0, 500) }))
          : [];
        json(res, 200, await assistant.ask(message.trim(), turns));
        return true;
      }
      return false;
    } catch (error) {
      if (!res.headersSent) json(res, 502, { error: (error as Error).message });
      return true;
    }
  };
}
