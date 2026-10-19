#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ArtoDevice, AvrTransport, SerialTransport } from 'arto-mcp';
import { HistoryStore } from './history.js';
import { createMcpHttpHandler, deriveToken, MCP_PATH } from './http.js';
import { createPillboxServer, ROLES, type Role } from './mcp.js';
import { COMPONENTS, Pillbox } from './pillbox.js';
import { parseSchedule } from './schedule.js';

const USAGE = `arto-pillbox

  arto-pillbox serve [options]     Start the MCP server (Streamable HTTP, spec 2025-11-25)
  arto-pillbox tokens              Print the bearer token of each client role

Options:
  --manifest <file>        Board manifest (default: board.json)
  --schedule <file>        Dose schedule (default: schedule.json)
  --history <file>         Intake history JSONL (default: .arto/pillbox-history.jsonl)
  --serial <device>        Physical Uno serial device; omit to use the AVR8js emulator
  --listen <port>          HTTP port (default: 8080)
  --bind <address>         Interface to bind (default: 127.0.0.1)
  --allowed-host <host>    Extra accepted Host header, e.g. a tunnel hostname (repeatable)
  --allowed-origin <url>   Accepted Origin header for browser clients (repeatable)

Environment:
  PILLBOX_MASTER_TOKEN     Required. Secret from which role tokens are derived.`;

/**
 * Parses command-line options.
 *
 * Args:
 *   argv: Arguments after the subcommand.
 *
 * Returns:
 *   A lookup for single-valued flags and a lookup for repeatable flags.
 */
function parseFlags(argv: string[]) {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
    values.set(argv[i], [...(values.get(argv[i]) ?? []), value]); i++;
  }
  return { one: (name: string) => values.get(name)?.at(-1), all: (name: string) => values.get(name) ?? [] };
}

function masterToken(): string {
  const master = process.env.PILLBOX_MASTER_TOKEN ?? '';
  if (master.length < 32) throw new Error('Set PILLBOX_MASTER_TOKEN to a secret of at least 32 characters (see .env.example)');
  return master;
}

/**
 * Starts the pillbox service and its HTTP endpoint.
 *
 * Args:
 *   argv: Options after `serve`.
 *
 * Returns:
 *   A promise that settles once the server listens.
 */
async function serve(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const master = masterToken();
  const port = Number(flags.one('--listen') ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--listen must be a TCP port');
  const bind = flags.one('--bind') ?? '127.0.0.1';
  const manifest = JSON.parse(await readFile(resolve(flags.one('--manifest') ?? 'board.json'), 'utf8'));
  const schedule = parseSchedule(JSON.parse(await readFile(resolve(flags.one('--schedule') ?? 'schedule.json'), 'utf8')));
  const history = new HistoryStore(resolve(flags.one('--history') ?? '.arto/pillbox-history.jsonl'));
  await history.load();

  const serial = flags.one('--serial');
  const transport = serial ? new SerialTransport(serial) : new AvrTransport();
  const device = new ArtoDevice(manifest, transport);
  await device.connect();
  const pillbox = new Pillbox(device, schedule, history);
  const lidPin = device.manifest.components.find(c => c.id === COMPONENTS.lid)!.pin;
  if (!serial) transport.setInput?.(lidPin, pillbox.lidOpenValue !== 1); // emulated lid starts closed
  pillbox.start();

  const tokens = Object.fromEntries(ROLES.map(role => [role, deriveToken(master, role)])) as Record<Role, string>;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...flags.all('--allowed-host')];
  const handler = createMcpHttpHandler({
    tokens, allowedHosts, allowedOrigins: flags.all('--allowed-origin'),
    createServer: role => createPillboxServer(pillbox, role),
    onRequest: ({ role, status, method }) => process.stderr.write(`${new Date().toISOString()} ${method} ${MCP_PATH} ${status} ${role ?? '-'}\n`),
  });
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(device.status === 'ready' ? 200 : 503).end(); return; }
    void handler(req, res);
  });
  await new Promise<void>(done => http.listen(port, bind, done));
  process.stderr.write(`Arto Pillbox ready on http://${bind}:${port}${MCP_PATH} (${serial ? `serial ${serial}` : 'emulated Uno'})\n`);

  if (!serial && process.stdin.isTTY) {
    process.stderr.write('Emulator controls: type "o" + Enter to open the lid, "c" + Enter to close it.\n');
    createInterface({ input: process.stdin }).on('line', line => {
      const open = line.trim() === 'o' ? true : line.trim() === 'c' ? false : undefined;
      if (open === undefined) return;
      transport.setInput?.(lidPin, open === (pillbox.lidOpenValue === 1));
      process.stderr.write(`Emulated lid ${open ? 'opened' : 'closed'}\n`);
    });
  }

  const close = async () => { http.close(); await pillbox.stop(); await device.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'serve') await serve(rest);
  else if (command === 'tokens') {
    const master = masterToken();
    for (const role of ROLES) console.log(`${role}\t${deriveToken(master, role)}`);
  } else console.log(USAGE);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
