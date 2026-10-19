import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Path of the single MCP endpoint, as required by the Streamable HTTP transport. */
export const MCP_PATH = '/mcp';
/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Options for {@link createMcpHttpHandler}. */
export interface McpHttpOptions<R extends string> {
  /** Bearer token for each role. Tokens must be distinct and non-empty. */
  tokens: Record<R, string>;
  /**
   * Accepted `Host` header values, such as `"pillbox.example.com"` or `"127.0.0.1:8080"`.
   * Requests with another host get 403 (DNS rebinding protection).
   */
  allowedHosts: string[];
  /**
   * Accepted `Origin` header values. Requests that carry another `Origin` get 403.
   * Requests without an `Origin` header (server-to-server clients such as Alexa+) are accepted.
   */
  allowedOrigins: string[];
  /** Builds a fresh MCP server for one authenticated request. */
  createServer: (role: R) => McpServer;
  /** Called for each handled request, for logging. */
  onRequest?: (entry: { role?: R; status: number; method?: string; path: string; host?: string }) => void;
}

/**
 * Derives a role token from the master secret.
 *
 * Args:
 *   master: Secret from `PILLBOX_MASTER_TOKEN`.
 *   role: Client role, such as `"alexa"`.
 *
 * Returns:
 *   Hex-encoded `HMAC-SHA256(master, role)`.
 */
export function deriveToken(master: string, role: string): string {
  return createHmac('sha256', master).update(role).digest('hex');
}

/**
 * Creates a Node.js request handler for a stateless Streamable HTTP MCP endpoint.
 *
 * Behaviour, in order:
 *   1. Paths other than {@link MCP_PATH} get 404.
 *   2. A `Host` outside `allowedHosts` or an `Origin` outside `allowedOrigins` gets 403.
 *   3. A missing or wrong bearer token gets 401 with `WWW-Authenticate: Bearer`.
 *   4. `GET` and `DELETE` get 405: this stateless server offers no standalone SSE stream
 *      and no sessions, which the specification allows.
 *   5. `POST` bodies over {@link MAX_BODY_BYTES} get 413; invalid JSON gets a JSON-RPC parse error.
 *   6. Valid requests are passed to the SDK's `StreamableHTTPServerTransport`, which validates
 *      `Accept`, `Content-Type` and `MCP-Protocol-Version` and negotiates the protocol version.
 *
 * Args:
 *   options: Tokens, host and origin allow-lists and the server factory.
 *
 * Returns:
 *   A function suitable for `http.createServer`.
 */
export function createMcpHttpHandler<R extends string>(options: McpHttpOptions<R>) {
  const tokens = Object.entries(options.tokens) as Array<[R, string]>;
  if (tokens.some(([, token]) => !token) || new Set(tokens.map(([, t]) => t)).size !== tokens.length) {
    throw new Error('Each role needs a distinct, non-empty token');
  }
  const expected = tokens.map(([role, token]) => [role, Buffer.from(`Bearer ${token}`)] as const);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    let role: R | undefined;
    const finish = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
      options.onRequest?.({ role, status, method: req.method, path, host: req.headers.host });
    };
    const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
      finish(status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);

    if (path !== MCP_PATH) return finish(404, { error: 'Not found' });
    if (!req.headers.host || !options.allowedHosts.includes(req.headers.host)) return rpcError(403, -32000, 'Forbidden: host not allowed');
    if (req.headers.origin !== undefined && !options.allowedOrigins.includes(req.headers.origin)) return rpcError(403, -32000, 'Forbidden: origin not allowed');

    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    role = expected.find(([, token]) => token.length === supplied.length && timingSafeEqual(token, supplied))?.[0];
    if (!role) return rpcError(401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="arto-pillbox"' });

    if (req.method !== 'POST') return rpcError(405, -32000, 'Method not allowed: this server is stateless and accepts POST only', { Allow: 'POST' });

    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return rpcError(413, -32000, 'Request body too large');
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return rpcError(400, -32700, 'Parse error');
    }

    const server = options.createServer(role);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); options.onRequest?.({ role, status: res.statusCode, method: req.method, path }); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) rpcError(500, -32603, `Internal error: ${(error as Error).message}`);
    }
  };
}
