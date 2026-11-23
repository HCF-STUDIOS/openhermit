import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StreamFn } from '@earendil-works/pi-agent-core';

import {
  DEFAULT_STREAM_MAX_RETRIES,
  isRetryableStreamError,
  resolveStreamMaxRetries,
  withStreamRetry,
} from '../src/agent-runner/stream-retry.js';
import { StreamIdleTimeoutError } from '../src/agent-runner/stream-idle-timeout.js';
import { classifyModelError } from '../src/agent-runner/user-facing-error.js';

const model = { provider: 'amiko' } as Parameters<StreamFn>[0];
const context = {} as Parameters<StreamFn>[1];

const noSleep = (_ms: number) => Promise.resolve();

// A fake stream that yields the given deltas, optionally throwing after
// `throwAfter` yields (0 = throw before the first event).
const fakeStream = (deltas: string[], opts: { throwAfter?: number; error?: Error } = {}) => {
  const { throwAfter, error } = opts;
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < deltas.length; i += 1) {
        if (throwAfter !== undefined && i === throwAfter) {
          throw error ?? new Error('terminated');
        }
        yield { type: 'text_delta', delta: deltas[i] } as never;
      }
      if (throwAfter !== undefined && throwAfter >= deltas.length) {
        throw error ?? new Error('terminated');
      }
    },
    result: async () => ({ role: 'assistant', content: [{ type: 'text', text: deltas.join('') }] }) as never,
  } as never;
};

const drain = async (stream: Awaited<ReturnType<StreamFn>>) => {
  const out: string[] = [];
  for await (const ev of stream as AsyncIterable<{ delta: string }>) {
    out.push(ev.delta);
  }
  return out;
};

test('retries a pre-first-token transient failure and succeeds on the next attempt', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    // First attempt: throws `terminated` before yielding anything.
    if (attempts === 1) return fakeStream([], { throwAfter: 0, error: new Error('terminated') });
    return fakeStream(['hello', ' world']);
  }) as StreamFn;

  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, undefined);

  assert.deepEqual(await drain(stream), ['hello', ' world']);
  assert.equal(attempts, 2, 'retried exactly once');
});

test('does NOT retry once an event has been yielded (mid-stream cut rethrows)', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    // Yields one delta, then drops — a committed stream must not be replayed.
    return fakeStream(['partial'], { throwAfter: 1, error: new Error('terminated') });
  }) as StreamFn;

  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, undefined);

  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const ev of stream as AsyncIterable<{ delta: string }>) {
        seen.push(ev.delta);
      }
    })(),
    /terminated/,
  );
  assert.deepEqual(seen, ['partial'], 'the partial event was delivered');
  assert.equal(attempts, 1, 'no retry after commit');
});

test('does NOT retry a non-retryable error even pre-first-token', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    return fakeStream([], { throwAfter: 0, error: new Error('401 Unauthorized') });
  }) as StreamFn;

  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, undefined);

  await assert.rejects(drain(stream), /401/);
  assert.equal(attempts, 1, 'terminal error is not retried');
});

test('gives up after maxRetries and rethrows the last error', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    return fakeStream([], { throwAfter: 0, error: new Error('terminated') });
  }) as StreamFn;

  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, undefined);

  await assert.rejects(drain(stream), /terminated/);
  assert.equal(attempts, 3, 'initial attempt + 2 retries');
});

test('does NOT retry when the caller has aborted', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    return fakeStream([], { throwAfter: 0, error: new Error('terminated') });
  }) as StreamFn;

  const caller = new AbortController();
  caller.abort(new Error('caller cancelled'));
  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, { signal: caller.signal });

  await assert.rejects(drain(stream), /terminated/);
  assert.equal(attempts, 1, 'an aborted caller is never retried');
});

test('result() reflects the committed (successful) attempt', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    if (attempts === 1) return fakeStream([], { throwAfter: 0, error: new Error('terminated') });
    return fakeStream(['final answer']);
  }) as StreamFn;

  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, undefined);
  await drain(stream);

  const result = (await (stream as { result: () => Promise<{ content: { text: string }[] }> }).result());
  assert.equal(result.content[0]?.text, 'final answer');
});

test('passes a chained abort signal down to each attempt', async () => {
  const seen: AbortSignal[] = [];
  const base: StreamFn = ((_m, _c, opts) => {
    if (opts?.signal) seen.push(opts.signal);
    return fakeStream(['x']);
  }) as StreamFn;

  const caller = new AbortController();
  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, { signal: caller.signal });
  await drain(stream);

  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], caller.signal, 'signal is chained, not passed through directly');
});

test('maxRetries <= 0 disables retry and returns the base fn identity', () => {
  const base: StreamFn = (() => fakeStream([])) as StreamFn;
  assert.equal(withStreamRetry(base, { maxRetries: 0 }), base);
});

test('isRetryableStreamError matches connection drops, not terminal errors', () => {
  assert.equal(isRetryableStreamError(new Error('terminated')), true);
  assert.equal(isRetryableStreamError(new Error('UND_ERR_SOCKET')), true);
  assert.equal(isRetryableStreamError(new Error('socket hang up')), true);
  assert.equal(isRetryableStreamError(new Error('502 Bad Gateway')), true);
  assert.equal(isRetryableStreamError(new Error('ECONNRESET')), true);
  assert.equal(isRetryableStreamError(new Error('401 Unauthorized')), false);
  assert.equal(isRetryableStreamError(new Error('429 Too Many Requests')), false);
  assert.equal(isRetryableStreamError(new Error('context length exceeded')), false);
});

