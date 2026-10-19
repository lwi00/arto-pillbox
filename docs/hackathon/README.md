# Amazon Developer Hackathon 2026

Working documents for the hackathon entry. User-facing documentation is in the
[parent folder](../README.md).

| Document | Contents |
| --- | --- |
| [Plan](plan.md) | Repositories, phases and status, tasks, risks, scope. |
| [Demo and submission](demo-and-submission.md) | Video script, submission checklist, disclosure text, feedback and friction log templates. |
| [Alexa+ compliance](../alexa-plus-compliance.md) | Requirement matrix with code and test evidence. |

## Entry

| Item | Choice |
| --- | --- |
| Primary track | Alexa+: self-hosted MCP server, spec 2025-11-25, Streamable HTTP. |
| Fallback path | Simulated Alexa+ experience in a web app, if add-on access is unavailable. |
| Mini challenge | AWS Builder: Strands Agents SDK, Amazon Bedrock, Amazon SNS. |
| Mini challenge | Open Source: Streamable HTTP mode contributed to `lwi00/arto`. |
| Priority category | Caretaking and accessibility. |

Each project can win one track prize and one mini challenge prize.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Use case | Pillbox for a person living alone, with a remote caregiver. | Concrete, easy to film, aligned with the caretaking priority. |
| Repositories | New `arto-pillbox` repository depending on `arto`; no fork. | Everything in the entry was built during the window; Arto stays generic; the Arto pull request is a separate Open Source contribution. |
| MCP transport | Stateless Streamable HTTP, JSON responses, one `/mcp` endpoint. | Required by the track; no server-initiated messages are needed. |
| Authentication | One bearer token per role, derived from a master secret. | Simple for the demo; isolated so OAuth can replace it if Alexa+ requires it. |
| Hardware | Physical Uno for the video; AVR8js for development, tests and fallback. | The user owns an Uno; the emulator removes hardware from the critical path. |
| Firmware | Unchanged Arto firmware. | Inputs, outputs and interlocks cover the design. |
| Actuators | LED and active buzzer. No servo. | Arto has no servo driver. |
| `missed` semantics | Only after continuous monitoring of the whole window. | Never claim an absence that was not observed. |
| Documentation language | English. | Required for the submission; read by Amazon judges. |

## Open questions

| Question | Blocks | Owner |
| --- | --- | --- |
| Alexa+ add-on access and locale. | Phase 3 path. | User |
| Bearer token or OAuth for the Alexa+ add-on? | Phase 3A. | User, from the Alexa+ MCP QuickStart |
| Alexa+ simulator, or Echo device required? | Phase 3 testing and video. | User |
| Exact submission deadline and time zone. | Schedule. | User |
| Bedrock model and AWS Region. | Phase 4. | User |
| Reed switch available, or push button stand-in? | Phase 2 wiring. | User |
