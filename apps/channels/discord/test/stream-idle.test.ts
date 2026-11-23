import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiscordBridge } from '../src/bridge.js';

/**
 * An agent event stream that delivers a few frames — one with malformed JSON —
 * then stalls without closing (a dead/half-open connection). It errors only
 * when the caller aborts the fetch.
 */
const stallingFetch = (frames: string): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

test('DiscordBridge gives up on a stalled agent event stream and skips malformed frames', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = stallingFetch(
    'event: text_delta\ndata: {not json\n\n'
      + 'event: text_final\ndata: {"text":"hello"}\n\n'
      + 'event: ping\ndata: {}\n\n',
  );

  const logs: string[] = [];
  const bridge = Object.assign(Object.create(DiscordBridge.prototype), {
    client: { buildEventsUrl: () => 'http://agent.invalid/events' },
    clientToken: 'tok',
    lastEventIds: new Map(),
    staleTurns: new Map(),
    log: (msg: string) => logs.push(msg),
    discord: { startTyping: async () => undefined },
    agentStreamIdleTimeoutMs: 50,
  }) as { waitForAgentResponse: (...args: unknown[]) => Promise<{ text?: string; error?: string }> };

  const result = await bridge.waitForAgentResponse('s1', 'c1');

  assert.match(result.error ?? '', /idle/, 'the turn ends with an idle-timeout error instead of hanging');
  assert.equal(result.text, 'hello', 'frames received before the stall are kept');
  assert.ok(logs.some((l) => l.includes('malformed')), 'the malformed frame is logged and skipped');
});

test('DiscordBridge ends the turn on a malformed agent_end frame', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = stallingFetch(
    'event: text_final\ndata: {"text":"hello"}\n\n'
      + 'event: agent_end\ndata: {not json\n\n',
  );

  const logs: string[] = [];
  const bridge = Object.assign(Object.create(DiscordBridge.prototype), {
    client: { buildEventsUrl: () => 'http://agent.invalid/events' },
    clientToken: 'tok',
    lastEventIds: new Map(),
    staleTurns: new Map(),
    log: (msg: string) => logs.push(msg),
    discord: { startTyping: async () => undefined },
    agentStreamIdleTimeoutMs: 2_000,
  }) as { waitForAgentResponse: (...args: unknown[]) => Promise<{ text?: string; error?: string }> };

  const result = await bridge.waitForAgentResponse('s1', 'c1');

  assert.equal(result.error, undefined, 'agent_end ends the turn even with an unparseable payload');
  assert.equal(result.text, 'hello');
});

/**
 * One scripted agent event stream per fetch call, each chunk delivered as its
 * own read. `close: false` streams stall after their chunks (a dead
 * connection) and error only when aborted; `close: true` streams end there.
 */
const scriptedFetch = (streams: { chunks: string[]; close: boolean }[]): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const next = streams.shift();
    if (!next) throw new Error('unexpected extra fetch');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of next.chunks) controller.enqueue(new TextEncoder().encode(chunk));
        if (next.close) {
          controller.close();
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

const sse = (id: number, event: string, data: string) => `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;

test('DiscordBridge: late events of a turn whose wait gave up are not the next message\'s reply', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = scriptedFetch([
    // Message 1: its turn starts, then the wait gives up (idle timeout) while the
    // turn is still running.
    { chunks: [sse(1, 'text_delta', '{"text":"old "}')], close: false },
    // Message 2: the stream resumes after the cursor, so message 1's late
    // reply and agent_end arrive first, then message 2's own turn.
    {
      chunks: [
        sse(2, 'text_final', '{"text":"old reply"}') + sse(3, 'agent_end', '{}'),
        sse(4, 'text_final', '{"text":"new reply"}') + sse(5, 'agent_end', '{}'),
      ],
      close: false,
    },
  ]);

  const bridge = Object.assign(Object.create(DiscordBridge.prototype), {
    client: { buildEventsUrl: () => 'http://agent.invalid/events' },
    clientToken: 'tok',
    lastEventIds: new Map(),
    staleTurns: new Map(),
    log: () => undefined,
    discord: { startTyping: async () => undefined },
    agentStreamIdleTimeoutMs: 50,
  }) as {
    lastEventIds: Map<string, number>;
    waitForAgentResponse: (...args: unknown[]) => Promise<{ text?: string; error?: string }>;
  };

  const first = await bridge.waitForAgentResponse('s1', 'c1');
  assert.match(first.error ?? '', /idle/, 'the first wait gives up before its turn ends');

  const second = await bridge.waitForAgentResponse('s1', 'c1');
  assert.equal(second.text, 'new reply', 'the old turn\'s late reply is skipped');
  assert.equal(second.error, undefined);
});

test('DiscordBridge: a wait stops at its own agent_end, leaving the next turn\'s frames unread', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = scriptedFetch([
    {
      chunks: [
        sse(1, 'text_final', '{"text":"mine"}') + sse(2, 'agent_end', '{}')
          + sse(3, 'text_final', '{"text":"next turn"}') + sse(4, 'agent_end', '{}'),
      ],
      close: false,
    },
  ]);

  const bridge = Object.assign(Object.create(DiscordBridge.prototype), {
    client: { buildEventsUrl: () => 'http://agent.invalid/events' },
    clientToken: 'tok',
    lastEventIds: new Map(),
    staleTurns: new Map(),
    log: () => undefined,
    discord: { startTyping: async () => undefined },
    agentStreamIdleTimeoutMs: 2000,
  }) as {
    lastEventIds: Map<string, number>;
    waitForAgentResponse: (...args: unknown[]) => Promise<{ text?: string; error?: string }>;
  };

  const result = await bridge.waitForAgentResponse('s1', 'c1');
  assert.equal(result.text, 'mine');
  assert.equal(bridge.lastEventIds.get('s1'), 2, 'the cursor stops at this turn\'s agent_end');
});
