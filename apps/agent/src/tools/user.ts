import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';
import { consumeLinkToken, issueLinkToken } from '../identity-link-tokens.js';

const UserListParams = Type.Object({});

const UserIdentityLinkParams = Type.Object({
  user_id: Type.String({ description: 'Target user ID to link the identity to.' }),
  channel: Type.String({ description: 'Channel type (e.g. "telegram", "cli", "web", "discord").' }),
  channel_user_id: Type.String({ description: 'Platform-specific user ID.' }),
});

type UserIdentityLinkArgs = Static<typeof UserIdentityLinkParams>;

const UserIdentityUnlinkParams = Type.Object({
  channel: Type.String({ description: 'Channel type.' }),
  channel_user_id: Type.String({ description: 'Platform-specific user ID to unlink.' }),
});

type UserIdentityUnlinkArgs = Static<typeof UserIdentityUnlinkParams>;

const UserRoleSetParams = Type.Object({
  user_id: Type.String({ description: 'User ID to update.' }),
  role: Type.Union([
    Type.Literal('owner'),
    Type.Literal('user'),
    Type.Literal('guest'),
  ], { description: 'New role for the user.' }),
});

type UserRoleSetArgs = Static<typeof UserRoleSetParams>;

const UserMergeParams = Type.Object({
  from_user_id: Type.String({ description: 'User ID to merge from (will be marked as merged).' }),
  into_user_id: Type.String({ description: 'User ID to merge into (will receive identities).' }),
});

type UserMergeArgs = Static<typeof UserMergeParams>;

export const createUserListTool = (context: ToolContext): PolicyAwareTool<typeof UserListParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'user_list',
  label: 'List Users',
  description: 'List all users with their identities and roles.',
  parameters: UserListParams,
  execute: async () => {
    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_list is unavailable: no user store is configured.');
    }

    const users = await context.userStore.list();
    const agentRoles = await context.userStore.listByAgent(context.storeScope!);
    const roleMap = new Map(agentRoles.map((r) => [r.userId, r.role]));
    const result = await Promise.all(
      users.map(async (user) => {
        const identities = await context.userStore!.listIdentities(user.userId);
        return {
          ...user,
          role: roleMap.get(user.userId) ?? 'guest',
          identities: identities.map((i) => ({
            channel: i.channel,
            channelUserId: i.channelUserId,
          })),
        };
      }),
    );

    return {
      content: asTextContent(result.length > 0 ? formatJson(result) : 'No users found.\n'),
      details: { count: result.length, users: result },
    };
  },
});

export const createUserIdentityLinkTool = (context: ToolContext): PolicyAwareTool<typeof UserIdentityLinkParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'user_identity_link',
  label: 'Link User Identity',
  description: 'Link a channel identity to a user. If the identity already belongs to another user, it will be re-linked to the target user.',
  parameters: UserIdentityLinkParams,
  execute: async (_toolCallId, args: UserIdentityLinkArgs) => {
    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_identity_link is unavailable: no user store is configured.');
    }

    const userId = args.user_id.trim();
    const channel = args.channel.trim();
    const channelUserId = args.channel_user_id.trim();

    if (!userId || !channel || !channelUserId) {
      throw new ValidationError('user_identity_link requires non-empty user_id, channel, and channel_user_id.');
    }

    // Verify target user exists
    const user = await context.userStore.get(userId);
    if (!user) {
      throw new ValidationError(`User not found: ${userId}`);
    }

    await context.userStore.linkIdentity({
      userId,
      channel,
      channelUserId,
      createdAt: new Date().toISOString(),
    });

    return {
      content: asTextContent(`Linked ${channel}:${channelUserId} to user ${userId}.\n`),
      details: { userId, channel, channelUserId },
    };
  },
});

export const createUserIdentityUnlinkTool = (context: ToolContext): PolicyAwareTool<typeof UserIdentityUnlinkParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'user_identity_unlink',
  label: 'Unlink User Identity',
  description: 'Remove a channel identity link from its user.',
  parameters: UserIdentityUnlinkParams,
  execute: async (_toolCallId, args: UserIdentityUnlinkArgs) => {
    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_identity_unlink is unavailable: no user store is configured.');
    }

    const channel = args.channel.trim();
    const channelUserId = args.channel_user_id.trim();

    if (!channel || !channelUserId) {
      throw new ValidationError('user_identity_unlink requires non-empty channel and channel_user_id.');
    }

    await context.userStore.unlinkIdentity(channel, channelUserId);

    return {
      content: asTextContent(`Unlinked ${channel}:${channelUserId}.\n`),
      details: { channel, channelUserId },
    };
  },
});

