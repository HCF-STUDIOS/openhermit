import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WechatBridge } from '../src/bridge.js';

// --- Out-of-turn attachment delivery via the persistent subscription ---
//
// Mirrors the Telegram bridge's wiring: `startAttachmentSubscription`
// (started per-session from `ensureSession`) is the SINGLE owner of
// `attachment` event delivery. The per-turn loop in `waitForAgentResponse`
// no longer collects or delivers attachment events at all, so the two
// readers of the same session event stream can never both call
// `deliverAttachment` for the same event.

function frameText(id: number | undefined, event: string, data: unknown): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** A fake SSE body: delivers `text` on the first read, then closes. */
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
 * A fake SSE body that enqueues each item then stays open forever (a
 * never-resolving pull), so only the idle timeout can end the stream.
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

function newBridge(): { bridge: WechatBridge; calls: Array<[string, Record<string, unknown>]> } {
  const bridge = new WechatBridge(
    { baseUrl: 'https://bot.example/', botToken: 'tok' },
    { baseUrl: 'https://agent.example/', token: 'ctok' },
    () => {},
  );
  const calls: Array<[string, Record<string, unknown>]> = [];
  // deliverAttachment is private; stub it on the instance so both delivery
  // paths under test route through this spy instead of the real iLink CDN.
  (bridge as unknown as { deliverAttachment: (peer: string, att: Record<string, unknown>) => Promise<void> })
    .deliverAttachment = async (peer, att) => {
      calls.push([peer, att]);
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
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, peer: string) => void })
        .startAttachmentSubscription('sess-1', 'wxid_peer1');

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'wxid_peer1');
  assert.equal(calls[0]![1]!.attachmentId, 'att-1');
  assert.equal(calls[0]![1]!.sessionId, 'sess-1');
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
      // The persistent subscription is already watching this session, as it
      // would be from the moment the session was opened.
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, peer: string) => void })
        .startAttachmentSubscription('sess-2', 'wxid_peer2');

      // The per-turn loop reads the SAME event stream concurrently, as it
      // does mid-turn in production.
      await (bridge as unknown as {
        waitForAgentResponse: (sessionId: string) => Promise<unknown>;
      }).waitForAgentResponse('sess-2');

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'wxid_peer2');
  assert.equal(calls[0]![1]!.attachmentId, 'att-2');
});

test('does not redeliver an attachment after idle-close and reopen (exactly-once across reconnects)', async () => {
  // Reproduces the regression: an out-of-turn attachment (id 1) is
  // delivered, the subscription then idle-closes (its subscriptions map
  // entry is dropped), and a later message reopens the subscription the way
  // `ensureSession` does. The gateway replays its backlog on every fresh
  // connection regardless of reconnect vs. brand-new session, so the
  // reopened stream re-serves id 1. Without a cursor that survives the
  // idle-close/reopen cycle, the bridge has no way to know id 1 was already
  // delivered and sends it again. A genuinely new event (id 2) after reopen
  // must still be delivered.
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
        startAttachmentSubscription: (sessionId: string, peer: string, idleTimeoutMs?: number) => void;
      }).startAttachmentSubscription.bind(bridge);
      const subscriptionCount = () => (bridge as unknown as { subscriptionCount: number }).subscriptionCount;

      startAttachmentSubscription('sess-4', 'wxid_peer4', 40);
      await waitFor(() => calls.length >= 1);
      await waitFor(() => subscriptionCount() === 0);

      startAttachmentSubscription('sess-4', 'wxid_peer4', 40);
      await waitFor(() => calls.length >= 2, 2000);
      await waitFor(() => subscriptionCount() === 0);
    },
  );

  assert.equal(calls.length, 2, 'attachment a1 must be delivered exactly once total, and a2 exactly once');
  assert.deepEqual(calls.map((c) => c[1]!.attachmentId), ['a1', 'a2']);
});

test('removes the session entry when its subscription ends (idle close), so it reopens lazily', async () => {
  const { bridge } = newBridge();
  const body = frameText(1, 'attachment', { sessionId: 'sess-3', attachmentId: 'a', kind: 'image', name: 'x.png' });

  await withFetch(
    // Serve the one frame, then keep the stream open so only the idle timer
    // ends it. A short idleTimeoutMs is threaded through below.
    async () => new Response(makeTimedStream([{ delayMs: 0, text: body }]), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, peer: string, idleTimeoutMs?: number) => void })
        .startAttachmentSubscription('sess-3', 'wxid_peer3', 40);

      // Subscription is live right after start.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 1);

      // After the idle timeout with no further frames, it ends and the map
      // entry is evicted, dropping the connection.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 0);

      assert.equal((bridge as unknown as { subscriptionCount: number }).subscriptionCount, 0);
    },
  );
});
