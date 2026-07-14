import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WhatsAppBridge } from '../src/bridge.js';

// startAttachmentSubscription is the sole owner of attachment delivery, so no event is delivered twice.

function frameText(id: number | undefined, event: string, data: unknown): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** A fake SSE body. Delivers `text` on the first read then closes. */
function makeStream(text: string): ReadableStream<Uint8Array> {
  let delivered = false;
  return new ReadableStream({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(new TextEncoder().encode(text));
        return;
      }
      controller.close();
    },
  });
}

/**
 * A fake SSE body that enqueues each item then stays open forever via a
 * never-resolving pull so only the idle timeout can end the stream.
 */
function makeTimedStream(items: Array<{ delayMs: number; text: string }>): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= items.length) return new Promise<void>(() => {});
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fakeWhatsAppApi = {} as unknown as ConstructorParameters<typeof WhatsAppBridge>[0];

function newBridge(): { bridge: WhatsAppBridge; calls: Array<[string, Record<string, unknown>]> } {
  const bridge = new WhatsAppBridge(fakeWhatsAppApi, { baseUrl: 'http://test.local', token: 'tok' }, {}, () => {});
  const calls: Array<[string, Record<string, unknown>]> = [];
  // deliverAttachment is private; stub it so both delivery paths route through this spy.
  (bridge as unknown as { deliverAttachment: (target: string, payload: Record<string, unknown>) => Promise<void> })
    .deliverAttachment = async (target, payload) => {
      calls.push([target, payload]);
    };
  return { bridge, calls };
}

test('delivers an out-of-turn attachment (no active turn) via the persistent subscription', async () => {
  const { bridge, calls } = newBridge();
  const attachmentPayload = { sessionId: 'sess-1', attachmentId: 'att-1', kind: 'document', name: 'report.pdf' };
  const body = frameText(1, 'attachment', attachmentPayload);

  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, target: string) => void })
        .startAttachmentSubscription('sess-1', '15551230001@s.whatsapp.net');

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['15551230001@s.whatsapp.net', attachmentPayload]);
});

test('an in-turn attachment is delivered exactly once, not doubled, with both the per-turn loop and the persistent subscription reading the same stream', async () => {
  const { bridge, calls } = newBridge();
  const attachmentPayload = { sessionId: 'sess-2', attachmentId: 'att-2', kind: 'image', name: 'x.png' };
  const body =
    frameText(1, 'text_delta', { text: 'hi' }) +
    frameText(2, 'attachment', attachmentPayload) +
    frameText(3, 'agent_end', {});

  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      // Persistent subscription is already watching, as in production.
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, target: string) => void })
        .startAttachmentSubscription('sess-2', '15551230002@s.whatsapp.net');

      // Per-turn loop reads the same stream concurrently, as mid-turn in production.
      await (bridge as unknown as {
        waitForAgentResponse: (sessionId: string) => Promise<unknown>;
      }).waitForAgentResponse('sess-2');

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['15551230002@s.whatsapp.net', attachmentPayload]);
});

test('does not redeliver an attachment after idle-close and reopen (exactly-once across reconnects)', async () => {
  // Regression: the gateway replays its backlog on reopen, so without a cursor
  // surviving idle-close the bridge would redeliver id 1. A new id 2 must still arrive.
  const { bridge, calls } = newBridge();
  const firstBody = frameText(1, 'attachment', { sessionId: 'sess-4', attachmentId: 'a1', kind: 'document', name: 'one.pdf' });
  const secondBody =
    frameText(1, 'attachment', { sessionId: 'sess-4', attachmentId: 'a1', kind: 'document', name: 'one.pdf' }) +
    frameText(2, 'attachment', { sessionId: 'sess-4', attachmentId: 'a2', kind: 'document', name: 'two.pdf' });

  let call = 0;
  await withFetch(
    async () => {
      call += 1;
      if (call === 1) return new Response(makeTimedStream([{ delayMs: 0, text: firstBody }]), { status: 200 });
      return new Response(makeTimedStream([{ delayMs: 0, text: secondBody }]), { status: 200 });
    },
    async () => {
      const startAttachmentSubscription = (bridge as unknown as {
        startAttachmentSubscription: (sessionId: string, target: string, idleTimeoutMs?: number) => void;
      }).startAttachmentSubscription.bind(bridge);
      const subscriptionCount = () => (bridge as unknown as { subscriptionCount: number }).subscriptionCount;

      startAttachmentSubscription('sess-4', '15551230004@s.whatsapp.net', 40);
      await waitFor(() => calls.length >= 1);
      await waitFor(() => subscriptionCount() === 0);

      startAttachmentSubscription('sess-4', '15551230004@s.whatsapp.net', 40);
      await waitFor(() => calls.length >= 2, 2000);
      await waitFor(() => subscriptionCount() === 0);
    },
  );

  assert.equal(calls.length, 2, 'attachment a1 must be delivered exactly once total, and a2 exactly once');
  assert.deepEqual(calls.map((c) => c[1].attachmentId), ['a1', 'a2']);
});

test('removes the session entry when its subscription ends (idle close), so it reopens lazily', async () => {
  const { bridge } = newBridge();
  const body = frameText(1, 'attachment', { sessionId: 'sess-3', attachmentId: 'a', kind: 'image', name: 'x.png' });

  await withFetch(
    // Serve one frame then stay open so only the idle timer ends it.
    async () => new Response(makeTimedStream([{ delayMs: 0, text: body }]), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, target: string, idleTimeoutMs?: number) => void })
        .startAttachmentSubscription('sess-3', '15551230003@s.whatsapp.net', 40);

      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 1);

      // After the idle timeout the entry is evicted and the connection drops.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 0);

      assert.equal((bridge as unknown as { subscriptionCount: number }).subscriptionCount, 0);
    },
  );
});
