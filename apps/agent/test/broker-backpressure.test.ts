import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionEventBroker } from '../src/runtime.js';

const textFinal = (sessionId: string) =>
  ({ type: 'text_final', sessionId, text: 'hi' }) as never;
const agentEnd = (sessionId: string) =>
  ({ type: 'agent_end', sessionId }) as never;

const DELIVERY_TIMEOUT_MS = 100;

test('a stuck subscriber does not block delivery to others and publish still resolves', async () => {
  const broker = new SessionEventBroker(DELIVERY_TIMEOUT_MS);
  const originalError = console.error;
  console.error = () => {};
  try {
    // Never resolves: models an SSE writer on a full socket whose write hangs.
    broker.subscribe('s', () => new Promise<void>(() => {}));
    let healthyDelay = Infinity;
    const start = Date.now();
    broker.subscribe('s', () => {
      healthyDelay = Date.now() - start;
    });

    await broker.publish(textFinal('s'));
    const publishDelay = Date.now() - start;

    assert.ok(healthyDelay < 50, `healthy delivery was blocked (delay=${healthyDelay}ms)`);
    assert.ok(publishDelay >= DELIVERY_TIMEOUT_MS - 20, `publish returned too early (delay=${publishDelay}ms)`);
  } finally {
    console.error = originalError;
  }
});

test('a stuck subscriber is dropped so a later agent_end fires without waiting again', async () => {
  const broker = new SessionEventBroker(DELIVERY_TIMEOUT_MS);
  const originalError = console.error;
  console.error = () => {};
  try {
    broker.subscribe('s', () => new Promise<void>(() => {}));
    const received: string[] = [];
    broker.subscribe('s', (envelope) => {
      received.push(envelope.event.type);
    });

    // First publish times out and drops the stuck subscriber.
    await broker.publish(textFinal('s'));

    const start = Date.now();
    await broker.publish(agentEnd('s'));
    const agentEndDelay = Date.now() - start;

    assert.ok(agentEndDelay < 50, `agent_end was delayed by a dropped subscriber (delay=${agentEndDelay}ms)`);
    assert.deepEqual(received, ['text_final', 'agent_end']);
  } finally {
    console.error = originalError;
  }
});

test('per-subscriber ordering is preserved across serialized publishes', async () => {
  const broker = new SessionEventBroker(DELIVERY_TIMEOUT_MS);
  const received: string[] = [];
  broker.subscribe('s', async (envelope) => {
    // An async subscriber: ordering must still hold because each publish is
    // awaited by its emitter before the next event is published.
    await Promise.resolve();
    received.push(envelope.event.type);
  });

  await broker.publish(textFinal('s'));
  await broker.publish(agentEnd('s'));

  assert.deepEqual(received, ['text_final', 'agent_end']);
});
