# Installation and configuration

## Requirements

| Item | Version or note |
| --- | --- |
| Node.js | 22 or later. |
| Git | Needed by npm to install `arto-mcp` from GitHub. |
| Arduino Uno | Optional. Without one, the bundled firmware runs in the AVR8js emulator. |
| Arduino IDE or `arduino-cli` | Only to flash the Arto firmware onto a physical board. |

## Install

```sh
git clone https://github.com/lwi00/arto-pillbox.git
cd arto-pillbox
npm install
npm run build
```

`npm install` fetches `arto-mcp` from `github:lwi00/arto` at a pinned commit and
compiles it through its `prepare` script.

## Secret and tokens

```sh
cp .env.example .env
# put a random value of at least 32 characters in PILLBOX_MASTER_TOKEN, for example:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The server does not read `.env` by itself. Export the variable in your shell, or use
Node's loader:

```sh
export PILLBOX_MASTER_TOKEN=...            # or: node --env-file=.env dist/main.js serve
npm run tokens                             # prints one bearer token per role
```

| Role | Use the token in |
| --- | --- |
| `alexa` | The Alexa+ add-on configuration, the MCP Inspector. |
| `agent` | The scheduler agent. |

Changing the master token changes every role token.

## Run

Emulated board, no hardware:

```sh
npm start
```

Type `o` and Enter to open the emulated lid, `c` and Enter to close it.

Physical board:

```sh
npx arto ports                              # from arto-mcp: lists serial devices
node dist/main.js serve --serial /dev/ttyACM0
```

Behind a tunnel, for Alexa+:

```sh
cloudflared tunnel --url http://127.0.0.1:8080       # prints https://<name>.trycloudflare.com
node dist/main.js serve --serial /dev/ttyACM0 --allowed-host <name>.trycloudflare.com
```

The public MCP URL is then `https://<name>.trycloudflare.com/mcp`.

## Command-line reference

```text
arto-pillbox serve [options]
arto-pillbox tokens
```

| Option | Default | Description |
| --- | --- | --- |
| `--manifest <file>` | `board.json` | Arto board manifest. |
| `--schedule <file>` | `schedule.json` | Dose schedule. |
| `--history <file>` | `.arto/pillbox-history.jsonl` | Intake history. |
| `--serial <device>` | none | Serial device of a physical Uno. Without it, the emulator is used. |
| `--listen <port>` | `8080` | HTTP port. |
| `--bind <address>` | `127.0.0.1` | Interface. Keep loopback unless a trusted reverse proxy runs on another host. |
| `--allowed-host <host>` | none | Extra accepted `Host` value, such as a tunnel hostname. Repeatable. Loopback hosts on the chosen port are always accepted. |
| `--allowed-origin <origin>` | none | Accepted `Origin` value for browser-based clients, such as `https://inspector.example`. Repeatable. |

| Environment variable | Required | Description |
| --- | --- | --- |
| `PILLBOX_MASTER_TOKEN` | Yes | Secret of at least 32 characters from which role tokens are derived. |

## HTTP endpoints

| Method and path | Authentication | Description |
| --- | --- | --- |
| `POST /mcp` | Bearer role token | MCP Streamable HTTP endpoint. |
| `GET /mcp`, `DELETE /mcp` | Bearer role token | 405: the server is stateless. |
| `GET /healthz` | none | 200 when the board is ready, 503 otherwise. No body. |

## Schedule

`schedule.json`:

```json
{
  "timeZone": "Europe/Paris",
  "lateAfterMinutes": 30,
  "slots": [
    { "id": "morning", "label": "Morning pills", "opens": "07:00", "due": "09:00", "closes": "11:00" },
    { "id": "evening", "label": "Evening pills", "opens": "19:00", "due": "20:00", "closes": "22:00" }
  ]
}
```

| Field | Rule |
| --- | --- |
| `timeZone` | IANA name. Dates and times in tool results use this zone. |
| `lateAfterMinutes` | 0 to 240. An opening after `due + lateAfterMinutes` is marked `late`. Default 30. |
| `slots` | 1 to 4 windows. |
| `slots[].id` | Lowercase identifier used by the `trigger_reminder` tool. |
| `slots[].label` | Name used in spoken summaries. |
| `opens`, `due`, `closes` | 24-hour `HH:MM`, with `opens <= due < closes` on the same day. Windows must not overlap. |

## Hardware

### Production wiring (`board.json`)

| Part | Uno pin | Notes |
| --- | --- | --- |
| Reed switch, one side | D2 | The other side to GND. Uses the internal pull-up. |
| Magnet | In the lid | Lid closed: switch closed, D2 reads 0. Lid open: D2 reads 1. |
| LED anode, through a 220 Ω resistor | D8 | Cathode to GND. |
| Active 5 V buzzer, positive lead | D9 | Negative lead to GND. A passive buzzer will not sound: the firmware drives DC levels, not tones. |

### Development wiring (`examples/board-pushbutton.json`)

A push button between D2 and GND stands in for the lid. Pressed (0) means open.
Start the server with `--manifest examples/board-pushbutton.json`. The manifest's
interlock uses `blockedValue: 0`, so the server reads polarity from it automatically.

### Flashing the firmware

Flash the Arto firmware (`node_modules/arto-mcp/firmware/arto/arto.ino`) with the
Arduino IDE or `arduino-cli`, as described in the Arto firmware README. The serial
link runs at 115200 baud. Close the Arduino serial monitor before starting the server.

## Files written at runtime

| Path | Content |
| --- | --- |
| `.arto/pillbox-history.jsonl` | Intake history. Delete it to start from an empty history. |

`.arto/`, `.env`, `dist/` and `node_modules/` are ignored by git.
