import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import {
  complete,
  streamSimple,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ProviderStreamOptions,
  type Tool,
} from '@mariozechner/pi-ai';
import { getErrorMessage } from '@openhermit/shared';
import { Langfuse } from 'langfuse';

const LANGFUSE_PUBLIC_KEY = 'LANGFUSE_PUBLIC_KEY';
const LANGFUSE_SECRET_KEY = 'LANGFUSE_SECRET_KEY';
const LANGFUSE_BASE_URL = 'LANGFUSE_BASE_URL';

export interface LangfuseGenerationLike {
  end(body: Record<string, unknown>): unknown;
}

export interface LangfuseTraceLike {
  generation(body: Record<string, unknown>): LangfuseGenerationLike;
  update(body: Record<string, unknown>): unknown;
}

export interface LangfuseClientLike {
  trace(body: Record<string, unknown>): LangfuseTraceLike;
  flushAsync?(): Promise<void>;
  shutdownAsync?(): Promise<void>;
}

export interface LangfuseRequestOptions {
  name: string;
  sessionId?: string;
  agentSessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface LangfuseTurnContext {
  currentTrace: LangfuseTraceLike | undefined;
}

type LangfuseStreamMetadataOptions = {
  transport?: string;
  sessionId?: string;
};

const sanitizeMessageContent = (content: Message['content']) => {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((item) => {
    if (item.type === 'image') {
      return {
        type: item.type,
        mimeType: item.mimeType,
        data: '[omitted]',
      };
    }

    if (item.type === 'thinking') {
      return {
        type: item.type,
        thinking: item.redacted ? '[redacted]' : item.thinking,
        ...(item.redacted ? { redacted: true } : {}),
      };
    }

    return item;
  });
};

const sanitizeMessages = (messages: Context['messages']) =>
  messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: message.role,
        content: sanitizeMessageContent(message.content),
      };
    }

    if (message.role === 'assistant') {
      return {
        role: message.role,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        usage: message.usage,
        content: sanitizeMessageContent(message.content),
      };
    }

    return {
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      content: sanitizeMessageContent(message.content),
    };
  });

const sanitizeTools = (tools: Tool[] | undefined) =>
  tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

const sanitizeContext = (context: Context) => ({
  ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
  messages: sanitizeMessages(context.messages),
  ...(context.tools ? { tools: sanitizeTools(context.tools) } : {}),
});

const serializeAssistantMessage = (message: AssistantMessage) => ({
  role: message.role,
  provider: message.provider,
  model: message.model,
  stopReason: message.stopReason,
  usage: message.usage,
  ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
  content: sanitizeMessageContent(message.content),
});

const buildMetadata = (
  model: Model<any>,
  options: LangfuseStreamMetadataOptions | undefined,
  request: LangfuseRequestOptions,
) => ({
  provider: model.provider,
  model: model.id,
  api: model.api,
  ...(options?.transport ? { transport: options.transport } : {}),
  ...(options?.sessionId ? { providerSessionId: options.sessionId } : {}),
  ...(request.agentSessionId ? { agentSessionId: request.agentSessionId } : {}),
  ...(request.metadata ? request.metadata : {}),
});

const flushLangfuse = async (langfuse: LangfuseClientLike): Promise<void> => {
  try {
    await langfuse.flushAsync?.();
  } catch {
    // Best-effort telemetry should never affect request execution.
  }
};

/**
 * Langfuse only prices observations from the generation's top-level
 * usageDetails/costDetails — usage buried in metadata is invisible to its
 * cost accounting. costDetails is omitted when the client-side estimate is
 * $0 (unpriced synthesized models): reporting an explicit zero would
 * override Langfuse's own model-price inference with $0.
 */
