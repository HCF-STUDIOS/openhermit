import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core';

import type { InternalStateStore, StoreScope } from '@openhermit/store';

import type { AgentConfig, IntrospectionConfig } from '../core/types.js';
import { DEFAULT_INTROSPECTION_CONFIG } from '../core/types.js';
import type { LangfuseClientLike, LangfuseTurnContext } from '../langfuse.js';
import { endTurnTrace } from '../langfuse.js';
import { createIntrospectionTools } from './tools.js';
import { INTROSPECTION_SYSTEM_PROMPT, buildIntrospectionUserMessage } from './prompt.js';
import { serializeDetails } from '../agent-runner/message-utils.js';
import type { AgentSecurity } from '../core/index.js';
import type { ToolContext } from '../tools/shared.js';

export interface IntrospectionInput {
  reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
  sessionId: string;
  config: AgentConfig;
  store: InternalStateStore;
  scope: StoreScope;
  security: AgentSecurity;
  /** History entries new since last introspection. */
  history: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string; userId?: string }>;
  previousWorkingMemory: string | undefined;
  currentDescription: string | undefined;
  createAgent: (input: {
    config: AgentConfig;
    agentSessionId: string;
    contextSessionId: string;
    extraSystemPrompt?: string;
    tools?: any[];
    langfuseTurnContext?: LangfuseTurnContext;
  }) => Promise<Agent>;

  langfuse?: LangfuseClientLike;
  logRuntime: (message: string) => void;
}

export interface IntrospectionResult {
  success: boolean;
  toolCallCount: number;
  memoriesAdded: number;
  memoriesUpdated: number;
  memoriesDeleted: number;
  workingMemoryUpdated: boolean;
  descriptionUpdated: boolean;
}

export const resolveIntrospectionConfig = (config: AgentConfig): IntrospectionConfig => ({
  ...DEFAULT_INTROSPECTION_CONFIG,
  ...(config.memory.introspection ?? {}),
});

