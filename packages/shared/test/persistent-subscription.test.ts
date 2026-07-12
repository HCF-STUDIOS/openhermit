import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';

import { startPersistentSubscription, type SseFrame } from '../src/persistent-subscription.js';

function frameText(id: number | undefined, event: string, data: unknown): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Fake SSE body. Delivers `text` on the first read then closes or errors on the next. */
function makeStream(text: string, endBehavior: 'close' | 'error'): ReadableStream<Uint8Array> {
  let delivered = false;
  return new ReadableStream({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(new TextEncoder().encode(text));
        return;
      }
      if (endBehavior === 'error') {
        controller.error(new Error('simulated drop'));
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Fake SSE body that enqueues each item after its per-pull delay then stays
 * open forever with a never-resolving pull so only the idle timeout can end
 * the stream. Models a live gateway connection that has gone quiet.
 */
function makeTimedStream(items: Array<{ delayMs: number; text: string }>): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= items.length) {
        // Stay open indefinitely. The idle timer is the only thing that ends us.
        return new Promise<void>(() => {});
      }
      const item = items[i++]!;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(item.text));
          resolve();
        }, item.delayMs);
      });
    },
  });
}

async function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('keeps delivering events after agent_end instead of stopping there', async () => {
  const body = frameText(1, 'text_delta', { text: 'hi' })
    + frameText(2, 'agent_end', {})
    + frameText(3, 'attachment', { url: 'https://x/y.png' });

  await withFetch(
    async () => new Response(makeStream(body, 'close'), { status: 200 }),
    async () => {
      const received: SseFrame[] = [];
      const abortController = new AbortController();

      await startPersistentSubscription({
        eventsUrl: 'https://example/events',
        onEvent: (frame) => {
          received.push(frame);
          if (frame.event === 'attachment') abortController.abort();
        },
        abortSignal: abortController.signal,
        reconnectDelayMs: 5,
      });

      assert.deepEqual(received.map((f) => f.event), ['text_delta', 'agent_end', 'attachment']);
    },
  );
});

test('reconnects after a dropped stream without redelivering already-seen ids', async () => {
  const firstBody = frameText(1, 'attachment', { n: 1 }) + frameText(2, 'attachment', { n: 2 });
  const secondBody = frameText(1, 'attachment', { n: 1 })
    + frameText(2, 'attachment', { n: 2 })
    + frameText(3, 'attachment', { n: 3 });

  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return calls === 1
        ? new Response(makeStream(firstBody, 'error'), { status: 200 })
        : new Response(makeStream(secondBody, 'close'), { status: 200 });
    },
    async () => {
      const received: number[] = [];
      const abortController = new AbortController();

      await startPersistentSubscription({
        eventsUrl: 'https://example/events',
        onEvent: (frame) => {
          const payload = JSON.parse(frame.data) as { n: number };
          received.push(payload.n);
          if (payload.n === 3) abortController.abort();
        },
        abortSignal: abortController.signal,
        reconnectDelayMs: 5,
      });

      assert.deepEqual(received, [1, 2, 3]);
      assert.equal(calls, 2);
    },
  );
});

test('closes and resolves after idleTimeoutMs with no frames, without reconnecting', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      // A live stream that never sends a frame and never closes on its own.
      return new Response(makeTimedStream([]), { status: 200 });
    },
    async () => {
      const received: SseFrame[] = [];
      const start = Date.now();

      // The idle timer is unref'd in production so it never blocks process
      // exit. Keep a ref'd interval alive here so the test's own event loop
      // doesn't end before that timer gets a chance to fire.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await startPersistentSubscription({
          eventsUrl: 'https://example/events',
          onEvent: (frame) => received.push(frame),
          idleTimeoutMs: 60,
          // A short reconnect delay would let a bug reconnect quickly. Keep it
          // large so a wrongful reconnect would hang the test instead of hiding.
          reconnectDelayMs: 10_000,
        });
      } finally {
        clearInterval(keepAlive);
      }

      // Resolved on idle close not after a reconnect cycle.
      assert.equal(received.length, 0);
      assert.equal(calls, 1);
      assert.ok(Date.now() - start < 5_000, 'should resolve promptly on idle close');
    },
  );
});

