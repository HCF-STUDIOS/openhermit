import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UserIdentity } from '@openhermit/store';

import {
  OWNER_CLAIM_ELIGIBLE_CHANNELS,
  planChannelClaim,
  type ChannelClaimRosterEntry,
} from '../src/channel-claim.js';

const roster = (...entries: ChannelClaimRosterEntry[]): ChannelClaimRosterEntry[] => entries;

test('allowlist contains wechat and nothing unexpected opens the door', () => {
  assert.ok(OWNER_CLAIM_ELIGIBLE_CHANNELS.has('wechat'));
  assert.ok(!OWNER_CLAIM_ELIGIBLE_CHANNELS.has('telegram'));
  assert.ok(!OWNER_CLAIM_ELIGIBLE_CHANNELS.has('web'));
});

test('ownerless agent: first unknown DM sender becomes owner (create new user)', () => {
  const plan = planChannelClaim({
    callerUserId: undefined,
    agentRoles: roster(),
    channelIdentityBound: false,
  });
  assert.deepEqual(plan, { action: 'assign-owner', userId: null });
});

test('ownerless agent: a known off-roster user becomes owner', () => {
  const plan = planChannelClaim({
    callerUserId: 'u_known',
    agentRoles: roster(),
    channelIdentityBound: false,
  });
  assert.deepEqual(plan, { action: 'assign-owner', userId: 'u_known' });
});

test('owner exists but has no identity on this channel: link the first DM sender to the owner', () => {
  const plan = planChannelClaim({
    callerUserId: undefined,
    agentRoles: roster({ userId: 'u_owner', role: 'owner' }),
    channelIdentityBound: false,
  });
  assert.deepEqual(plan, { action: 'link-to-owner', ownerUserId: 'u_owner' });
});

test('idempotent: the caller is already the owner → no-op success', () => {
  const plan = planChannelClaim({
    callerUserId: 'u_owner',
    agentRoles: roster({ userId: 'u_owner', role: 'owner' }),
    channelIdentityBound: true, // owner already has a wechat identity
  });
  assert.deepEqual(plan, { action: 'already-owner', ownerUserId: 'u_owner' });
});

test('ANTI-HIJACK: once a channel identity is bound to the agent, a different DMer cannot rebind', () => {
  // A wechat identity is already bound (owner claimed earlier). A second,
  // unknown wechat peer messages — must be refused, not promoted.
  const plan = planChannelClaim({
    callerUserId: undefined,
    agentRoles: roster({ userId: 'u_owner', role: 'owner' }),
    channelIdentityBound: true,
  });
  assert.deepEqual(plan, { action: 'reject', reason: 'channel_already_claimed' });
});

test('ANTI-HIJACK: second DMer cannot seize an ownerless-then-guest-bound channel', () => {
  // Someone already came in as a guest on this channel; a new peer must not
  // leapfrog them into ownership.
  const plan = planChannelClaim({
    callerUserId: undefined,
    agentRoles: roster({ userId: 'u_guest', role: 'guest' }),
    channelIdentityBound: true,
  });
  assert.deepEqual(plan, { action: 'reject', reason: 'channel_already_claimed' });
});

test('sender is a known DIFFERENT established user: refuse (no silent cross-user merge)', () => {
  const plan = planChannelClaim({
    callerUserId: 'u_someone_else',
    agentRoles: roster({ userId: 'u_owner', role: 'owner' }),
    channelIdentityBound: false,
  });
  assert.deepEqual(plan, { action: 'reject', reason: 'sender_bound_elsewhere' });
});

// Type-only sanity: UserIdentity is the shape the route filters on by channel.
test('UserIdentity shape carries a channel discriminator', () => {
  const id: UserIdentity = {
    userId: 'u1',
    channel: 'wechat',
    channelUserId: 'wx1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(id.channel, 'wechat');
});
