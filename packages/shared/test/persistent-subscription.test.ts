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
