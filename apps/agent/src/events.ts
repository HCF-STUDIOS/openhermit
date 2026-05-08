/**
 * Agent runtime event catalog.
 *
 * This file defines the *shape* of a future plugin/hook surface. It does
 * not (yet) wire emitters into the runner — its purpose is to make the
 * event catalog reviewable as a public-API design before any plugin
 * loader is built. Subsequent PRs:
 *
 *   PR1 — refactor existing in-runner code to emit/listen via this bus
 *         (no new features, no behavior change).
 *   PR2 — file-based plugin registry that subscribes to this bus.
 *   PR3 — out-of-process plugins via webhook reusing the channel ingress.
 *
 * Design notes:
 *
 * - **Versioned payloads.** Every event has a `@v1` suffix. Future
 *   payload changes ship as `name@v2`; bus dispatches both, plugins
 *   pin a version. We never silently mutate v1.
 * - **Three hook shapes:** `listener` (passive, no return), `transform`
 *   (returns a possibly-mutated payload), `veto` (returns
 *   `{ allow, reason? }`). The shape is a property of the event, not
 *   the subscription.
 * - **Per-agent instance, never singleton.** Each running AgentRunner
 *   owns its own bus; plugins are loaded into it. This avoids
 *   cross-tenant state leaks.
 * - **Failure mode default = skip + log.** A throwing hook is dropped
 *   from the chain for that invocation; the bus emits an internal
 *   `plugin.error` event so the failure is observable. Manifests can
 *   opt into `failureMode: 'fail'` to abort the turn instead.
 * - **Priority is declared at subscribe time.** Lower number runs
 *   first; ties broken by registration order.
 */

import type { Message } from '@mariozechner/pi-ai';
import type { SessionType } from '@openhermit/protocol';

// ─── Event payloads ────────────────────────────────────────────────────

export interface AgentLifecyclePayload {
  agentId: string;
  at: string;
}

export interface SessionOpenedPayload {
  agentId: string;
  sessionId: string;
  sessionType: SessionType;
  sourceKind: string;
  sourcePlatform?: string;
  participants: string[];
}

export interface SessionClosedPayload {
  agentId: string;
  sessionId: string;
  reason: 'user' | 'idle' | 'shutdown' | 'error';
}

export interface SessionMessageReceivedPayload {
  agentId: string;
  sessionId: string;
  /** The text the user (or channel) just submitted. */
  text: string;
  senderUserId?: string;
  senderRole?: 'owner' | 'user' | 'guest';
  senderChannel?: string;
  /** Caller-supplied per-message metadata. Plugins may inspect this and
   *  rewrite `text` accordingly (e.g. prepend a context note for the model). */
  metadata?: Record<string, unknown>;
}

export interface PromptAssemblePayload {
  agentId: string;
  sessionId: string;
  /** The prompt sections in order — plugins may rewrite, append, drop. */
  sections: { key: string; content: string }[];
}

export interface ModelTurnPayload {
  agentId: string;
  sessionId: string;
  turnIndex: number;
  /** Snapshot of the message list being sent to the model. Read-only for `before`. */
  messages: Message[];
}

