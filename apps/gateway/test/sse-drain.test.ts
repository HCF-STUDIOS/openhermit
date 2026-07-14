import assert from 'node:assert/strict';
import { test } from 'node:test';

import { drainBufferedLive } from '../src/app.js';

type Envelope = { id: number; event: { type: string } };

const env = (id: number): Envelope => ({ id, event: { type: 't' } });

test('drainBufferedLive keeps a concurrent publish from racing ahead of a lower leftover id', async () => {
  // Two events buffered while the backlog (ids <= 2) replayed.
  const pendingLive: Envelope[] = [env(3), env(4)];
  const written: number[] = [];

  const write = async (e: Envelope) => {
    written.push(e.id);
    // A broker publish lands while id 3 is being written. The old code had
    // already flipped to the live path and would have written id 5 ahead of
    // the leftover id 4. Here it must buffer and drain in order.
    if (e.id === 3) pendingLive.push(env(5));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await drainBufferedLive(pendingLive as any, 2, write as any);

  assert.deepEqual(written, [3, 4, 5], 'events must be written in strictly increasing id order');
});

test('drainBufferedLive skips ids already covered by the replayed backlog', async () => {
  const pendingLive: Envelope[] = [env(1), env(2), env(3)];
  const written: number[] = [];
  const write = async (e: Envelope) => { written.push(e.id); };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await drainBufferedLive(pendingLive as any, 2, write as any);

  assert.deepEqual(written, [3], 'ids <= maxBacklogId are duplicates and must be skipped');
});

test('drainBufferedLive bails when shouldContinue is false (e.g. buffer overflow)', async () => {
  const pendingLive: Envelope[] = [env(3), env(4)];
  const written: number[] = [];
  const write = async (e: Envelope) => { written.push(e.id); };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await drainBufferedLive(pendingLive as any, 2, write as any, () => false);

  assert.deepEqual(written, [], 'no events written once the caller signals stop');
});