const buildGenerationUsage = (usage: AssistantMessage['usage']) => {
  if (!usage) {
    return {};
  }

  const usageDetails = {
    input: usage.input,
    output: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
    total:
      usage.totalTokens ||
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
  };

  if (!(usage.cost?.total > 0)) {
    return { usageDetails };
  }

  return {
    usageDetails,
    costDetails: {
      input: usage.cost.input,
      output: usage.cost.output,
      cache_read_input_tokens: usage.cost.cacheRead,
      cache_creation_input_tokens: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
};

const recordLangfuseSuccess = async (
  langfuse: LangfuseClientLike,
  trace: LangfuseTraceLike,
  generation: LangfuseGenerationLike,
  message: AssistantMessage,
  metadata: Record<string, unknown>,
): Promise<AssistantMessage> => {
  const output = serializeAssistantMessage(message);
  const update = {
    output,
    metadata: {
      ...metadata,
      stopReason: message.stopReason,
      usage: message.usage,
    },
  };

  generation.end({ ...update, ...buildGenerationUsage(message.usage) });
  trace.update(update);
  await flushLangfuse(langfuse);
  return message;
};

const recordLangfuseError = async (
  langfuse: LangfuseClientLike,
  trace: LangfuseTraceLike,
  generation: LangfuseGenerationLike,
  error: unknown,
  metadata: Record<string, unknown>,
): Promise<never> => {
  const message = getErrorMessage(error);
  const update = {
    output: { error: message },
    metadata: {
      ...metadata,
      error: message,
    },
  };

  generation.end(update);
  trace.update(update);
  await flushLangfuse(langfuse);
  throw error;
};

const startLangfuseGeneration = (
  langfuse: LangfuseClientLike,
  model: Model<any>,
  context: Context,
  options: LangfuseStreamMetadataOptions | undefined,
  request: LangfuseRequestOptions,
) => {
  const metadata = buildMetadata(model, options, request);
  const trace = langfuse.trace({
    name: request.name,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    input: sanitizeContext(context),
    metadata,
  });
  const generation = trace.generation({
    name: 'llm_call',
    model: model.id,
    input: sanitizeContext(context),
    metadata,
    startTime: new Date(),
  });

  return {
    trace,
    generation,
    metadata,
  };
};

export const startTurnTrace = (
  langfuse: LangfuseClientLike,
  turnContext: LangfuseTurnContext,
  sessionId: string,
  turnNumber: number,
  userMessage?: string,
): void => {
  turnContext.currentTrace = langfuse.trace({
    name: 'openhermit.turn',
    sessionId,
    ...(userMessage ? { input: { text: userMessage } } : {}),
    metadata: { turnNumber },
  });
};

export const endTurnTrace = async (
  langfuse: LangfuseClientLike,
  turnContext: LangfuseTurnContext,
  output?: { text?: string; error?: string },
): Promise<void> => {
  if (turnContext.currentTrace) {
    turnContext.currentTrace.update({
      ...(output ? { output } : {}),
    });
    turnContext.currentTrace = undefined;
    await flushLangfuse(langfuse);
  }
};

export const createLangfuseClientFromEnv = (options: {
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
} = {}): LangfuseClientLike | undefined => {
  const env = options.env ?? process.env;
  const publicKey = env[LANGFUSE_PUBLIC_KEY];
  const secretKey = env[LANGFUSE_SECRET_KEY];
  const baseUrl = env[LANGFUSE_BASE_URL];

  if (!publicKey && !secretKey && !baseUrl) {
    return undefined;
  }

  if (!publicKey || !secretKey) {
    options.logger?.(
      'Langfuse disabled: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both required.',
    );
    return undefined;
  }

  return new Langfuse({
    publicKey,
    secretKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
};

export const createLangfuseShutdownHandler = (
  langfuse: LangfuseClientLike | undefined,
) => async (): Promise<void> => {
  if (!langfuse) {
    return;
  }

  try {
    await langfuse.shutdownAsync?.();
  } catch {
    // Best-effort shutdown flush.
  }
};

export const completeWithLangfuseTrace = async (
  langfuse: LangfuseClientLike | undefined,
  model: Model<any>,
  context: Context,
  options: ProviderStreamOptions | undefined,
  request: LangfuseRequestOptions,
): Promise<AssistantMessage> => {
  if (!langfuse) {
    return complete(model, context, options);
  }

  const { trace, generation, metadata } = startLangfuseGeneration(
    langfuse,
    model,
    context,
    options,
    request,
  );

  try {
    const message = await complete(model, context, options);
    return await recordLangfuseSuccess(
      langfuse,
      trace,
      generation,
      message,
      metadata,
    );
  } catch (error) {
    return recordLangfuseError(
      langfuse,
      trace,
      generation,
      error,
      metadata,
    );
  }
};

const startGenerationOnTrace = (
  trace: LangfuseTraceLike,
  model: Model<any>,
  context: Context,
  options: LangfuseStreamMetadataOptions | undefined,
) => {
  const metadata: Record<string, unknown> = {
    provider: model.provider,
    model: model.id,
    api: model.api,
    ...(options?.transport ? { transport: options.transport } : {}),
    ...(options?.sessionId ? { providerSessionId: options.sessionId } : {}),
  };
  const generation = trace.generation({
    name: 'llm_call',
    model: model.id,
    input: sanitizeContext(context),
    metadata,
    startTime: new Date(),
  });

  return { trace, generation, metadata };
};

export const createLangfuseTracedStreamFn = (
  langfuse: LangfuseClientLike | undefined,
  baseStreamFn: StreamFn | undefined,
  turnContext: LangfuseTurnContext,
): StreamFn | undefined => {
  if (!langfuse) {
    return baseStreamFn;
  }

  const nextStreamFn = baseStreamFn ?? streamSimple;

  return async (model, context, options) => {
    const original = await Promise.resolve(nextStreamFn(model, context, options));

    // If inside a turn, create generation as child of the turn trace.
    // Otherwise fall back to a standalone trace+generation.
    const { trace, generation, metadata } = turnContext.currentTrace
      ? startGenerationOnTrace(turnContext.currentTrace, model, context, options)
      : startLangfuseGeneration(langfuse, model, context, options, {
          name: 'openhermit.llm_step',
        });

    let finalized: Promise<AssistantMessage> | undefined;
    const finalize = () => {
      if (!finalized) {
        finalized = original.result().then(
          (message) =>
            recordLangfuseSuccess(
              langfuse,
              trace,
              generation,
              message,
              metadata,
            ),
          (error) =>
            recordLangfuseError(
              langfuse,
              trace,
              generation,
              error,
              metadata,
            ),
        );
      }

      return finalized;
    };

    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of original) {
          yield event;
        }
      },
      result: () => finalize(),
    } as unknown as Awaited<ReturnType<StreamFn>>;
  };
};

export const loadEnvironmentFile = async (
  envFilePath: string,
): Promise<number> => {
  try {
    const content = await fs.readFile(envFilePath, 'utf8');
    let loaded = 0;

    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();

      if (!line || line.startsWith('#')) {
        continue;
      }

      const normalized = line.startsWith('export ')
        ? line.slice('export '.length)
        : line;
      const separatorIndex = normalized.indexOf('=');

      if (separatorIndex <= 0) {
        continue;
      }

      const key = normalized.slice(0, separatorIndex).trim();

      if (!key || key in process.env) {
        continue;
      }

      let value = normalized.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith('\'') && value.endsWith('\''))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value.replace(/\\n/gu, '\n');
      loaded += 1;
    }

    return loaded;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return 0;
    }

    throw error;
  }
};

export const resolveAgentEnvPath = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
