import assert from 'node:assert/strict';
import test from 'node:test';

import { isSessionNotFoundError, openSessionWithFreshFallback } from '../src/index.js';

test('isSessionNotFoundError detects a stale-session 404 from the agent API', () => {
  const err = new Error(
    'Agent local API request failed (404): {"error":{"code":"not_found","message":"Session not found: telegram:2026-05-27-c6fb1431"}}',
  );
  assert.equal(isSessionNotFoundError(err), true);
});

test('isSessionNotFoundError ignores unrelated errors', () => {
  assert.equal(isSessionNotFoundError(new Error('Agent local API request failed (500): boom')), false);
  assert.equal(isSessionNotFoundError(new Error('404: Not Found')), false);
  assert.equal(isSessionNotFoundError(new Error('Session not found')), false);
  assert.equal(isSessionNotFoundError('random string'), false);
});

test('openSessionWithFreshFallback returns the original id when open succeeds', async () => {
  const opened: string[] = [];
  const id = await openSessionWithFreshFallback(
    'telegram:orig',
    async (sid) => { opened.push(sid); },
    () => { throw new Error('should not mint a fresh id'); },
  );
  assert.equal(id, 'telegram:orig');
  assert.deepEqual(opened, ['telegram:orig']);
});

test('openSessionWithFreshFallback mints a fresh session on a stale-session 404', async () => {
  const opened: string[] = [];
  const id = await openSessionWithFreshFallback(
    'telegram:stale',
    async (sid) => {
      opened.push(sid);
      if (sid === 'telegram:stale') {
        throw new Error('Agent local API request failed (404): Session not found: telegram:stale');
      }
    },
    () => 'telegram:fresh',
  );
  assert.equal(id, 'telegram:fresh');
  assert.deepEqual(opened, ['telegram:stale', 'telegram:fresh']);
});

test('openSessionWithFreshFallback rethrows non-404 errors without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    openSessionWithFreshFallback(
      'telegram:x',
      async () => { calls += 1; throw new Error('Agent local API request failed (500): boom'); },
      () => 'telegram:fresh',
    ),
    /500/,
  );
  assert.equal(calls, 1);
});
