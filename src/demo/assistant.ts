import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** OpenAI-compatible chat model settings. */
export interface ModelConfig {
  /** Base URL ending before `/chat/completions`, such as `https://openrouter.ai/api/v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** One turn of the visible conversation. */
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/** One MCP tool call made while answering. */
export interface TraceStep { tool: string; arguments: Record<string, unknown>; isError: boolean; summary: string }

/** Answer to one user message. */
export interface AssistantReply { reply: string; trace: TraceStep[] }

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

const SYSTEM_PROMPT = `You are a voice assistant in a SIMULATED Alexa+ experience, helping a family caregiver check on a relative's connected pillbox.
Always call a pillbox tool before answering a question about the pillbox; never guess its state.
Answer in one or two short spoken sentences, in the user's language. Prefer the "summary" field of tool results.
Say "the pillbox was opened", never "the medication was taken". Do not give medical advice.`;

const MAX_TOOL_ROUNDS = 4;

/**
 * Reads model settings from the environment variables Nerdit injects for an AI binding.
 *
 * Args:
 *   env: Process environment.
 *
 * Returns:
 *   The model configuration, or `undefined` if any variable is missing.
 */
export function modelConfigFromEnv(env: NodeJS.ProcessEnv): ModelConfig | undefined {
  const baseUrl = env.OPENAI_BASE_URL, apiKey = env.OPENAI_API_KEY, model = env.OPENAI_MODEL;
  if (!baseUrl || !apiKey || !model) return undefined;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

/**
 * A chat assistant that answers through the pillbox's own MCP endpoint, like Alexa+ would.
 *
 * Every question goes to an OpenAI-compatible chat model with the pillbox tools listed
 * by MCP `tools/list`. Tool calls are executed with MCP `tools/call` over Streamable
 * HTTP, authenticated with the `alexa` role token, so the demo exercises the same
 * endpoint and checks as an external client.
 */
export class PillboxAssistant {
  /**
   * Creates an assistant.
   *
   * Args:
   *   mcpUrl: URL of the pillbox MCP endpoint, normally on loopback.
   *   token: Bearer token of the role to act as.
   *   model: Chat model settings.
   *   fetchImpl: Fetch implementation, injectable for tests.
   */
  constructor(readonly mcpUrl: string, private readonly token: string, readonly model: ModelConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  /**
   * Answers one user message.
   *
   * Args:
   *   message: The new user message.
   *   history: Previous visible turns, oldest first.
   *
   * Returns:
   *   The spoken reply and the MCP tool calls made to produce it.
   *
   * Throws:
   *   Error: If the model endpoint fails or returns an unusable response.
   */
  async ask(message: string, history: ChatTurn[] = []): Promise<AssistantReply> {
    const client = new Client({ name: 'pillbox-demo-assistant', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${this.token}` } } }));
    try {
      const { tools } = await client.listTools();
      const functions = tools.map(tool => ({
        type: 'function' as const,
        function: { name: tool.name, description: tool.description ?? tool.title ?? tool.name, parameters: withoutSchemaKey(tool.inputSchema) },
      }));
      const messages: Message[] = [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nServer instructions:\n${client.getInstructions() ?? ''}` },
        ...history.map(turn => ({ role: turn.role, content: turn.content }) as Message),
        { role: 'user', content: message },
      ];
      const trace: TraceStep[] = [];
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const choice = await this.complete(messages, round < MAX_TOOL_ROUNDS ? functions : undefined);
        const calls = choice.tool_calls ?? [];
        if (calls.length === 0) return { reply: cleanReply(choice.content), trace };
        messages.push({ role: 'assistant', content: choice.content ?? null, tool_calls: calls });
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { /* keep {} */ }
          const result = await client.callTool({ name: call.function.name, arguments: args });
          const structured = result.structuredContent as { summary?: string } | undefined;
          const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '';
          trace.push({ tool: call.function.name, arguments: args, isError: Boolean(result.isError), summary: structured?.summary ?? text });
          messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, 6000) });
        }
      }
      return { reply: 'Sorry, I could not finish that request.', trace };
    } finally {
      await client.close();
    }
  }

  private async complete(messages: Message[], tools?: object[]): Promise<{ content?: string | null; tool_calls?: ToolCall[] }> {
    const response = await this.fetchImpl(`${this.model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.model.apiKey}` },
      body: JSON.stringify({ model: this.model.model, messages, ...(tools ? { tools, tool_choice: 'auto' } : {}), temperature: 0.2, max_tokens: 800 }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Model endpoint answered ${response.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
    const choice = body.choices?.[0]?.message;
    if (!choice) throw new Error('Model endpoint returned no choice');
    return choice;
  }
}

/** Removes `$schema`, which some OpenAI-compatible providers reject in tool parameters. */
function withoutSchemaKey(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

/** Removes reasoning blocks some models emit and trims the reply. */
function cleanReply(content: string | null | undefined): string {
  const reply = (content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return reply || 'Sorry, I have no answer.';
}
