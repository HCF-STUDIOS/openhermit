/**
 * First-contact owner claim for single-user channels.
 *
 * A "single-user channel" is one whose transport is an inherently private 1:1
 * line to a single human the owner controls (e.g. a WeChat personal account
 * that only ever talks to its owner). For those — and only those — the channel
 * bridge may bind the first direct-message sender as the agent owner, removing
 * the manual cross-channel identity-link step.
 *
 * This module owns the two trust-critical pieces: the central eligibility
 * allowlist, and the pure decision function that the gateway route executes.
 * Keeping the branching logic pure makes the anti-hijack invariants unit
 * testable without a database.
 */

/**
 * Channels eligible for first-contact owner auto-claim. Central + hardcoded ON
 * PURPOSE: a channel manifest must NOT be able to self-declare eligibility, or
 * an untrusted channel package could seize ownership of an agent. Adding a
 * namespace here is a deliberate security decision that must pass review.
 */
export const OWNER_CLAIM_ELIGIBLE_CHANNELS: ReadonlySet<string> = new Set(['wechat']);

/** Minimal roster entry: a user's role on the agent. */
export interface ChannelClaimRosterEntry {
  userId: string;
  role: string;
}

/** Minimal identity shape the claim logic discriminates on. */
export interface ChannelClaimIdentity {
  channel: string;
}

/**
 * Whether this channel has already been owner-claimed on the agent.
 *
 * The claim flow only ever binds an OWNER's identity on the channel, so "already
 * claimed" means an OWNER already carries an identity on this channel — NOT that
 * some guest/user does. This scoping is load-bearing: a hub agent accumulates
 * cross-agent guests, and those guests carry channel identities that belong to
 * THEIR OWN agents (e.g. an amiko web guest who separately uses WeChat on their
 * own twin). Counting a guest's unrelated identity would make the channel
 * permanently unclaimable — the real owner could never first-contact-claim. So
 * the once-per-channel anti-hijack guard looks ONLY at the agent's owner(s).
 *
 * @param channel          the channel namespace being claimed (e.g. 'wechat')
 * @param agentRoles       the agent's current (userId, role) roster
 * @param identitiesByUser identities keyed by userId (only owner ids need be
 *                         populated; non-owner entries are ignored)
 */
export function isChannelClaimed(input: {
  channel: string;
  agentRoles: ChannelClaimRosterEntry[];
  identitiesByUser: ReadonlyMap<string, readonly ChannelClaimIdentity[]>;
}): boolean {
  const { channel, agentRoles, identitiesByUser } = input;
  return agentRoles
    .filter((u) => u.role === 'owner')
    .some((u) =>
      (identitiesByUser.get(u.userId) ?? []).some((identity) => identity.channel === channel),
    );
}

/**
 * What the route should do, given the agent's current roster and identity
 * bindings. Preconditions (channel-mode token, allowlist membership, a concrete
 * DM sender id) are checked by the caller BEFORE planning.
 */
export type ChannelClaimPlan =
  /** The caller is already the owner — nothing to do (idempotent success). */
  | { action: 'already-owner'; ownerUserId: string }
  /** Refuse: the channel is already claimed, or the sender is a different established user. */
  | { action: 'reject'; reason: 'channel_already_claimed' | 'sender_bound_elsewhere' }
  /** Attach the caller's channel identity to the agent's existing owner. */
  | { action: 'link-to-owner'; ownerUserId: string }
  /** Make the caller the owner. `userId: null` means create a fresh user + identity first. */
  | { action: 'assign-owner'; userId: string | null };

/**
 * Decide the owner-claim action. Pure — no I/O. The anti-hijack invariant lives
 * here: once an identity on this channel is bound to the agent OWNER, the
 * channel is considered claimed and a later/other DM sender can never rebind it.
 *
 * @param callerUserId     the user the DM sender already resolves to, if any
 * @param agentRoles       the agent's current (userId, role) roster
 * @param channelIdentityBound whether the agent's owner already has an identity
 *                         on the channel (see {@link isChannelClaimed}, precomputed)
 */
export function planChannelClaim(input: {
  callerUserId: string | undefined;
  agentRoles: ChannelClaimRosterEntry[];
  channelIdentityBound: boolean;
}): ChannelClaimPlan {
  const { callerUserId, agentRoles, channelIdentityBound } = input;
  const existingOwner = agentRoles.find((u) => u.role === 'owner');

  // Idempotent: the caller is already the owner.
  if (existingOwner && callerUserId && callerUserId === existingOwner.userId) {
    return { action: 'already-owner', ownerUserId: existingOwner.userId };
  }

  // Once-per-channel: the owner already has an identity on this channel.
  if (channelIdentityBound) {
    return { action: 'reject', reason: 'channel_already_claimed' };
  }

  // From here, the owner has no identity on this channel yet.
  if (existingOwner) {
    // Owner exists (e.g. created in-app) but has no identity on this channel.
    if (callerUserId && callerUserId !== existingOwner.userId) {
      // The sender is a known, DIFFERENT established user — auto-merging
      // identities across users needs the explicit link/merge flow.
      return { action: 'reject', reason: 'sender_bound_elsewhere' };
    }
    return { action: 'link-to-owner', ownerUserId: existingOwner.userId };
  }

  // No owner at all → this first DM sender becomes the owner.
  return { action: 'assign-owner', userId: callerUserId ?? null };
}
