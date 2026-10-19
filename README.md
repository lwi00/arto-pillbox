# Arto Pillbox

A connected pillbox that Alexa+ can talk to. An Arduino Uno watches the lid and drives
a reminder light and buzzer. A **self-hosted MCP server (specification 2025-11-25,
Streamable HTTP)** lets Alexa+ answer "Did Mum open her pillbox this morning?" and play
a reminder.

Built on [Arto](https://github.com/lwi00/arto), which turns an Arduino wiring manifest
into safe, typed device access for agents. The pillbox's hardware is described by one
JSON file ([`board.json`](board.json)); safety limits live in that manifest and in the
firmware, not in the model.

> Not a medical device. The pillbox reports that its lid **was opened**, which does not
> prove that the medication was taken.

## What it does

| Ask | Tool | Result |
| --- | --- | --- |
| "Did she open her pillbox this morning?" | `get_intake_status` | Per-window status: opened at 09:42, pending, overdue, missed or unknown. |
| "How did this week go?" | `get_intake_history` | Opened, missed and untracked windows over up to 14 days. |
| "Remind her." | `trigger_reminder` | LED and buzzer for 5 to 60 s, only while the dose is due; stops when the lid opens. |
| "Stop the reminder." | `stop_reminder` | Outputs off. |
| "Is the pillbox connected?" | `get_device_health` | Connection, emulated or physical, last readings. |

A window is reported as **missed** only if the lid was monitored continuously for the
whole window; otherwise it is **unknown**. Opening the lid silences the buzzer through a
firmware interlock, independently of the server.

## Quick start

Requires Node.js 22 or later. No hardware needed: the Arto firmware runs in an emulator.

```sh
npm install
npm run build
export PILLBOX_MASTER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm run tokens        # bearer token per client role
npm start             # http://127.0.0.1:8080/mcp, emulated Uno
```

In the server terminal, type `o` + Enter to open the emulated lid and `c` + Enter to
close it. Connect any MCP client that supports Streamable HTTP to
`http://127.0.0.1:8080/mcp` with `Authorization: Bearer <alexa token>`.

With a physical Uno flashed with the Arto firmware:

```sh
node dist/main.js serve --serial /dev/ttyACM0
```

To expose it to Alexa+, put an HTTPS tunnel in front and allow its hostname:

```sh
cloudflared tunnel --url http://127.0.0.1:8080
node dist/main.js serve --serial /dev/ttyACM0 --allowed-host <name>.trycloudflare.com
```

## Demo site

`node dist/main.js serve --demo` adds a public page: an emulated pillbox you can
open and close, scenario buttons that move the clock, a live log of MCP tool calls,
and a **simulated Alexa+ assistant** (typed or spoken) whose language model answers
by calling the pillbox tools through the same `/mcp` endpoint Alexa+ would use. The
demo is deployed on Nerdit with `nerdit.toml`. See [docs/demo-site.md](docs/demo-site.md).

## Alexa+ track compliance

| Requirement | How |
| --- | --- |
| Self-hosted MCP server | Runs on your machine or your AWS account (`src/main.ts`). |
| Spec 2025-11-25 or later | `@modelcontextprotocol/sdk` 1.32.1; `initialize` negotiates `2025-11-25` (tested). |
| Streamable HTTP | Single `/mcp` endpoint with the SDK's `StreamableHTTPServerTransport` (`src/http.ts`). |
| Security | Bearer token per role, `Origin` and `Host` validation, loopback bind by default. |

Every requirement is mapped to code and a test in
[docs/alexa-plus-compliance.md](docs/alexa-plus-compliance.md). Run them with `npm test`.

## Documentation

| Document | Contents |
| --- | --- |
| [Installation and configuration](docs/configuration.md) | Options, schedule, hardware wiring, tunnel. |
| [Architecture](docs/architecture.md) | Layers, monitoring rules, reminders, roles, persistence. |
| [MCP tool reference](docs/mcp-tools.md) | Inputs, outputs, refusals, example session. |
| [Alexa+ compliance](docs/alexa-plus-compliance.md) | Requirement matrix with evidence. |
| [Testing](docs/testing.md) | Test suites and manual checks. |
| [Demo site](docs/demo-site.md) | Public demo page, simulated Alexa+ assistant, Nerdit deployment. |
| [Hackathon](docs/hackathon/README.md) | Plan, demo script, submission checklist. |

## Project layout

```text
board.json                      production wiring: reed switch, LED, buzzer, interlock
examples/board-pushbutton.json  development wiring with a push button
schedule.json                   dose windows and time zone
src/main.ts                     CLI entry point
src/http.ts                     Streamable HTTP endpoint, authentication, Host/Origin checks
src/mcp.ts                      MCP tools and server instructions
src/pillbox.ts                  polling, reminders, status
src/tracker.ts                  intake detection and monitoring coverage
src/schedule.ts                 schedule validation, time zones
src/history.ts                  JSONL history
src/demo/assistant.ts           simulated Alexa+ assistant: model loop over MCP tools
src/demo/site.ts                demo routes and scenario clock
public/index.html               demo page
nerdit.toml                     Nerdit deployment of the demo
tests/                          conformance, tracker and emulated-hardware tests
docs/                           documentation
```

## License

MIT. See [LICENSE](LICENSE). Arto and its firmware dependencies keep their own licenses.