export interface ToolBeforePayload {
  agentId: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

export interface ToolAfterPayload {
  agentId: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ChannelMessagePayload {
  agentId: string;
  sessionId: string;
  channel: string;
  direction: 'in' | 'out';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ScheduleFiredPayload {
  agentId: string;
  scheduleId: string;
  type: 'cron' | 'once';
  prompt: string;
  /** Pre-resolved session the schedule will post into. */
  sessionId: string;
}

export interface MemoryUpsertPayload {
  agentId: string;
  key: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface PluginErrorPayload {
  pluginId: string;
  event: string;
  message: string;
  stack?: string;
}

// ─── Event registry ────────────────────────────────────────────────────

/**
 * Maps each event name to its payload type. Versioned suffix is part
 * of the name so plugins pin a stable schema.
 */
export interface AgentEventMap {
  'agent.started@v1': AgentLifecyclePayload;
  'agent.stopped@v1': AgentLifecyclePayload;
  'session.opened@v1': SessionOpenedPayload;
  'session.closed@v1': SessionClosedPayload;
  'session.message.received@v1': SessionMessageReceivedPayload;
  'prompt.assemble@v1': PromptAssemblePayload;
  'model.before@v1': ModelTurnPayload;
  'model.after@v1': ModelTurnPayload;
  'tool.before@v1': ToolBeforePayload;
  'tool.after@v1': ToolAfterPayload;
  'channel.message.in@v1': ChannelMessagePayload;
  'channel.message.out@v1': ChannelMessagePayload;
  'schedule.fired@v1': ScheduleFiredPayload;
  'memory.upsert@v1': MemoryUpsertPayload;
  'plugin.error@v1': PluginErrorPayload;
}

export type AgentEventName = keyof AgentEventMap;

/**
 * Hook shape per event. `listener` events ignore the return value;
 * `transform` events thread the (possibly mutated) payload through
 * each handler in priority order; `veto` events short-circuit on the
 * first denial. Vetoable events are also transformable — a veto hook
 * may rewrite args before allowing.
 */
export type EventShape = 'listener' | 'transform' | 'veto';

export const EVENT_SHAPES: Record<AgentEventName, EventShape> = {
  'agent.started@v1': 'listener',
  'agent.stopped@v1': 'listener',
  'session.opened@v1': 'listener',
  'session.closed@v1': 'listener',
  'session.message.received@v1': 'transform',
  'prompt.assemble@v1': 'transform',
  'model.before@v1': 'transform',
  'model.after@v1': 'listener',
  'tool.before@v1': 'veto',
  'tool.after@v1': 'listener',
  'channel.message.in@v1': 'transform',
  'channel.message.out@v1': 'transform',
  'schedule.fired@v1': 'transform',
  'memory.upsert@v1': 'listener',
  'plugin.error@v1': 'listener',
};

// ─── Subscriber types ──────────────────────────────────────────────────

export interface SubscribeOptions {
  /** Lower runs first. Defaults to 100. */
  priority?: number;
  /** Plugin identifier — surfaced on errors. */
  pluginId?: string;
  /** When a handler throws: skip it (default) or fail the turn. */
  failureMode?: 'skip' | 'fail';
}

export type ListenerHandler<P> = (payload: P) => void | Promise<void>;
export type TransformHandler<P> = (payload: P) => P | Promise<P>;
export type VetoDecision<P> =
  | { allow: true; payload?: P }
  | { allow: false; reason: string };
export type VetoHandler<P> = (payload: P) => VetoDecision<P> | Promise<VetoDecision<P>>;

export type AnyHandler<P> = ListenerHandler<P> | TransformHandler<P> | VetoHandler<P>;

interface Subscription {
  handler: AnyHandler<unknown>;
  options: Required<Pick<SubscribeOptions, 'priority' | 'failureMode'>> & { pluginId?: string };
  registrationOrder: number;
}

// ─── Bus ───────────────────────────────────────────────────────────────

/**
 * Per-agent typed event bus. Owned by `AgentRunner`. Plugins receive a
 * scoped reference to this bus through the plugin context (future PR);
 * the runner emits events at well-defined points in its lifecycle.
 *
 * The bus is intentionally minimal: it does not buffer, persist, or
 * fan out to other processes. Out-of-process plugins (Phase 3) get
 * their own webhook fan-out adapter that subscribes here as a normal
 * listener and forwards over HTTP.
 */
export class AgentEventBus {
  private subscriptions = new Map<AgentEventName, Subscription[]>();
  private nextRegistrationOrder = 0;

  on<E extends AgentEventName>(
    event: E,
    handler: ListenerHandler<AgentEventMap[E]>,
    options?: SubscribeOptions,
  ): () => void;
  on<E extends AgentEventName>(
    event: E,
    handler: TransformHandler<AgentEventMap[E]>,
    options?: SubscribeOptions,
  ): () => void;
  on<E extends AgentEventName>(
    event: E,
    handler: VetoHandler<AgentEventMap[E]>,
    options?: SubscribeOptions,
  ): () => void;
  on<E extends AgentEventName>(
    event: E,
    handler: AnyHandler<AgentEventMap[E]>,
    options?: SubscribeOptions,
  ): () => void {
    const sub: Subscription = {
      handler: handler as AnyHandler<unknown>,
      options: {
        priority: options?.priority ?? 100,
        failureMode: options?.failureMode ?? 'skip',
        ...(options?.pluginId ? { pluginId: options.pluginId } : {}),
      },
      registrationOrder: this.nextRegistrationOrder++,
    };
    const list = this.subscriptions.get(event) ?? [];
    list.push(sub);
    list.sort((a, b) => a.options.priority - b.options.priority || a.registrationOrder - b.registrationOrder);
    this.subscriptions.set(event, list);
    return () => {
      const current = this.subscriptions.get(event);
      if (!current) return;
      const idx = current.indexOf(sub);
      if (idx !== -1) current.splice(idx, 1);
    };
  }

  /**
   * Emit a `listener` event. Handlers run sequentially in priority
   * order. Errors are swallowed (per failureMode) and reported via
   * `plugin.error@v1` unless the offending hook itself is on
   * `plugin.error@v1` (avoids recursion).
   */
  async emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): Promise<void> {
    if (EVENT_SHAPES[event] !== 'listener') {
      throw new Error(`emit() is for listener events; ${event} is ${EVENT_SHAPES[event]} — use transform()/veto().`);
    }
    const subs = this.subscriptions.get(event);
    if (!subs) return;
    for (const sub of subs) {
      try {
        await (sub.handler as ListenerHandler<unknown>)(payload);
      } catch (err) {
        await this.handleHookError(event, sub, err);
      }
    }
  }

  /**
   * Emit a `transform` event. Each handler receives the
   * (possibly-mutated) payload from the previous one and returns a
   * new payload. Returns the final payload after the chain.
   */
  async transform<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): Promise<AgentEventMap[E]> {
    if (EVENT_SHAPES[event] !== 'transform') {
      throw new Error(`transform() is for transform events; ${event} is ${EVENT_SHAPES[event]}.`);
    }
    const subs = this.subscriptions.get(event);
    if (!subs) return payload;
    let current = payload;
    for (const sub of subs) {
      try {
        const next = await (sub.handler as TransformHandler<unknown>)(current);
        if (next !== undefined) current = next as AgentEventMap[E];
      } catch (err) {
        await this.handleHookError(event, sub, err);
      }
    }
    return current;
  }

  /**
   * Emit a `veto` event. Handlers run sequentially. The first to
   * return `{ allow: false }` short-circuits the chain and the
   * decision (with reason) is returned. Allowing handlers may also
   * return a mutated payload; subsequent handlers see the new value.
   */
  async veto<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): Promise<VetoDecision<AgentEventMap[E]>> {
    if (EVENT_SHAPES[event] !== 'veto') {
      throw new Error(`veto() is for veto events; ${event} is ${EVENT_SHAPES[event]}.`);
    }
    const subs = this.subscriptions.get(event);
    if (!subs) return { allow: true, payload };
    let current = payload;
    for (const sub of subs) {
      try {
        const decision = await (sub.handler as VetoHandler<unknown>)(current);
        if (!decision.allow) return decision as VetoDecision<AgentEventMap[E]>;
        if (decision.payload !== undefined) current = decision.payload as AgentEventMap[E];
      } catch (err) {
        await this.handleHookError(event, sub, err);
        // A throwing veto handler in 'skip' mode is treated as allow-with-no-mutation.
      }
    }
    return { allow: true, payload: current };
  }

