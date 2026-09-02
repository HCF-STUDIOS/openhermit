import type { StreamFn, AgentTool } from '@mariozechner/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ThinkingContent,
  type TextContent,
  type ToolCall,
} from '@mariozechner/pi-ai';
import type { TSchema } from 'typebox';

import type { Toolset } from '../tools/shared.js';
import { asTextContent } from '../tools/shared.js';
import {
  AMIKO_CLI_CATALOG,
  getCatalogEntry,
  runAmikoTool,
  searchCatalog,
  toFunctionDeclaration,
  type FunctionDeclaration,
} from '../tools/amiko-cli-catalog.js';

/**
 * Google Interactions API adapter with client-side Tool Retrieval
 * (`tool_search`) over the Amiko CLI catalog.
 *
 * Context (issue #262): the EAP model `gemini-flash-tool-retrieval` requires
 * the Interactions API (`/v1beta/interactions`) — pi-ai's google provider only
 * speaks generateContent, and OpenHermit's default loop dumps every built-in
 * tool schema each turn, which defeats Tool Retrieval. This adapter:
 *
 * - replaces the transport for models with `api: 'google-interactions'` via a
 *   composable StreamFn wrapper (pi-agent-core still runs the tool loop, so
 *   session events, persistence, approval gating, and Langfuse tracing are
 *   unchanged);
 * - advertises ONLY `tool_search` (execution: "client") to the model, plus the
 *   function declarations already surfaced by earlier `amiko_tool_search`
 *   results in this context — never the full OpenHermit toolset;
 * - runs stateless (`store: false`), replaying the full step history each call
 *   and round-tripping thought signatures via pi-ai's `thinkingSignature` /
 *   `thoughtSignature` fields.
 *
 * Server-side `defer_loading: true` with full parameters is known to 400 on
 * this EAP model — do not add it here; client-side execution is the supported
 * mode until Google fixes it.
 */

/** `AgentModelConfig.api` value that routes a model through this adapter. */
export const GOOGLE_INTERACTIONS_API = 'google-interactions';

export const TOOL_SEARCH_NAME = 'amiko_tool_search';

const API_REVISION = '2026-05-20';

export const isToolRetrievalModel = (model: { api?: string }): boolean =>
  model.api === GOOGLE_INTERACTIONS_API;

// --- local toolset -----------------------------------------------------------

interface ToolSearchDetails {
  declarations: FunctionDeclaration[];
}

/**
 * The `amiko_tool_search` result content is the JSON the Interactions loop
 * sends back in `function_result.result` — an array of FunctionDeclarations.
 * The stream adapter also re-reads it from history to know which catalog
 * tools are unlocked for subsequent turns.
 */
const createToolSearchTool = (): AgentTool<TSchema, ToolSearchDetails> => ({
  name: TOOL_SEARCH_NAME,
  label: 'Amiko Tool Search',
  description:
    'Search the Amiko CLI tool catalog. Returns function declarations for matching tools, which become callable on the next turn.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What kind of tool you are looking for.' },
      limit: { type: 'number', description: 'Maximum number of tools to return (default 8).' },
    },
    required: ['query'],
  } as unknown as TSchema,
  execute: async (_toolCallId, params: unknown) => {
    const { query, limit } = (params ?? {}) as { query?: string; limit?: number };
    const declarations = searchCatalog(query ?? '', limit ?? 8).map(toFunctionDeclaration);
    return {
      content: asTextContent(JSON.stringify({ tools: declarations })),
      details: { declarations },
    };
  },
});

const createCatalogTool = (name: string): AgentTool<TSchema> => {
  const entry = getCatalogEntry(name)!;
  return {
    name: entry.name,
    label: entry.name,
    description: entry.description,
    parameters: entry.parameters as unknown as TSchema,
    execute: async (_toolCallId, params: unknown, signal?: AbortSignal) => {
      const result = await runAmikoTool(entry.name, (params ?? {}) as Record<string, unknown>, {
        ...(signal ? { signal } : {}),
      });
      const body = result.exitCode === 0
        ? result.stdout.trim() || '(no output)'
        : `Command failed (exit ${result.exitCode}).\nstdout:\n${result.stdout.trim()}\nstderr:\n${result.stderr.trim()}`;
      return {
        content: asTextContent(body),
        details: { command: result.command, exitCode: result.exitCode },
      };
    },
  };
};

