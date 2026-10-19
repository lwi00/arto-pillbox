# Alexa+ track compliance

This document checks Arto Pillbox against the Alexa+ track requirement of the
Amazon Developer Hackathon and the MCP specification it references. Each row
names the code that implements the requirement and the test that verifies it.

## Track requirement

> Build a self-hosted MCP server (spec 2025-11-25 or later, Streamable HTTP) or an
> Agent Skill. MCP is the open standard that powers Alexa+ integrations.
>
> Your repo needs to actually call your track's required technology in code, an import,
> an entry point, a loaded agent/flow/MCP config, not just a mention in the README.
>
> Alexa+: show your Agent Skill or MCP server (spec 2025-11-25+, Streamable HTTP) in action.

Arto Pillbox takes the **self-hosted MCP server** option.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Self-hosted MCP server | Met | `src/main.ts` runs the server on your own machine (or your own AWS account). No third-party MCP hosting is involved. |
| MCP specification 2025-11-25 or later | Met | `@modelcontextprotocol/sdk` 1.32.1, whose `LATEST_PROTOCOL_VERSION` is `2025-11-25`. Test: *initialize negotiates protocol version 2025-11-25*. |
| Streamable HTTP transport | Met | `src/http.ts` uses the SDK's `StreamableHTTPServerTransport` on a single `/mcp` endpoint. stdio and the deprecated HTTP+SSE transport are not used. |
| Technology called in code | Met | `src/mcp.ts` imports `McpServer` and registers the tools; `src/http.ts` imports `StreamableHTTPServerTransport`; `src/main.ts` is the entry point (`arto-pillbox serve`). |
| Shown in action | To do | Demo video: Alexa+ (or the simulated path) calling the tools. See [demo script](hackathon/demo-and-submission.md). |

## MCP 2025-11-25: Streamable HTTP transport

Requirements from the *Transports* section of the specification. Tests are in
`tests/conformance.test.ts`.

| Specification requirement | Implementation | Test |
| --- | --- | --- |
| The server provides a single HTTP endpoint that supports POST (and GET, see below). | `MCP_PATH = '/mcp'`; other paths get 404. | *the endpoint is a single path; other paths get 404* |
| Every client message is a new HTTP POST to the endpoint. | Handled by the SDK transport. | *initialize negotiates protocol version 2025-11-25* |
| The client's `Accept` header lists `application/json` and `text/event-stream`. | The SDK returns 406 otherwise. | *a POST whose Accept header omits text/event-stream gets 406* |
| A POST body is a single JSON-RPC request, notification or response. | The SDK returns 415 for a non-JSON content type; `src/http.ts` returns a JSON-RPC parse error (-32700) for invalid JSON. | *a POST with a non-JSON Content-Type gets 415*, *a malformed JSON body gets a JSON-RPC parse error* |
| A notification or response is answered with 202 Accepted and no body. | Handled by the SDK transport. | *a JSON-RPC notification is answered with 202 Accepted and no body* |
| A request is answered with `Content-Type: application/json` or an SSE stream. | JSON responses (`enableJsonResponse: true`). | *a request is answered with Content-Type application/json* |
| A GET either opens an SSE stream or gets 405 Method Not Allowed. | 405 with `Allow: POST`; this server sends no server-initiated messages. | *GET without an SSE stream offer gets 405 Method Not Allowed* |
| Session management is optional. | Stateless: no `MCP-Session-Id` is issued; DELETE gets 405. | *no session id is issued (stateless mode)*, *DELETE gets 405 because the server is stateless* |
| The client sends `MCP-Protocol-Version` on later requests; an invalid or unsupported version gets 400 Bad Request. | Checked by the SDK transport. | *an unsupported MCP-Protocol-Version header gets 400 Bad Request* |
| Servers **must** validate the `Origin` header and answer 403 Forbidden when it is invalid (DNS rebinding). | `src/http.ts`: an `Origin` outside `--allowed-origin` gets 403. Requests without `Origin` (server-to-server clients such as Alexa+) are accepted. The `Host` header is also checked against loopback plus `--allowed-host`. | *a request with a foreign Origin gets 403*, *a request with an allowed Origin is accepted*, *a request with a foreign Host gets 403* |
| Local servers **should** bind only to localhost. | `--bind` defaults to `127.0.0.1`. Public access goes through a tunnel or a reverse proxy that terminates HTTPS. | Reviewed in `src/main.ts` |
| Servers **should** implement authentication. | Bearer token per client role (`alexa`, `agent`), compared in constant time; 401 with `WWW-Authenticate: Bearer` otherwise. | *a request without a bearer token gets 401 with WWW-Authenticate*, *a request with a wrong bearer token gets 401* |

