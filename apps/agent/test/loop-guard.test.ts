import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LOOP_GUARD_ABORT_THRESHOLD,
  LOOP_GUARD_REMINDER_THRESHOLDS,
  LOOP_GUARD_WINDOW,
  appendReminder,
  canonicalizeToolCall,
  recordToolCall,
} from '../src/agent-runner/loop-guard.js';

describe('canonicalizeToolCall', () => {
  test('is independent of object key order', () => {
    const a = canonicalizeToolCall('read_file', { path: '/a', limit: 10 });
    const b = canonicalizeToolCall('read_file', { limit: 10, path: '/a' });
    assert.equal(a, b);
  });

  test('is independent of nested key order', () => {
    const a = canonicalizeToolCall('q', { filter: { b: 2, a: 1 }, sort: 'x' });
    const b = canonicalizeToolCall('q', { sort: 'x', filter: { a: 1, b: 2 } });
    assert.equal(a, b);
  });

  test('distinguishes different tool names', () => {
    assert.notEqual(
      canonicalizeToolCall('read_file', { path: '/a' }),
      canonicalizeToolCall('write_file', { path: '/a' }),
    );
  });

  test('distinguishes different argument values', () => {
    assert.notEqual(
      canonicalizeToolCall('read_file', { path: '/a' }),
      canonicalizeToolCall('read_file', { path: '/b' }),
    );
  });

  test('preserves array element order (order is semantic for arrays)', () => {
    assert.notEqual(
      canonicalizeToolCall('t', { ids: [1, 2] }),
      canonicalizeToolCall('t', { ids: [2, 1] }),
    );
  });

  test('handles undefined / no args without throwing', () => {
    assert.equal(canonicalizeToolCall('t', undefined), canonicalizeToolCall('t', undefined));
    assert.notEqual(canonicalizeToolCall('t', undefined), canonicalizeToolCall('t', {}));
  });
});

describe('recordToolCall', () => {
  test('counts repeats of identical calls', () => {
    const window: string[] = [];
    const args = { path: '/a' };
    assert.equal(recordToolCall(window, 'read_file', args).count, 1);
    assert.equal(recordToolCall(window, 'read_file', args).count, 2);
    assert.equal(recordToolCall(window, 'read_file', args).count, 3);
  });

  test('does not conflate distinct calls', () => {
    const window: string[] = [];
    recordToolCall(window, 'read_file', { path: '/a' });
    recordToolCall(window, 'read_file', { path: '/b' });
    const third = recordToolCall(window, 'read_file', { path: '/a' });
    assert.equal(third.count, 2);
  });

  test('emits a reminder exactly at each reminder threshold', () => {
    const window: string[] = [];
    const args = { path: '/a' };
    const reminders: (string | undefined)[] = [];
    for (let i = 0; i < LOOP_GUARD_ABORT_THRESHOLD; i += 1) {
      reminders.push(recordToolCall(window, 'read_file', args).reminder);
    }
    for (let count = 1; count <= reminders.length; count += 1) {
      const reminder = reminders[count - 1];
      if ((LOOP_GUARD_REMINDER_THRESHOLDS as readonly number[]).includes(count)) {
        assert.ok(reminder, `expected reminder at count ${count}`);
        assert.match(reminder!, /read_file/);
      } else {
        assert.equal(reminder, undefined, `unexpected reminder at count ${count}`);
      }
    }
  });

  test('escalates reminder severity across thresholds', () => {
    const window: string[] = [];
    const args = { path: '/a' };
    const seen: string[] = [];
    for (let i = 0; i < LOOP_GUARD_ABORT_THRESHOLD; i += 1) {
      const { reminder } = recordToolCall(window, 'read_file', args);
      if (reminder) seen.push(reminder);
    }
    assert.equal(seen.length, LOOP_GUARD_REMINDER_THRESHOLDS.length);
    assert.match(seen[seen.length - 1], /loop/i);
  });

  test('aborts at the abort threshold', () => {
    const window: string[] = [];
    const args = { path: '/a' };
    let aborted = false;
    for (let i = 0; i < LOOP_GUARD_ABORT_THRESHOLD; i += 1) {
      aborted = recordToolCall(window, 'read_file', args).abort;
    }
    assert.equal(aborted, true);
  });

  test('does not abort before the abort threshold', () => {
    const window: string[] = [];
    const args = { path: '/a' };
    for (let i = 0; i < LOOP_GUARD_ABORT_THRESHOLD - 1; i += 1) {
      assert.equal(recordToolCall(window, 'read_file', args).abort, false);
    }
  });

  test('catches an A,B,A,B oscillation within the window', () => {
    const window: string[] = [];
    let last = recordToolCall(window, 'a', {});
    for (let i = 0; i < 4; i += 1) {
      recordToolCall(window, 'b', {});
      last = recordToolCall(window, 'a', {});
    }
    // "a" has now been called 5 times interleaved with "b".
    assert.ok(last.count >= LOOP_GUARD_REMINDER_THRESHOLDS[1]);
  });

  test('trims the window to its cap', () => {
    const window: string[] = [];
    for (let i = 0; i < LOOP_GUARD_WINDOW + 10; i += 1) {
      recordToolCall(window, `tool_${i}`, {});
    }
    assert.equal(window.length, LOOP_GUARD_WINDOW);
  });

  test('distinct calls beyond the window do not accumulate a false loop', () => {
    const window: string[] = [];
    let decision = recordToolCall(window, 'unique_0', {});
    for (let i = 1; i < LOOP_GUARD_WINDOW * 2; i += 1) {
      decision = recordToolCall(window, `unique_${i}`, {});
    }
    assert.equal(decision.count, 1);
    assert.equal(decision.abort, false);
  });
});

describe('appendReminder', () => {
  test('appends a trailing text block, preserving existing content', () => {
    const content = [{ type: 'text' as const, text: 'original' }];
    const out = appendReminder(content, 'advisory');
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { type: 'text', text: 'original' });
    assert.deepEqual(out[1], { type: 'text', text: 'advisory' });
    // Does not mutate the input array.
    assert.equal(content.length, 1);
  });
});
