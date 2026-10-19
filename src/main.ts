#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { ArtoDevice, AvrTransport, SerialTransport } from 'arto-mcp';
import { modelConfigFromEnv, PillboxAssistant } from './demo/assistant.js';
import { createDemoHandler, DemoClock } from './demo/site.js';
import { HistoryStore } from './history.js';
import { createMcpHttpHandler, deriveToken, MCP_PATH } from './http.js';
import { createPillboxServer, ROLES, type Role, type ToolCallEntry } from './mcp.js';
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
  --demo                   Serve the public demo site (emulator only): virtual pillbox,
                           scenario clock and a simulated Alexa+ chat

Environment:
  PILLBOX_MASTER_TOKEN     Secret from which role tokens are derived. Required, except
                           with --demo, where a random one is generated if it is unset
  PILLBOX_ALLOWED_HOSTS    Comma-separated extra Host values, like --allowed-host
  PORT                     Default for --listen
  PILLBOX_DEMO_START       Local time the demo clock starts at (default 09:45)
  OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
                           OpenAI-compatible chat model for the demo assistant`;

const BOOLEAN_FLAGS = ['--demo'];

/**
 * Parses command-line options.
 *
 * Args:
 *   argv: Arguments after the subcommand.
 *
 * Returns:
 *   Lookups for single-valued flags, repeatable flags and boolean switches.
 */
function parseFlags(argv: string[]) {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    if (BOOLEAN_FLAGS.includes(argv[i])) { switches.add(argv[i]); continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
    values.set(argv[i], [...(values.get(argv[i]) ?? []), value]); i++;
  }
  return { one: (name: string) => values.get(name)?.at(-1), all: (name: string) => values.get(name) ?? [], has: (name: string) => switches.has(name) };
}

/**
 * Reads the master secret.
 *
 * Args:
 *   generateIfMissing: Return a random secret instead of failing when the variable is unset.
 *
 * Returns:
 *   The secret.
 *
 * Throws:
 *   Error: If the variable is shorter than 32 characters and no fallback is allowed.
 */
function masterToken(generateIfMissing = false): string {
  const master = process.env.PILLBOX_MASTER_TOKEN ?? '';
  if (master.length >= 32) return master;
  if (generateIfMissing && !master) {
    process.stderr.write('PILLBOX_MASTER_TOKEN is not set: using a random secret. External MCP clients cannot authenticate until it is set.\n');
    return randomBytes(32).toString('hex');
  }
  throw new Error('Set PILLBOX_MASTER_TOKEN to a secret of at least 32 characters (see .env.example)');
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
  const demo = flags.has('--demo');
  const serial = flags.one('--serial');
  if (demo && serial) throw new Error('--demo drives an emulated board and cannot be combined with --serial');
  const master = masterToken(demo);
  const port = Number(flags.one('--listen') ?? process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--listen must be a TCP port');
  const bind = flags.one('--bind') ?? '127.0.0.1';
  const manifest = JSON.parse(await readFile(resolve(flags.one('--manifest') ?? 'board.json'), 'utf8'));
  const schedule = parseSchedule(JSON.parse(await readFile(resolve(flags.one('--schedule') ?? 'schedule.json'), 'utf8')));
  // The demo replays scenarios with a shifted clock, so its history stays in memory.
  const history = new HistoryStore(demo ? undefined : resolve(flags.one('--history') ?? '.arto/pillbox-history.jsonl'));
  await history.load();

  const transport = serial ? new SerialTransport(serial) : new AvrTransport();
  const device = new ArtoDevice(manifest, transport);
  await device.connect();
  const clock = new DemoClock();
  // A visitor sees the most telling scenario first: the morning dose is overdue.
  if (demo) clock.jumpTo(process.env.PILLBOX_DEMO_START ?? '09:45', schedule.timeZone);
  const pillbox = new Pillbox(device, schedule, history, demo ? { now: clock.now } : {});
  const lidPin = device.manifest.components.find(c => c.id === COMPONENTS.lid)!.pin;
  if (!serial) transport.setInput?.(lidPin, pillbox.lidOpenValue !== 1); // emulated lid starts closed
  pillbox.start();

  const activity: ToolCallEntry[] = [];
  const onToolCall = (entry: ToolCallEntry) => { activity.push(entry); if (activity.length > 50) activity.shift(); };
  const tokens = Object.fromEntries(ROLES.map(role => [role, deriveToken(master, role)])) as Record<Role, string>;
  const extraHosts = [...flags.all('--allowed-host'), ...(process.env.PILLBOX_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean)];
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extraHosts];
  const mcp = createMcpHttpHandler({
    tokens, allowedHosts, allowedOrigins: flags.all('--allowed-origin'),
    createServer: role => createPillboxServer(pillbox, role, { onToolCall }),
    onRequest: ({ role, status, method, host }) => process.stderr.write(`${new Date().toISOString()} ${method} ${MCP_PATH} ${status} ${role ?? '-'}${status === 403 ? ` host=${host}` : ''}\n`),
  });

  let site: ReturnType<typeof createDemoHandler> | undefined;
  if (demo) {
    const model = modelConfigFromEnv(process.env);
    if (!model) process.stderr.write('OPENAI_BASE_URL, OPENAI_API_KEY or OPENAI_MODEL is unset: the demo chat is disabled.\n');
    const assistant = model ? new PillboxAssistant(`http://127.0.0.1:${port}${MCP_PATH}`, tokens.alexa, model) : undefined;
    site = createDemoHandler({ pillbox, transport, clock, assistant, activity, modelName: process.env.PILLBOX_MODEL_LABEL });
  }

  const http = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/healthz') { res.writeHead(device.status === 'ready' ? 200 : 503).end(); return; }
    if (path === MCP_PATH) { await mcp(req, res); return; }
    if (site && await site(req, res)) return;
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise<void>(done => http.listen(port, bind, done));
  process.stderr.write(`Arto Pillbox ready on http://${bind}:${port}${MCP_PATH} (${serial ? `serial ${serial}` : 'emulated Uno'}${demo ? ', demo site' : ''})\n`);

  if (!serial && !demo && process.stdin.isTTY) {
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
