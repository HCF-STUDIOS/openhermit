import type { AgentTool } from '@mariozechner/pi-agent-core';

import { createMemoryToolset } from './tools/memory.js';
import { withApproval } from './tools/approval.js';
import type {
  ApprovalCallback,
  ApprovalDecision,
  Toolset,
  ToolContext,
  ToolCallCallback,
} from './tools/shared.js';
import { createInstructionToolset } from './tools/instruction.js';
import { createWebToolset } from './tools/web.js';
import { createSessionToolset } from './tools/session.js';
import { createIdentityToolset, createUserToolset } from './tools/user.js';
import { createExecToolset } from './tools/sandbox-exec.js';
import { createFileToolset } from './tools/file.js';
import { createScheduleToolset } from './tools/schedule.js';
import { createPolicyToolset } from './tools/policy.js';
import { createApprovalToolset } from './tools/approval-request.js';
import { createAttachmentToolset } from './tools/attachment.js';

export type {
  ApprovalCallback,
  ApprovalDecision,
  Toolset,
  ToolContext,
  ToolCallCallback,
} from './tools/shared.js';

export {
  withApproval,
};

export const toolsFromToolsets = (toolsets: Toolset[]): AgentTool<any>[] =>
  toolsets.flatMap((ts) => ts.tools);

export const createBuiltInTools = (context: ToolContext): AgentTool<any>[] =>
  toolsFromToolsets(createBuiltInToolsets(context));

export const createBuiltInToolsets = (
  context: ToolContext,
): Toolset[] => {
  const { security, approvalCallback, approvedCache, onToolCall } = context;

  const toolsets: Toolset[] = [];

  if (context.memoryProvider) {
    toolsets.push(createMemoryToolset(context));
  }
  if (context.instructionStore) {
    toolsets.push(createInstructionToolset(context));
  }
  if (context.webProvider) {
    toolsets.push(createWebToolset(context));
  }
  if (context.agentId) {
    toolsets.push(createExecToolset(context));
    toolsets.push(createFileToolset(context));
  }
  if (context.userStore) {
    toolsets.push(createUserToolset(context));
    toolsets.push(createIdentityToolset(context));
  }
  if (context.sessionStore) {
    toolsets.push(createSessionToolset(context));
  }
  if (context.scheduleStore) {
    toolsets.push(createScheduleToolset(context));
  }
  if (context.policyStore) {
    toolsets.push(createPolicyToolset(context));
  }
  if (context.approvalRequestStore) {
    toolsets.push(createApprovalToolset(context));
  }
  if (context.attachmentStore && context.attachmentStorage) {
    toolsets.push(createAttachmentToolset(context));
  }
  // working_memory_update is intentionally excluded from the main agent —
  // it is only available to the introspection agent to prevent overwrite conflicts.

  const hookCtx = context.hookBus && context.agentId && context.sessionId
    ? { bus: context.hookBus, agentId: context.agentId, sessionId: context.sessionId }
    : undefined;

  // Apply withApproval to all tools in all toolsets
  return toolsets.map((ts) => ({
    ...ts,
    tools: ts.tools.map((tool) =>
      withApproval(
        tool,
        security,
        approvalCallback,
        onToolCall,
        approvedCache,
        hookCtx,
      ),
    ),
  }));
};
