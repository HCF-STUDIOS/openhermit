import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEndClosesTurn, turnContentInScope } from '../src/turn-scope.js';

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

// turnContentInScope: content frames must be scoped to the reader's own turn so
// a bridge without per-chat serialization never accumulates a concurrent turn's
// text and posts the wrong reply.

test('content: this turn own frame is in scope', () => {
  assert.equal(turnContentInScope({ correlationId: 'B', text: 'mine' }, 'B'), true);
});

test('content: a concurrent turn frame is out of scope', () => {
  assert.equal(turnContentInScope({ correlationId: 'A', text: 'theirs' }, 'B'), false);
});

test('content: a frame with no correlationId is accepted (legacy runner)', () => {
  assert.equal(turnContentInScope({ text: 'no-corr' }, 'B'), true);
});

test('content: a reader with no own id accepts everything (backward-compat)', () => {
  assert.equal(turnContentInScope({ correlationId: 'A' }, undefined), true);
});
