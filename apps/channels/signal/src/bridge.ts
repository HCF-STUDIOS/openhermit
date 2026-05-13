import { randomUUID } from 'node:crypto';

import type { SignalIncomingMessage } from './signal-api.js';

export interface ConversationKeyInput {
  sourceUuid?: string | undefined;
  sourceNumber?: string | undefined;
  groupId?: string | undefined;
}

export function conversationKey(input: ConversationKeyInput): string {
  if (input.groupId) return `signal:group:${input.groupId}`;
  if (input.sourceUuid) return `signal:uuid:${input.sourceUuid}`;
  if (input.sourceNumber) return `signal:${input.sourceNumber}`;
  throw new Error('conversationKey requires at least one of groupId, sourceUuid, sourceNumber');
}

export function generateSessionId(): string {
  return `signal:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

export function shouldAcceptSender(
  msg: ConversationKeyInput,
  allowedSenders: string[] | undefined,
  allowedGroupIds: string[] | undefined,
): boolean {
  if (msg.groupId) {
    if (!allowedGroupIds || allowedGroupIds.length === 0) return true;
    return allowedGroupIds.includes(msg.groupId);
  }
  if (!allowedSenders || allowedSenders.length === 0) return true;
  if (msg.sourceUuid && allowedSenders.includes(`uuid:${msg.sourceUuid}`)) return true;
  if (msg.sourceNumber && allowedSenders.includes(msg.sourceNumber)) return true;
  return false;
}

// SignalBridge class is implemented in Task 7 — it lives in this same file.
