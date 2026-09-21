import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent } from '@mariozechner/pi-ai';
import { streamSimple } from '@mariozechner/pi-ai';

/**
 * Transparent pre-first-token retry for provider streams.
 *
 * A model stream can be torn down before it emits anything — the upstream
 * socket is RST/`terminated`, the provider returns a transient 5xx, a DNS/econn
 * blip drops the connection. When that happens *before any event has been
 * yielded to the consumer*, nothing was produced and nothing was shown to the
 * user, so re-issuing the identical request is completely safe: no tool has run
 * (tools dispatch only after the assistant message completes) and no partial
 * output has streamed. This decorator retries exactly that window.
 *
 * The invariant is strict: the moment the wrapped stream yields its first event
 * (even the `start` marker), the attempt is committed and NO further retry can
 * happen — retrying after a partial yield would replay a half-streamed message
 * and violate the stream contract. Mid-stream drops therefore fall through to
 * the caller unchanged (the salvage path handles the "already produced text"
 * case; classification handles the rest).
 *
 * Placed inside the attribution wrappers and outside the idle-timeout wrapper,
 * so each attempt is independently idle-guarded and carries the same headers.
 */

export const STREAM_MAX_RETRIES_ENV = 'STREAM_MAX_RETRIES';

// Two retries covers the overwhelming majority of transient connect blips
// without turning a hard outage into a long stall (each attempt is still
// idle-guarded at 120s).
export const DEFAULT_STREAM_MAX_RETRIES = 2;

export const resolveStreamMaxRetries = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env[STREAM_MAX_RETRIES_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_STREAM_MAX_RETRIES;
  }
  const parsed = Number(raw);
  // 0 (or negative) disables retry; NaN falls back to the default.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STREAM_MAX_RETRIES;
};

/**
 * Connection-drop / transient-availability signatures worth a pre-first-token
 * retry. Deliberately excludes rate limits (429 — an immediate retry is
 * counterproductive), auth, quota, and context-length errors (all terminal).
 */
const RETRYABLE = /terminated|und_err|econn|socket hang ?up|network error|\b5\d\d\b|overloaded|bad gateway|service unavailable/i;

export const isRetryableStreamError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return RETRYABLE.test(message);
};

export interface StreamRetryOptions {
  maxRetries?: number;
  isRetryable?: (error: unknown) => boolean;
  /** Backoff before the Nth retry (1-based). Defaults to 500ms, then 1500ms… */
  backoffMs?: (attempt: number) => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultBackoffMs = (attempt: number): number => (attempt <= 1 ? 500 : 1_500);
const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export const withStreamRetry = (
  baseStreamFn: StreamFn | undefined,
  options: StreamRetryOptions = {},
): StreamFn => {
  const next = baseStreamFn ?? streamSimple;
  const maxRetries = options.maxRetries ?? resolveStreamMaxRetries();

  // Disabled: pass through untouched so behaviour is identical to no wrapper.
  if (maxRetries <= 0) {
    return next;
  }

  const isRetryable = options.isRetryable ?? isRetryableStreamError;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const sleep = options.sleep ?? defaultSleep;

  return ((model, context, callOptions) => {
    // The inner stream we've committed to; set the instant we're about to yield
    // (or observe a clean empty stream). result() defers to it so the caller's
    // response.result() reflects the attempt that actually produced output.
    let committed: Awaited<ReturnType<StreamFn>> | undefined;
    const callerSignal = callOptions?.signal;

    const iterate = async function* (): AsyncGenerator<AssistantMessageEvent> {
      let attempt = 0;
      for (;;) {
        // Chain the caller's abort into a per-attempt controller so a genuine
        // external abort tears down the current attempt and is never retried.
        const controller = new AbortController();
        const onAbort = () => controller.abort((callerSignal as { reason?: unknown }).reason);
        if (callerSignal) {
          if (callerSignal.aborted) controller.abort((callerSignal as { reason?: unknown }).reason);
          else callerSignal.addEventListener('abort', onAbort, { once: true });
        }
        const detach = () => callerSignal?.removeEventListener('abort', onAbort);

        const retryOrThrow = async (error: unknown): Promise<void> => {
          detach();
          if (callerSignal?.aborted || attempt >= maxRetries || !isRetryable(error)) {
            throw error;
          }
          controller.abort(error);
          attempt += 1;
          await sleep(backoffMs(attempt));
        };

        // Phase 1 — establish the stream and pull its first event. Any failure
        // here is pre-first-token, so it is eligible for a retry.
        let iterator: AsyncIterator<AssistantMessageEvent>;
        let first: IteratorResult<AssistantMessageEvent>;
        try {
          const inner = await Promise.resolve(
            next(model, context, { ...(callOptions ?? {}), signal: controller.signal }),
          );
          committed = inner;
          iterator = inner[Symbol.asyncIterator]();
          first = await iterator.next();
        } catch (error) {
          committed = undefined;
          await retryOrThrow(error);
          continue;
        }

        // Phase 2 — committed. From the first yield onward we never retry:
        // replaying a partially-consumed stream would corrupt it.
        try {
          if (first.done) return;
          yield first.value;
          for (;;) {
            const result = await iterator.next();
            if (result.done) return;
            yield result.value;
          }
        } finally {
          detach();
        }
        return;
      }
    };

    return {
      [Symbol.asyncIterator]: () => iterate(),
      result: (): Promise<AssistantMessage> =>
        committed
          ? committed.result()
          : Promise.reject(new Error('Stream retry: result() called before the stream produced output.')),
    } as unknown as ReturnType<StreamFn>;
  }) as StreamFn;
};
