# Architecture

## Overview

```text
                  voice                     HTTPS: Streamable HTTP, Bearer token
  Person  ───────────────▶  Alexa+  ──────────────────────────────────┐
                                                                       ▼
                                          ┌─────────────────────────────────────────┐
  Scheduler agent (planned)  ───────────▶ │ arto-pillbox (this repository)          │
  Strands Agents + Amazon Bedrock          │                                         │
                                          │  src/http.ts     /mcp endpoint, auth,   │
                                          │                  Host/Origin checks     │
                                          │  src/mcp.ts      task-level MCP tools   │
                                          │  src/pillbox.ts  polling, reminders     │
                                          │  src/tracker.ts  intake detection       │
                                          │  src/history.ts  JSONL history          │
                                          │  ArtoDevice      (arto-mcp library)     │
                                          └────────────────────┬────────────────────┘
                                                               │ SerialTransport (USB)
                                                               │ or AvrTransport (emulated)
                                                               ▼
                                          Arduino Uno running the Arto firmware
                                          lid switch (D2) · LED (D8) · buzzer (D9)
```

Arto Pillbox is an application built on [Arto](https://github.com/lwi00/arto), which
provides the Uno firmware, the serial and emulated transports and the `ArtoDevice`
command layer. This repository adds everything specific to the pillbox: the domain
rules, the MCP tools and the HTTP endpoint.

## Layers

| Layer | File | Responsibility | Talks to |
| --- | --- | --- | --- |
| Entry point | `src/main.ts` | Parses options, connects the board, starts polling and the HTTP server, emulator keyboard controls. | Every layer |
| HTTP endpoint | `src/http.ts` | Single `/mcp` path, Host and Origin checks, bearer authentication, method and body limits, then the SDK's Streamable HTTP transport. One stateless MCP server per request. | `McpServer` factory |
| MCP tools | `src/mcp.ts` | Tool definitions, input and output schemas, spoken summaries, server instructions. | `Pillbox` only |
| Domain service | `src/pillbox.ts` | Lid polling loop, reminder rules and timers, status and history queries, device health. The only code that writes outputs. | `ArtoDevice`, `IntakeTracker`, `HistoryStore` |
| Intake tracker | `src/tracker.ts` | Debounce, minimum open time, slot attribution, monitoring coverage and gaps, slot status computation. No I/O apart from history writes. | `HistoryStore` |
| Schedule | `src/schedule.ts` | Schedule validation and time-zone arithmetic. | none |
| History | `src/history.ts` | Append-only records in memory and in a JSONL file. | File system |
| Hardware access | `arto-mcp` | Firmware protocol, command serialization, timeouts, heartbeat, interlocks. | Uno over USB, or AVR8js |

The tools never call the device directly, and the device is never exposed through MCP
as raw pins. Arto's generic `set_component` tool is deliberately not used here.

## Request flow: "Did Mum open her pillbox this morning?"

1. Alexa+ sends `POST /mcp` with `Authorization: Bearer <alexa token>` and a JSON-RPC
   `tools/call` for `get_intake_status`.
2. `createMcpHttpHandler` checks the path, `Host`, `Origin` and token, resolves the
   role `alexa`, reads the body and creates a fresh `McpServer` for that role.
3. The SDK's `StreamableHTTPServerTransport` checks `Accept`, `Content-Type` and
   `MCP-Protocol-Version`, then dispatches the call.
4. The tool calls `Pillbox.status()`, which asks `IntakeTracker.statusFor()` to
   combine the schedule, the clock and the history records.
5. The tool returns `structuredContent` (validated against its output schema) with
   a `summary` sentence that Alexa+ can read aloud.

## Lid monitoring

The Arto firmware answers requests but does not push input changes, so
`Pillbox.poll()` reads the lid every 250 ms and feeds the reading to the tracker.

```text
reading ──▶ debounce (2 identical) ──▶ lid state ──▶ open ≥ 2 s ──▶ "opened" record
   │                                       │
   │                                       └──▶ lid opened: stop reminder
   └──▶ coverage: gaps, restarts and failed readings ──▶ "interrupted" / "covered" records
```

### Status rules

| State | Condition |
| --- | --- |
| `upcoming` | Before the window opens, or a future date. |
| `pending` | Window open, before `due`, no opening yet. |
| `overdue` | After `due`, before `closes`, no opening yet. Reminders allowed. |
| `opened` | A qualifying opening was recorded during the window. `late` is set after `due + lateAfterMinutes`. |
| `missed` | Window closed, no opening, **and** the lid was monitored without gaps from before `opens` until `closes`. |
| `unknown` | Window closed, no opening, and monitoring was not continuous. |

`missed` is never inferred from silence. A window gets a `covered` record only when
consecutive valid readings span its closing time with no gap above 10 s and no
interruption since before it opened. A restart or failed reading inside a window
records `interrupted`, which turns a would-be `missed` into `unknown`.

An opened lid is evidence of access, not proof that the medication was swallowed.
Tool descriptions, summaries and server instructions use the wording "the pillbox
was opened".

## Reminders

`Pillbox.triggerReminder(slot, seconds, role)`:

1. Rejects durations outside 5 to 60 seconds.
2. Rejects slots that are not `pending` or `overdue`.
3. Rejects a second concurrent reminder, an open lid, and a repeat within the
   cooldown (300 s by default) for the same slot.
4. Writes `reminder_led = 1` and `buzzer = 1` and records the reminder with the
   requesting role.
5. Stops after `seconds`, when the lid opens, or on `stop_reminder`.

Three independent mechanisms bound the buzzer:

| Mechanism | Where | Effect |
| --- | --- | --- |
| Reminder timer | Server | Clears outputs after the requested duration. |
| Interlock `lid → buzzer` | Firmware | Rejects buzzer writes while the lid is open and clears an active buzzer as soon as it opens, even if the server hangs. |
| Watchdog | Firmware | Clears every output after five seconds without host contact. |

The interlock also defines the lid polarity: the `blockedValue` of the `lid → buzzer`
interlock is the reading that means "open". The production manifest and the
push-button manifest therefore need no separate polarity setting.

## Authentication and roles

`PILLBOX_MASTER_TOKEN` is the only secret. Each role's bearer token is
`HMAC-SHA256(master, role)`, printed by `arto-pillbox tokens`.

| Role | Client | Tools |
| --- | --- | --- |
| `alexa` | Alexa+ add-on, MCP Inspector | All five pillbox tools. |
| `agent` | Scheduler agent (planned) | The same tools; `notify_caregiver` will be added for this role only. |

Reminders record the role that requested them, so the history shows whether Alexa+
or the agent triggered each one.

## Persistence

`HistoryStore` appends one JSON object per line to `.arto/pillbox-history.jsonl`
(ignored by git).

| Record | Written when |
| --- | --- |
| `opened` | A qualifying opening is attributed to a window. |
| `interrupted` | Monitoring had a gap inside a window (first reading after start, failed reading, delay above 10 s). |
| `covered` | A window closed while monitored continuously. |
| `reminder` | A reminder started. |

Corrupt lines are skipped on load. The device event log stays in memory in
`ArtoDevice` (500 events).

## Known limitations

- After a device fault (USB unplugged, command timeout), the server reports
  `fault` and windows become `unknown`, but it does not reconnect automatically.
  Restart the process.
- Schedules are read at startup; changes need a restart.
- The server is stateless and sends no server-initiated notifications.
- The system is a demonstration and not a medical device.
