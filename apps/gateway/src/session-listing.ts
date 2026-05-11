import type { SessionListQuery, SessionSummary } from '@openhermit/protocol';

import type { AuthContext } from './auth.js';

/**
 * Minimum surface of an `AgentRunner` we need to list sessions for a
 * caller. Defined here so tests can pass a stub.
 */
interface SessionListingRuntime {
  listSessions(
    query?: SessionListQuery,
    callerUserId?: string,
  ): Promise<SessionSummary[]>;
  resolveCallerUserId?(caller: {
    channel: string;
    channelUserId: string;
  }): Promise<string | undefined>;
  resolveCallerRole?(caller: {
    channel: string;
    channelUserId: string;
  }): Promise<'owner' | 'user' | 'guest' | undefined>;
}

/**
 * Single source of truth for "what sessions can this caller see?". Both
 * the HTTP handler (`GET /api/agents/:id/sessions`) and the WebSocket
 * `session.list` RPC route through this so they stay in lockstep.
 *
 * Auth-mode dispatch:
 *   - `admin`   — full agent visibility (management consoles).
 *   - `channel` — full agent visibility within the adapter's namespace
 *                 (caller can pre-set query.channel to constrain).
 *   - `user`    — strictly the caller's own participation. Owners are
 *                 *not* special here; agent tools (`session_list` /
 *                 `session_read`) widen visibility for owners
 *                 separately when run in-process.
 */
export const listSessionsForCaller = async (
  runtime: SessionListingRuntime,
  auth: AuthContext,
  query: SessionListQuery,
): Promise<SessionSummary[]> => {
  // Observation mode: owner-only view of sessions the caller is NOT a
  // participant of. Strip `observe` from the downstream query so the
  // runtime doesn't see a flag it doesn't know about; enforce role here.
  const { observe, ...rest } = query;
  const baseQuery: SessionListQuery = rest;

  if (observe) {
    if (auth.mode !== 'user') return [];
    if (!runtime.resolveCallerUserId || !runtime.resolveCallerRole) return [];
    const role = await runtime.resolveCallerRole({
      channel: auth.channel,
      channelUserId: auth.channelUserId,
    });
    if (role !== 'owner') return [];
    const callerUserId = await runtime.resolveCallerUserId({
      channel: auth.channel,
      channelUserId: auth.channelUserId,
    });
    if (!callerUserId) return [];
    const all = await runtime.listSessions(baseQuery);
    // Require userIds to be populated — a missing/empty array would
    // otherwise leak unbackfilled or system rows into the observed list
    // since `!undefined.includes(...)` is trivially true.
    return all.filter(
      (s) => s.userIds && s.userIds.length > 0 && !s.userIds.includes(callerUserId),
    );
  }

  if (auth.mode === 'admin') {
    return runtime.listSessions(baseQuery);
  }

  if (auth.mode === 'channel') {
    const effectiveQuery: SessionListQuery = { ...baseQuery };
    if (auth.channelNamespace && !effectiveQuery.channel) {
      effectiveQuery.channel = auth.channelNamespace;
    }
    return runtime.listSessions(effectiveQuery);
  }

  // user mode
  if (!runtime.resolveCallerUserId) return [];
  const callerUserId = await runtime.resolveCallerUserId({
    channel: auth.channel,
    channelUserId: auth.channelUserId,
  });
  if (!callerUserId) return [];
  return runtime.listSessions(baseQuery, callerUserId);
};
