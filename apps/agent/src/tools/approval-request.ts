import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';

// ── Parameters ──────────────────────────────────────────────────────

const ApprovalListParams = Type.Object({
  status: Type.Optional(
    Type.Union(
      [Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('expired')],
      { description: 'Filter by status. Omit to list all.' },
    ),
  ),
});

const ApprovalReviewParams = Type.Object({
  id: Type.String({ description: 'Approval request ID.' }),
  decision: Type.Union(
    [Type.Literal('approved'), Type.Literal('rejected')],
    { description: '"approved" or "rejected".' },
  ),
  resolution: Type.Optional(
    Type.Union(
      [Type.Literal('once'), Type.Literal('persistent')],
      { description: '"once" (default) = one-time approval. "persistent" = auto-create an allow policy for future requests.' },
    ),
  ),
  reason: Type.Optional(
    Type.String({ description: 'Optional reason for the decision.' }),
  ),
});

type ApprovalListArgs = Static<typeof ApprovalListParams>;
type ApprovalReviewArgs = Static<typeof ApprovalReviewParams>;

// ── Tools ───────────────────────────────────────────────────────────

export const createApprovalListTool = (context: ToolContext): PolicyAwareTool<typeof ApprovalListParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'approval_list',
  label: 'List Approval Requests',
  description: 'List approval requests for this agent. Defaults to showing all requests; filter by status (pending/approved/rejected/expired).',
  parameters: ApprovalListParams,
  execute: async (_id, args: ApprovalListArgs) => {
    if (!context.approvalRequestStore || !context.storeScope) {
      throw new ValidationError('approval_list is unavailable: no approval store is configured.');
    }
    const requests = await context.approvalRequestStore.list(
      context.storeScope.agentId,
      args.status as any,
    );
    return {
      content: asTextContent(
        requests.length > 0
          ? formatJson(requests)
          : `No approval requests${args.status ? ` with status "${args.status}"` : ''}.\n`,
      ),
      details: { count: requests.length },
    };
  },
});

export const createApprovalReviewTool = (context: ToolContext): PolicyAwareTool<typeof ApprovalReviewParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'approval_review',
  label: 'Review Approval Request',
  description:
    'Approve or reject an approval request. '
    + 'Use resolution="once" (default) for a one-time approval, or '
    + '"persistent" to auto-create an allow policy so future identical requests are allowed automatically.',
  parameters: ApprovalReviewParams,
  execute: async (_id, args: ApprovalReviewArgs) => {
    if (!context.approvalRequestStore || !context.storeScope) {
      throw new ValidationError('approval_review is unavailable: no approval store is configured.');
    }

    const request = await context.approvalRequestStore.get(args.id);
    if (!request) {
      throw new ValidationError(`Approval request not found: ${args.id}`);
    }
    if (request.agentId !== context.storeScope.agentId) {
      throw new ValidationError('Approval request belongs to a different agent.');
    }
    if (request.status !== 'pending') {
      throw new ValidationError(`Request is already ${request.status}. Only pending requests can be reviewed.`);
    }

    const reviewerId = context.currentUserId ?? 'owner';
    const resolution = args.resolution ?? (args.decision === 'approved' ? 'once' : undefined);

    const updated = await context.approvalRequestStore.resolve(
      args.id,
      args.decision,
      reviewerId,
      resolution,
      args.reason,
    );

    // If persistent approval, auto-create an allow policy row
    if (args.decision === 'approved' && resolution === 'persistent' && context.policyStore) {
      await context.policyStore.upsert({
        agentId: request.agentId,
        resourceType: request.resourceType,
        resourceKey: request.resourceKey,
        effect: 'allow',
        grants: [{ type: 'user', value: request.requesterId }],
        scope: request.scope,
      });
    }

    // Also fan-out to the inbox session so the owner-side UI marks
    // the card as resolved. Requester-side fan-out below is separate
    // and unchanged.
    if (context.publishEvent) {
      context.publishEvent({
        type: 'approval_resolved',
        sessionId: 'inbox',
        requestId: request.id,
        resourceType: request.resourceType,
        resourceKey: request.resourceKey,
        decision: args.decision,
        ...(resolution ? { resolution } : {}),
        reviewerId,
        mode: 'async',
      });
    }
    if (context.messageStore && context.storeScope) {
      try {
        const verb = args.decision === 'approved' ? '✅ Approved' : '✗ Rejected';
        await context.messageStore.appendLogEntry(context.storeScope, 'inbox', {
          ts: new Date().toISOString(),
          role: 'assistant',
          content: `${verb} by owner: ${request.resourceType}/${request.resourceKey}.`,
          metadata: {
            resolvedRequestId: request.id,
            resourceType: request.resourceType,
            resourceKey: request.resourceKey,
            decision: args.decision,
            ...(resolution ? { resolution } : {}),
            reviewerId,
          },
        });
      } catch (err) {
        console.error('[approval] failed to persist approval_resolved (inbox)', err);
      }
    }

    // Notify the requester's session that their request was resolved.
    const requesterSessionId = request.sessionId;
    if (requesterSessionId && requesterSessionId !== 'unknown') {
      if (context.publishEvent) {
        context.publishEvent({
          type: 'approval_resolved',
          sessionId: requesterSessionId,
          requestId: request.id,
          resourceType: request.resourceType,
          resourceKey: request.resourceKey,
          decision: args.decision,
          ...(resolution ? { resolution } : {}),
          reviewerId,
          mode: 'async',
        });
      }
      if (context.messageStore && context.storeScope) {
        try {
          await context.messageStore.appendLogEntry(context.storeScope, requesterSessionId, {
            ts: new Date().toISOString(),
            role: 'system',
            type: 'approval_resolved',
            requestId: request.id,
            resourceType: request.resourceType,
            resourceKey: request.resourceKey,
            decision: args.decision,
            ...(resolution ? { resolution } : {}),
            reviewerId,
            mode: 'async',
          });
        } catch (err) {
          console.error('[approval] failed to persist approval_resolved (requester)', err);
        }
      }
    }

    const label = args.decision === 'approved'
      ? `Approved${resolution === 'persistent' ? ' (persistent — allow policy created)' : ' (one-time)'}`
      : 'Rejected';

    return {
      content: asTextContent(
        `${label}: ${request.resourceType}/${request.resourceKey} for user ${request.requesterId}\n`
        + (args.reason ? `Reason: ${args.reason}\n` : ''),
      ),
      details: updated,
    };
  },
});

// ── Toolset ─────────────────────────────────────────────────────────

const APPROVAL_DESCRIPTION = `\
### Approval Request Management

Owner-only tools for reviewing resource access approval requests.

- \`approval_list\`: show approval requests (filter by status)
- \`approval_review\`: approve or reject a pending request

When a user attempts to use a resource with \`require_approval\` policy,
an approval request is created. The owner can then review and approve/reject it.
Use resolution="persistent" to create a permanent allow policy.`;

export const createApprovalToolset = (context: ToolContext): Toolset => ({
  id: 'approval',
  description: APPROVAL_DESCRIPTION,
  tools: [
    createApprovalListTool(context),
    createApprovalReviewTool(context),
  ],
});