export const createUserRoleSetTool = (context: ToolContext): PolicyAwareTool<typeof UserRoleSetParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'user_role_set',
  label: 'Set User Role',
  description: 'Change a user\'s role (owner, user, or guest).',
  parameters: UserRoleSetParams,
  execute: async (_toolCallId, args: UserRoleSetArgs) => {
    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_role_set is unavailable: no user store is configured.');
    }

    const userId = args.user_id.trim();
    if (!userId) {
      throw new ValidationError('user_role_set requires a non-empty user_id.');
    }

    const user = await context.userStore.get(userId);
    if (!user) {
      throw new ValidationError(`User not found: ${userId}`);
    }

    await context.userStore.assignAgent(context.storeScope!, userId, args.role, new Date().toISOString());

    return {
      content: asTextContent(`Set role of user ${userId} to ${args.role}.\n`),
      details: { userId, role: args.role },
    };
  },
});

export const createUserMergeTool = (context: ToolContext): PolicyAwareTool<typeof UserMergeParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'user_merge',
  label: 'Merge Users',
  description: 'Merge one user into another. All identities from the source user are moved to the target. The source user is marked as merged and excluded from listings.',
  parameters: UserMergeParams,
  execute: async (_toolCallId, args: UserMergeArgs) => {
    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_merge is unavailable: no user store is configured.');
    }

    const fromId = args.from_user_id.trim();
    const intoId = args.into_user_id.trim();

    if (!fromId || !intoId) {
      throw new ValidationError('user_merge requires non-empty from_user_id and into_user_id.');
    }
    if (fromId === intoId) {
      throw new ValidationError('Cannot merge a user into themselves.');
    }

    // Verify both users exist
    const fromUser = await context.userStore.get(fromId);
    if (!fromUser) {
      throw new ValidationError(`Source user not found: ${fromId}`);
    }
    const intoUser = await context.userStore.get(intoId);
    if (!intoUser) {
      throw new ValidationError(`Target user not found: ${intoId}`);
    }

    // Inherit name from source if target has none
    if (fromUser.name && !intoUser.name) {
      await context.userStore.upsert({
        ...intoUser,
        name: fromUser.name,
        updatedAt: new Date().toISOString(),
      });
    }

    await context.userStore.merge(fromId, intoId);

    const parts = [`Merged user ${fromId} into ${intoId}. All identities have been transferred.`];
    if (fromUser.name && !intoUser.name) {
      parts.push(`Name "${fromUser.name}" inherited from source user.`);
    }

    return {
      content: asTextContent(parts.join('\n') + '\n'),
      details: { fromUserId: fromId, intoUserId: intoId },
    };
  },
});

// ── Self-service identity link (any role) ─────────────────────────

const IdentityLinkRequestParams = Type.Object({});

const IdentityLinkConfirmParams = Type.Object({
  token: Type.String({ description: 'The token issued by identity_link_request on the other channel.' }),
});

type IdentityLinkConfirmArgs = Static<typeof IdentityLinkConfirmParams>;

export const createIdentityLinkRequestTool = (
  context: ToolContext,
): PolicyAwareTool<typeof IdentityLinkRequestParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'identity_link_request',
  label: 'Request Identity Link',
  description:
    'Generate a short-lived link token so the user can connect their identity across channels (e.g. link Telegram + web as one user). Call this when the user wants to link accounts, merge identities, or be recognised across platforms. Token is single-use and expires in ~10 minutes. The user must then run identity_link_confirm with this token from a different channel.',
  parameters: IdentityLinkRequestParams,
  execute: async () => {
    if (!context.currentUserId) {
      throw new ValidationError('identity_link_request requires a resolved user identity.');
    }
    if (!context.currentChannel || !context.currentChannelUserId) {
      throw new ValidationError('identity_link_request requires a known caller channel.');
    }

    const { token, expiresAt } = issueLinkToken({
      userId: context.currentUserId,
      channel: context.currentChannel,
      channelUserId: context.currentChannelUserId,
    });

    return {
      content: asTextContent(
        `Token: ${token}\nExpires: ${expiresAt}\n\nOn the other channel, ask the agent to run \`identity_link_confirm\` with this token. The token must be used from a different channel than this one (${context.currentChannel}).\n`,
      ),
      details: { token, expiresAt, channel: context.currentChannel },
    };
  },
});

