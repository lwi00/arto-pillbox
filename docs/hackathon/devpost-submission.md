# Devpost submission draft

Copy-ready texts for the Devpost form. Items in `<angle brackets>` must be filled in.
Items marked **To confirm** describe work or experiences that have not happened
yet; edit or delete them before submitting. Never submit a claim that is not true
on the day of submission.

## Status check before submitting

| Item | State on 2026-10-19 | Action |
| --- | --- | --- |
| Code on the default branch | Everything is on `claude/keen-shannon-veehdo`; `main` holds only the license. | Merge into `main` in both repositories. Judges open the default branch. |
| Arto dependency pin | `arto-pillbox` pins `lwi00/arto` commit `1fc418d`, which only exists on Arto's work branch. | Merge Arto's branch into `main`, then optionally re-pin to the merge commit. |
| Alexa+ track | Self-hosted MCP server, spec 2025-11-25, Streamable HTTP: done and tested. Simulated Alexa+ experience: done and deployed. Real Alexa+ add-on: not tested. | Either connect the real add-on, or present the simulated path, which the rules accept. |
| AWS Builder mini challenge | **Not met.** No AWS service is used yet: the demo model runs on OpenRouter. | Add Amazon Bedrock (and the planned Strands agent), or drop this mini challenge. |
| Open Source mini challenge | **Not met yet.** No pull request opened. | Open the planned pull request on `lwi00/arto` (Streamable HTTP mode, plus the `prepare` script). |
| Demo video | Not recorded. | Follow the [video script](demo-and-submission.md#video-script). |
| Repository access | Both repositories are public with an MIT license. | Nothing to add while they stay public. |

## Project name

Arto Pillbox

## Tagline (one line)

A connected pillbox that Alexa+ can talk to: an Arduino exposed as a self-hosted MCP server, where safety lives in the hardware, not in the model.

## Tracks and mini challenges

- Primary track: **Alexa+** (self-hosted MCP server, spec 2025-11-25, Streamable HTTP; simulated Alexa+ experience included).
- Mini challenge: **Open Source** (once the pull request exists).
- Mini challenge: **AWS Builder** (only if Bedrock or Strands is added).

A project can win one track prize and one mini challenge prize.

## Project description

### Inspiration

Millions of older people live alone and take medication on a schedule. The people
who care for them usually live somewhere else, and the questions they ask every day
are simple: *"Did Mum take her morning pills?"*, *"Can you remind her?"*. Voice
assistants are already in many of these homes, but they cannot see the physical world.

We wanted to show that connecting a voice assistant to real hardware does not require
custom device code or trusting a language model with a buzzer. With Arto, our open
source framework that turns an Arduino wiring manifest into safe MCP tools, a pillbox
becomes an Alexa+ integration in one JSON file plus a small domain layer.

### What it does

Arto Pillbox is an Arduino Uno with a lid sensor, a reminder light and a buzzer,
exposed to Alexa+ as a **self-hosted MCP server (specification 2025-11-25, Streamable
HTTP)**. It provides five task-level tools:

- `get_intake_status`: for each dose window today, was the pillbox opened, is the dose pending or overdue, was it missed?
- `get_intake_history`: how the last days went.
- `trigger_reminder`: light and buzzer for 5 to 60 seconds, only while a dose is due.
- `stop_reminder`.
- `get_device_health`: is the pillbox connected?

Every result includes a short `summary` sentence ready to be spoken.

The project is careful about what it claims:

- **The pillbox says "the lid was opened", never "the medication was taken".** An opened lid is evidence, not proof. Tool descriptions and server instructions tell the model to keep that wording.
- **A dose is reported as "missed" only if the lid was monitored without interruption for the whole window.** A restart, an unplugged cable or a gap of more than 10 seconds turns a would-be "missed" into "unknown". The system never claims an absence it did not observe.
- **Safety does not depend on the AI.** The firmware silences the buzzer the instant the lid opens (a hardware interlock declared in the manifest). A firmware watchdog clears every output if the server stops talking to the board. The server bounds reminder duration and frequency, and the language model never gets raw pin access.

A public demo site lets anyone try it without hardware or an Echo device: an emulated
pillbox you can open and close, scenario buttons that move the clock, a live log of
MCP tool calls, and a **simulated Alexa+ experience** (typed or spoken). Its language
model answers by calling the pillbox tools through the same MCP endpoint Alexa+ uses.

Demo: <https://pillbox--box-node-6abe373cb88-8bb81b.nodes.nerdit.ai/>

### How we built it

- **Hardware access: Arto.** The Uno runs the Arto firmware. The pillbox is declared in `board.json`: lid switch on D2, LED on D8, buzzer on D9, plus one interlock. The same firmware runs unmodified in the AVR8js emulator, which powers the demo and the tests.
- **MCP server.** TypeScript on Node.js with the official MCP SDK. A single `/mcp` endpoint uses Streamable HTTP in stateless mode with JSON responses. Every client role (`alexa`, `agent`) has its own bearer token. `Host` and `Origin` are validated against DNS rebinding, and the server binds to loopback by default.
- **Domain layer.** It polls the lid every 250 ms, debounces readings, requires a 2-second minimum opening, attributes openings to time-zone-aware dose windows, tracks monitoring coverage and stores history as JSONL.
- **Compliance as tests.** 50 automated tests include a conformance suite that maps each MCP 2025-11-25 transport requirement to a test: version negotiation, 202 for notifications, 405 for GET, 400 for an unsupported `MCP-Protocol-Version`, 406 and 415, 403 for a foreign `Origin` or `Host`, 401 without a token, and output-schema validation of `structuredContent`. The tests run against the real firmware in the emulator.
- **Demo site.** A single static page served by the same process. The simulated assistant is an OpenAI-compatible tool-calling loop that acts as an MCP client of the server's own endpoint. It is deployed on a Nerdit box, whose AI gateway routes to `minimax/minimax-m3.1-flash:free` on OpenRouter.

### Challenges we ran into

- **"Missed" is a claim about the past.** Our first version reported windows as missed right after the server started, for hours it had never watched. We redesigned the tracker around monitoring coverage, so silence is never mistaken for absence.
- **Models over-apply caveats.** Once told never to say "medication taken", the model started adding that disclaimer to unrelated answers. Precise server instructions and a `summary` field per result fixed it.
- **Installing a TypeScript library from Git.** npm only compiles a Git dependency that defines a `prepare` script, so we added one to Arto.

### Accomplishments that we're proud of

- An MCP server whose spec compliance is demonstrated by a test per requirement, not just claimed.
- Three independent safety layers (server timer, firmware interlock, firmware watchdog), so the reminder is safe even if the AI or the server misbehaves.
- A demo anyone can open in a browser, running the same firmware as the physical board.

### What we learned

- Streamable HTTP in stateless mode is a good fit for voice assistants: no sessions, no server-sent events, simple to host behind a tunnel or a platform proxy.
- Task-level tools with short spoken summaries make tool-calling models far more reliable than generic "read pin / write pin" tools.
- Being explicit about uncertainty (`unknown`, "the lid was opened") matters more in caregiving than any extra feature.

### What's next for Arto Pillbox

- Connect the real Alexa+ add-on and record the end-to-end flow on an Echo device.
- A scheduler agent (Strands Agents on Amazon Bedrock) that plays reminders and sends the caregiver a short message through Amazon SNS when a dose is missed.
- Upstream the generic Streamable HTTP mode to Arto, so any Arduino can become a remote MCP server.
- OAuth 2.1 authorization (for example with Amazon Cognito), if Alexa+ add-ons require it.

## Built with

`typescript`, `node.js`, `model-context-protocol`, `mcp-typescript-sdk`, `arduino`,
`avr8js`, `zod`, `web-speech-api`, `openrouter`, `minimax`, `nerdit`, `arto`
(add `amazon-bedrock`, `strands-agents` and `amazon-sns` only once they are used).

## Links

| Field | Value |
| --- | --- |
| Repository | https://github.com/lwi00/arto-pillbox |
| Live demo | https://pillbox--box-node-6abe373cb88-8bb81b.nodes.nerdit.ai/ |
| MCP endpoint | https://pillbox--box-node-6abe373cb88-8bb81b.nodes.nerdit.ai/mcp (bearer token required) |
| Framework | https://github.com/lwi00/arto |
| Video | `<YouTube or Vimeo URL, public, English, under 3 minutes>` |

## Pre-existing project explanation

> Arto Pillbox (`lwi00/arto-pillbox`) was created during the submission window. It
> depends on Arto (`lwi00/arto`), an MIT-licensed framework we published before the
> hackathon. Arto exposes Arduino Uno sensors and actuators to MCP clients over stdio
> and includes the firmware, an AVR8js emulator transport and a serial transport
> (baseline commit `3b87b01`).
>
> Built during the window, in `arto-pillbox`:
> - the self-hosted MCP server over Streamable HTTP (spec 2025-11-25), with bearer roles and Host/Origin validation;
> - the pillbox domain: schedule, lid tracking with coverage-aware missed/unknown states, bounded reminders, history;
> - the five MCP tools;
> - the public demo site with the simulated Alexa+ experience and its Nerdit deployment;
> - the conformance suite and the documentation.
>
> Changed during the window, in `arto`: a `prepare` build script so the library
> installs from GitHub, and `<the Streamable HTTP mode pull request: URL>`.

## Open Source mini challenge fields

| Field | Value |
| --- | --- |
| Contribution URL | `<URL of the pull request on lwi00/arto>` |
| Your repository URL | https://github.com/lwi00/arto-pillbox |
| GitHub username | `lwi00` |
| Description | Draft below. |

> **What:** a pull request to Arto, an MIT-licensed framework that gives AI agents safe,
> typed access to Arduino hardware through MCP. It adds a Streamable HTTP server mode
> (`arto serve --http`) implementing MCP 2025-11-25, with per-client bearer tokens and
> Host/Origin validation, and a `prepare` script so the library installs straight
> from GitHub.
>
> **How it works:** the CLI serves the existing MCP tools on a single stateless `/mcp`
> endpoint through the official SDK's Streamable HTTP transport. Requests with a
> missing token, a foreign `Origin` or a foreign `Host` are rejected before reaching
> the board. A conformance test suite checks each transport requirement against the
> real firmware running in an emulator.
>
> **Why it matters:** until now Arto boards could only be used by a local MCP client
> over stdio. With this mode, any Arduino can be reached by remote, cloud-hosted
> assistants such as Alexa+, while the safety limits stay in the board manifest and
> the firmware.

Only use this text once the pull request contains exactly what it describes.

## AWS Builder mini challenge fields

**To confirm.** This section applies only if AWS services are added. Planned
integration, to describe once it exists:

> - **Amazon Bedrock**: the model behind the scheduler agent and the demo assistant, `<model id>` in `<Region>`.
> - **Strands Agents SDK**: the agent loop; it connects to the pillbox through `MCPClient` over Streamable HTTP with the `agent` token.
> - **Amazon SNS**: caregiver notifications for missed or untracked doses, at most one per dose window.
>
> Code: `<paths>`. IAM: one role with `bedrock:InvokeModel` on one model and `sns:Publish` on one topic.

## Product feedback

The form asks for feedback on every tool, API or SDK used. Fill in the Alexa+ and
AWS blocks from your own experience; the others reflect what happened while building.

### Alexa+ (MCP integration)

- **Used for:** `<the add-on configuration, or "the requirements of the Alexa+ track, while building the simulated experience">`
- **What worked well:** Building on MCP meant no proprietary SDK. A standard server built with the official MCP SDK is the whole integration surface, and it can be tested with any MCP client.
- **What needs work:** `<To confirm from your own reading of the docs.>` The track description does not say how an add-on authenticates to a self-hosted server: static bearer token, or the OAuth 2.1 flow of the MCP authorization spec? It also does not say whether an `Origin` header is sent. We had to design authentication defensively without knowing.
- **Onboarding:** `<your experience>`
- **Would build with it again:** `<yes/no, why>`

### MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **Used for:** the MCP server, the Streamable HTTP transport, and the MCP client in the demo assistant and the tests.
- **What worked well:** `StreamableHTTPServerTransport` already enforces most transport rules (`Accept`, `Content-Type`, `MCP-Protocol-Version`, protocol negotiation). Output schemas with Zod produce validated `structuredContent`.
- **What needs work:** a tool registered without `inputSchema` receives the request context as its first argument instead of empty arguments, which surprised our logging wrapper. Stateless mode still answers `GET` with a stream attempt from the client side, which shows up as 405s in logs.
- **Would build with it again:** yes.

### Nerdit (hosting and AI gateway)

- **Used for:** deploying the demo site from GitHub, the public HTTPS address, project variables, and the AI gateway alias for the model.
- **What worked well:** a Git deploy with a dry run that shows the build plan; AI bindings injected as `OPENAI_*` variables with no provider key inside the container; a HTTPS address that also serves the MCP endpoint.
- **What needs work:** `<your experience>`
- **Would build with it again:** `<yes/no>`

### OpenRouter, MiniMax M3.1 Flash (free tier)

- **Used for:** the language model of the simulated Alexa+ experience.
- **What worked well:** reliable OpenAI-style tool calling, chaining two tools (status then reminder) correctly, and answering in the user's language.
- **What needs work:** it over-applied safety wording from the instructions until the prompt was narrowed; replies may include reasoning blocks, which we strip.

### AVR8js and Arto

- **Used for:** running the unmodified Uno firmware in Node.js for the demo and tests.
- **What worked well:** the same firmware, interlocks and watchdog behave identically in emulation and on the board, so the tests exercise the real safety logic.

### Amazon Bedrock, Strands Agents, Amazon SNS

**To confirm.** Only if used.

## Feature requests (optional)

Candidate requests, to keep only if they match your experience:

| Request | Product | Why it matters | Urgency |
| --- | --- | --- | --- |
| Document the authentication options for self-hosted MCP servers (bearer token, OAuth 2.1 and protected resource metadata), with an example. | Alexa+ | Builders cannot design the auth layer until they know what the add-on sends. | Important |
| A hosted MCP test console that replays Alexa+ requests (headers, `Origin`, protocol version) against a developer's endpoint. | Alexa+ | Lets developers outside the Alexa+ preview regions validate their server. | Important |
| Let an add-on declare that a tool needs confirmation before it acts on a device (for example, playing a buzzer). | Alexa+ | Physical actions deserve a voice confirmation step that the developer can require. | Nice-to-have |

## Friction log (optional, up to a 10% judging bonus)

Record real entries as they happen, one block per task. The format is below; the
example shows the expected level of detail and must be replaced with your own experience.

```markdown
### <Short title>
- Date:
- Product:
- Task attempted:
- Steps taken:
  1.
- Expected:
- Actual:
- Severity: blocker | major | minor | cosmetic
- Workaround:
- Suggestion:
```

**Example (To confirm against your own experience):**

```markdown
### Authentication requirements for a self-hosted MCP server are unclear
- Date: 2026-10-19
- Product: Alexa+ (MCP integration)
- Task attempted: design authentication for a self-hosted Streamable HTTP MCP server before registering it with Alexa+.
- Steps taken:
  1. Read the Alexa+ track requirements on Devpost.
  2. Looked for the authentication model expected from the server.
- Expected: a statement of what Alexa+ sends (static bearer token, OAuth 2.1 with protected resource metadata, custom header) and whether it sends an Origin header.
- Actual: <what you found>
- Severity: major
- Workaround: per-client bearer tokens, isolated in one function so an OAuth layer can replace them.
- Suggestion: add an "Authentication" section to the MCP QuickStart with one example per supported method.
```