const AMIKO_TOOLSET_DESCRIPTION = `\
### Amiko CLI (Tool Retrieval)

Tools for the Amiko platform are discovered at runtime: call \`${TOOL_SEARCH_NAME}\` with a
description of what you need (e.g. "credits balance"), then call the returned tools.`;

/**
 * Toolset installed in the agent's state for tool-retrieval models. All
 * catalog tools are registered so pi-agent-core can execute whatever the
 * model calls — but the stream adapter only ADVERTISES tool_search plus
 * already-searched declarations to the API.
 */
export const createAmikoToolRetrievalToolset = (): Toolset => ({
  id: 'amiko-cli-tool-retrieval',
  description: AMIKO_TOOLSET_DESCRIPTION,
  tools: [
    { ...createToolSearchTool(), policy: { defaultGrants: [{ type: 'any' }] } },
    ...AMIKO_CLI_CATALOG.map((entry) => ({
      ...createCatalogTool(entry.name),
      // Mutating commands (chat send, …) default to owner-only; readonly ones are open.
      policy: entry.readonly
        ? { defaultGrants: [{ type: 'any' as const }] }
        : { defaultGrants: [{ type: 'role' as const, value: 'owner' as const }] },
    })),
  ],
});

// --- message mapping ---------------------------------------------------------

type InteractionStep = Record<string, unknown>;

const textBlocks = (content: UserContent): Array<{ type: 'text'; text: string }> => {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => ({ type: 'text' as const, text: b.text }));
};

type UserContent = string | Array<TextContent | { type: string; [k: string]: unknown }>;

/**
 * Map pi-ai transcript messages to Interactions steps (stateless replay).
 * Thought signatures ride along: `thinking` blocks carry `thinkingSignature`,
 * tool calls carry `thoughtSignature`; both were captured verbatim from
 * earlier Interactions responses by `parseInteractionSteps`.
 *
 * Image/attachment content is dropped with a placeholder — this EAP smoke
 * path is text-only.
 */
export const mapMessagesToSteps = (messages: Message[]): InteractionStep[] => {
  const steps: InteractionStep[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      steps.push({
        type: 'user_input',
        content: textBlocks(message.content as UserContent),
      });
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'thinking') {
          const t = block as ThinkingContent;
          // Signature is required by the API for replayed thoughts; a thought
          // captured without one cannot be replayed and is skipped.
          if (!t.thinkingSignature) continue;
          steps.push({
            type: 'thought',
            ...(t.thinking ? { summary: t.thinking } : {}),
            signature: t.thinkingSignature,
          });
        } else if (block.type === 'text') {
          steps.push({
            type: 'model_output',
            content: [{ type: 'text', text: (block as TextContent).text }],
          });
        } else if (block.type === 'toolCall') {
          const call = block as ToolCall;
          steps.push({
            type: 'function_call',
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? {},
            ...(call.thoughtSignature ? { signature: call.thoughtSignature } : {}),
          });
        }
      }
    } else if (message.role === 'toolResult') {
      steps.push({
        type: 'function_result',
        name: message.toolName,
        call_id: message.toolCallId,
        result: textBlocks(message.content as UserContent),
      });
    }
  }
  return steps;
};

/**
 * Names of catalog tools already surfaced by `amiko_tool_search` results in
 * this transcript. Only these (plus tool_search itself) are advertised.
 */
export const collectUnlockedToolNames = (messages: Message[]): string[] => {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== TOOL_SEARCH_NAME) continue;
    for (const block of message.content) {
      if (block.type !== 'text') continue;
      try {
        const parsed = JSON.parse(block.text) as { tools?: Array<{ name?: string }> };
        for (const tool of parsed.tools ?? []) {
          if (tool.name && getCatalogEntry(tool.name)) names.add(tool.name);
        }
      } catch {
        // Not JSON (e.g. an error result) — nothing unlocked by this block.
      }
    }
  }
  return [...names];
};

