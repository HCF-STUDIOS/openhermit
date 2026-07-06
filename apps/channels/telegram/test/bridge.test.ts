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

// --- Out-of-turn attachment delivery via the persistent subscription ---
//
// These exercise the wiring added for exactly-once attachment delivery:
// `startAttachmentSubscription` (started per-session, e.g. from
// `ensureSession`) is the SINGLE owner of `attachment` event delivery.
// The per-turn loop in `waitForAgentResponse` no longer touches attachment
// events at all, so the two readers of the same session event stream can
// never both call `deliverAttachmentToTelegram` for the same event.

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

const fakeTelegramApi = {
  sendChatAction: async () => true,
} as unknown as TelegramApi;

function newBridge(): { bridge: TelegramBridge; calls: Array<[number, Record<string, unknown>]> } {
  const bridge = new TelegramBridge(fakeTelegramApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});
  const calls: Array<[number, Record<string, unknown>]> = [];
  // deliverAttachmentToTelegram is private; stub it on the instance so both
  // delivery paths under test route through this spy instead of touching
  // the real Telegram Bot API.
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
      // The persistent subscription is already watching this session, as it
      // would be from the moment the session was opened.
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, chatId: number) => void })
        .startAttachmentSubscription('sess-2', 777);

      // The per-turn loop reads the SAME event stream concurrently, as it
      // does mid-turn in production.
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
  // Reproduces the regression: an out-of-turn attachment (id 1) is
  // delivered, the subscription then idle-closes (its subscriptions map
  // entry is dropped, same as `removes the session entry...` above), and a
  // later message reopens the subscription the way `ensureSession` does. The
  // gateway replays its backlog on every fresh connection regardless of
  // reconnect vs. brand-new session, so the reopened stream re-serves id 1.
  // Without a cursor that survives the idle-close/reopen cycle, the bridge
  // has no way to know id 1 was already delivered and sends it again. A
  // genuinely new event (id 2) after reopen must still be delivered.
  const { bridge, calls } = newBridge();
  const firstBody = frameText(1, 'attachment', { sessionId: 'sess-4', attachmentId: 'a1', kind: 'document', name: 'one.pdf' });
  const secondBody =
    frameText(1, 'attachment', { sessionId: 'sess-4', attachmentId: 'a1', kind: 'document', name: 'one.pdf' }) +
    frameText(2, 'attachment', { sessionId: 'sess-4', attachmentId: 'a2', kind: 'document', name: 'two.pdf' });

  let call = 0;
  await withFetch(
    async () => {
      call += 1;
      // First connection: serve the one frame, then idle forever.
      if (call === 1) return new Response(makeTimedStream([{ delayMs: 0, text: firstBody }]), { status: 200 });
      // Second connection (the reopen): the gateway replays its backlog,
      // which still contains id 1, plus the new id 2, then goes quiet
      // (mirrors the first connection so only the idle timer ends it).
      return new Response(makeTimedStream([{ delayMs: 0, text: secondBody }]), { status: 200 });
    },
    async () => {
      const startAttachmentSubscription = (bridge as unknown as {
        startAttachmentSubscription: (sessionId: string, chatId: number, idleTimeoutMs?: number) => void;
      }).startAttachmentSubscription.bind(bridge);
      const subscriptionCount = () => (bridge as unknown as { subscriptionCount: number }).subscriptionCount;

      // First open: short idle timeout so it closes quickly on its own.
      startAttachmentSubscription('sess-4', 4242, 40);
      await waitFor(() => calls.length >= 1);
      await waitFor(() => subscriptionCount() === 0);

      // Reopen, as `ensureSession` does on the next inbound message.
      startAttachmentSubscription('sess-4', 4242, 40);
      await waitFor(() => calls.length >= 2, 2000);
      await waitFor(() => subscriptionCount() === 0);
    },
  );

  assert.equal(calls.length, 2, 'attachment a1 must be delivered exactly once total, and a2 exactly once');
  assert.deepEqual(calls.map((c) => c[1].attachmentId), ['a1', 'a2']);
});

test('/new (handleNew) aborts and removes the old session\'s persistent subscription, not just its cursor', async () => {
  // A dedicated fake API (not the shared module-level one) so stubbing
  // sendMessage here can't affect other tests that rely on it being absent.
  const localTelegramApi = {
    sendChatAction: async () => true,
    sendMessage: async () => ({ message_id: 1 }),
  } as unknown as TelegramApi;
  const bridge = new TelegramBridge(localTelegramApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});
  const chatId = 4321;

  // Stub the network calls handleNew makes so the test stays offline.
  (bridge as unknown as { client: { checkpointSession: () => Promise<unknown> } }).client.checkpointSession =
    async () => ({});

  // Seed the chat's current (soon-to-be-old) session and a live persistent
  // subscription for it, the way `ensureSession` would have left it.
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
  // A fresh session id must have replaced the old one for this chat.
  assert.notEqual((bridge as unknown as { chatSessions: Map<number, string> }).chatSessions.get(chatId), 'old-sess');
});

test('removes the session entry when its subscription ends (idle close), so it reopens lazily', async () => {
  const { bridge } = newBridge();
  const body = frameText(1, 'attachment', { sessionId: 'sess-3', attachmentId: 'a', kind: 'image', name: 'x.png' });

  await withFetch(
    // Serve the one frame, then keep the stream open so only the idle timer
    // ends it. A short idleTimeoutMs is threaded through below.
    async () => new Response(makeTimedStream([{ delayMs: 0, text: body }]), { status: 200 }),
    async () => {
      (bridge as unknown as { startAttachmentSubscription: (sessionId: string, chatId: number, idleTimeoutMs?: number) => void })
        .startAttachmentSubscription('sess-3', 999, 40);

      // Subscription is live right after start.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 1);

      // After the idle timeout with no further frames, it ends and the map
      // entry is evicted, dropping the connection.
      await waitFor(() => (bridge as unknown as { subscriptionCount: number }).subscriptionCount === 0);

      assert.equal((bridge as unknown as { subscriptionCount: number }).subscriptionCount, 0);
    },
  );
});
