import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StreamFn } from '@mariozechner/pi-agent-core';

import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  resolveStreamIdleTimeoutMs,
  withStreamIdleTimeout,
} from '../src/agent-runner/stream-idle-timeout.js';

const model = { provider: 'minimax-cn' } as Parameters<StreamFn>[0];
const context = {} as Parameters<StreamFn>[1];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Build a fake stream whose async iterator yields the given events, sleeping
// `gapMs` before each. `result` resolves with a sentinel message.
const fakeStream = (events: string[], gapMs: number) =>
  ({
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        await delay(gapMs);
        yield { type: 'text_delta', delta: e } as never;
      }
    },
    result: async () => ({ role: 'assistant', content: [] }) as never,
  }) as never;

// A stream that connects but never emits and never ends (the production wedge).
const hangingStream = () =>
  ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    result: () => new Promise<never>(() => {}),
  }) as never;

const drain = async (stream: Awaited<ReturnType<StreamFn>>) => {
  const out: string[] = [];
  for await (const ev of stream as AsyncIterable<{ delta: string }>) {
    out.push(ev.delta);
  }
  return out;
};

test('throws StreamIdleTimeoutError when the stream hangs with no events', async () => {
  const base: StreamFn = (() => hangingStream()) as StreamFn;
  const wrapped = withStreamIdleTimeout(base, 40);
  const stream = await wrapped(model, context, undefined);

  await assert.rejects(drain(stream), (err: unknown) => {
    assert.ok(err instanceof StreamIdleTimeoutError);
    assert.equal(err.idleMs, 40);
    return true;
  });
});

test('passes events through unchanged for a healthy stream', async () => {
  const base: StreamFn = (() => fakeStream(['a', 'b', 'c'], 1)) as StreamFn;
  const wrapped = withStreamIdleTimeout(base, 1_000);
  const stream = await wrapped(model, context, undefined);

  assert.deepEqual(await drain(stream), ['a', 'b', 'c']);
});

test('idle timer resets per-event: a long-but-live stream is not killed', async () => {
  // Six events, 20ms apart = ~120ms total, well past the 50ms idle budget —
  // but each inter-event gap (20ms) stays under it, so it must complete.
  const base: StreamFn = (() => fakeStream(['1', '2', '3', '4', '5', '6'], 20)) as StreamFn;
  const wrapped = withStreamIdleTimeout(base, 50);
  const stream = await wrapped(model, context, undefined);

  assert.deepEqual(await drain(stream), ['1', '2', '3', '4', '5', '6']);
});

test('idleMs <= 0 disables the guard and returns the base fn identity', () => {
  const base: StreamFn = (() => fakeStream([], 0)) as StreamFn;
  assert.equal(withStreamIdleTimeout(base, 0), base);
});

test('a hung stream would never resolve without the guard (control)', async () => {
  const base: StreamFn = (() => hangingStream()) as StreamFn;
  const wrapped = withStreamIdleTimeout(base, 30);
  const stream = await wrapped(model, context, undefined);

  const raced = await Promise.race([
    drain(stream).then(() => 'drained', () => 'threw'),
    delay(300).then(() => 'still-hanging'),
  ]);
  assert.equal(raced, 'threw');
});

test('passes a chained abort signal down to the underlying stream', async () => {
  let seenSignal: AbortSignal | undefined;
  const base: StreamFn = ((_m, _c, opts) => {
    seenSignal = opts?.signal;
    return fakeStream(['x'], 1);
  }) as StreamFn;

  const caller = new AbortController();
  const wrapped = withStreamIdleTimeout(base, 1_000);
  await wrapped(model, context, { signal: caller.signal });

  assert.ok(seenSignal, 'underlying stream received a signal');
  assert.notEqual(seenSignal, caller.signal, 'signal is chained, not the caller signal directly');
  assert.equal(seenSignal?.aborted, false);
  caller.abort(new Error('caller cancelled'));
  assert.equal(seenSignal?.aborted, true, 'caller abort propagates to the chained signal');
});

test('resolveStreamIdleTimeoutMs: default, override, disable, and invalid', () => {
  assert.equal(resolveStreamIdleTimeoutMs({}), DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  assert.equal(resolveStreamIdleTimeoutMs({ STREAM_IDLE_TIMEOUT_MS: '5000' }), 5_000);
  assert.equal(resolveStreamIdleTimeoutMs({ STREAM_IDLE_TIMEOUT_MS: '0' }), 0);
  assert.equal(
    resolveStreamIdleTimeoutMs({ STREAM_IDLE_TIMEOUT_MS: 'nope' }),
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );
  assert.equal(
    resolveStreamIdleTimeoutMs({ STREAM_IDLE_TIMEOUT_MS: '  ' }),
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );
});
