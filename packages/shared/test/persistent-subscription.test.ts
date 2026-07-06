import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startPersistentSubscription, type SseFrame } from '../src/persistent-subscription.js';

function frameText(id: number | undefined, event: string, data: unknown): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** A fake SSE body: delivers `text` on the first read, then closes or errors on the next. */
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
 * A fake SSE body that enqueues each item after its per-pull delay, then
 * stays open forever (a never-resolving pull) so that only the idle timeout
 * can end the stream. Models a live gateway connection that has gone quiet.
 */
function makeTimedStream(items: Array<{ delayMs: number; text: string }>): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= items.length) {
        // Stay open indefinitely; the idle timer is the only thing that ends us.
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

      await startPersistentSubscription({
        eventsUrl: 'https://example/events',
        onEvent: (frame) => received.push(frame),
        idleTimeoutMs: 60,
        // A short reconnect delay would let a bug reconnect quickly; keep it
        // large so a wrongful reconnect would hang the test instead of hiding.
        reconnectDelayMs: 10_000,
      });

      // Resolved on idle close, not after a reconnect cycle.
      assert.equal(received.length, 0);
      assert.equal(calls, 1);
      assert.ok(Date.now() - start < 5_000, 'should resolve promptly on idle close');
    },
  );
});

test('a frame within idleTimeoutMs resets the idle timer so an active stream is not evicted', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      // Four frames 25ms apart (each gap < the 60ms idle window), then the
      // stream goes quiet. If the timer did NOT reset per frame it would
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

      await startPersistentSubscription({
        eventsUrl: 'https://example/events',
        onEvent: (frame) => {
          received.push((JSON.parse(frame.data) as { n: number }).n);
        },
        idleTimeoutMs: 60,
        reconnectDelayMs: 10_000,
      });

      // All four in-flight frames delivered because each reset the timer;
      // the stream only idle-closed after the last one, without reconnecting.
      assert.deepEqual(received, [1, 2, 3, 4]);
      assert.equal(calls, 1);
    },
  );
});
