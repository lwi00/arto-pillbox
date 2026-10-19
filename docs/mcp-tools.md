# MCP tool reference

Server identity: `arto-pillbox` ("Arto Pillbox"), version 0.1.0. Protocol 2025-11-25
over Streamable HTTP at `/mcp`.

Every tool returns:

- `structuredContent`, an object that matches the tool's output schema;
- one `text` content item with the same object serialized as JSON, for clients that
  ignore structured content.

Every result object has a `summary` field: one or two plain English sentences meant
to be read aloud. Failures return `isError: true` and a text message, such as
`No reminder needed: Morning pills is opened`.

## Server instructions

Sent in the `initialize` result:

> This server is a connected pillbox for one person, built on an Arduino. It reports
> whether the pillbox lid was opened during each dose window and can play a short
> reminder (light and buzzer). An opened lid does not prove the medication was
> swallowed: say "the pillbox was opened", never "the medication was taken". Call
> get_intake_status before answering questions about today. Use each result's
> "summary" field for spoken answers. Only call trigger_reminder when the user asks for
> a reminder and the dose is pending or overdue. This is not a medical device.

## Slot status object

Used by `get_intake_status` and `get_intake_history`.

| Field | Type | Description |
| --- | --- | --- |
| `slot` | string | Slot identifier, such as `morning`. |
| `label` | string | Slot name, such as `Morning pills`. |
| `date` | string | Local date `YYYY-MM-DD`. |
| `window` | object | `opens`, `due`, `closes` as `HH:MM`. |
| `state` | enum | `upcoming`, `pending`, `overdue`, `opened`, `missed` or `unknown`. See [status rules](architecture.md#status-rules). |
| `openedAt` | string, optional | Local `HH:MM` of the opening. |
| `late` | boolean, optional | Opening after `due + lateAfterMinutes`. |
| `trackingInterrupted` | boolean | Monitoring had a gap during the window. |
| `reminders` | integer | Reminders played for this window. |

## `get_intake_status`

Reports today's dose windows (or another date's), the lid state and any active reminder.

Annotations: read-only, idempotent, closed world.

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `date` | string `YYYY-MM-DD` | today | Local date. |

| Output | Type | Description |
| --- | --- | --- |
| `summary` | string | One sentence per slot, plus a warning when the board is disconnected. |
| `date`, `localTime`, `timeZone` | string | Requested date, current local time and schedule time zone. |
| `lidOpen` | boolean or null | Debounced lid state; null if unknown. |
| `reminderActive` | object or null | `slot` and `endsAt` (ISO 8601) of the playing reminder. |
| `slots` | slot status[] | One per schedule slot. |
| `device` | object | `status` (`ready`, `fault`, ...) and `transport` (`usb-serial`, `avr8js`). |

Example summary: `Morning pills: the pillbox was opened at 09:42, later than planned. Evening pills: not due yet; the window opens at 19:00.`

## `get_intake_history`

Summarizes recent days.

Annotations: read-only, idempotent, closed world.

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `days` | integer 1 to 14 | 7 | Number of days including today. |

| Output | Type | Description |
| --- | --- | --- |
| `summary` | string | Counts of opened, missed and untracked windows. |
| `days` | array | `{ date, slots: slot status[] }`, most recent first. |
| `totals` | object | `opened`, `missed`, `unknown` counts. Windows not yet closed are not counted as missed or unknown. |

## `trigger_reminder`

Turns on the LED and the buzzer for a few seconds.

Annotations: not read-only, not destructive, not idempotent, closed world.

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `slot` | enum of slot ids | required | Window to remind about. |
| `seconds` | integer 5 to 60 | 20 | Duration. |

| Output | Type | Description |
| --- | --- | --- |
| `summary` | string | `The reminder is playing for 20 seconds.` |
| `slot` | string | Slot reminded about. |
| `endsAt` | string | ISO 8601 end time. |
| `outputs` | object | Firmware-acknowledged values of `reminder_led` and `buzzer`. |

Refused when the slot is not `pending` or `overdue`, a reminder is already playing,
the lid is open, the same slot had a reminder less than 5 minutes earlier, or the
board is not ready.

## `stop_reminder`

Turns the LED and buzzer off.

Annotations: not read-only, not destructive, idempotent, closed world.

No input. Output: `summary`, `stopped` (whether a reminder was playing).

## `get_device_health`

Reports the hardware connection.

Annotations: read-only, idempotent, closed world.

No input.

| Output | Type | Description |
| --- | --- | --- |
| `summary` | string | `The pillbox is connected (emulated board).` |
| `status` | string | `ready`, `connecting`, `fault` or `disconnected`. |
| `transport` | string | `usb-serial` or `avr8js`. |
| `emulated` | boolean | True for the AVR8js emulator. |
| `polling` | boolean | Lid polling loop running. |
| `lidOpen` | boolean or null | Debounced lid state. |
| `observations` | object | Last value, time and source per component. |

## Example session

```http
POST /mcp HTTP/1.1
Host: 127.0.0.1:8080
Authorization: Bearer <alexa token>
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}
```

```http
POST /mcp HTTP/1.1
MCP-Protocol-Version: 2025-11-25
(same headers)

{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_intake_status","arguments":{}}}
```
