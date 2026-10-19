# Plan

Target: 1 to 3 weeks of work. Days are relative (D1 = first day of work) until the
exact deadline is known. Every demo-critical item fits in the first 10 days.

## Repositories

| Repository | Role | Submission field |
| --- | --- | --- |
| `lwi00/arto-pillbox` (this one, MIT) | The entry: pillbox application, MCP server, agent, documentation. Created during the hackathon. | Primary track: Alexa+. Mini challenge: AWS Builder. |
| `lwi00/arto` (public, MIT, existed before) | The framework the entry depends on. Hackathon changes go through a branch and a pull request. | Mini challenge: Open Source (contribution to a public repository). |

Arto changes made so far on branch `claude/keen-shannon-veehdo`:

- `prepare` script, so npm compiles Arto when installed from GitHub (needed by this repository).

Planned Arto contribution: a generic Streamable HTTP mode (`arto serve --http`) based
on `src/http.ts` from this repository, so any Arto board can be reached by remote MCP
clients. This is the Open Source submission.

## Phases

| Phase | Days | Outcome | Status |
| --- | --- | --- | --- |
| 0. Verify access | D1 | Alexa+ path chosen, AWS Region and model chosen. | Waiting for the user |
| 1. MCP server and pillbox domain | D1 to D4 | Streamable HTTP endpoint, tools, tracker, reminders, conformance tests. | Done |
| 2. Physical board | D4 to D5 | Wiring, firmware flashed, checklist in [testing](../testing.md#physical-board-checklist) passed. | To do |
| 3. Alexa+ integration | D5 to D8 | Alexa+ calls the pillbox through a tunnel or the Nerdit address. The simulated path is done (demo site). | In progress |
| 4. Strands and Bedrock agent | D7 to D10 | Missed-dose reminders and caregiver email through Amazon SNS. | To do |
| 5. Demo site | D9 to D10 | Public page: emulated pillbox, scenarios, MCP activity, simulated Alexa+ chat; deployed on Nerdit. | Done (see [demo site](../demo-site.md)) |
| 6. Open Source contribution | D10 to D11 | Pull request to `lwi00/arto` with the HTTP mode. | To do |
| 7. Hosted backup | D11 to D12 | Emulated pillbox on AWS with HTTPS. | Optional |
| 8. Video and submission | D12 to D15 | Video under 3 minutes, feedback, friction log, repository access. | To do |

Record friction log entries throughout, in `docs/hackathon/friction-log.md`.

## Phase 0: Verify access

1. Read the Alexa+ MCP QuickStart and Toolkit Overview.
2. Answer the [open questions](../alexa-plus-compliance.md#points-not-yet-verified-against-alexa):
   authentication model, public HTTPS requirements, `Origin` header, locales.
3. In AWS, enable one Bedrock model in one Region and note its model id.
4. Create an SNS topic and confirm an email subscription.
5. Install `cloudflared` or `ngrok` and expose a local port over HTTPS.

| Path | Condition | Consequence |
| --- | --- | --- |
| A. Real Alexa+ add-on | Access granted in a usable locale. | Phase 3A. |
| B. Simulated Alexa+ | No access, or access too late. | Phase 3B. Explicitly allowed by the rules. |

## Phase 1: MCP server and pillbox domain (done)

Delivered:

- `src/http.ts`: single `/mcp` endpoint, Streamable HTTP via the SDK, stateless,
  bearer roles, Host and Origin validation, body limit.
- `src/mcp.ts`: five task-level tools with input and output schemas, annotations,
  spoken summaries and server instructions.
- `src/pillbox.ts`, `src/tracker.ts`, `src/schedule.ts`, `src/history.ts`: polling,
  debounce, attribution, coverage-based `missed` vs `unknown`, bounded reminders.
- 44 tests, including the [compliance matrix](../alexa-plus-compliance.md).

## Phase 2: Physical board

1. Wire the reed switch (or push button), LED and active buzzer as in
   [configuration](../configuration.md#hardware).
2. Flash the Arto firmware.
3. Run the [physical board checklist](../testing.md#physical-board-checklist).
4. Film short clips of the interlock silencing the buzzer, as backup footage.

## Phase 3A: Real Alexa+ add-on

1. Start the server with `--serial` and the tunnel; add `--allowed-host <tunnel hostname>`.
2. Register the add-on with the public `/mcp` URL and the `alexa` token, following the QuickStart.
3. Test the utterances of the [demo script](demo-and-submission.md#video-script).
4. Adjust tool descriptions if Alexa+ routes requests poorly; log each change in the friction log.
5. Document the add-on configuration in `docs/alexa-plus-setup.md`.
6. If Alexa+ requires OAuth, add an authorization layer (for example Amazon Cognito and
   RFC 9728 protected resource metadata) inside `createMcpHttpHandler`.

## Phase 3B: Simulated Alexa+ experience

1. Web page with push-to-talk, using the browser Web Speech API for speech-to-text and text-to-speech.
2. A server route sends the transcript to a Bedrock model that calls the pillbox tools
   through the same `/mcp` endpoint with the `alexa` token.
3. The page shows the transcript, tool calls and spoken answer, labelled "Simulated Alexa+ experience".

## Phase 4: Strands and Bedrock agent (AWS Builder)

1. `agent/` with `pyproject.toml`, pinned dependencies, `.env.example`, `README.md`,
   Google-style docstrings.
2. Loop: deterministic timer every 5 minutes and at each `due` and `closes` time;
   Strands `Agent` with `BedrockModel` and an `MCPClient` over Streamable HTTP using the `agent` token.
3. Policy: `overdue` and no reminder in the last 15 minutes → `trigger_reminder`;
   `missed` → `notify_caregiver` once; `unknown` → `notify_caregiver` once ("monitoring interrupted").
4. Server: add `notify_caregiver` for the `agent` role only, with `@aws-sdk/client-sns`,
   at most one message per slot and day.
5. Flags: `--once` for a single run, `--dry-run` to print the message instead of publishing it.

## Phase 5: Demo site (done)

`--demo` serves a public page with the emulated pillbox, scenario clock, MCP activity
log and a simulated Alexa+ chat backed by `minimax/minimax-m3.1-flash:free` through
the Nerdit AI gateway. It doubles as phase 3B. See [demo site](../demo-site.md).

## Phase 6: Open Source contribution

1. Port `createMcpHttpHandler` into Arto as `arto serve --http` (`--listen`, `--bind`,
   `--allowed-host`, `--allowed-origin`, `ARTO_MCP_TOKEN`), with the conformance tests adapted to Arto's six tools.
2. Open a pull request on `lwi00/arto` and record its URL for the submission.

## Phase 7: Hosted backup (optional)

1. `Dockerfile` for the emulated pillbox.
2. Deploy to AWS App Runner or Amazon ECS on Fargate with HTTPS; master token in AWS Secrets Manager.

## Phase 8: Video and submission

See [Demo and submission](demo-and-submission.md).

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| No Alexa+ add-on access, or none in the user's locale. | Medium | High | Path B is explicitly allowed. Decide on D1. |
| Alexa+ requires OAuth instead of a static bearer token. | Medium | Medium | Authentication is isolated in one function. Add Cognito and protected resource metadata only if required. |
| Tunnel URL changes between sessions. | High with quick tunnels | Low | Named Cloudflare Tunnel, or update the add-on before recording. |
| Alexa+ picks the wrong tool or rephrases answers. | Medium | Medium | Five tools, precise descriptions, `summary` fields, server instructions. |
| Bedrock model not enabled in the chosen Region. | Low | Medium | Check in phase 0. |
| Hardware failure during recording. | Low | Medium | Emulated board as backup footage. |
| Claims read as medical advice. | Low | High | "The pillbox was opened" wording; not-a-medical-device statement. |
| Scope creep. | Medium | High | One track. Optional phases only after phase 4 passes. |

## Out of scope

- Voice-editable schedules.
- More than four compartments.
- Servo-driven dispensing (no servo driver in Arto).
- Ring, Fire TV or Bee integrations.
- Multi-user accounts.
