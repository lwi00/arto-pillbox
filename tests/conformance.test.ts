/**
 * Conformance tests for the MCP Streamable HTTP transport, specification 2025-11-25.
 *
 * Each test names the requirement it checks. See docs/alexa-plus-compliance.md for the
 * full requirement matrix.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_POST_HEADERS, TOKENS, TestClock, initializeBody, raw, startPillbox } from './helpers.js';

const auth = { authorization: `Bearer ${TOKENS.alexa}` };
let env: Awaited<ReturnType<typeof startPillbox>>;

before(async () => { env = await startPillbox(new TestClock(new Date('2026-10-20T09:30:00Z'))); });
after(async () => { await env.close(); });

describe('Lifecycle and version negotiation', () => {
  test('initialize negotiates protocol version 2025-11-25', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth }, initializeBody('2025-11-25'));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.result.protocolVersion, '2025-11-25');
    assert.equal(body.result.serverInfo.name, 'arto-pillbox');
    assert.ok(body.result.capabilities.tools, 'server declares the tools capability');
    assert.match(body.result.instructions, /not a medical device/);
  });

  test('an older supported version is accepted (backward compatibility)', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth }, initializeBody('2025-06-18'));
    assert.equal(JSON.parse(res.body).result.protocolVersion, '2025-06-18');
  });

  test('an unknown requested version falls back to the latest supported version', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth }, initializeBody('2099-01-01'));
    assert.equal(JSON.parse(res.body).result.protocolVersion, '2025-11-25');
  });

  test('the official SDK client connects and negotiates 2025-11-25', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(env.url), { requestInit: { headers: auth } });
    const client = new Client({ name: 'conformance-test', version: '1.0.0' });
    await client.connect(transport);
    assert.equal(transport.protocolVersion, '2025-11-25');
    assert.equal(client.getServerVersion()?.name, 'arto-pillbox');
    await client.close();
  });
});

describe('Streamable HTTP transport', () => {
  test('a JSON-RPC notification is answered with 202 Accepted and no body', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth, 'mcp-protocol-version': '2025-11-25' },
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.equal(res.status, 202);
    assert.equal(res.body, '');
  });

  test('a request is answered with Content-Type application/json', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth, 'mcp-protocol-version': '2025-11-25' },
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.deepEqual(JSON.parse(res.body), { jsonrpc: '2.0', id: 7, result: {} });
  });

  test('an unsupported MCP-Protocol-Version header gets 400 Bad Request', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth, 'mcp-protocol-version': '1999-01-01' },
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
    assert.equal(res.status, 400);
  });

  test('a POST whose Accept header omits text/event-stream gets 406', async () => {
    const res = await raw(env.port, 'POST', { 'content-type': 'application/json', accept: 'application/json', ...auth }, initializeBody());
    assert.equal(res.status, 406);
  });

  test('a POST with a non-JSON Content-Type gets 415', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, 'content-type': 'text/plain', ...auth }, initializeBody());
    assert.equal(res.status, 415);
  });

  test('a malformed JSON body gets a JSON-RPC parse error', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth }, '{not json');
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, -32700);
  });

  test('GET without an SSE stream offer gets 405 Method Not Allowed', async () => {
    const res = await raw(env.port, 'GET', { accept: 'text/event-stream', ...auth });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST');
  });

  test('DELETE gets 405 because the server is stateless', async () => {
    const res = await raw(env.port, 'DELETE', { ...auth });
    assert.equal(res.status, 405);
  });

  test('the endpoint is a single path; other paths get 404', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth }, initializeBody(), '/other');
    assert.equal(res.status, 404);
  });

  test('no session id is issued (stateless mode)', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth }, initializeBody());
    assert.equal(res.headers['mcp-session-id'], undefined);
  });
});

describe('Security', () => {
  test('a request with a foreign Origin gets 403 (DNS rebinding protection)', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth, origin: 'https://evil.example' }, initializeBody());
    assert.equal(res.status, 403);
  });

  test('a request with an allowed Origin is accepted', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth, origin: 'https://allowed.example' }, initializeBody());
    assert.equal(res.status, 200);
  });

  test('a request with a foreign Host gets 403', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, ...auth, host: 'attacker.example' }, initializeBody());
    assert.equal(res.status, 403);
  });

  test('a request without a bearer token gets 401 with WWW-Authenticate', async () => {
    const res = await raw(env.port, 'POST', MCP_POST_HEADERS, initializeBody());
    assert.equal(res.status, 401);
    assert.match(String(res.headers['www-authenticate']), /^Bearer/);
  });

  test('a request with a wrong bearer token gets 401', async () => {
    const res = await raw(env.port, 'POST', { ...MCP_POST_HEADERS, authorization: `Bearer ${'c'.repeat(64)}` }, initializeBody());
    assert.equal(res.status, 401);
  });

  test('the token is checked before the method, so GET without a token gets 401', async () => {
    const res = await raw(env.port, 'GET', { accept: 'text/event-stream' });
    assert.equal(res.status, 401);
  });
});

describe('Tools', () => {
  test('tools/list exposes task-level tools with schemas and annotations, and no raw pin access', async () => {
    const client = new Client({ name: 'conformance-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(env.url), { requestInit: { headers: auth } }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['get_device_health', 'get_intake_history', 'get_intake_status', 'stop_reminder', 'trigger_reminder']);
    for (const tool of tools) {
      assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/, 'tool name follows the 2025-11-25 naming rules');
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.outputSchema?.type, 'object');
      assert.ok(tool.title && tool.description && tool.annotations);
    }
    assert.ok(!tools.some(t => t.name === 'set_component'));
    await client.close();
  });

  test('tools/call returns structuredContent that validates against the output schema', async () => {
    const client = new Client({ name: 'conformance-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(env.url), { requestInit: { headers: auth } }));
    const result = await client.callTool({ name: 'get_intake_status', arguments: {} });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as { summary: string; slots: Array<{ slot: string; state: string }> };
    assert.equal(content.slots[0].state, 'overdue');
    assert.match(content.summary, /Morning pills: not opened yet/);
    await client.close();
  });

  test('invalid tool arguments are reported as a tool error, not a transport failure', async () => {
    const client = new Client({ name: 'conformance-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(env.url), { requestInit: { headers: auth } }));
    const result = await client.callTool({ name: 'trigger_reminder', arguments: { slot: 'noon', seconds: 20 } });
    assert.equal(result.isError, true);
    await client.close();
  });
});