  private async handleHookError(event: AgentEventName, sub: Subscription, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (sub.options.failureMode === 'fail') {
      throw err instanceof Error ? err : new Error(message);
    }
    // Avoid recursion if the failing hook is itself listening to plugin.error.
    if (event !== 'plugin.error@v1') {
      const errorPayload: PluginErrorPayload = {
        pluginId: sub.options.pluginId ?? '<unknown>',
        event,
        message,
        ...(stack ? { stack } : {}),
      };
      // Fire-and-forget; do not await to avoid blocking the original chain.
      void this.emit('plugin.error@v1', errorPayload).catch(() => undefined);
    }
  }

  /** Used by tests + diagnostics. */
  listSubscriptions(event: AgentEventName): { priority: number; pluginId?: string }[] {
    return (this.subscriptions.get(event) ?? []).map((s) => ({
      priority: s.options.priority,
      ...(s.options.pluginId ? { pluginId: s.options.pluginId } : {}),
    }));
  }

  /** Drop everything subscribed by a given plugin (used at unload). */
  removePlugin(pluginId: string): void {
    for (const [event, subs] of this.subscriptions) {
      const filtered = subs.filter((s) => s.options.pluginId !== pluginId);
      if (filtered.length === 0) this.subscriptions.delete(event);
      else this.subscriptions.set(event, filtered);
    }
  }
}

/** Convenience type for plugin authors: a scoped subset of the bus. */
export interface PluginEventApi {
  on: AgentEventBus['on'];
}
