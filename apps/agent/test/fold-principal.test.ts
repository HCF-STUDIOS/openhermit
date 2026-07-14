import assert from 'node:assert/strict';
import { test } from 'node:test';

import { principalMayFold } from '../src/agent-runner.js';

test('same userId and role folds', () => {
  assert.equal(principalMayFold('u1', 'owner', 'u1', 'owner'), true);
});

test('same userId but downgraded role does NOT fold', () => {
  // Owner started the turn; the same user was demoted to guest, then posts
  // again. Folding would run the guest message at the turn owner tools.
  assert.equal(principalMayFold('u1', 'guest', 'u1', 'owner'), false);
});

test('different userId does NOT fold', () => {
  assert.equal(principalMayFold('u2', 'owner', 'u1', 'owner'), false);
});

test('same guest principal folds', () => {
  assert.equal(principalMayFold('u1', 'guest', 'u1', 'guest'), true);
});
