import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { DbInternalStateStore } from '@openhermit/store';
import type { StoreScope } from '@openhermit/store';

// Users and identities are global (not agent-scoped); a user's role lives in
// the per-agent user_agents binding. Every test uses fresh random ids so it
// can run against a shared database without cross-test interference.

async function createTestStore(t: import('node:test').TestContext) {
  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  return store;
}

const uid = (label: string): string => `usr-test-${label}-${randomUUID().slice(0, 8)}`;
const chanId = (): string => randomUUID();
const uniqueScope = (): StoreScope => ({ agentId: `test-agent-${randomUUID().slice(0, 8)}` });
const now = (): string => new Date().toISOString();

test('UserStore: upsert and get a user', async (t) => {
  const { users } = await createTestStore(t);
  const alice = uid('alice');

  await users.upsert({ userId: alice, name: 'Alice', createdAt: now(), updatedAt: now() });

  const user = await users.get(alice);
  assert.ok(user);
  assert.equal(user.userId, alice);
  assert.equal(user.name, 'Alice');
});

test('UserStore: upsert updates existing user', async (t) => {
  const { users } = await createTestStore(t);
  const bob = uid('bob');
  const createdAt = now();

  await users.upsert({ userId: bob, createdAt, updatedAt: createdAt });
  await users.upsert({ userId: bob, name: 'Bob', createdAt, updatedAt: now() });

  const user = await users.get(bob);
  assert.ok(user);
  assert.equal(user.name, 'Bob');
});

test('UserStore: get and list exclude merged users', async (t) => {
  const { users } = await createTestStore(t);
  const keep = uid('keep');
  const merged = uid('merged');

  await users.upsert({ userId: keep, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: merged, mergedInto: keep, createdAt: now(), updatedAt: now() });

  assert.equal(await users.get(merged), undefined);
  const ids = new Set((await users.list()).map((u) => u.userId));
  assert.ok(ids.has(keep));
  assert.ok(!ids.has(merged));
});

test('UserStore: link and resolve identity', async (t) => {
  const { users } = await createTestStore(t);
  const alice = uid('alice');
  const tg = chanId();

  await users.upsert({ userId: alice, createdAt: now(), updatedAt: now() });
  await users.linkIdentity({ userId: alice, channel: 'telegram', channelUserId: tg, createdAt: now() });

  assert.equal(await users.resolve('telegram', tg), alice);
  assert.equal(await users.resolve('telegram', chanId()), undefined, 'unknown identity');
  assert.equal(await users.resolve('discord', tg), undefined, 'same id on another channel');
});

test('UserStore: resolve follows merged_into', async (t) => {
  const { users } = await createTestStore(t);
  const target = uid('target');
  const source = uid('source');
  const tg = chanId();

  await users.upsert({ userId: target, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: source, mergedInto: target, createdAt: now(), updatedAt: now() });
  await users.linkIdentity({ userId: source, channel: 'telegram', channelUserId: tg, createdAt: now() });

  assert.equal(await users.resolve('telegram', tg), target);
});

test('UserStore: merge moves identities and agent roles, then deletes the source', async (t) => {
  const { users } = await createTestStore(t);
  const into = uid('into');
  const from = uid('from');
  const tg = chanId();
  const dc = chanId();
  const ownedByFrom = uniqueScope();
  const shared = uniqueScope();

  await users.upsert({ userId: into, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: from, createdAt: now(), updatedAt: now() });
  await users.linkIdentity({ userId: from, channel: 'telegram', channelUserId: tg, createdAt: now() });
  await users.linkIdentity({ userId: from, channel: 'discord', channelUserId: dc, createdAt: now() });
  await users.assignAgent(ownedByFrom, from, 'owner', now());
  await users.assignAgent(shared, from, 'user', now());
  await users.assignAgent(shared, into, 'guest', now());

  await users.merge(from, into);

  const identities = await users.listIdentities(into);
  assert.equal(identities.length, 2);
  assert.ok(identities.some((i) => i.channel === 'telegram' && i.channelUserId === tg));
  assert.ok(identities.some((i) => i.channel === 'discord' && i.channelUserId === dc));
  assert.equal((await users.listIdentities(from)).length, 0);

  // Ownership transfers without tripping the one-owner index; where both had
  // a binding, the stronger role survives (source `user` beats target `guest`).
  assert.equal(await users.getAgentRole(ownedByFrom, into), 'owner');
  assert.equal(await users.getAgentRole(shared, into), 'user');
  assert.equal((await users.listAgentRoles(from)).length, 0);
  assert.equal(await users.get(from), undefined);
});

test('UserStore: merging an owner into a guest of the same agent makes the target owner', async (t) => {
  const { users } = await createTestStore(t);
  const into = uid('into');
  const from = uid('from');
  const scope = uniqueScope();

  await users.upsert({ userId: into, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: from, createdAt: now(), updatedAt: now() });
  await users.assignAgent(scope, from, 'owner', now());
  await users.assignAgent(scope, into, 'guest', now());

  await users.merge(from, into);

  assert.equal(await users.getAgentRole(scope, into), 'owner', 'merge never demotes or drops the owner');
  assert.deepEqual((await users.listByAgent(scope)).map((r) => r.userId), [into], 'still exactly one binding');
});

