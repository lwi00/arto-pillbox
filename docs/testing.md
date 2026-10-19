# Testing

```sh
npm test          # all suites
npm run typecheck # TypeScript, no output files
```

The tests run against the real Arto firmware in the AVR8js emulator. They need no
hardware, no network access and no credentials.

## Suites

| File | Scope | What it proves |
| --- | --- | --- |
| `tests/conformance.test.ts` | HTTP endpoint and MCP protocol | Compliance with MCP 2025-11-25 Streamable HTTP and the security checks. Each test maps to a row of [the compliance matrix](alexa-plus-compliance.md). |
| `tests/tracker.test.ts` | Intake tracker and schedule | Status transitions, debounce, minimum open time, attribution, coverage and gaps, time zones, schedule validation. Pure logic with an injected clock. |
| `tests/demo.test.ts` | Demo assistant and clock | The model loop calls tools through the real MCP endpoint, strips reasoning blocks, records the role, reports model errors; Nerdit variables; scenario clock. Uses a fake model. |
| `tests/pillbox.test.ts` | Domain service with the emulated board | Reminder lifecycle, the firmware interlock, refusals, rate limiting, openings reported with local time. |

`tests/helpers.ts` starts an emulated pillbox with its MCP endpoint on an ephemeral
port, provides a controllable `TestClock` and a raw HTTP client that can set headers
such as `Host`, which `fetch` forbids.

## Conventions

- Tests use a UTC schedule so results do not depend on daylight saving time.
  Time-zone handling is tested separately with `Europe/Paris`.
- The pillbox is polled explicitly (`settle()`), not by its timer, so tests are deterministic.
- Protocol tests use both raw requests (to check status codes and headers) and the
  official SDK client (to check what a real client sees).

## Manual checks

### MCP Inspector

```sh
npm start
npx @modelcontextprotocol/inspector
```

In the Inspector, choose transport "Streamable HTTP", URL `http://127.0.0.1:8080/mcp`,
and add the header `Authorization: Bearer <alexa token>`. If the Inspector runs in a
browser and sends an `Origin` header, start the server with
`--allowed-origin <inspector origin>`.

### curl

```sh
TOKEN=$(npm run -s tokens | awk '/^alexa/{print $2}')
curl -s http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

### Physical board checklist

1. `node dist/main.js serve --serial <device>` reports `serial <device>`.
2. `get_device_health` reports `ready` and `emulated: false`.
3. Opening the lid for more than 2 seconds during a window sets the slot to `opened`.
4. `trigger_reminder` lights the LED and sounds the buzzer.
5. Opening the lid silences the buzzer immediately (firmware interlock) and turns the LED off.
6. Unplugging USB sets the status to `fault`; the window in progress becomes `unknown` once it closes.
