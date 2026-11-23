import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LarkBridge } from '../src/bridge.js';

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

test('LarkBridge gives up on a stalled agent event stream and skips malformed frames', async (t) => {
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
  const bridge = Object.assign(Object.create(LarkBridge.prototype), {
    client: { buildEventsUrl: () => 'http://agent.invalid/events' },
    clientToken: 'tok',
    lastEventIds: new Map(),
    log: (msg: string) => logs.push(msg),
    agentStreamIdleTimeoutMs: 50,
  }) as { waitForAgentResponse: (...args: unknown[]) => Promise<{ text?: string; error?: string }> };

  const result = await bridge.waitForAgentResponse('s1', 'c1');

  assert.match(result.error ?? '', /idle/, 'the turn ends with an idle-timeout error instead of hanging');
  assert.equal(result.text, 'hello', 'frames received before the stall are kept');
  assert.ok(logs.some((l) => l.includes('malformed')), 'the malformed frame is logged and skipped');
});
