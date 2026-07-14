import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionEventBroker } from '../src/runtime.js';

const textFinal = (sessionId: string) =>
  ({ type: 'text_final', sessionId, text: 'hi' }) as never;
const agentEnd = (sessionId: string) =>
  ({ type: 'agent_end', sessionId }) as never;

test('one rejecting subscriber does not stop delivery to others or abort publish', async () => {
  const broker = new SessionEventBroker();
  const originalError = console.error;
  console.error = () => {};
  try {
    const received: string[] = [];
    broker.subscribe('s', async () => {
      throw new Error('client disconnected');
    });
    broker.subscribe('s', (envelope) => {
      received.push(envelope.event.type);
    });

    // A rejecting subscriber must not block the healthy one, and publish must
    // resolve rather than reject.
    await assert.doesNotReject(() => broker.publish(textFinal('s')));
    await assert.doesNotReject(() => broker.publish(agentEnd('s')));

    assert.deepEqual(received, ['text_final', 'agent_end']);
  } finally {
    console.error = originalError;
  }
});

test('a subscriber that unsubscribes itself during delivery does not perturb the fanout', async () => {
  const broker = new SessionEventBroker();
  const received: string[] = [];
  const unsub = broker.subscribe('s', () => {
    unsub();
  });
  broker.subscribe('s', (envelope) => {
    received.push(envelope.event.type);
  });

  await broker.publish(agentEnd('s'));

  assert.deepEqual(received, ['agent_end'], 'the second subscriber still received the event');
});
