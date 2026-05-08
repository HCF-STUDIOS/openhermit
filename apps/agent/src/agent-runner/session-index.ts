import type { SessionListQuery, SessionStatus, SessionSummary } from '@openhermit/protocol';

import type { PersistedSessionIndexEntry } from '@openhermit/store';
import { matchesSessionListQuery, sortSessionSummaries } from '../session-utils.js';
import type { RunnerSession } from './types.js';

export const createPersistedSessionIndexEntry = (
  session: RunnerSession,
): PersistedSessionIndexEntry => ({
  sessionId: session.spec.sessionId,
  source: session.spec.source,
  status: session.status,
  createdAt: session.createdAt,
  lastActivityAt: session.updatedAt,
  messageCount: session.messageCount,
  completedTurnCount: session.completedTurnCount,
  ...(session.description ? { description: session.description } : {}),
  ...(session.descriptionSource
    ? { descriptionSource: session.descriptionSource }
    : {}),
  ...(session.lastMessagePreview
    ? { lastMessagePreview: session.lastMessagePreview }
    : {}),
  ...(session.spec.metadata ? { metadata: session.spec.metadata } : {}),
  ...(session.userIds.length > 0 ? { userIds: session.userIds } : {}),
  ...(session.spec.customInstruction
    ? { customInstruction: session.spec.customInstruction }
    : {}),
});

/**
 * Build session summaries directly from the persisted DB rows. The
 * runtime in-memory map (`AgentRunner.sessions`) is intentionally NOT
 * consulted: the DB is the source of truth for source / metadata /
 * counters / description / preview. Runtime status transitions
 * (running ↔ idle) are persisted on every event so the DB row is
 * fresh enough for listing.
 */
export const buildSessionSummaries = (
  persistedSessions: PersistedSessionIndexEntry[],
  query: SessionListQuery,
  getLastEventId: (sessionId: string) => number,
): SessionSummary[] => {
  return persistedSessions
    .map((session) => ({
      sessionId: session.sessionId,
      source: session.source,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      lastEventId: getLastEventId(session.sessionId),
      messageCount: session.messageCount,
      ...(session.description ? { description: session.description } : {}),
      ...(session.lastMessagePreview
        ? { lastMessagePreview: session.lastMessagePreview }
        : {}),
      status: (session.status as SessionStatus) ?? 'idle',
      ...(session.metadata ? { metadata: session.metadata } : {}),
    }))
    .filter((summary) => matchesSessionListQuery(summary, query))
    .sort(sortSessionSummaries);
};
