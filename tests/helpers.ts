import { createServer, request, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { ArtoDevice, AvrTransport } from 'arto-mcp';
import { HistoryStore } from '../src/history.js';
import { createMcpHttpHandler } from '../src/http.js';
import { createPillboxServer, type Role } from '../src/mcp.js';
import { Pillbox } from '../src/pillbox.js';
import { parseSchedule, type Schedule } from '../src/schedule.js';

/** Schedule in UTC so tests do not depend on daylight saving time. */
export const UTC_SCHEDULE: Schedule = parseSchedule({
  timeZone: 'UTC', lateAfterMinutes: 30,
  slots: [
    { id: 'morning', label: 'Morning pills', opens: '07:00', due: '09:00', closes: '11:00' },
    { id: 'evening', label: 'Evening pills', opens: '19:00', due: '20:00', closes: '22:00' },
  ],
});

export const TOKENS: Record<Role, string> = { alexa: 'a'.repeat(64), agent: 'b'.repeat(64) };

/** A mutable clock for deterministic tests. */
export class TestClock {
  constructor(public current: Date) {}
  now = () => this.current;
  set(iso: string) { this.current = new Date(iso); }
  advance(ms: number) { this.current = new Date(this.current.getTime() + ms); }
}

/**
 * Starts an emulated pillbox with its MCP endpoint on an ephemeral port.
 *
 * Args:
 *   clock: Clock used by the pillbox.
 *
 * Returns:
 *   The device, transport, pillbox, server URL and a close function.
 */
export async function startPillbox(clock: TestClock) {
  const manifest = JSON.parse(await readFile(new URL('../board.json', import.meta.url), 'utf8'));
  const transport = new AvrTransport();
  const device = new ArtoDevice(manifest, transport);
  await device.connect();
  const pillbox = new Pillbox(device, UTC_SCHEDULE, new HistoryStore(), { now: clock.now, minOpenMs: 2000 });
  const lidPin = 2;
  const setLid = (open: boolean) => transport.setInput(lidPin, open === (pillbox.lidOpenValue === 1));
  setLid(false);
  let port = 0;
  // The allowed Host values depend on the ephemeral port, so the handler is built lazily.
  let handler: ReturnType<typeof createMcpHttpHandler<Role>> | undefined;
  const server: Server = createServer((req, res) => {
    handler ??= createMcpHttpHandler({
      tokens: TOKENS, allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`], allowedOrigins: ['https://allowed.example'],
      createServer: role => createPillboxServer(pillbox, role),
    });
    void handler(req, res);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
  /** Reads the lid twice (debounce) at the current clock time. */
  const settle = async () => { await new Promise(r => setTimeout(r, 30)); await pillbox.poll(); await pillbox.poll(); };
  return {
    device, transport, pillbox, setLid, settle, port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => { await pillbox.stop(); server.close(); await device.close(); },
  };
}

/** Raw HTTP response used by protocol-level assertions. */
export interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/**
 * Sends a raw HTTP request, allowing headers such as Host that fetch forbids.
 *
 * Args:
 *   port: Server port on 127.0.0.1.
 *   method: HTTP method.
 *   headers: Request headers.
 *   body: Optional request body.
 *   path: Request path; defaults to `/mcp`.
 *
 * Returns:
 *   Status, headers and body text.
 */
export function raw(port: number, method: string, headers: Record<string, string>, body?: string, path = '/mcp'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Headers a compliant Streamable HTTP client sends with a POST. */
export const MCP_POST_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** A JSON-RPC `initialize` request body. */
export function initializeBody(protocolVersion = '2025-11-25', id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'conformance-test', version: '1.0.0' } } });
}
