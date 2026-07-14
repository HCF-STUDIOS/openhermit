import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SlackBridge } from '../src/bridge.js';

// The per-turn reader (waitForAgentResponse) must close only on the agent_end
// that answered ITS OWN message. Slack has no per-chat serialization, so two
// same-thread messages overlap: message B, posted behind a still-running turn
// A, must ignore A's session-wide agent_end and return B's own reply.

function frameText(id: number | undefined, event: string, data: unknown): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

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

async function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const fakeSlackApi = {} as unknown as ConstructorParameters<typeof SlackBridge>[0];

function newBridge(): SlackBridge {
  return new SlackBridge(fakeSlackApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});
}

type Reader = (
  sessionId: string,
  channelId: string,
  threadTs?: string,
  ownMessageId?: string,
) => Promise<{ text?: string; error?: string }>;

test('slack reader ignores a concurrent turn agent_end and closes on its own (messageId)', async () => {
  const bridge = newBridge();
  const body =
    // A's session-wide end arrives first; it did not answer B.
    frameText(1, 'agent_end', { messageId: 'A' }) +
    frameText(2, 'text_final', { text: 'B-reply' }) +
    // B's own end.
    frameText(3, 'agent_end', { messageId: 'B' });

  let result: { text?: string; error?: string } | undefined;
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      result = await (bridge as unknown as { waitForAgentResponse: Reader })
        .waitForAgentResponse('sess', 'chan', undefined, 'B');
    },
  );

  assert.equal(result?.text, 'B-reply', 'reader must return its own reply, not close on A\'s end');
});

test('slack reader closes on its own end named via answeredMessageIds', async () => {
  const bridge = newBridge();
  const body =
    frameText(1, 'agent_end', { messageId: 'A', answeredMessageIds: ['A'] }) +
    frameText(2, 'text_final', { text: 'B-reply' }) +
    // B was folded into a turn whose end names it in answeredMessageIds.
    frameText(3, 'agent_end', { messageId: 'C', answeredMessageIds: ['C', 'B'] });

  let result: { text?: string; error?: string } | undefined;
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      result = await (bridge as unknown as { waitForAgentResponse: Reader })
        .waitForAgentResponse('sess', 'chan', undefined, 'B');
    },
  );

  assert.equal(result?.text, 'B-reply');
});

test('slack reader stops at its own agent_end and ignores a following turn frames in the same chunk', async () => {
  const bridge = newBridge();
  // A single decoded chunk carries B's terminal frames followed by C's. The
  // reader must return B's text and not read past its own agent_end into C.
  const body =
    frameText(1, 'text_final', { text: 'B-reply' }) +
    frameText(2, 'agent_end', { messageId: 'B' }) +
    frameText(3, 'text_final', { text: 'C-reply' }) +
    frameText(4, 'agent_end', { messageId: 'C' });

  let result: { text?: string; error?: string } | undefined;
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      result = await (bridge as unknown as { waitForAgentResponse: Reader })
        .waitForAgentResponse('sess', 'chan', undefined, 'B');
    },
  );

  assert.equal(result?.text, 'B-reply', 'reader must not process C\'s frames after its own agent_end');
});

test('slack reader ignores a concurrent turn text and returns only its own (content scoping)', async () => {
  const bridge = newBridge();
  // Turn A is still running and interleaves its text on the session while B's
  // reader is open. B must not accumulate A's text; only B's own is returned.
  const body =
    frameText(1, 'text_final', { text: 'A-reply', correlationId: 'A' }) +
    frameText(2, 'text_final', { text: 'B-reply', correlationId: 'B' }) +
    frameText(3, 'agent_end', { messageId: 'B' });

  let result: { text?: string; error?: string } | undefined;
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      result = await (bridge as unknown as { waitForAgentResponse: Reader })
        .waitForAgentResponse('sess', 'chan', undefined, 'B');
    },
  );

  assert.equal(result?.text, 'B-reply', 'reader must ignore the concurrent turn A text and return only its own');
});

test('slack reader accepts its own content whether tagged with its correlationId or untagged', async () => {
  const bridge = newBridge();
  // A concurrent turn A's delta (correlationId A) must be dropped, but B's own
  // frames — tagged B or untagged (legacy runner) — are kept and concatenated.
  const body =
    frameText(1, 'text_delta', { text: 'ignore-A', correlationId: 'A' }) +
    frameText(2, 'text_delta', { text: 'hello ', correlationId: 'B' }) +
    frameText(3, 'text_final', { text: 'hello world' }) +
    frameText(4, 'agent_end', { messageId: 'B' });

  let result: { text?: string; error?: string } | undefined;
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      result = await (bridge as unknown as { waitForAgentResponse: Reader })
        .waitForAgentResponse('sess', 'chan', undefined, 'B');
    },
  );

  assert.equal(result?.text, 'hello world', 'B keeps its own tagged and untagged content, drops A');
});

test('slack reader with no own messageId keeps closing on any agent_end (backward-compat)', async () => {
  const bridge = newBridge();
  const body =
    frameText(1, 'text_final', { text: 'first' }) +
    frameText(2, 'agent_end', { messageId: 'whatever' });

  let result: { text?: string; error?: string } | undefined;
  await withFetch(
    async () => new Response(makeStream(body), { status: 200 }),
    async () => {
      result = await (bridge as unknown as { waitForAgentResponse: Reader })
        .waitForAgentResponse('sess', 'chan', undefined, undefined);
    },
  );

  assert.equal(result?.text, 'first');
});
