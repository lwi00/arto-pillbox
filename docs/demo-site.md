# Demo site

`arto-pillbox serve --demo` serves a public page next to the MCP endpoint. Judges
and visitors can use the pillbox without hardware, without an Alexa device and
without an MCP client.

## What the page shows

| Area | Content |
| --- | --- |
| The pillbox | A drawing of the emulated pillbox: lid, reminder light, buzzer. Lid, outputs, board status and the local time. A button opens or closes the emulated lid. Today's dose windows with their state. |
| Scenario | Jumps the demo clock to 08:15, 09:45 or 19:30 (or back to real time) and starts the day over. |
| MCP activity | The last tool calls received on `/mcp`, with the client role: the page's assistant and any external client, such as an Alexa+ add-on. |
| Simulated Alexa+ experience | A chat, typed or spoken (browser speech recognition and synthesis where available). A language model answers by calling the pillbox's MCP tools. Each answer lists the tools it called. |

The page is labelled as a simulated Alexa+ experience. It is not an Amazon product.

## How the assistant works

```text
browser ──POST /api/chat──▶ PillboxAssistant ──chat/completions──▶ OpenAI-compatible model
                                  │   ▲                            (Nerdit AI gateway → OpenRouter)
                                  │   └── tool calls ◀──────────────┘
                                  ▼
                       MCP client, Streamable HTTP, Bearer <alexa token>
                                  │
                                  ▼
                          POST http://127.0.0.1:<port>/mcp   (same endpoint as Alexa+)
```

1. `PillboxAssistant` (`src/demo/assistant.ts`) opens an MCP client session to the
   server's own `/mcp` endpoint with the `alexa` role token.
2. It lists the tools with `tools/list` and offers them to the model as functions,
   with the server instructions added to the system prompt.
3. Each function call from the model is executed with MCP `tools/call`; the result
   text is returned to the model. At most four rounds of tool calls are made.
4. The final answer, without any `<think>` block, is returned with the list of
   tool calls.

Because the assistant goes through the real endpoint, the demo exercises the same
transport, authentication and tools as an external client.

## Demo-only behaviour

| Behaviour | Reason |
| --- | --- |
| Emulated board only (`--demo` refuses `--serial`). | Anyone can open the virtual lid. |
| The clock starts at 09:45 local time (`PILLBOX_DEMO_START`). | Visitors first see an overdue dose, the most telling state. |
| Scenario buttons shift the clock and clear the in-memory history. | History must stay chronological. |
| After a start or a scenario jump, the simulated day counts as monitored from its start. | Otherwise every demo window would show as interrupted and end as `unknown`. A real deployment never assumes this. |
| History is kept in memory only. | Scenarios rewrite time. |
| Chat limited to 12 requests per minute for the whole site; messages up to 500 characters; 8 previous turns. | Protects the free model quota. |
| Without `PILLBOX_MASTER_TOKEN`, a random secret is generated. | The page works out of the box; external MCP clients need the variable to be set. |

## HTTP routes

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /` | | The page (`public/index.html`). |
| `GET /api/state` | | Status, health, outputs, schedule, recent MCP activity, assistant availability. |
| `POST /api/lid` | `{ "open": true }` | Opens or closes the emulated lid. |
| `POST /api/scenario` | `{ "time": "09:45" }` or `{ "time": null }` | Jumps the clock, closes the lid, clears the day; returns the new state. |
| `POST /api/chat` | `{ "message": "...", "history": [{ "role": "user", "content": "..." }] }` | `{ "reply", "trace": [{ "tool", "arguments", "isError", "summary" }] }`. 429 when the rate limit is reached, 503 without a model, 502 on a model error. |
| `POST /mcp` | MCP JSON-RPC | The MCP endpoint, unchanged by demo mode. |
| `GET /healthz` | | 200 when the emulated board is ready. |

## Configuration

| Variable | Description |
| --- | --- |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | Chat model. Nerdit injects them from the `[ai.default]` binding. Without them the chat is disabled; the rest of the page works. |
| `PILLBOX_MODEL_LABEL` | Optional model name shown on the page instead of `OPENAI_MODEL`. |
| `PILLBOX_DEMO_START` | Local time the demo clock starts at. Default `09:45`. |
| `PILLBOX_MASTER_TOKEN` | Optional in demo mode; required for external MCP clients such as Alexa+. |
| `PILLBOX_ALLOWED_HOSTS` | Comma-separated public host names accepted on `/mcp`, such as the Nerdit address. |

Run it locally:

```sh
npm run build
OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENAI_API_KEY=... OPENAI_MODEL=minimax/minimax-m3.1-flash:free \
  node dist/main.js serve --demo
# open http://127.0.0.1:8080/
```

## Deployment on Nerdit

`nerdit.toml` declares the app:

```toml
[deploy]
name = "pillbox"
port = 8000
start = "node dist/main.js serve --demo --bind 0.0.0.0 --listen 8000"
health = "/healthz"

[ai.default]
provider = "gateway"
model = "minimax-m3-1-flash-free"
```

- The Node buildpack installs the dependencies (including `arto-mcp` from GitHub)
  and runs `npm run build`.
- `[ai.default]` points at the machine AI gateway alias `minimax-m3-1-flash-free`,
  which maps to `minimax/minimax-m3.1-flash:free` on OpenRouter. The provider key
  stays in the gateway; the app receives a per-app virtual key.
- The hosted address has the form `https://pillbox--<node>.nodes.nerdit.ai/`.
  The MCP endpoint is that address followed by `mcp`.

To let Alexa+ or the MCP Inspector use the public endpoint, set two variables on
the app yourself, so the secret never passes through a chat transcript:

```sh
nerdit vars set <project> --secret --prompt PILLBOX_MASTER_TOKEN
nerdit vars set <project> PILLBOX_ALLOWED_HOSTS=pillbox--<node>.nodes.nerdit.ai
```

Then print the role tokens locally with the same master token (`npm run tokens`).

A hosted Nerdit box sleeps after a period without traffic and wakes on the next
request; the first request after a wake can take up to a couple of minutes.