export async function runIntrospection(input: IntrospectionInput): Promise<IntrospectionResult> {
  const introspectionConfig = resolveIntrospectionConfig(input.config);
  const ts = () => new Date().toISOString();

  const result: IntrospectionResult = {
    success: false,
    toolCallCount: 0,
    memoriesAdded: 0,
    memoriesUpdated: 0,
    memoriesDeleted: 0,
    workingMemoryUpdated: false,
    descriptionUpdated: false,
  };

  const turnsSinceLast = await input.store.messages.getTurnsSinceLastIntrospection(
    input.scope,
    input.sessionId,
  );

  // Write introspection_start event
  await input.store.messages.appendLogEntry(input.scope, input.sessionId, {
    ts: ts(),
    role: 'system',
    type: 'introspection_start',
    reason: input.reason,
    turnsSinceLast,
  });

  // Create a Langfuse trace for the entire introspection run so that
  // all LLM calls (including tool-loop iterations) are grouped together.
  const langfuseTurnContext: LangfuseTurnContext | undefined = input.langfuse
    ? {
        currentTrace: input.langfuse.trace({
          name: 'openhermit.introspection',
          sessionId: input.sessionId,
          metadata: { reason: input.reason },
        }),
      }
    : undefined;

  try {
    // Build transcript from history
    const transcript = input.history
      .map((entry) => {
        const label = entry.role === 'user' && entry.userId
          ? `USER [${entry.userId}]`
          : entry.role.toUpperCase();
        return `${label}: ${entry.content}`;
      })
      .join('\n\n')
      .slice(0, 32_000);

    const toolContext: ToolContext = {
      security: input.security,
      memoryProvider: input.store.memories,
      messageStore: input.store.messages,
      sessionStore: input.store.sessions,
      sessionId: input.sessionId,
      storeScope: input.scope,
    };

    const tools = createIntrospectionTools(toolContext);

    // Create introspection agent
    const agent = await input.createAgent({
      config: input.config,
      agentSessionId: `${input.sessionId}:introspection`,
      contextSessionId: input.sessionId,
      extraSystemPrompt: INTROSPECTION_SYSTEM_PROMPT,
      tools,
      ...(langfuseTurnContext ? { langfuseTurnContext } : {}),
    });

    // Track tool calls via subscription.
    // We await tool_call inserts so each tool_result can reference its call's event ID.
    const pendingCallIds = new Map<string, Promise<number>>();

    const unsub = agent.subscribe((event: AgentEvent) => {
      if (event.type === 'tool_execution_start') {
        const callPromise = input.store.messages.appendLogEntry(input.scope, input.sessionId, {
          ts: ts(),
          role: 'tool_call',
          type: 'tool_call',
          name: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
          introspection: true,
        });
        pendingCallIds.set(event.toolCallId, callPromise);
      }

      if (event.type === 'tool_execution_end') {
        result.toolCallCount++;

        if (event.toolName === 'memory_add') result.memoriesAdded++;
        if (event.toolName === 'memory_update') result.memoriesUpdated++;
        if (event.toolName === 'memory_delete') result.memoriesDeleted++;
        if (event.toolName === 'working_memory_update') result.workingMemoryUpdated = true;
        if (event.toolName === 'session_description_update') result.descriptionUpdated = true;

        const callPromise = pendingCallIds.get(event.toolCallId) ?? Promise.resolve(0);
        void callPromise.then((toolCallEventId) => {
          return input.store.messages.appendLogEntry(input.scope, input.sessionId, {
            ts: ts(),
            role: 'tool_result',
            type: 'tool_result',
            name: event.toolName,
            toolCallId: event.toolCallId,
            toolCallEventId,
            isError: event.isError,
            content: serializeDetails(event.result),
            introspection: true,
          });
        });

        if (result.toolCallCount >= introspectionConfig.max_tool_calls) {
          input.logRuntime(`introspection hit max_tool_calls (${introspectionConfig.max_tool_calls}), aborting`);
          agent.abort();
        }
      }
    });

    // Send the introspection prompt
    const userMessage = buildIntrospectionUserMessage({
      reason: input.reason,
      turnsSinceLast,
      transcript,
      currentWorkingMemory: input.previousWorkingMemory,
      currentDescription: input.currentDescription,
    });

    await agent.prompt({
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
      timestamp: Date.now(),
    });
    await agent.waitForIdle();
    unsub();

    if (input.langfuse && langfuseTurnContext) {
      void endTurnTrace(input.langfuse, langfuseTurnContext);
    }

    result.success = true;
  } catch (error) {
    if (input.langfuse && langfuseTurnContext) {
      void endTurnTrace(input.langfuse, langfuseTurnContext, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    input.logRuntime(`introspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Build summary for introspection_end
  const summaryParts: string[] = [];
  if (result.memoriesAdded > 0) summaryParts.push(`added ${result.memoriesAdded} memory(s)`);
  if (result.memoriesUpdated > 0) summaryParts.push(`updated ${result.memoriesUpdated} memory(s)`);
  if (result.memoriesDeleted > 0) summaryParts.push(`deleted ${result.memoriesDeleted} memory(s)`);
  if (result.workingMemoryUpdated) summaryParts.push('refreshed working memory');
  if (result.descriptionUpdated) summaryParts.push('updated session description');
  if (summaryParts.length === 0) summaryParts.push('no changes');

  // Write introspection_end event
  await input.store.messages.appendLogEntry(input.scope, input.sessionId, {
    ts: ts(),
    role: 'system',
    type: 'introspection_end',
    reason: input.reason,
    summary: summaryParts.join(', '),
    toolCallCount: result.toolCallCount,
    memoriesAdded: result.memoriesAdded,
    memoriesUpdated: result.memoriesUpdated,
    memoriesDeleted: result.memoriesDeleted,
    workingMemoryUpdated: result.workingMemoryUpdated,
    descriptionUpdated: result.descriptionUpdated,
    success: result.success,
  });

  return result;
}