test('UserStore: merge keeps the target role when it is the stronger one', async (t) => {
  const { users } = await createTestStore(t);
  const into = uid('into');
  const from = uid('from');
  const scope = uniqueScope();

  await users.upsert({ userId: into, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: from, createdAt: now(), updatedAt: now() });
  await users.assignAgent(scope, into, 'owner', now());
  await users.assignAgent(scope, from, 'guest', now());

  await users.merge(from, into);
  assert.equal(await users.getAgentRole(scope, into), 'owner');
});

test('UserStore: merge and orphan cleanup repoint schedules.created_by', async (t) => {
  const store = await createTestStore(t);
  const { users, schedules } = store;
  const into = uid('into');
  const from = uid('from');
  const orphan = uid('orphan');
  const scope = uniqueScope();
  const tg = chanId();

  await users.upsert({ userId: into, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: from, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: orphan, createdAt: now(), updatedAt: now() });
  const byFrom = await schedules.create(scope, { type: 'cron', cronExpression: '0 9 * * *', prompt: 'p', createdBy: from });
  const byOrphan = await schedules.create(scope, { type: 'cron', cronExpression: '0 9 * * *', prompt: 'p', createdBy: orphan });

  await users.merge(from, into);
  assert.equal((await schedules.get(scope, byFrom.scheduleId))?.createdBy, into);

  // linkIdentity's orphan-prune path shares the same reassignment.
  await users.linkIdentity({ userId: orphan, channel: 'telegram', channelUserId: tg, createdAt: now() });
  await users.linkIdentity({ userId: into, channel: 'telegram', channelUserId: tg, createdAt: now() });
  assert.equal(await users.get(orphan), undefined);
  assert.equal((await schedules.get(scope, byOrphan.scheduleId))?.createdBy, into);
});

test('UserStore: re-linking moves an orphaned owner onto a guest target without tripping the one-owner index', async (t) => {
  const { users } = await createTestStore(t);
  const survivor = uid('survivor');
  const orphan = uid('orphan');
  const tg = chanId();
  const scope = uniqueScope();

  await users.upsert({ userId: survivor, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: orphan, createdAt: now(), updatedAt: now() });
  await users.linkIdentity({ userId: orphan, channel: 'telegram', channelUserId: tg, createdAt: now() });
  await users.assignAgent(scope, orphan, 'owner', now());
  await users.assignAgent(scope, survivor, 'guest', now());

  await users.linkIdentity({ userId: survivor, channel: 'telegram', channelUserId: tg, createdAt: now() });

  assert.equal(await users.get(orphan), undefined);
  assert.equal(await users.getAgentRole(scope, survivor), 'owner');
});

test('UserStore: unlink identity', async (t) => {
  const { users } = await createTestStore(t);
  const alice = uid('alice');
  const tg = chanId();

  await users.upsert({ userId: alice, createdAt: now(), updatedAt: now() });
  await users.linkIdentity({ userId: alice, channel: 'telegram', channelUserId: tg, createdAt: now() });
  await users.unlinkIdentity('telegram', tg);

  assert.equal(await users.resolve('telegram', tg), undefined);
  assert.ok(await users.get(alice), 'unlinking keeps the user');
});

test('UserStore: delete removes the user and its identities stop resolving', async (t) => {
  const { users } = await createTestStore(t);
  const alice = uid('alice');
  const tg = chanId();

  await users.upsert({ userId: alice, createdAt: now(), updatedAt: now() });
  await users.linkIdentity({ userId: alice, channel: 'telegram', channelUserId: tg, createdAt: now() });
  await users.delete(alice);

  assert.equal(await users.get(alice), undefined);
  assert.equal(await users.resolve('telegram', tg), undefined);
});

test('UserStore: re-linking an identity moves it and prunes the orphaned user', async (t) => {
  const { users } = await createTestStore(t);
  const survivor = uid('survivor');
  const orphan = uid('orphan');
  const tg = chanId();
  const scope = uniqueScope();

  await users.upsert({ userId: survivor, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: orphan, createdAt: now(), updatedAt: now() });
  await users.linkIdentity({ userId: orphan, channel: 'telegram', channelUserId: tg, createdAt: now() });
  await users.assignAgent(scope, orphan, 'user', now());

  await users.linkIdentity({ userId: survivor, channel: 'telegram', channelUserId: tg, createdAt: now() });

  assert.equal(await users.resolve('telegram', tg), survivor);
  assert.equal(await users.get(orphan), undefined, 'user left with no identities is pruned');
  assert.equal(await users.getAgentRole(scope, survivor), 'user', 'its agent binding is carried over');
});

test('UserStore: agent roles are scoped per agent and allow one owner', async (t) => {
  const { users } = await createTestStore(t);
  const alice = uid('alice');
  const bob = uid('bob');
  const agentA = uniqueScope();
  const agentB = uniqueScope();

  await users.upsert({ userId: alice, createdAt: now(), updatedAt: now() });
  await users.upsert({ userId: bob, createdAt: now(), updatedAt: now() });
  await users.assignAgent(agentA, alice, 'owner', now());

  assert.equal(await users.getAgentRole(agentA, alice), 'owner');
  assert.equal(await users.getAgentRole(agentB, alice), undefined, 'no role on another agent');
  assert.deepEqual((await users.listByAgent(agentA)).map((r) => r.userId), [alice]);

  await assert.rejects(
    users.assignAgent(agentA, bob, 'owner', now()),
    'a second owner on the same agent is rejected',
  );
  // Re-assigning the existing owner is idempotent.
  await users.assignAgent(agentA, alice, 'owner', now());

  await users.removeAgent(agentA, alice);
  assert.equal(await users.getAgentRole(agentA, alice), undefined);
});
