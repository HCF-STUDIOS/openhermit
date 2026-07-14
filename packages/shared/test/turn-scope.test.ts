import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEndClosesTurn, turnContentInScope, isOutOfBandErrorFrame } from '../src/turn-scope.js';

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

// Content frames must be scoped to the reader's own turn, or a bridge accumulates a concurrent turn's text and replies wrong.

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

// Classify media-vs-turn by `reason`, never by correlationId: a turn error carries a correlationId
// and no reason, so it must not read as out-of-band.

test('out-of-band error: a media_error frame is out-of-band', () => {
  assert.equal(isOutOfBandErrorFrame({ message: 'x', correlationId: 'att_1', reason: 'media_error' }), true);
});

test('out-of-band error: a reconcile_cancel frame is out-of-band', () => {
  assert.equal(isOutOfBandErrorFrame({ correlationId: 'att_1', reason: 'reconcile_cancel' }), true);
});

test('out-of-band error: a turn error (correlationId, no reason) is NOT out-of-band', () => {
  assert.equal(isOutOfBandErrorFrame({ message: 'twin out of credits', correlationId: 'B' }), false);
});

test('out-of-band error: a turn error with no correlationId is NOT out-of-band', () => {
  assert.equal(isOutOfBandErrorFrame({ message: 'boom' }), false);
});
