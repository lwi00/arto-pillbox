# Demo and submission

## Video script

Target length: 2 min 40 s. Judges may stop at 3 minutes, so the Alexa+ interaction
comes first. The video is in English, public on YouTube or Vimeo, with no
third-party music or footage.

| Time | Shot | Voice-over or dialogue |
| --- | --- | --- |
| 0:00 to 0:15 | Pillbox with the Uno visible, LED off. | "My mum lives alone and takes pills twice a day. This pillbox is an Arduino, and Alexa+ can talk to it." |
| 0:15 to 0:40 | Person asks the Echo, or the simulated page. Dashboard visible beside it. | "Alexa, did Mum open her pillbox this morning?" Answer: "Not yet. The morning window closes at 11." |
| 0:40 to 1:05 | Request a reminder. LED and buzzer turn on. | "Alexa, remind her." The dashboard shows the `trigger_reminder` call. |
| 1:05 to 1:20 | Lid opens and the buzzer stops at once. | "The Arduino firmware silences the buzzer as soon as the lid opens. That safety rule doesn't depend on the AI." |
| 1:20 to 1:35 | Ask again. | "Alexa, did she open it?" Answer: "Yes, at 9:42." |
| 1:35 to 2:05 | Missed evening dose: agent run in the terminal, then the caregiver email. | "A Strands agent on Amazon Bedrock checks the schedule. When a dose is missed, it sends me a short, specific message through Amazon SNS." |
| 2:05 to 2:30 | `board.json` next to the architecture diagram. | "The whole device is this JSON file. Arto turns the Arduino wiring into MCP tools over Streamable HTTP. Swap the manifest and the same stack runs a garage door or plant watering." |
| 2:30 to 2:40 | Repository URL and license. | "Open source, MIT. Not a medical device." |

Recording checklist:

- [ ] Clock, schedule and history set so each window is in the right state.
- [ ] Tunnel URL stable and add-on pointed at it.
- [ ] Dashboard at a readable zoom level.
- [ ] Agent run with `--once`, and SNS email delivered.
- [ ] No tokens, account ids or email addresses visible on screen.
- [ ] Backup take recorded against the emulated board.

## Submission checklist

| Item | Source | Done |
| --- | --- | --- |
| Project description: what it does and how it works. | [README](../../README.md) and [architecture](../architecture.md). | [ ] |
| GitHub repository with all source, assets and run instructions. | This repository. | [ ] |
| Repository access: public with a license, or private and shared. | See below. | [ ] |
| Alexa+ technology called in code (MCP server, spec 2025-11-25, Streamable HTTP). | `src/http.ts`, `src/mcp.ts`, `src/main.ts`; see the [compliance matrix](../alexa-plus-compliance.md). | [x] |
| Demo video under 3 minutes, public, in English. | Script above. | [ ] |
| Product feedback for every tool, API and SDK used. | Template below. | [ ] |
| Tracks: Alexa+; mini challenges: AWS Builder and Open Source. | [Hackathon README](README.md#entry). | [ ] |
| AWS Builder: documented integrations. | Agent README and feedback. | [ ] |
| Open Source: contribution URL (pull request on `lwi00/arto`), repository URL, GitHub username `lwi00`, description. | [Plan, phase 6](plan.md#phase-6-open-source-contribution). | [ ] |
| Pre-existing project disclosure. | Section below. | [ ] |
| Optional: feature requests. | Template below. | [ ] |
| Optional: friction log (up to 10% judging bonus). | Template below. | [ ] |

### Repository access

`lwi00/arto-pillbox` is MIT licensed. If it is public at submission time, the license
is enough. If it is private, add these collaborators on the day of submission, because
invitations expire after seven days: `chris-trag`, `knmeiss`, `giolaq`, `anishamalde`,
`mosesroth`, `emersonsklar`. Also share it with `testing@devpost.com`, as the rules require.

`lwi00/arto` is public, so the dependency installs for reviewers without extra access.

## Pre-existing project disclosure

Draft text, to be completed with the final commit ranges:

> Arto Pillbox (`lwi00/arto-pillbox`) was created during the submission window. It
> depends on Arto (`lwi00/arto`), an MIT-licensed framework that existed before the
> hackathon and exposes Arduino Uno sensors and actuators to MCP clients over stdio
> (baseline commit `3b87b01`).
>
> Built during the window, in `arto-pillbox`: the self-hosted MCP server over
> Streamable HTTP (spec 2025-11-25) with bearer roles and Host/Origin validation; the
> pillbox domain (schedule, lid tracking with coverage-aware missed/unknown states,
> bounded reminders, history); the MCP tools; the Alexa+ integration; the Strands
> Agents scheduler on Amazon Bedrock with SNS notifications; the conformance tests and
> documentation.
>
> Changed during the window, in `arto`: a `prepare` build script for Git installs and a
> Streamable HTTP mode contributed as a pull request (`<URL>`).

## Product feedback template

Fill in one block per product.

```markdown
### <Product: Alexa+ MCP toolkit | Amazon Bedrock | Strands Agents SDK | Amazon SNS | AgentCore | ...>
- Used for:
- What worked well:
- What needs work:
- Onboarding:
- Would build with it again: yes / no, because
```

AWS services must be described in the feedback answer: which ones and how.

## Feature request template

```markdown
### <Title>
- Product:
- Request:
- Why it matters:
- Urgency: critical | important | nice-to-have
```

## Friction log template

Record entries as they happen. Keep them in `docs/hackathon/friction-log.md`
(to be created at the first entry).

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