## MCP 2025-11-25: lifecycle and server features

| Specification requirement | Implementation | Test |
| --- | --- | --- |
| `initialize` returns the negotiated `protocolVersion`, `capabilities` and `serverInfo`. | `SERVER_INFO` and `instructions` in `src/mcp.ts`. | *initialize negotiates protocol version 2025-11-25* |
| If the client requests an unsupported version, the server replies with a version it supports. | Handled by the SDK: `2025-11-25`. | *an unknown requested version falls back to the latest supported version* |
| Earlier supported versions remain usable. | Handled by the SDK. | *an older supported version is accepted (backward compatibility)* |
| A server that offers tools declares the `tools` capability. | Declared by `McpServer` when tools are registered. | *initialize negotiates protocol version 2025-11-25* |
| Tool names are 1 to 128 characters from `A-Z a-z 0-9 _ - .`. | `snake_case` names. | *tools/list exposes task-level tools with schemas and annotations, and no raw pin access* |
| Tools declare an input schema of type `object`; an output schema, if declared, constrains `structuredContent`. | Every tool has a Zod input and output schema, a `title` and annotations. | *tools/call returns structuredContent that validates against the output schema* |
| Tool execution errors are reported in the result with `isError: true`, not as protocol errors. | `failure()` in `src/mcp.ts`; argument validation errors are returned the same way by the SDK. | *invalid tool arguments are reported as a tool error, not a transport failure* |

## Points not yet verified against Alexa+

Amazon's Alexa+ developer documentation could not be read from the environment that
wrote this file. Check these points in the Alexa+ MCP QuickStart before the
integration phase, then update this table.

| Question | Why it matters | Current design |
| --- | --- | --- |
| Does the Alexa+ add-on accept a static bearer token, or does it require OAuth 2.1 (MCP *Authorization* section: protected resource metadata, RFC 9728)? | The MCP authorization flow needs an authorization server and a `/.well-known/oauth-protected-resource` document, which this server does not provide yet. | Static bearer token per role. Authentication is isolated in `createMcpHttpHandler`, so an OAuth layer (for example Amazon Cognito) can replace it without touching the tools. |
| Must the endpoint be public HTTPS, and are self-signed certificates or tunnels accepted? | Alexa+ calls the server from the Amazon cloud. | Local server behind a Cloudflare Tunnel or ngrok, started with `--allowed-host <tunnel hostname>`. |
| Does Alexa+ send an `Origin` header? | A browser-style origin would be rejected unless allowed. | Requests without `Origin` are accepted; add `--allowed-origin` if Alexa+ sends one. |
| Does Alexa+ need prompts or resources in addition to tools? | Only tools are exposed. | Tools only, plus server `instructions`. |
| Which locales and accounts can use Alexa+ add-ons? | Decides between the real add-on and the simulated path, which the rules also accept. | See [plan, phase 0](hackathon/plan.md#phase-0-verify-access). |

## Re-running the checks

```sh
npm test
```

The conformance suite starts the real server against the emulated Uno on an
ephemeral port and talks to it with both raw HTTP requests and the official MCP
SDK client. It needs no hardware, network access or credentials.

To check a deployed endpoint by hand, use the MCP Inspector with transport
"Streamable HTTP", the public URL ending in `/mcp`, and the header
`Authorization: Bearer <alexa token>`.