/** Client-side tool_search declaration sent every turn. */
const toolSearchDeclaration = (): Record<string, unknown> => ({
  type: 'tool_search',
  execution: 'client',
  name: TOOL_SEARCH_NAME,
  description:
    'Search the Amiko CLI tool catalog for tools matching a natural-language need. '
    + 'Returns function declarations that become callable afterwards.',
});

export const buildInteractionsRequest = (
  model: Model<never> | { id: string },
  context: Context,
  options?: { maxTokens?: number },
): Record<string, unknown> => {
  const unlocked = collectUnlockedToolNames(context.messages);
  const declarations = unlocked
    .map((name) => getCatalogEntry(name))
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
    .map(toFunctionDeclaration);
  return {
    model: (model as { id: string }).id,
    store: false,
    ...(context.systemPrompt ? { system_instruction: context.systemPrompt } : {}),
    input: mapMessagesToSteps(context.messages),
    tools: [toolSearchDeclaration(), ...declarations],
    ...(options?.maxTokens
      ? { generation_config: { max_output_tokens: options.maxTokens } }
      : {}),
  };
};

// --- response parsing --------------------------------------------------------

interface InteractionResponse {
  id?: string;
  status?: string;
  steps?: InteractionStep[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: unknown;
}

export const parseInteractionSteps = (
  response: InteractionResponse,
  base: { provider: string; model: string },
): AssistantMessage => {
  const content: AssistantMessage['content'] = [];
  for (const step of response.steps ?? []) {
    const type = step.type as string;
    if (type === 'thought') {
      content.push({
        type: 'thinking',
        thinking: typeof step.summary === 'string' ? step.summary : '',
        ...(typeof step.signature === 'string' ? { thinkingSignature: step.signature } : {}),
      } as ThinkingContent);
    } else if (type === 'model_output') {
      const blocks = Array.isArray(step.content) ? step.content : [];
      for (const block of blocks as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          content.push({ type: 'text', text: block.text });
        }
      }
    } else if (type === 'function_call') {
      content.push({
        type: 'toolCall',
        id: typeof step.id === 'string' ? step.id : `call_${Math.random().toString(36).slice(2)}`,
        name: String(step.name ?? ''),
        arguments: (step.arguments ?? {}) as Record<string, unknown>,
        ...(typeof step.signature === 'string' ? { thoughtSignature: step.signature } : {}),
      } as ToolCall);
    }
    // user_input / function_result steps in the echo (if any) are replay, not output.
  }

  const usage = response.usage ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const hasToolCall = content.some((b) => b.type === 'toolCall');
  return {
    role: 'assistant',
    content,
    api: GOOGLE_INTERACTIONS_API as never,
    provider: base.provider as never,
    model: base.model,
    ...(response.id ? { responseId: response.id } : {}),
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.total_tokens ?? input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: hasToolCall ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
};

// --- stream adapter ----------------------------------------------------------

export interface GoogleInteractionsOptions {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override API host (default generativelanguage.googleapis.com). */
  baseUrl?: string;
}

const errorMessageFor = (
  base: { provider: string; model: string },
  errorMessage: string,
  reason: 'error' | 'aborted' = 'error',
): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: GOOGLE_INTERACTIONS_API as never,
  provider: base.provider as never,
  model: base.model,
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: reason,
  errorMessage,
  timestamp: Date.now(),
});

/**
 * Wrap a StreamFn so tool-retrieval models are served over the Interactions
 * API. All other models pass through to the wrapped function untouched, so
 * this composes with the existing Langfuse/attribution wrapper chain.
 */
