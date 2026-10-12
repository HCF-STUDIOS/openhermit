import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UserIdentity } from '@openhermit/store';

import {
  OWNER_CLAIM_ELIGIBLE_CHANNELS,
  isChannelClaimed,
  planChannelClaim,
  type ChannelClaimRosterEntry,
} from '../src/channel-claim.js';

const roster = (...entries: ChannelClaimRosterEntry[]): ChannelClaimRosterEntry[] => entries;

const ids = (entries: Record<string, string[]>): Map<string, { channel: string }[]> =>
  new Map(
    Object.entries(entries).map(([userId, channels]) => [
      userId,
      channels.map((channel) => ({ channel })),
    ]),
  );

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

test('isChannelClaimed: true when the owner already has an identity on the channel', () => {
  assert.equal(
    isChannelClaimed({
      channel: 'wechat',
      agentRoles: roster({ userId: 'u_owner', role: 'owner' }),
      identitiesByUser: ids({ u_owner: ['web', 'wechat'] }),
    }),
    true,
  );
});

test('isChannelClaimed: false when the owner has no identity on the channel', () => {
  assert.equal(
    isChannelClaimed({
      channel: 'wechat',
      agentRoles: roster({ userId: 'u_owner', role: 'owner' }),
      identitiesByUser: ids({ u_owner: ['web', 'telegram'] }),
    }),
    false,
  );
});

test('isChannelClaimed: a GUEST with a channel identity does NOT claim the channel (hub-agent bug fix)', () => {
  // The crux: cross-agent guests carry wechat identities from their OWN agents.
  // Only the owner's identity may mark the channel claimed.
  assert.equal(
    isChannelClaimed({
      channel: 'wechat',
      agentRoles: roster(
        { userId: 'u_owner', role: 'owner' },
        { userId: 'u_guest', role: 'guest' },
      ),
      identitiesByUser: ids({ u_owner: ['web'], u_guest: ['wechat'] }),
    }),
    false,
  );
});

test('isChannelClaimed: false on an ownerless agent even if guests carry the channel', () => {
  assert.equal(
    isChannelClaimed({
      channel: 'wechat',
      agentRoles: roster({ userId: 'u_guest', role: 'guest' }),
      identitiesByUser: ids({ u_guest: ['wechat'] }),
    }),
    false,
  );
});

test('isChannelClaimed: with multiple owners, any owner holding the channel marks it claimed', () => {
  assert.equal(
    isChannelClaimed({
      channel: 'wechat',
      agentRoles: roster(
        { userId: 'u_owner1', role: 'owner' },
        { userId: 'u_owner2', role: 'owner' },
      ),
      identitiesByUser: ids({ u_owner1: ['telegram'], u_owner2: ['wechat'] }),
    }),
    true,
  );
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
