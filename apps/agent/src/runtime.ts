import { randomUUID } from 'node:crypto';
import {
  type OutboundEvent,
  type OutboundEventBody,
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

/** Default cap on how long a single subscriber may take to accept one event. */
const DEFAULT_SUBSCRIBER_DELIVERY_TIMEOUT_MS = 30_000;

/** Default soft cap on how many events may be queued for one subscriber at once.
 *  A subscriber this far behind WITH a delivery in flight (delivering near the
 *  timeout while events arrive faster) is effectively dead; dropping it bounds
 *  the chain and the pending publish() calls it holds. Gated on `inFlight` so a
 *  healthy synchronous burst that momentarily exceeds it is not dropped. */
const DEFAULT_MAX_PENDING_DELIVERIES = 500;

/** Absolute hard cap on a subscriber's pending chain depth, enforced regardless
 *  of `inFlight`. The soft cap only trips once a delivery is in flight, so a
 *  pathological SYNCHRONOUS burst (a publisher enqueuing far more events in one
 *  tick than any consumer could drain, before a single delivery callback runs
 *  and `inFlight` leaves 0) would otherwise grow the chain without bound in that
 *  tick. Set well above the soft cap so a healthy burst (e.g. 600 events) is
 *  never affected while a runaway burst is still bounded. */
const DEFAULT_MAX_PENDING_HARD_CAP = 5000;

export class SessionEventBroker {
  private readonly subscribers = new Map<string, Set<SessionSubscriber>>();

  private readonly backlog = new Map<string, SessionEventEnvelope[]>();

  // Per-subscriber serial delivery queue. Each subscriber's events are chained
  // so event N settles before event N+1 is dispatched to that same subscriber,
  // preserving publish order per subscriber. Subscribers keep independent chains
  // and are delivered to concurrently, so a slow one never blocks another.
  private readonly deliveryChains = new WeakMap<
    SessionSubscriber,
    { tail: Promise<void>; depth: number; inFlight: number }
  >();

  private nextEventId = 1;

  constructor(
    private readonly deliveryTimeoutMs = DEFAULT_SUBSCRIBER_DELIVERY_TIMEOUT_MS,
    private readonly maxPendingDeliveries = DEFAULT_MAX_PENDING_DELIVERIES,
    private readonly maxPendingHardCap = DEFAULT_MAX_PENDING_HARD_CAP,
  ) {}

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const sessionSubscribers =
      this.subscribers.get(sessionId) ?? new Set<SessionSubscriber>();
    sessionSubscribers.add(subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);

    if (!this.deliveryChains.has(subscriber)) {
      this.deliveryChains.set(subscriber, { tail: Promise.resolve(), depth: 0, inFlight: 0 });
    }

    return () => this.removeSubscriber(sessionId, subscriber);
  }

  private removeSubscriber(
    sessionId: string,
    subscriber: SessionSubscriber,
  ): void {
    const currentSubscribers = this.subscribers.get(sessionId);

    if (!currentSubscribers) {
      return;
    }

    currentSubscribers.delete(subscriber);

    if (currentSubscribers.size === 0) {
      this.subscribers.delete(sessionId);
    }
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
        // Route replay through the same per-subscriber FIFO chain as live
        // publish so replayed events keep publish order and a stuck replay
        // callback is bounded by the delivery timeout and depth cap, instead
        // of firing concurrently and unbounded.
        void this.enqueueDelivery(sessionId, subscriber, envelope);
      }
    }
    return unsubscribe;
  }

  async publish(event: OutboundEventBody): Promise<void> {
    const fullEvent: OutboundEvent = { ...event, eventId: randomUUID() };
    const envelope: SessionEventEnvelope = {
      id: this.nextEventId,
      event: fullEvent,
    };
    this.nextEventId += 1;

    const sessionBacklog = this.backlog.get(fullEvent.sessionId) ?? [];
    sessionBacklog.push(envelope);
    this.backlog.set(fullEvent.sessionId, sessionBacklog.slice(-100));

    const sessionSubscribers = this.subscribers.get(fullEvent.sessionId);

    if (!sessionSubscribers) {
      return;
    }

    // Deliver to every subscriber concurrently, but strictly in order per
    // subscriber. A slow or backpressured client (e.g. an SSE writer whose
    // socket buffer is full, or a disconnected reader whose write never
    // resolves) must not block delivery to the other subscribers. Each
    // delivery is bounded by a timeout; a subscriber that exceeds it is dropped
    // so a dead client can't hold the session. Ordering is enforced here rather
    // than at the call site: emitters fire events without awaiting publish, so
    // chaining each subscriber's delivery onto its previous one is what keeps
    // event N settling before N+1 for that subscriber (e.g. agent_end can never
    // overtake the preceding text_final). Snapshot first so a subscriber removed
    // during delivery cannot perturb the fanout.
    const deliveries: Promise<void>[] = [];
    for (const subscriber of [...sessionSubscribers]) {
      deliveries.push(
        this.enqueueDelivery(fullEvent.sessionId, subscriber, envelope),
      );
    }
    await Promise.allSettled(deliveries);
  }

  /**
   * Append one event to a subscriber's serial delivery chain. Enforces both the
   * per-delivery timeout (via deliverToSubscriber) and a per-subscriber pending
   * depth cap: a subscriber already at the cap is dropped rather than accruing
   * an unbounded chain of pending deliveries (and the publish() calls awaiting
   * them). Shared by live publish and backlog replay so both preserve order and
   * are bounded identically.
   */
  private enqueueDelivery(
    sessionId: string,
    subscriber: SessionSubscriber,
    envelope: SessionEventEnvelope,
  ): Promise<void> {
    const chain =
      this.deliveryChains.get(subscriber) ?? { tail: Promise.resolve(), depth: 0, inFlight: 0 };
    this.deliveryChains.set(subscriber, chain);
    // Drop a subscriber only when its backlog is at the cap AND a delivery has
    // actually started but not settled, i.e. it is genuinely not keeping up.
    // `depth` counts deliveries queued via `.then()` before their callbacks run,
    // so a synchronous burst to a fast subscriber reaches the cap in one tick,
    // before the microtask queue turns (`inFlight` still 0); gating the drop on
    // `inFlight` lets that burst drain instead of dropping a healthy consumer. A
    // genuinely stuck head keeps `inFlight` > 0 across turns and is still
    // dropped, and the per-delivery timeout remains the ultimate backstop.
    // Hard cap first: a synchronous burst never lets `inFlight` leave 0 within
    // the tick, so the soft cap below can't bound it. Past the hard cap drop the
    // subscriber regardless of `inFlight` so the chain can't grow without limit.
    if (chain.depth >= this.maxPendingHardCap) {
      this.removeSubscriber(sessionId, subscriber);
      return Promise.resolve();
    }
    if (chain.depth >= this.maxPendingDeliveries && chain.inFlight > 0) {
      this.removeSubscriber(sessionId, subscriber);
      return Promise.resolve();
    }
    chain.depth += 1;
    const delivery = chain.tail.then(() => {
      chain.inFlight += 1;
      return this.deliverToSubscriber(sessionId, subscriber, envelope);
    });
    chain.tail = delivery;
    void delivery.finally(() => {
      chain.depth -= 1;
      chain.inFlight -= 1;
    });
    return delivery;
  }

  private async deliverToSubscriber(
    sessionId: string,
    subscriber: SessionSubscriber,
    envelope: SessionEventEnvelope,
  ): Promise<void> {
    // A subscriber dropped (timed out) or unsubscribed before this queued
    // delivery ran must not receive further events.
    if (!this.subscribers.get(sessionId)?.has(subscriber)) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(subscriber(envelope)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new SubscriberDeliveryTimeoutError()),
            this.deliveryTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof SubscriberDeliveryTimeoutError) {
        // Stuck/backpressured client: drop it so it cannot delay future events.
        this.removeSubscriber(sessionId, subscriber);
      }
      console.error('[openhermit-agent] session event subscriber failed', error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class SubscriberDeliveryTimeoutError extends Error {
  constructor() {
    super('session event subscriber delivery timed out');
    this.name = 'SubscriberDeliveryTimeoutError';
  }
}
