import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveWithinMs } from '../src/agent-runner.js';

test('resolves with the promise value when it settles in time', async () => {
  const result = await resolveWithinMs(Promise.resolve('real'), 1000, () => 'fallback');
  assert.equal(result, 'real');
});

test('resolves with the fallback when the promise hangs past the bound', async () => {
  // A transform that never returns must not strand the caller: past the bound
  // the fallback value is used and the caller proceeds.
  const start = Date.now();
  const result = await resolveWithinMs(new Promise<string>(() => {}), 20, () => 'fallback');
  assert.equal(result, 'fallback');
  assert.ok(Date.now() - start < 1000, 'must resolve on the timeout, not hang');
});

test('propagates a rejection (a throwing dependency is not swallowed)', async () => {
  await assert.rejects(
    resolveWithinMs(Promise.reject(new Error('boom')), 1000, () => 'fallback'),
    /boom/,
  );
});
