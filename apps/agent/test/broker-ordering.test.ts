import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionEventBroker } from '../src/runtime.js';

const textFinal = (sessionId: string) =>
  ({ type: 'text_final', sessionId, text: 'hi' }) as never;
const agentEnd = (sessionId: string) =>
  ({ type: 'agent_end', sessionId }) as never;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('per-subscriber FIFO holds when publishes are not awaited and the subscriber is slow on the first event', async () => {
  const broker = new SessionEventBroker();
  const received: string[] = [];
  broker.subscribe('s', async (envelope) => {
    // Slow on the first event only: without per-subscriber serialization the
    // fast agent_end delivery would overtake the slow text_final delivery.
    if (envelope.event.type === 'text_final') await delay(30);
    received.push(envelope.event.type);
  });

  // Emitters fire without awaiting publish (as agent-runner does).
  void broker.publish(textFinal('s'));
  void broker.publish(agentEnd('s'));

  await delay(120);
  assert.deepEqual(received, ['text_final', 'agent_end'], 'agent_end must never overtake the preceding text_final');
});

test('a stuck subscriber does not reorder or block delivery to an independent subscriber', async () => {
  const broker = new SessionEventBroker(100);
  const originalError = console.error;
  console.error = () => {};
  try {
    // Never resolves; models a dead client.
    broker.subscribe('s', () => new Promise<void>(() => {}));
    const received: string[] = [];
    broker.subscribe('s', (envelope) => {
      received.push(envelope.event.type);
    });

    void broker.publish(textFinal('s'));
    void broker.publish(agentEnd('s'));

    await delay(50);
    assert.deepEqual(received, ['text_final', 'agent_end'], 'the healthy subscriber gets both in order despite a stuck peer');
  } finally {
    console.error = originalError;
  }
});
