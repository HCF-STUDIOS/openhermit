import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent } from '@mariozechner/pi-ai';
import { streamSimple } from '@mariozechner/pi-ai';

/**
 * Client-side inactivity guard for provider streams.
 *
 * A provider's `/anthropic` SSE stream can connect and then hang open with no
 * data and no close (observed in production against minimax-cn: a
 * post-compaction continuation request whose stream never emitted a byte and
 * never terminated). With no client read-timeout the `for await` over the event
 * stream blocks forever, so `agent.prompt()` never resolves and the session's
 * turn lock is held indefinitely — the "already processing a prompt" wedge that
 * survives even `/new` and the turn watchdog's `abort()` (a no-op on a socket
 * read that never observes the signal).
 *
 * This decorator races each pull of the underlying stream against an idle
 * timer. If no event arrives within `idleMs`, it aborts the underlying stream
 * (via a chained AbortController so the provider transport can tear down) and
 * throws — converting an unbounded hang into a normal, bounded turn error that
 * releases the lock. The timer is inactivity-based, not total-duration: a
 * healthy generation streams tokens continuously and keeps resetting it, so
 * long-but-live completions are never killed; only genuine stalls are.
 */

export const STREAM_IDLE_TIMEOUT_ENV = 'STREAM_IDLE_TIMEOUT_MS';

// Conservative default: real minimax-cn first-token latency in production sits
// at 1–17s; 120s of complete silence is unambiguously a stall, while staying
// well under the 10min turn watchdog so this fires first with a clear cause.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

export const resolveStreamIdleTimeoutMs = (
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const raw = env[STREAM_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  // 0 (or negative) disables the guard; NaN falls back to the default.
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
};

export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number;

  constructor(idleMs: number) {
    super(
      `Provider stream idle for ${idleMs}ms with no events; aborting to avoid a wedged turn.`,
    );
    this.name = 'StreamIdleTimeoutError';
    this.idleMs = idleMs;
  }
}

const IDLE = Symbol('idle');

export const withStreamIdleTimeout = (
  baseStreamFn: StreamFn | undefined,
  idleMs: number = resolveStreamIdleTimeoutMs(),
): StreamFn => {
  const next = baseStreamFn ?? streamSimple;

  // Disabled: pass through untouched so behaviour is identical to no wrapper.
  if (idleMs <= 0) {
    return next;
  }

  return (async (model, context, options) => {
    const controller = new AbortController();
    const callerSignal = options?.signal;

    // Chain the caller's signal so a legitimate external abort still tears the
    // underlying stream down (and does NOT surface as an idle-timeout error).
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort((callerSignal as { reason?: unknown }).reason);
      } else {
        callerSignal.addEventListener(
          'abort',
          () => controller.abort((callerSignal as { reason?: unknown }).reason),
          { once: true },
        );
      }
    }

    const inner = await Promise.resolve(
      next(model, context, { ...(options ?? {}), signal: controller.signal }),
    );

    let idleError: StreamIdleTimeoutError | undefined;

    const iterate = async function* (): AsyncGenerator<AssistantMessageEvent> {
      const iterator = inner[Symbol.asyncIterator]();
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idleTimeout = new Promise<typeof IDLE>((resolve) => {
          timer = setTimeout(() => resolve(IDLE), idleMs);
        });

        let result: IteratorResult<AssistantMessageEvent> | typeof IDLE;
        try {
          result = await Promise.race([iterator.next(), idleTimeout]);
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
        }

        if (result === IDLE) {
          idleError = new StreamIdleTimeoutError(idleMs);
          controller.abort(idleError);
          throw idleError;
        }

        if (result.done) {
          return;
        }

        yield result.value;
      }
    };

    return {
      [Symbol.asyncIterator]: () => iterate(),
      result: (): Promise<AssistantMessage> =>
        idleError ? Promise.reject(idleError) : inner.result(),
    } as unknown as ReturnType<StreamFn>;
  }) as StreamFn;
};
