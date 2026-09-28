import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChannelOutbound } from '@openhermit/protocol';
import type { ToolContext } from '../src/tools/shared.js';
import { createSessionSendTool } from '../src/tools/session.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';

type Session = {
  sessionId: string;
  source: { kind?: string; platform?: string };
  type?: 'direct' | 'group';
  userIds?: string[];
  metadata?: Record<string, unknown>;
};

const GROUP: Session = {
  sessionId: 's-group',
  source: { kind: 'channel', platform: 'wechat' },
  type: 'group',
  userIds: [OWNER],
  metadata: { wechat_peer_id: 'g1' },
};
const OWNER_DM: Session = {
  sessionId: 's-owner-dm',
  source: { kind: 'channel', platform: 'wechat' },
  type: 'direct',
  userIds: [OWNER],
  metadata: { wechat_peer_id: 'owner' },
};
const STRANGER_DM: Session = {
  sessionId: 's-stranger-dm',
  source: { kind: 'channel', platform: 'wechat' },
  type: 'direct',
  userIds: [STRANGER],
  metadata: { wechat_peer_id: 'stranger' },
};

const adapter = (sent: any[]): ChannelOutbound => ({
  channel: 'wechat',
  send: async (msg: any) => {
    sent.push(msg);
    return { success: true };
  },
  resolveRecipient(session: any): string | undefined {
    const v = session.metadata?.wechat_peer_id;
    return typeof v === 'string' && v ? v : undefined;
  },
});

type Ctx = {
  ctx: ToolContext;
  sent: any[];
  created: any[];
  callbackDecision: 'approved' | 'rejected';
};

const makeCtx = (
  session: Session,
  opts: {
    outboundConfirm?: { groups: boolean; nonOwnerDms: boolean };
    sourceKind?: string;
    callbackDecision?: 'approved' | 'rejected';
    approvalCallback?: boolean;
    preApproved?: boolean;
  } = {},
): Ctx => {
  const sent: any[] = [];
  const created: any[] = [];
  const callbackDecision = opts.callbackDecision ?? 'approved';
  const ctx = {
    storeScope: { agentId: 'a1' },
    currentUserId: 'caller-1',
    sessionStore: { get: async (_s: unknown, id: string) => (id === session.sessionId ? session : undefined) },
    messageStore: { appendLogEntry: async () => {} },
    channelOutbound: new Map([['wechat', adapter(sent)]]),
    userStore: {
      listByAgent: async () => [
        { userId: OWNER, role: 'owner' },
        { userId: STRANGER, role: 'user' },
      ],
    },
    approvalRequestStore: {
      findApproved: async () => (opts.preApproved ? { id: 'pre' } : null),
      create: async (req: any) => {
        created.push(req);
        return { id: `req-${created.length}` };
      },
      resolve: async () => {},
    },
    ...(opts.approvalCallback
      ? { approvalCallback: async () => callbackDecision }
      : {}),
    ...(opts.outboundConfirm ? { outboundConfirm: opts.outboundConfirm } : {}),
    ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
  } as unknown as ToolContext;
  return { ctx, sent, created, callbackDecision };
};

const run = async (c: Ctx, sessionId: string, text = 'hello') => {
  const tool = createSessionSendTool(c.ctx);
  return tool.execute('tc', { session_id: sessionId, text } as any);
};

test('no gate configured → group send goes straight out', async () => {
  const c = makeCtx(GROUP);
  await run(c, GROUP.sessionId);
  assert.equal(c.sent.length, 1);
  assert.equal(c.created.length, 0);
});

test('scheduled jobs are exempt from the gate', async () => {
  const c = makeCtx(GROUP, {
    outboundConfirm: { groups: true, nonOwnerDms: true },
    sourceKind: 'schedule',
    approvalCallback: true,
  });
  await run(c, GROUP.sessionId);
  assert.equal(c.sent.length, 1);
  assert.equal(c.created.length, 0);
});

test('group broadcast is held, then sent on realtime approval', async () => {
  const c = makeCtx(GROUP, {
    outboundConfirm: { groups: true, nonOwnerDms: true },
    approvalCallback: true,
    callbackDecision: 'approved',
  });
  await run(c, GROUP.sessionId);
  assert.equal(c.created.length, 1, 'an approval request was created');
  assert.equal(c.created[0].resourceType, 'outbound_send');
  assert.ok(c.created[0].resourceKey.startsWith('group:'));
  assert.equal(c.sent.length, 1, 'sent after approval');
});

test('group broadcast is blocked on realtime rejection (nothing sent)', async () => {
  const c = makeCtx(GROUP, {
    outboundConfirm: { groups: true, nonOwnerDms: true },
    approvalCallback: true,
    callbackDecision: 'rejected',
  });
  await assert.rejects(() => run(c, GROUP.sessionId), /rejected/i);
  assert.equal(c.sent.length, 0, 'never sent');
});

test('DM to owner is not outward → no gate', async () => {
  const c = makeCtx(OWNER_DM, {
    outboundConfirm: { groups: true, nonOwnerDms: true },
    approvalCallback: true,
  });
  await run(c, OWNER_DM.sessionId);
  assert.equal(c.created.length, 0, 'no approval for an owner DM');
  assert.equal(c.sent.length, 1);
});

test('DM to a non-owner is held for approval', async () => {
  const c = makeCtx(STRANGER_DM, {
    outboundConfirm: { groups: true, nonOwnerDms: true },
    approvalCallback: true,
  });
  await run(c, STRANGER_DM.sessionId);
  assert.equal(c.created.length, 1);
  assert.ok(c.created[0].resourceKey.startsWith('dm:'));
  assert.equal(c.sent.length, 1);
});

test('groups:false leaves group broadcasts ungated', async () => {
  const c = makeCtx(GROUP, {
    outboundConfirm: { groups: false, nonOwnerDms: true },
    approvalCallback: true,
  });
  await run(c, GROUP.sessionId);
  assert.equal(c.created.length, 0);
  assert.equal(c.sent.length, 1);
});

test('a prior approval is reused without re-prompting', async () => {
  const c = makeCtx(GROUP, {
    outboundConfirm: { groups: true, nonOwnerDms: true },
    approvalCallback: true,
    preApproved: true,
  });
  await run(c, GROUP.sessionId);
  assert.equal(c.created.length, 0, 'no new request when already approved');
  assert.equal(c.sent.length, 1);
});

test('resourceKey changes with message text so edits re-prompt', async () => {
  const a = makeCtx(GROUP, { outboundConfirm: { groups: true, nonOwnerDms: true }, approvalCallback: true });
  await run(a, GROUP.sessionId, 'version one');
  const b = makeCtx(GROUP, { outboundConfirm: { groups: true, nonOwnerDms: true }, approvalCallback: true });
  await run(b, GROUP.sessionId, 'version two');
  assert.notEqual(a.created[0].resourceKey, b.created[0].resourceKey);
});
