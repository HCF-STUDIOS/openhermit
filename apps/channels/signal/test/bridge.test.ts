import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conversationKey,
  generateSessionId,
  shouldAcceptSender,
} from '../src/bridge.js';

test('conversationKey uses signal: prefix for DMs keyed by uuid when available', () => {
  assert.equal(
    conversationKey({ sourceUuid: 'uuid-alice', sourceNumber: '+15559999999' }),
    'signal:uuid:uuid-alice',
  );
});

test('conversationKey falls back to E.164 when uuid is missing', () => {
  assert.equal(
    conversationKey({ sourceNumber: '+15559999999' }),
    'signal:+15559999999',
  );
});

test('conversationKey uses group prefix for group messages', () => {
  assert.equal(
    conversationKey({ sourceUuid: 'uuid-alice', groupId: 'gid==' }),
    'signal:group:gid==',
  );
});

test('generateSessionId produces a date-stamped signal: prefix', () => {
  const id = generateSessionId();
  assert.match(id, /^signal:\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
});

test('shouldAcceptSender accepts everyone when no allow-list is configured', () => {
  assert.equal(shouldAcceptSender({ sourceUuid: 'x' }, undefined, undefined), true);
});

test('shouldAcceptSender accepts when sender uuid matches allowedSenders', () => {
  assert.equal(
    shouldAcceptSender({ sourceUuid: 'uuid-alice' }, ['uuid:uuid-alice'], undefined),
    true,
  );
});

test('shouldAcceptSender accepts when sender E.164 matches allowedSenders', () => {
  assert.equal(
    shouldAcceptSender({ sourceNumber: '+15559999999' }, ['+15559999999'], undefined),
    true,
  );
});

test('shouldAcceptSender rejects DMs not in allowedSenders', () => {
  assert.equal(
    shouldAcceptSender({ sourceUuid: 'uuid-stranger' }, ['uuid:uuid-friend'], undefined),
    false,
  );
});

test('shouldAcceptSender consults allowedGroupIds only for group messages', () => {
  assert.equal(
    shouldAcceptSender({ groupId: 'gid==', sourceUuid: 'x' }, undefined, ['gid==']),
    true,
  );
  assert.equal(
    shouldAcceptSender({ groupId: 'other==', sourceUuid: 'x' }, undefined, ['gid==']),
    false,
  );
});

test('shouldAcceptSender drops group messages by default when no allow-list is configured', () => {
  // Default-deny groups so a bot dropped into a random chat doesn't
  // immediately start replying. Operator opts in via allowed_group_ids.
  assert.equal(shouldAcceptSender({ groupId: 'gid==' }, undefined, undefined), false);
  assert.equal(shouldAcceptSender({ groupId: 'gid==' }, undefined, []), false);
});
