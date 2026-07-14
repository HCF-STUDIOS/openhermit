import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickMediaFile, TelegramBridge } from '../src/bridge.js';
import type { TelegramApi, TelegramMessage } from '../src/telegram-api.js';

const baseMessage = (extra: Partial<TelegramMessage>): TelegramMessage => ({
  message_id: 1,
  chat: { id: 1, type: 'private' },
  date: 0,
  ...extra,
});

test('pickMediaFile picks the largest photo size', () => {
  const media = pickMediaFile(baseMessage({
    photo: [
      { file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 1000 },
      { file_id: 'large', file_unique_id: 'l', width: 1280, height: 1280, file_size: 90000 },
    ],
  }));
  assert.deepEqual(media, {
    fileId: 'large',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 90000,
  });
});

test('pickMediaFile maps a document with its filename and mime', () => {
  const media = pickMediaFile(baseMessage({
    document: { file_id: 'd1', file_unique_id: 'd', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 50 },
  }));
  assert.deepEqual(media, {
    fileId: 'd1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 50,
  });
});

test('pickMediaFile maps a video with fallbacks', () => {
  const media = pickMediaFile(baseMessage({
    video: { file_id: 'v1', file_unique_id: 'v', width: 640, height: 480, duration: 5 },
  }));
  assert.deepEqual(media, {
    fileId: 'v1',
    filename: 'video.mp4',
    mimeType: 'video/mp4',
  });
});

test('pickMediaFile returns undefined for a text-only message', () => {
  assert.equal(pickMediaFile(baseMessage({ text: 'hello' })), undefined);
});

// startAttachmentSubscription is the sole owner of attachment delivery, so no event is delivered twice.

function frameText(id: number | undefined, event: string, data: unknown): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Fake SSE body. Delivers text on the first read then closes. */
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
 * Fake SSE body that enqueues each item then stays open forever with a
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

const fakeTelegramApi = {
  sendChatAction: async () => true,
} as unknown as TelegramApi;

function newBridge(): { bridge: TelegramBridge; calls: Array<[number, Record<string, unknown>]> } {
  const bridge = new TelegramBridge(fakeTelegramApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});
  const calls: Array<[number, Record<string, unknown>]> = [];
  // deliverAttachmentToTelegram is private; stub it so both delivery paths route through this spy.
  (bridge as unknown as { deliverAttachmentToTelegram: (chatId: number, payload: Record<string, unknown>) => Promise<void> }).deliverAttachmentToTelegram =
    async (chatId, payload) => {
      calls.push([chatId, payload]);
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
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, chatId: number) => void })
        .startAttachmentSubscription('sess-1', 555);

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [555, attachmentPayload]);
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
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, chatId: number) => void })
        .startAttachmentSubscription('sess-2', 777);

      // Per-turn loop reads the same stream concurrently, as mid-turn in production.
      await (bridge as unknown as {
        waitForAgentResponse: (sessionId: string, chatId: number, suppress?: boolean) => Promise<unknown>;
      }).waitForAgentResponse('sess-2', 777, false);

      await waitFor(() => calls.length > 0);
      (bridge as unknown as { stop: () => void }).stop();
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [777, attachmentPayload]);
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
      // First connection: serve one frame then idle forever.
      if (call === 1) return new Response(makeTimedStream([{ delayMs: 0, text: firstBody }]), { status: 200 });
      // Reopen: gateway replays id 1 plus new id 2 then goes quiet.
      return new Response(makeTimedStream([{ delayMs: 0, text: secondBody }]), { status: 200 });
    },
    async () => {
      const startAttachmentSubscription = (bridge as unknown as {
        startAttachmentSubscription: (sessionId: string, chatId: number, idleTimeoutMs?: number) => void;
      }).startAttachmentSubscription.bind(bridge);
      const subscriptionCount = () => (bridge as unknown as { subscriptionCount: number }).subscriptionCount;

      // First open with a short idle timeout so it closes on its own.
      startAttachmentSubscription('sess-4', 4242, 40);
      await waitFor(() => calls.length >= 1);
      await waitFor(() => subscriptionCount() === 0);

      // Reopen as ensureSession does on the next inbound message.
      startAttachmentSubscription('sess-4', 4242, 40);
      await waitFor(() => calls.length >= 2, 2000);
      await waitFor(() => subscriptionCount() === 0);
    },
  );

  assert.equal(calls.length, 2, 'attachment a1 must be delivered exactly once total, and a2 exactly once');
  assert.deepEqual(calls.map((c) => c[1].attachmentId), ['a1', 'a2']);
});

