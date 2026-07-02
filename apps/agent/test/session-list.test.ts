import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ToolContext } from '../src/tools/shared.js';
import { createSessionListTool } from '../src/tools/session.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ENTRIES: any[] = [
  {
    sessionId: 's-tg',
    source: { kind: 'channel', platform: 'telegram', interactive: true, type: 'direct' },
    type: 'direct',
    metadata: { telegram_first_name: 'Alice', telegram_username: 'alice', telegram_user_id: 123 },
    userIds: ['u1'],
    description: 'chat about widgets',
    lastMessagePreview: 'see you',
    messageCount: 5,
    lastActivityAt: '2026-07-02T10:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
  },
  {
    sessionId: 's-wx',
    source: { kind: 'channel', platform: 'wechat', interactive: true, type: 'group' },
    type: 'group',
    metadata: { wechat_group_id: 'g1' },
    userIds: ['u2'],
    description: 'team group',
    messageCount: 2,
    lastActivityAt: '2026-07-02T09:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
  },
  {
    sessionId: 's-old',
    source: { kind: 'channel', platform: 'telegram', interactive: true, type: 'direct' },
    type: 'direct',
    metadata: { telegram_first_name: 'Zed' },
    userIds: [],
    messageCount: 1,
    lastActivityAt: '2026-06-30T00:00:00Z',
    createdAt: '2026-06-01T00:00:00Z',
  },
];

const NAMES: Record<string, string> = { u1: 'Alice OH', u2: 'Bob' };
const IDENTS: Record<string, { channel: string; channelUserId: string }[]> = {
  u1: [{ channel: 'telegram', channelUserId: '123' }, { channel: 'wechat', channelUserId: 'wxid_a' }],
};

const ctx = (): ToolContext =>
  ({
    storeScope: {},
    currentUserRole: 'owner',
    sessionStore: { list: async () => ENTRIES.slice() },
    userStore: {
      get: async (id: string) => (NAMES[id] ? { userId: id, name: NAMES[id] } : { userId: id }),
      listIdentitiesByUserIds: async (ids: string[]) =>
        new Map(ids.map((id) => [id, IDENTS[id] ?? []])),
    },
  }) as unknown as ToolContext;

async function run(args: Record<string, unknown> = {}): Promise<{ rows: any[]; details: any }> {
  const tool = createSessionListTool(ctx());
  const res = await tool.execute('tc', args as any);
  const text = (res.content as any[]).map((c) => c.text ?? '').join('');
  const rows = text.startsWith('No sessions') ? [] : JSON.parse(text);
  return { rows, details: (res as any).details };
}

test('session_list is ordered by most-recent activity and shows participants + counterpart', async () => {
  const { rows } = await run();
  assert.equal(rows[0].sessionId, 's-tg'); // most recent
  assert.equal(rows[0].counterpart, 'Alice (@alice)');
  assert.equal(rows[0].type, 'direct');
  assert.deepEqual(rows[0].participants[0], {
    userId: 'u1',
    name: 'Alice OH',
    identities: ['telegram:123', 'wechat:wxid_a'],
  });
  assert.equal(rows[1].sessionId, 's-wx');
  assert.equal(rows[1].counterpart, 'group g1');
});

test('filter by channel', async () => {
  const { rows } = await run({ channel: 'wechat' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 's-wx');
});

test('filter by type=group', async () => {
  const { rows } = await run({ type: 'group' });
  assert.deepEqual(rows.map((r) => r.sessionId), ['s-wx']);
});

test('filter by user_id', async () => {
  const { rows } = await run({ user_id: 'u1' });
  assert.deepEqual(rows.map((r) => r.sessionId), ['s-tg']);
});

test('search matches description / counterpart', async () => {
  assert.deepEqual((await run({ search: 'alice' })).rows.map((r) => r.sessionId), ['s-tg']);
  assert.deepEqual((await run({ search: 'team group' })).rows.map((r) => r.sessionId), ['s-wx']);
});

test('pagination via limit + offset with total/hasMore', async () => {
  const p1 = await run({ limit: 1, offset: 0 });
  assert.equal(p1.rows.length, 1);
  assert.equal(p1.rows[0].sessionId, 's-tg');
  assert.equal(p1.details.total, 3);
  assert.equal(p1.details.hasMore, true);

  const p2 = await run({ limit: 1, offset: 2 });
  assert.equal(p2.rows[0].sessionId, 's-old');
  assert.equal(p2.details.hasMore, false);
});