test('onCursorAdvance reports the cursor so a caller can resume after idle-close without redelivering the backlog', async () => {
  // Models the real bug. An attachment id 1 arrives. The connection then
  // idle-closes and the caller drops the map entry. A NEW subscription opens
  // later. The gateway always replays its recent backlog on a fresh
  // connection so the second stream re-serves id 1 alongside a genuinely
  // new id 2. A caller that persisted the cursor via `onCursorAdvance` and
  // passes it back as `lastEventId` must skip the already-delivered id 1 and
  // still deliver the new id 2 exactly once.
  let persistedCursor = 0;
  const received: number[] = [];

  // First connection delivers id 1 then goes idle forever. Only the idle
  // timer ends it with no reconnect.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await withFetch(
      async () => new Response(
        makeTimedStream([{ delayMs: 0, text: frameText(1, 'attachment', { n: 1 }) }]),
        { status: 200 },
      ),
      async () => {
        await startPersistentSubscription({
          eventsUrl: 'https://example/events',
          onEvent: (frame) => received.push((JSON.parse(frame.data) as { n: number }).n),
          onCursorAdvance: (cursor) => { persistedCursor = cursor; },
          idleTimeoutMs: 30,
          reconnectDelayMs: 10_000,
        });
      },
    );
  } finally {
    clearInterval(keepAlive);
  }

  assert.deepEqual(received, [1]);
  assert.equal(persistedCursor, 1, 'cursor should have advanced to the delivered id');

  // Second reopen. A fresh call as a bridge would make after reopening a
  // session's subscription. The gateway replays its backlog of ids 1 and 2
  // because it honors no resume header itself. Only the client-side cursor
  // dedupes. Passing the persisted cursor must skip id 1 and deliver id 2.
  const abortController = new AbortController();
  await withFetch(
    async () => new Response(
      makeStream(
        frameText(1, 'attachment', { n: 1 }) + frameText(2, 'attachment', { n: 2 }),
        'close',
      ),
      { status: 200 },
    ),
    async () => {
      await startPersistentSubscription({
        eventsUrl: 'https://example/events',
        lastEventId: persistedCursor,
        onEvent: (frame) => {
          received.push((JSON.parse(frame.data) as { n: number }).n);
          abortController.abort();
        },
        onCursorAdvance: (cursor) => { persistedCursor = cursor; },
        abortSignal: abortController.signal,
        reconnectDelayMs: 5,
      });
    },
  );

  // The already-delivered attachment id 1 must NOT be redelivered. The new
  // one id 2 must be delivered. Exactly one delivery per id.
  assert.deepEqual(received, [1, 2]);
});

test('does not leak an abort listener per reconnect once the retry timer wins', async () => {
  // Each `!response.ok` reconnect sleeps before retrying. When the sleep
  // timer resolves on its own with no abort it must detach the abort listener
  // it registered. Otherwise one listener accumulates per retry for the
  // life of the subscription.
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      if (calls <= 3) return new Response(null, { status: 500 });
      return new Response(makeTimedStream([]), { status: 200 });
    },
    async () => {
      const abortController = new AbortController();
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await startPersistentSubscription({
          eventsUrl: 'https://example/events',
          onEvent: () => {},
          abortSignal: abortController.signal,
          reconnectDelayMs: 5,
          idleTimeoutMs: 30,
        });
      } finally {
        clearInterval(keepAlive);
      }

      assert.equal(calls, 4, 'three failed reconnects then one idle-closed connection');
      assert.equal(
        getEventListeners(abortController.signal, 'abort').length,
        0,
        'no abort listeners should remain attached after the subscription resolves',
      );
    },
  );
});

test('onEnding fires when idle closes, before the subscription promise settles', async () => {
  // Bridges gate reopens on a map entry held until teardown finishes. If
  // that entry is only cleared in a finally after cancel settles, a
  // concurrent start no-ops during the window. onEnding must fire as soon
  // as idle decides to end, while the promise is still pending.
  let onEndingCalls = 0;
  let promiseSettled = false;
  let onEndingWhilePending = false;

  const keepAlive = setInterval(() => {}, 1000);
  try {
    await withFetch(
      async () => new Response(makeTimedStream([]), { status: 200 }),
      async () => {
        const done = startPersistentSubscription({
          eventsUrl: 'https://example/events',
          onEvent: () => {},
          onEnding: () => {
            onEndingCalls += 1;
            onEndingWhilePending = !promiseSettled;
          },
          idleTimeoutMs: 40,
          reconnectDelayMs: 10_000,
        });
        await done;
        promiseSettled = true;
      },
    );
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(onEndingCalls, 1, 'onEnding should fire exactly once on idle close');
  assert.equal(onEndingWhilePending, true, 'onEnding must run before the promise settles');
});

test('a frame within idleTimeoutMs resets the idle timer so an active stream is not evicted', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      // Four frames 25ms apart. Each gap is under the 60ms idle window. Then
      // the stream goes quiet. If the timer did NOT reset per frame it would
      // close ~60ms in and miss the later frames.
      return new Response(
        makeTimedStream([
          { delayMs: 25, text: frameText(1, 'attachment', { n: 1 }) },
          { delayMs: 25, text: frameText(2, 'attachment', { n: 2 }) },
          { delayMs: 25, text: frameText(3, 'attachment', { n: 3 }) },
          { delayMs: 25, text: frameText(4, 'attachment', { n: 4 }) },
        ]),
        { status: 200 },
      );
    },
    async () => {
      const received: number[] = [];

      // See the previous test. The idle timer is unref'd in production so
      // keep the test's event loop alive independently of it.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await startPersistentSubscription({
          eventsUrl: 'https://example/events',
          onEvent: (frame) => {
            received.push((JSON.parse(frame.data) as { n: number }).n);
          },
          idleTimeoutMs: 60,
          reconnectDelayMs: 10_000,
        });
      } finally {
        clearInterval(keepAlive);
      }

      // All four in-flight frames delivered because each reset the timer.
      // The stream only idle-closed after the last one without reconnecting.
      assert.deepEqual(received, [1, 2, 3, 4]);
      assert.equal(calls, 1);
    },
  );
});
