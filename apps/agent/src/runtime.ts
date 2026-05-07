import {
  type OutboundEvent,
  type SessionHistoryMessage,
  type SessionListQuery,
  type SessionMessage,
  type SessionSpec,
  type SessionSummary,
} from '@openhermit/protocol';

export interface SessionEventEnvelope {
  id: number;
  event: OutboundEvent;
}

export interface SessionDescriptor {
  spec: SessionSpec;
  createdAt: string;
  updatedAt: string;
}

/**
 * Channel identity of the current request initiator (HTTP/WS auth context
 * or channel adapter handling an incoming message). Decoupled from the
 * session's `source` so an owner browsing a CLI session in the web UI
 * authenticates as `{channel:'web', channelUserId:<fingerprint>}` rather
 * than being forced through the session's CLI channel.
 */
export interface Caller {
  channel: string;
  channelUserId: string;
}

export interface SessionRuntime {
  readonly events: SessionEventBroker;
  openSession(spec: SessionSpec, caller?: Caller): Promise<SessionDescriptor>;
  listSessions(query?: SessionListQuery, callerUserId?: string): Promise<SessionSummary[]>;
  listSessionMessages(sessionId: string, callerUserId?: string): Promise<SessionHistoryMessage[]>;
  /** Resolve a channel identity to an internal userId (read-only). */
  resolveCallerUserId?(caller: { channel: string; channelUserId: string }): Promise<string | undefined>;
  /** Update a user's display name by channel identity. */
  updateUserName?(caller: { channel: string; channelUserId: string }, name: string): Promise<void>;
  /**
   * Ensure a user record exists for the given channel identity. Creates a
   * guest user if none is found. Used at JWT exchange time so the caller
   * has a stable userId immediately on first device auth, instead of
   * waiting for the first session-open to lazily create one.
   */
  ensureUserForCaller?(
    caller: { channel: string; channelUserId: string },
    displayName?: string,
  ): Promise<{ userId: string; role: string | undefined; created: boolean }>;
  checkpointSession(
    sessionId: string,
    reason?: 'manual' | 'new_session' | 'turn_limit' | 'idle',
  ): Promise<boolean>;
  postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }>;
}

export type SessionSubscriber = (
  envelope: SessionEventEnvelope,
) => void | Promise<void>;

export class SessionEventBroker {
  private readonly subscribers = new Map<string, Set<SessionSubscriber>>();

  private readonly backlog = new Map<string, SessionEventEnvelope[]>();

  private nextEventId = 1;

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const sessionSubscribers =
      this.subscribers.get(sessionId) ?? new Set<SessionSubscriber>();
    sessionSubscribers.add(subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);

    return () => {
      const currentSubscribers = this.subscribers.get(sessionId);

      if (!currentSubscribers) {
        return;
      }

      currentSubscribers.delete(subscriber);

      if (currentSubscribers.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  getBacklog(sessionId: string): SessionEventEnvelope[] {
    return this.backlog.get(sessionId) ?? [];
  }

  /**
   * Atomically subscribe and replay backlog events with id > afterEventId.
   * Eliminates the race between getBacklog() and subscribe().
   */
  /** Current next-id, exposed so SSE clients can detect sequence resets across runner restarts. */
  getNextEventId(): number {
    return this.nextEventId;
  }

  subscribeFrom(
    sessionId: string,
    afterEventId: number,
    subscriber: SessionSubscriber,
  ): () => void {
    const unsubscribe = this.subscribe(sessionId, subscriber);
    // If the caller's cursor is >= the broker's next id, it came from a
    // previous broker instance (e.g. the runner was evicted and re-
    // hydrated). The new sequence restarts at 1 — filtering against the
    // stale cursor would skip every event. Treat as a fresh subscription.
    const effectiveAfter = afterEventId >= this.nextEventId ? 0 : afterEventId;
    const backlog = this.backlog.get(sessionId) ?? [];
    for (const envelope of backlog) {
      if (envelope.id > effectiveAfter) {
        void subscriber(envelope);
      }
    }
    return unsubscribe;
  }

  async publish(event: OutboundEvent): Promise<void> {
    const envelope: SessionEventEnvelope = {
      id: this.nextEventId,
      event,
    };
    this.nextEventId += 1;

    const sessionBacklog = this.backlog.get(event.sessionId) ?? [];
    sessionBacklog.push(envelope);
    this.backlog.set(event.sessionId, sessionBacklog.slice(-100));

    const sessionSubscribers = this.subscribers.get(event.sessionId);

    if (!sessionSubscribers) {
      return;
    }

    for (const subscriber of sessionSubscribers) {
      await subscriber(envelope);
    }
  }
}
