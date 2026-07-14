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

test('drainBufferedLive flips to live synchronously exactly when the buffer is observed empty', async () => {
  const pendingLive: Envelope[] = [env(3)];
  const written: number[] = [];
  let bufferLenAtFlip = -1;
  const write = async (e: Envelope) => {
    written.push(e.id);
    // A late publish lands while id 3 is being written. The flip must not
    // happen until this drains, and must be synchronous with the empty check.
    if (e.id === 3) pendingLive.push(env(4));
  };

  await drainBufferedLive(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pendingLive as any,
    2,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write as any,
    () => true,
    () => { bufferLenAtFlip = pendingLive.length; },
  );

  assert.deepEqual(written, [3, 4], 'the late publish drained before going live');
  assert.equal(bufferLenAtFlip, 0, 'the live flip is observed with the buffer empty, no leftover stranded');
});

test('drainBufferedLive does not flip to live when it bails on overflow', async () => {
  const pendingLive: Envelope[] = [env(3), env(4)];
  let flipped = false;

  await drainBufferedLive(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pendingLive as any,
    2,
    async () => {},
    () => false,
    () => { flipped = true; },
  );

  assert.equal(flipped, false, 'overflow bail must not flip to live; the caller tears the connection down');
});
