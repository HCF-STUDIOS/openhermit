import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiscordBridge } from '../src/bridge.js';

// startAttachmentSubscription is the single owner of attachment delivery; the
// per-turn loop no longer touches attachment events, so the two readers of the
// shared stream never both deliver the same one.

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

/** Fake SSE body that enqueues each item then stays open forever, so only the idle timeout ends the stream. */
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
  // Stub private deliverAttachment so both delivery paths route through this spy.
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
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, channelId: string) => void })
        .startAttachmentSubscription('sess-2', 'chan-777');

      // Per-turn loop reads the same stream concurrently, as it does mid-turn in production.
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
  // The gateway replays its backlog on every reopen, so after idle-close the
  // re-served id 1 must not redeliver (needs a cursor surviving reopen), while
  // a genuinely new id 2 still must.
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

test('delivers an out-of-turn media-job failure (reason media_error) as a text message', async () => {
  const sends: Array<[string, string]> = [];
  const discord = {
    startTyping: async () => undefined,
    sendMessage: async (channelId: string, text: string) => { sends.push([channelId, text]); },
  } as unknown as ConstructorParameters<typeof DiscordBridge>[0];
  const bridge = new DiscordBridge(discord, { baseUrl: 'http://test.local', token: 'tok' }, () => {});

  const body = frameText(1, 'error', { sessionId: 'sess-e1', message: 'image generation failed', correlationId: 'att_9', reason: 'media_error' });
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

test('out-of-turn subscription drops turn errors (correlated or not) and reconcile-cancels, delivering only a media_error', async () => {
  const sends: Array<[string, string]> = [];
  const discord = {
    startTyping: async () => undefined,
    sendMessage: async (channelId: string, text: string) => { sends.push([channelId, text]); },
  } as unknown as ConstructorParameters<typeof DiscordBridge>[0];
  const bridge = new DiscordBridge(discord, { baseUrl: 'http://test.local', token: 'tok' }, () => {});

  const body =
    // Non-correlated turn failure: the in-turn reader owns it, not this path.
    frameText(1, 'error', { sessionId: 'sess-e2', message: 'twin ran out of credits' }) +
    // Correlated turn failure: classified by reason not correlationId, so not shown here.
    frameText(2, 'error', { sessionId: 'sess-e2', message: 'model stream failed', correlationId: 'turn_7' }) +
    // Internal reconcile-cancel: never shown in a text channel.
    frameText(3, 'error', { sessionId: 'sess-e2', message: 'Media was prepared but not sent.', correlationId: 'att_1', reason: 'reconcile_cancel' }) +
    // Genuine media-job failure (reason media_error): delivered once.
    frameText(4, 'error', { sessionId: 'sess-e2', message: 'real media failure', correlationId: 'att_2', reason: 'media_error' });
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
    // Keep the stream open after one frame so only the idle timer ends it.
    async () => new Response(makeTimedStream([{ delayMs: 0, text: body }]), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, channelId: string, idleTimeoutMs?: number) => void })
        .startAttachmentSubscription('sess-3', 'chan-999', 40);

      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 1);

      // After the idle timeout the entry is evicted and the connection drops.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 0);

      assert.equal((bridge as unknown as { subscriptionCount: number }).subscriptionCount, 0);
    },
  );
});