test('stale-session fallback clears subscriptionCursors and lastEventIds for the abandoned id', async () => {
  // Fresh-fallback must drop cursor maps like handleNew, so an abandoned id
  // cannot write back on a late onCursorAdvance and memory does not grow.
  const localTelegramApi = {
    sendChatAction: async () => true,
    sendMessage: async () => ({ message_id: 1 }),
  } as unknown as TelegramApi;
  const bridge = new TelegramBridge(localTelegramApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});

  const staleId = 'stale-sess';
  (bridge as unknown as { lastEventIds: Map<string, number> }).lastEventIds.set(staleId, 42);
  (bridge as unknown as { subscriptionCursors: Map<string, number> }).subscriptionCursors.set(staleId, 7);
  const oldAbortController = new AbortController();
  let aborted = false;
  oldAbortController.signal.addEventListener('abort', () => { aborted = true; });
  (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions.set(staleId, oldAbortController);
  (bridge as unknown as { chatSessions: Map<number, string> }).chatSessions.set(99, staleId);

  // Stub ensureSession to 404 once on the stale id, then succeed on the fresh id.
  const state = bridge as unknown as {
    ensureSession: (id: string, message: unknown, isGroup: boolean) => Promise<void>;
    sendToAgent: (
      chatId: number,
      sessionId: string,
      text: string,
      message: unknown,
      isGroup: boolean,
    ) => Promise<void>;
    client: { postMessage: (...args: unknown[]) => Promise<unknown> };
  };
  let ensureCalls = 0;
  state.ensureSession = async (id: string) => {
    ensureCalls += 1;
    if (ensureCalls === 1 && id === staleId) {
      throw new Error('HTTP 404: Session not found');
    }
  };
  // Avoid network after open succeeds: pretend the agent did not trigger a turn.
  state.client.postMessage = async () => ({ triggered: false });

  await state.sendToAgent(
    99,
    staleId,
    'hi',
    { chat: { id: 99 }, from: { id: 1, first_name: 't' }, message_id: 1, date: 0, text: 'hi' },
    false,
  );

  assert.equal(aborted, true, 'stale subscription must be aborted');
  assert.equal(
    (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions.has(staleId),
    false,
  );
  assert.equal(
    (bridge as unknown as { subscriptionCursors: Map<string, number> }).subscriptionCursors.has(staleId),
    false,
    'subscriptionCursors entry for abandoned id must be cleared',
  );
  assert.equal(
    (bridge as unknown as { lastEventIds: Map<string, number> }).lastEventIds.has(staleId),
    false,
    'lastEventIds entry for abandoned id must be cleared',
  );
  assert.notEqual(
    (bridge as unknown as { chatSessions: Map<number, string> }).chatSessions.get(99),
    staleId,
  );
});

test('/new (handleNew) aborts and removes the old session\'s persistent subscription, not just its cursor', async () => {
  // Dedicated fake API so stubbing sendMessage cannot affect other tests.
  const localTelegramApi = {
    sendChatAction: async () => true,
    sendMessage: async () => ({ message_id: 1 }),
  } as unknown as TelegramApi;
  const bridge = new TelegramBridge(localTelegramApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});
  const chatId = 4321;

  // Stub the network calls handleNew makes so the test stays offline.
  (bridge as unknown as { client: { checkpointSession: () => Promise<unknown> } }).client.checkpointSession =
    async () => ({});

  // Seed the chat's old session and a live subscription as ensureSession would.
  (bridge as unknown as { chatSessions: Map<number, string> }).chatSessions.set(chatId, 'old-sess');
  const oldAbortController = new AbortController();
  let aborted = false;
  oldAbortController.signal.addEventListener('abort', () => { aborted = true; });
  (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions.set('old-sess', oldAbortController);

  await (bridge as unknown as { handleNew: (chatId: number) => Promise<void> }).handleNew(chatId);

  assert.equal(aborted, true, 'the old session subscription must be aborted, not left running');
  assert.equal(
    (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions.has('old-sess'),
    false,
    'the old session subscription map entry must be removed',
  );
  assert.notEqual((bridge as unknown as { chatSessions: Map<number, string> }).chatSessions.get(chatId), 'old-sess');
});

test('removes the session entry when its subscription ends (idle close), so it reopens lazily', async () => {
  const { bridge } = newBridge();
  const body = frameText(1, 'attachment', { sessionId: 'sess-3', attachmentId: 'a', kind: 'image', name: 'x.png' });

  await withFetch(
    // Serve one frame then stay open so only the idle timer ends it.
    async () => new Response(makeTimedStream([{ delayMs: 0, text: body }]), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, chatId: number, idleTimeoutMs?: number) => void })
        .startAttachmentSubscription('sess-3', 999, 40);

      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 1);

      // After the idle timeout the entry is evicted and the connection drops.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 0);

      assert.equal((bridge as unknown as { subscriptionCount: number }).subscriptionCount, 0);
    },
  );
});
