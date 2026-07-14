import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEndClosesTurn } from '../src/turn-scope.js';

test('closes on the end whose answeredMessageIds includes the own id', () => {
  assert.equal(agentEndClosesTurn({ answeredMessageIds: ['C', 'B'] }, 'B'), true);
});

test('does not close on a concurrent end that answered a different message', () => {
  assert.equal(agentEndClosesTurn({ messageId: 'A', answeredMessageIds: ['A'] }, 'B'), false);
});

test('falls back to messageId when answeredMessageIds is absent', () => {
  assert.equal(agentEndClosesTurn({ messageId: 'B' }, 'B'), true);
  assert.equal(agentEndClosesTurn({ messageId: 'A' }, 'B'), false);
});

test('closes on any end when the runner emits no ids (legacy)', () => {
  assert.equal(agentEndClosesTurn({}, 'B'), true);
});

test('closes on any end when the reader has no own id (backward-compat)', () => {
  assert.equal(agentEndClosesTurn({ messageId: 'A' }, undefined), true);
});
