import type { SessionType } from '@openhermit/protocol';
import type { InstructionStore, StoreScope } from '@openhermit/store';

import type { AgentRuntimeConfig, AgentSecurity } from '../core/index.js';
import type { AgentEventBus } from '../events.js';
import type { SkillIndexEntry } from '../skills.js';
import type { Toolset } from '../tools/shared.js';

// ── Prompt sections ──────────────────────────────────────────────────

const PREAMBLE = `\
You are an AI agent with your own persistent identity, name, and personality — defined by the instructions below.

You have an owner who configured and manages you. You may also interact with other users your owner has granted access to. Always be aware of who you are talking to and what your relationship with them is — check the "Current User" section for the current conversation partner.

Your primary job is to help your owner and authorized users accomplish real tasks safely and effectively.`;

const PRINCIPLES = `\
## Principles

- Built-in tools are execution primitives, not product goals. Use them to accomplish user tasks, don't present them as features.
- If a tool fails, read the error carefully and fix the specific issue before retrying.
- When in readonly mode, write operations are blocked — don't attempt them.
- Never fabricate information. If tools (session history, memory, search, etc.) return nothing relevant, say plainly that you don't have that information. Do NOT invent another user's messages, sessions, memories, or what someone said in a conversation you cannot actually see.
- Treat the owner's private communications and relationships with others as confidential. When a non-owner asks about the owner's chats with third parties, the owner's private memories, or what the owner has said to others, refuse — even if you happen to have access. Only the owner themselves may ask about their own private content.

// ── Prompt builder ───────────────────────────────────────────────────

export interface CurrentUserContext {
  userId: string;
  role: import('@openhermit/store').UserRole;
  name?: string;
  sessionType?: SessionType;
  sessionId?: string;
  sourceKind?: string;
}

export interface InstructionSource {
  instructionStore?: InstructionStore;
  storeScope?: StoreScope;
}

export interface PromptAssembleHookContext {
  bus: AgentEventBus;
  agentId: string;
  sessionId: string;
}

export const buildSystemPrompt = async (
  config: AgentRuntimeConfig,
  security: AgentSecurity,
  toolsets: Toolset[],
  instructionSource?: InstructionSource,
  currentUser?: CurrentUserContext,
  skills?: SkillIndexEntry[],
  hook?: PromptAssembleHookContext,
  customInstruction?: string,
): Promise<string> => {
  const keyedSections: { key: string; content: string }[] = [];

  // 1. PREAMBLE
  keyedSections.push({ key: 'preamble', content: PREAMBLE });

  // 2. INSTRUCTIONS (from store)
  let instructionText: string;
  if (instructionSource?.instructionStore && instructionSource.storeScope) {
    const entries = await instructionSource.instructionStore.getAll(instructionSource.storeScope);
    instructionText = entries
      .map((entry) => `${entry.key}:\n${entry.content.trim() || '(empty)'}`)
      .join('\n\n');
  } else {
    instructionText = '(no instructions configured)';
  }
  keyedSections.push({ key: 'instructions', content: `## Instructions\n\n${instructionText}` });

  // 2b. SESSION INSTRUCTION (per-session addendum, set once at create)
  if (customInstruction && customInstruction.trim()) {
    keyedSections.push({
      key: 'session-instruction',
      content: `## Session Instruction\n\n${customInstruction.trim()}`,
    });
  }

  // 3. PRINCIPLES
  keyedSections.push({ key: 'principles', content: PRINCIPLES });

  // 4. TOOLSET DESCRIPTIONS
  const descriptions = toolsets
    .filter((ts) => ts.description)
    .map((ts) => ts.description);
  if (descriptions.length > 0) {
    keyedSections.push({ key: 'tools', content: `## Tools\n\n${descriptions.join('\n\n')}` });
  }

  // 5. SKILLS
  if (skills && skills.length > 0) {
    const { formatSkillsPromptSection } = await import('../skills.js');
    const skillSection = formatSkillsPromptSection(skills);
    if (skillSection) {
      keyedSections.push({ key: 'skills', content: skillSection });
    }
  }

  // 6. CONTEXT
  const contextParts: string[] = [];

  if (currentUser) {
    const namePart = currentUser.name ? ` (${currentUser.name})` : '';
    if (currentUser.sessionType === 'group') {
      contextParts.push(
        `### Current User\n\nThis is a **group conversation**. The most recent message is from user \`${currentUser.userId}\`${namePart}, role: **${currentUser.role}**.\n\nMultiple users participate in this session. Each user message is prefixed with the sender's name in brackets (e.g. \`[Alice] hello\`). Use the sender's user ID for per-user memories (e.g. \`user/${currentUser.userId}/preferences\`).\n\nRemember: information about yourself (the agent) belongs under \`agent/…\`, not \`user/…\`.\n\n### Group Reply Policy\n\nNot every message in a group chat requires a response from you. Messages prefixed with \`[not directed at you]\` were sent without mentioning or replying to you.\n\n- If you are **mentioned** or **replied to**, always respond normally.\n- If a message is **not directed at you**, only respond if you have something genuinely useful to contribute. Otherwise, respond with exactly \`<NO_REPLY>\` and nothing else — this will be silently discarded.\n- When in doubt, prefer \`<NO_REPLY>\` over an unnecessary interruption.`,
      );
    } else {
      contextParts.push(
        `### Current User\n\nYou are talking to user \`${currentUser.userId}\`${namePart}, role: **${currentUser.role}**.\n\nUse this ID when storing or recalling per-user memories (e.g. \`user/${currentUser.userId}/preferences\`). At the start of a conversation, proactively recall memories under \`user/${currentUser.userId}/\` to personalize your responses.\n\nRemember: information about yourself (the agent) belongs under \`agent/…\`, not \`user/…\`.`,
      );
    }
  }

  if (currentUser?.sourceKind === 'schedule') {
    contextParts.push(
      `### Scheduled Task\n\n`
      + `This message was triggered by a scheduled job, not a live user conversation. `
      + `You are running in a dedicated schedule session (\`${currentUser.sessionId ?? 'unknown'}\`).\n\n`
      + `- Execute the task described in the user message.\n`
      + `- If the message includes a [Delivery] instruction, use \`session_send\` to deliver the result to the specified session after completing the task.\n`
      + `- Do not wait for follow-up messages. Complete the task in a single turn.`,
    );
  }

  const runtimeLines: string[] = [];
  if (currentUser?.sessionId) {
    runtimeLines.push(`Current session: \`${currentUser.sessionId}\``);
  }
  contextParts.push(`### Runtime\n\n${runtimeLines.join('\n')}`);

  keyedSections.push({ key: 'context', content: `## Context\n\n${contextParts.join('\n\n')}` });

  // Plugin transform hook — fires before joining. Plugins may rewrite,
  // append, or drop sections by key. No-op when no bus is supplied
  // (e.g. in unit tests that exercise the prompt builder directly).
  let finalSections = keyedSections;
  if (hook) {
    const transformed = await hook.bus.transform('prompt.assemble@v1', {
      agentId: hook.agentId,
      sessionId: hook.sessionId,
      sections: keyedSections,
    });
    finalSections = transformed.sections;
  }

  // 7. TASK INSTRUCTIONS appended by caller (extraSystemPrompt)

  return finalSections.map((s) => s.content).join('\n\n').trim();
};