test('resolveStreamMaxRetries: default, override, disable, and invalid', () => {
  assert.equal(resolveStreamMaxRetries({}), DEFAULT_STREAM_MAX_RETRIES);
  assert.equal(resolveStreamMaxRetries({ STREAM_MAX_RETRIES: '5' }), 5);
  assert.equal(resolveStreamMaxRetries({ STREAM_MAX_RETRIES: '0' }), 0);
  assert.equal(resolveStreamMaxRetries({ STREAM_MAX_RETRIES: 'nope' }), DEFAULT_STREAM_MAX_RETRIES);
  assert.equal(resolveStreamMaxRetries({ STREAM_MAX_RETRIES: '  ' }), DEFAULT_STREAM_MAX_RETRIES);
});

// pi-ai providers never throw: they catch the failure and push an `error`
// event (usually right after a `start` marker) carrying the AssistantMessage.
const piErrorStream = (errorMessage: string, opts: { withStart?: boolean; text?: string } = {}) => {
  const message = {
    role: 'assistant',
    content: opts.text ? [{ type: 'text', text: opts.text }] : [],
    stopReason: 'error',
    errorMessage,
  };
  return {
    async *[Symbol.asyncIterator]() {
      if (opts.withStart !== false) yield { type: 'start', partial: message } as never;
      if (opts.text) yield { type: 'text_delta', delta: opts.text } as never;
      yield { type: 'error', reason: 'error', error: message } as never;
    },
    result: async () => message as never,
  } as never;
};

const drainTypes = async (stream: Awaited<ReturnType<StreamFn>>) => {
  const out: string[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string; delta?: string }>) {
    out.push(ev.type === 'text_delta' ? `text_delta:${ev.delta}` : ev.type);
  }
  return out;
};

test('retries a pi-style error EVENT that arrives before any output', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    if (attempts === 1) return piErrorStream('503 Service Unavailable');
    return fakeStream(['ok']);
  }) as StreamFn;

  const wrapped = withStreamRetry(base, { maxRetries: 2, sleep: noSleep });
  const stream = await wrapped(model, context, undefined);

  assert.deepEqual(await drainTypes(stream), ['text_delta:ok'], 'the failed attempt\'s start/error never leak');
  assert.equal(attempts, 2);
});

test('retries a pi-style error event even without a preceding start marker', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    if (attempts === 1) return piErrorStream('terminated', { withStart: false });
    return fakeStream(['ok']);
  }) as StreamFn;

  const stream = await withStreamRetry(base, { maxRetries: 2, sleep: noSleep })(model, context, undefined);
  assert.deepEqual(await drainTypes(stream), ['text_delta:ok']);
  assert.equal(attempts, 2);
});

test('does NOT retry a non-retryable pi-style error event; it is passed through', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    return piErrorStream('429 Too Many Requests');
  }) as StreamFn;

  const stream = await withStreamRetry(base, { maxRetries: 2, sleep: noSleep })(model, context, undefined);
  assert.deepEqual(await drainTypes(stream), ['start', 'error']);
  assert.equal(attempts, 1);
});

test('does NOT retry a pi-style error event once output was produced', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    return piErrorStream('terminated', { text: 'partial' });
  }) as StreamFn;

  const stream = await withStreamRetry(base, { maxRetries: 2, sleep: noSleep })(model, context, undefined);
  assert.deepEqual(await drainTypes(stream), ['start', 'text_delta:partial', 'error']);
  assert.equal(attempts, 1);
});

test('passes the final pi-style error event through once retries are exhausted', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    return piErrorStream('502 Bad Gateway');
  }) as StreamFn;

  const stream = await withStreamRetry(base, { maxRetries: 2, sleep: noSleep })(model, context, undefined);
  assert.deepEqual(await drainTypes(stream), ['start', 'error'], 'caller still sees the error event');
  assert.equal(attempts, 3, 'initial attempt + 2 retries');
});

test('retries a pre-first-token provider-stream idle timeout', async () => {
  let attempts = 0;
  const base: StreamFn = (() => {
    attempts += 1;
    if (attempts === 1) return fakeStream([], { throwAfter: 0, error: new StreamIdleTimeoutError(120_000) });
    return fakeStream(['ok']);
  }) as StreamFn;

  const stream = await withStreamRetry(base, { maxRetries: 2, sleep: noSleep })(model, context, undefined);
  assert.deepEqual(await drain(stream), ['ok']);
  assert.equal(attempts, 2);
});

test('retry decision is consistent with the user-facing classifier', () => {
  // Retryable ⇒ classified `unavailable`; terminal kinds are never retried.
  for (const raw of ['terminated', 'ECONNRESET', '503 Service Unavailable', 'overloaded_error', 'premature close']) {
    assert.equal(isRetryableStreamError(new Error(raw)), true, raw);
    assert.equal(classifyModelError(raw), 'unavailable', raw);
  }
  for (const raw of ['402 Payment Required', '429 rate limit', '401 Unauthorized', 'prompt is too long', '404 no endpoints found']) {
    assert.equal(isRetryableStreamError(new Error(raw)), false, raw);
  }
  // A quota message that happens to mention a 5xx-looking number is quota, not retryable.
  assert.equal(isRetryableStreamError(new Error('insufficient credits (code 500)')), false);
});