export const withGoogleInteractionsToolRetrieval = (
  base: StreamFn,
  adapterOptions: GoogleInteractionsOptions = {},
): StreamFn => {
  return (model, context, options) => {
    if (!isToolRetrievalModel(model as { api?: string })) {
      return base(model, context, options);
    }

    const stream = createAssistantMessageEventStream();
    const fetchImpl = adapterOptions.fetchImpl ?? fetch;
    // The EAP Interactions endpoint host is deployment-specific — never guess.
    // Sources, in order: adapter option (tests), model.baseUrl (config.model.
    // base_url), GOOGLE_INTERACTIONS_BASE_URL env.
    const configuredBaseUrl = adapterOptions.baseUrl
      ?? (model as { baseUrl?: string }).baseUrl
      ?? process.env.GOOGLE_INTERACTIONS_BASE_URL;
    const modelBase = {
      provider: String((model as { provider?: string }).provider ?? 'google'),
      model: String((model as { id?: string }).id ?? 'gemini-flash-tool-retrieval'),
    };

    void (async () => {
      try {
        if (!configuredBaseUrl) {
          stream.push({
            type: 'error',
            reason: 'error',
            error: errorMessageFor(
              modelBase,
              'No Interactions endpoint configured for this EAP model. Set config.model.base_url or the GOOGLE_INTERACTIONS_BASE_URL environment variable to the endpoint host provided with your EAP access.',
            ),
          });
          return;
        }
        const baseUrl = configuredBaseUrl.replace(/\/+$/, '');
        const apiKey = options?.apiKey
          ?? process.env.GEMINI_API_KEY
          ?? process.env.GOOGLE_API_KEY;
        if (!apiKey) {
          stream.push({
            type: 'error',
            reason: 'error',
            error: errorMessageFor(modelBase, 'Missing Google API key (GEMINI_API_KEY / GOOGLE_API_KEY) for the Interactions API.'),
          });
          return;
        }

        const request = buildInteractionsRequest(model as { id: string }, context, {
          ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
        });

        // A bare host gets the documented path appended; a URL already ending
        // in /interactions is used verbatim (EAP endpoints may differ).
        const endpoint = /\/interactions\/?$/.test(baseUrl)
          ? baseUrl
          : `${baseUrl}/v1beta/interactions`;
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
            'Api-Revision': API_REVISION,
            ...(options?.headers ?? {}),
          },
          body: JSON.stringify(request),
          ...(options?.signal ? { signal: options.signal } : {}),
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          stream.push({
            type: 'error',
            reason: 'error',
            error: errorMessageFor(
              modelBase,
              `Interactions API error ${response.status}: ${bodyText.slice(0, 2000)}`,
            ),
          });
          return;
        }

        const payload = (await response.json()) as InteractionResponse;
        if (payload.status === 'failed') {
          stream.push({
            type: 'error',
            reason: 'error',
            error: errorMessageFor(modelBase, `Interaction failed: ${JSON.stringify(payload.error ?? payload).slice(0, 2000)}`),
          });
          return;
        }

        const message = parseInteractionSteps(payload, modelBase);
        // Non-streaming under the hood: replay the parsed message as protocol
        // events so downstream consumers (session events, UI) see the usual
        // start → block start/end → done sequence.
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        message.content.forEach((block, contentIndex) => {
          if (block.type === 'text') {
            stream.push({ type: 'text_start', contentIndex, partial: message });
            stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: message });
            stream.push({ type: 'text_end', contentIndex, content: block.text, partial: message });
          } else if (block.type === 'thinking') {
            stream.push({ type: 'thinking_start', contentIndex, partial: message });
            if (block.thinking) {
              stream.push({ type: 'thinking_delta', contentIndex, delta: block.thinking, partial: message });
            }
            stream.push({ type: 'thinking_end', contentIndex, content: block.thinking, partial: message });
          } else if (block.type === 'toolCall') {
            stream.push({ type: 'toolcall_start', contentIndex, partial: message });
            stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: message });
          }
        });
        stream.push({
          type: 'done',
          reason: message.stopReason as 'stop' | 'toolUse',
          message,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        stream.push({
          type: 'error',
          reason: aborted ? 'aborted' : 'error',
          error: errorMessageFor(
            modelBase,
            error instanceof Error ? error.message : String(error),
            aborted ? 'aborted' : 'error',
          ),
        });
      }
    })();

    return stream;
  };
};
