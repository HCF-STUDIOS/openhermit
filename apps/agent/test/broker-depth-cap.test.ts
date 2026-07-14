import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionEventBroker } from '../src/runtime.js';

const textFinal = (sessionId: string, text = 'hi') =>
  ({ type: 'text_final', sessionId, text }) as never;
const agentEnd = (sessionId: string) =>
  ({ type: 'agent_end', sessionId }) as never;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A subscriber whose delivery chain grows past the depth cap is dropped, so the
// chain and the publishes it holds cannot grow without bound.
test('a subscriber past the pending-depth cap is dropped, not accumulated', async () => {
  // Large per-delivery timeout so a drop, not the timeout, is what unblocks.
  const broker = new SessionEventBroker(10_000, 3);
  const originalError = console.error;
  console.error = () => {};
  // A gate so the in-flight delivery can be released at the end, instead of
  // lingering until the 10s bound.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    let invoked = 0;
    // First delivery starts and blocks on the gate; later ones queue behind it.
    broker.subscribe('s', () => {
      invoked += 1;
      return gate;
    });

    // Fill the chain to the cap: one in-flight + two queued.
    void broker.publish(textFinal('s'));
    void broker.publish(textFinal('s'));
    void broker.publish(textFinal('s'));
    // Let the first delivery start and block so the two behind it stay queued at
    // the cap (a blocked delivery never decrements it).
    await delay(10);

    // The next publish finds the chain at the cap and drops the subscriber; it
    // must resolve immediately, not wait on the 10s delivery timeout.
    const start = Date.now();
    await broker.publish(agentEnd('s'));
    assert.ok(Date.now() - start < 1000, 'drop-path publish must not wait on the delivery timeout');

    // Dropped: a further publish returns immediately and never re-invokes the
    // subscriber (only the first, in-flight delivery ever ran).
    const start2 = Date.now();
    await broker.publish(agentEnd('s'));
    assert.ok(Date.now() - start2 < 1000);
    assert.equal(invoked, 1, 'the slow subscriber was dropped, not accumulated or re-delivered');
  } finally {
    release();
    console.error = originalError;
  }
});

// A synchronous burst larger than the cap must not drop a subscriber that drains
// instantly: only a genuinely stuck head (inFlight > 0 across turns) is dropped.
test('a synchronous burst to a fast subscriber is not dropped by the depth cap', async () => {
  // Default cap 500; publish 600 synchronously to an instantly-resolving sub.
  const broker = new SessionEventBroker();
  let seen = 0;
  broker.subscribe('s', () => {
    seen += 1;
  });

  const pending: Promise<void>[] = [];
  for (let i = 0; i < 600; i += 1) {
    pending.push(broker.publish(textFinal('s')));
  }
  await Promise.all(pending);

  assert.equal(seen, 600, 'a fast subscriber handling a synchronous burst must receive every event');

  // Still subscribed: a later publish is delivered too, not dropped.
  await broker.publish(agentEnd('s'));
  assert.equal(seen, 601, 'the subscriber remains subscribed after the burst');
});

// A burst enqueued in one tick keeps inFlight at 0, so the inFlight-gated soft
// cap never trips; an absolute hard cap must drop the subscriber to keep the
// chain from growing without bound in that tick.
test('a synchronous burst past the hard cap is bounded and drops the subscriber', async () => {
  // soft cap 3 (inFlight-gated), hard cap 5 (absolute). Large per-delivery
  // timeout so a bound, not the timeout, is what unblocks.
  const broker = new SessionEventBroker(10_000, 3, 5);
  const originalError = console.error;
  console.error = () => {};
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    let invoked = 0;
    broker.subscribe('s', () => {
      invoked += 1;
      return gate;
    });

    // Enqueue far more than the hard cap synchronously (inFlight stays 0, so only
    // the hard cap can bound it). All settle promptly, not accrete 100 pending.
    const pending: Promise<void>[] = [];
    const start = Date.now();
    for (let i = 0; i < 100; i += 1) {
      pending.push(broker.publish(textFinal('s')));
    }
    await Promise.all(pending);
    assert.ok(Date.now() - start < 1000, 'hard-cap burst must not wait on the delivery timeout');

    // Dropped once past the hard cap: a later publish returns immediately and is
    // never delivered; the chain never grew to 100.
    await broker.publish(agentEnd('s'));
    assert.ok(invoked <= 1, `chain bounded by the hard cap, not accumulated; invoked=${invoked}`);
  } finally {
    release();
    console.error = originalError;
  }
});

// Backlog replay routes through the same per-subscriber FIFO chain as live
// publish, so replayed events keep publish order.
test('backlog replay preserves per-subscriber order via the FIFO chain', async () => {
  const broker = new SessionEventBroker();
  // Populate the backlog before anyone subscribes.
  await broker.publish(textFinal('s', 'first'));
  await broker.publish(textFinal('s', 'second'));

  const received: string[] = [];
  broker.subscribeFrom('s', 0, async (envelope) => {
    // Slow on the first replayed event only; the fast second must not overtake it.
    if ((envelope.event as { text?: string }).text === 'first') await delay(30);
    received.push((envelope.event as { text?: string }).text ?? '');
  });

  await delay(120);
  assert.deepEqual(received, ['first', 'second'], 'replay must preserve publish order');
});

// A stuck replay callback is bounded by the delivery timeout (and dropped),
// instead of hanging later live delivery forever.
test('a stuck replay subscriber is bounded by the delivery timeout', async () => {
  const broker = new SessionEventBroker(80);
  const originalError = console.error;
  console.error = () => {};
  try {
    await broker.publish(textFinal('s')); // backlog has one event to replay
    broker.subscribeFrom('s', 0, () => new Promise<void>(() => {}));

    // A later live publish chains behind the stuck replay; it resolves once the
    // replay times out (~80ms) and is dropped.
    const start = Date.now();
    await broker.publish(agentEnd('s'));
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 60, `should wait for the replay timeout, got ${elapsed}ms`);
    assert.ok(elapsed < 3000, `must not hang on the stuck replay, got ${elapsed}ms`);
  } finally {
    console.error = originalError;
  }
});
