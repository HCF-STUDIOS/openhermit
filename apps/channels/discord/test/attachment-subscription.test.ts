import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiscordBridge } from '../src/bridge.js';

// Out-of-turn attachment delivery via the persistent subscription.
//
// Mirrors the Telegram bridge wiring. `startAttachmentSubscription` is the
// single owner of `attachment` event delivery. The per-turn loop in
// `waitForAgentResponse` no longer touches attachment events. So the two
// readers of the shared session stream never both call `deliverAttachment`
// for the same event.

function frameText(id: number | undefined, event: string, data: unknown): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Fake SSE body. Delivers `text` on the first read then closes. */
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
 * Fake SSE body that enqueues each item then stays open forever via a
 * never-resolving pull. Only the idle timeout can end the stream.
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

const fakeDiscordApi = {
  startTyping: async () => undefined,
} as unknown as ConstructorParameters<typeof DiscordBridge>[0];

function newBridge(): { bridge: DiscordBridge; calls: Array<[string, Record<string, unknown>]> } {
  const bridge = new DiscordBridge(fakeDiscordApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});
  const calls: Array<[string, Record<string, unknown>]> = [];
  // deliverAttachment is private. Stub it on the instance so both delivery
  // paths route through this spy instead of the real Discord API.
  (bridge as unknown as { deliverAttachment: (channelId: string, payload: Record<string, unknown>) => Promise<void> })
    .deliverAttachment = async (channelId, payload) => {
      calls.push([channelId, payload]);
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
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, channelId: string) => void })
        .startAttachmentSubscription('sess-1', 'chan-555');

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['chan-555', attachmentPayload]);
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
      // The persistent subscription is already watching this session as it
      // would be from the moment the session opened.
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, channelId: string) => void })
        .startAttachmentSubscription('sess-2', 'chan-777');

      // The per-turn loop reads the same event stream concurrently as it
      // does mid-turn in production.
      await (bridge as unknown as {
        waitForAgentResponse: (sessionId: string, channelId: string) => Promise<unknown>;
      }).waitForAgentResponse('sess-2', 'chan-777');

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['chan-777', attachmentPayload]);
});

test('does not redeliver an attachment after idle-close and reopen (exactly-once across reconnects)', async () => {
  // Reproduces the regression. An out-of-turn attachment id 1 is delivered.
  // The subscription then idle-closes and its map entry is dropped. A later
  // message reopens the subscription the way `ensureSession` does. The
  // gateway replays its backlog on every fresh connection. So the reopened
  // stream re-serves id 1. Without a cursor that survives idle-close/reopen
  // the bridge can not tell id 1 was already delivered and sends it again.
  // A genuinely new event id 2 after reopen must still be delivered.
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
        startAttachmentSubscription: (sessionId: string, channelId: string, idleTimeoutMs?: number) => void;
      }).startAttachmentSubscription.bind(bridge);
      const subscriptionCount = () => (bridge as unknown as { subscriptionCount: number }).subscriptionCount;

      startAttachmentSubscription('sess-4', 'chan-4242', 40);
      await waitFor(() => calls.length >= 1);
      await waitFor(() => subscriptionCount() === 0);

      startAttachmentSubscription('sess-4', 'chan-4242', 40);
      await waitFor(() => calls.length >= 2, 2000);
      await waitFor(() => subscriptionCount() === 0);
    },
  );

  assert.equal(calls.length, 2, 'attachment a1 must be delivered exactly once total, and a2 exactly once');
  assert.deepEqual(calls.map((c) => c[1].attachmentId), ['a1', 'a2']);
});

test('delivers an out-of-turn media-job failure (correlated, no reason) as a text message', async () => {
  const sends: Array<[string, string]> = [];
  const discord = {
    startTyping: async () => undefined,
    sendMessage: async (channelId: string, text: string) => { sends.push([channelId, text]); },
  } as unknown as ConstructorParameters<typeof DiscordBridge>[0];
  const bridge = new DiscordBridge(discord, { baseUrl: 'http://test.local', token: 'tok' }, () => {});

  const body = frameText(1, 'error', { sessionId: 'sess-e1', message: 'image generation failed', correlationId: 'att_9' });
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, channelId: string) => void })
        .startAttachmentSubscription('sess-e1', 'chan-err');
      await waitFor(() => sends.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], ['chan-err', 'Error: image generation failed']);
});

test('out-of-turn subscription drops non-correlated turn errors and reconcile-cancels, delivering only a real media failure', async () => {
  const sends: Array<[string, string]> = [];
  const discord = {
    startTyping: async () => undefined,
    sendMessage: async (channelId: string, text: string) => { sends.push([channelId, text]); },
  } as unknown as ConstructorParameters<typeof DiscordBridge>[0];
  const bridge = new DiscordBridge(discord, { baseUrl: 'http://test.local', token: 'tok' }, () => {});

  const body =
    // Non-correlated turn failure: the in-turn reader owns it, not this path.
    frameText(1, 'error', { sessionId: 'sess-e2', message: 'twin ran out of credits' }) +
    // Internal reconcile-cancel: never shown in a text channel.
    frameText(2, 'error', { sessionId: 'sess-e2', message: 'Media was prepared but not sent.', correlationId: 'att_1', reason: 'reconcile_cancel' }) +
    // Genuine out-of-band media-job failure: delivered exactly once.
    frameText(3, 'error', { sessionId: 'sess-e2', message: 'real media failure', correlationId: 'att_2' });
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, channelId: string) => void })
        .startAttachmentSubscription('sess-e2', 'chan-err2');
      await waitFor(() => sends.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], ['chan-err2', 'Error: real media failure']);
});

test('removes the session entry when its subscription ends (idle close), so it reopens lazily', async () => {
  const { bridge } = newBridge();
  const body = frameText(1, 'attachment', { sessionId: 'sess-3', attachmentId: 'a', kind: 'image', name: 'x.png' });

  await withFetch(
    // Serve the one frame then keep the stream open so only the idle timer
    // ends it. A short idleTimeoutMs is threaded through below.
    async () => new Response(makeTimedStream([{ delayMs: 0, text: body }]), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, channelId: string, idleTimeoutMs?: number) => void })
        .startAttachmentSubscription('sess-3', 'chan-999', 40);

      // Subscription is live right after start.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 1);

      // After the idle timeout with no further frames it ends. The map
      // entry is evicted and the connection drops.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 0);

      assert.equal((bridge as unknown as { subscriptionCount: number }).subscriptionCount, 0);
    },
  );
});