export const createIdentityLinkConfirmTool = (
  context: ToolContext,
): PolicyAwareTool<typeof IdentityLinkConfirmParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'identity_link_confirm',
  label: 'Confirm Identity Link',
  description:
    'Redeem a token issued by identity_link_request on another channel. Links the current channel identity to the same user. Must be invoked from a different channel than the one that issued the token.',
  parameters: IdentityLinkConfirmParams,
  execute: async (_toolCallId, args: IdentityLinkConfirmArgs) => {
    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('identity_link_confirm is unavailable: no user store is configured.');
    }
    if (!context.currentChannel || !context.currentChannelUserId) {
      throw new ValidationError('identity_link_confirm requires a known caller channel.');
    }

    const token = args.token.trim();
    if (!token) {
      throw new ValidationError('identity_link_confirm requires a non-empty token.');
    }

    const link = consumeLinkToken(token);
    if (!link) {
      throw new ValidationError('Token is invalid, already used, or expired. Issue a new one with identity_link_request.');
    }

    if (link.channel === context.currentChannel) {
      throw new ValidationError(
        `Token must be redeemed from a different channel than the one that issued it (issued from ${link.channel}, redeemed from ${context.currentChannel}). The cross-channel constraint is what proves the two identities belong to the same person.`,
      );
    }

    const issuerUser = await context.userStore.get(link.userId);
    if (!issuerUser) {
      throw new ValidationError(`Requesting user ${link.userId} no longer exists.`);
    }

    // Already the same user — nothing to do.
    if (context.currentUserId === link.userId) {
      return {
        content: asTextContent(
          `Channel ${context.currentChannel}:${context.currentChannelUserId} is already linked to user ${link.userId}.\n`,
        ),
        details: { userId: link.userId, alreadyLinked: true },
      };
    }

    // No caller-side user yet — just attach the identity to the issuer.
    if (!context.currentUserId) {
      await context.userStore.linkIdentity({
        userId: link.userId,
        channel: context.currentChannel,
        channelUserId: context.currentChannelUserId,
        createdAt: new Date().toISOString(),
      });
      return {
        content: asTextContent(
          `Linked ${context.currentChannel}:${context.currentChannelUserId} to user ${link.userId}.\n`,
        ),
        details: {
          userId: link.userId,
          linkedChannel: context.currentChannel,
          linkedChannelUserId: context.currentChannelUserId,
          sourceChannel: link.channel,
        },
      };
    }

    // Both sides have a user. Direction is decided by role on this agent:
    // the guest side is always absorbed into the non-guest side. If neither
    // is a guest, refuse — merging two established users is user_merge's
    // job, not a self-service link.
    const scope = context.storeScope;
    const [issuerRole, callerRole] = await Promise.all([
      context.userStore.getAgentRole(scope, link.userId),
      context.userStore.getAgentRole(scope, context.currentUserId),
    ]);
    const issuerIsGuest = (issuerRole ?? 'guest') === 'guest';
    const callerIsGuest = (callerRole ?? 'guest') === 'guest';

    if (!issuerIsGuest && !callerIsGuest) {
      throw new ValidationError(
        `Both ${link.userId} (${issuerRole}) and ${context.currentUserId} (${callerRole}) are established users on this agent. identity_link only auto-merges when one side is a guest. Ask the owner to run user_merge if a real merge is intended.`,
      );
    }

    // Guest side becomes `from`, non-guest side becomes `into`.  When both
    // are guests we keep the legacy direction (caller → issuer) so the
    // user who initiated the link stays the surviving identity.
    const absorbCaller = callerIsGuest;
    const fromUserId = absorbCaller ? context.currentUserId : link.userId;
    const intoUserId = absorbCaller ? link.userId : context.currentUserId;

    await context.userStore.merge(fromUserId, intoUserId);

    return {
      content: asTextContent(
        `Linked ${context.currentChannel}:${context.currentChannelUserId} to user ${intoUserId}. Absorbed guest user ${fromUserId}.\n`,
      ),
      details: {
        userId: intoUserId,
        linkedChannel: context.currentChannel,
        linkedChannelUserId: context.currentChannelUserId,
        sourceChannel: link.channel,
        mergedFromUserId: fromUserId,
      },
    };
  },
});

// ── Toolsets ────────────────────────────────────────────────────────

const USER_DESCRIPTION = `\
### User Management

You can manage users and their cross-channel identities. Only the owner can use these tools.

When the owner mentions managing users, use these tools. For example:
- "give Bob user access" → \`user_role_set\`
- "who are my users?" → \`user_list\`
- "merge these duplicate users" → \`user_merge\` (rare; prefer self-service link below)`;

export const createUserToolset = (context: ToolContext): Toolset => ({
  id: 'user',
  description: USER_DESCRIPTION,
  tools: [
    createUserListTool(context),
    createUserIdentityLinkTool(context),
    createUserIdentityUnlinkTool(context),
    createUserRoleSetTool(context),
    createUserMergeTool(context),
  ],
});

const IDENTITY_DESCRIPTION = `\
### Cross-channel Identity Link

When a user asks to "link accounts", "connect identities", "merge my accounts",
"link my Telegram/CLI/web", "generate a link token", or anything about being
recognised as the same person across channels — use these tools.

Flow:
1. On channel A: call \`identity_link_request\` → returns a short token.
2. On channel B: call \`identity_link_confirm\` with that token.

The two channels must be different — that cross-channel proof is what links
the identities. Tokens are single-use and expire in ~10 minutes.`;

export const createIdentityToolset = (context: ToolContext): Toolset => ({
  id: 'identity',
  description: IDENTITY_DESCRIPTION,
  tools: [
    createIdentityLinkRequestTool(context),
    createIdentityLinkConfirmTool(context),
  ],
});
