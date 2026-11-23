import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  DbApprovalRequestStore,
  DbConsumedJtiStore,
  runMigrations,
} from '@openhermit/store';

// Periodic gateway housekeeping (apps/gateway/src/index.ts) relies on these
// two sweeps; cover them directly against the DB.

test('DbConsumedJtiStore.sweepExpired deletes only jtis past their expiry', async (t) => {
  await runMigrations();
  const store = await DbConsumedJtiStore.open();
  t.after(() => store.close());

  const now = Math.floor(Date.now() / 1000);
  const expiredJti = `test-jti-expired-${randomUUID()}`;
  const liveJti = `test-jti-live-${randomUUID()}`;
  const consumedAt = new Date().toISOString();

  assert.equal(await store.tryConsume(expiredJti, now - 60, consumedAt), true);
  assert.equal(await store.tryConsume(liveJti, now + 3600, consumedAt), true);

  const swept = await store.sweepExpired(now);
  assert.ok(swept >= 1, `expected at least one jti swept, got ${swept}`);

  // The expired row is gone (a fresh consume succeeds again); the live row
  // is still there, so replay of the live token stays blocked.
  assert.equal(await store.tryConsume(expiredJti, now - 60, consumedAt), true);
  assert.equal(await store.tryConsume(liveJti, now + 3600, consumedAt), false);

  // Clean up the re-inserted expired row.
  await store.sweepExpired(now);
});

test('DbApprovalRequestStore.expireOld expires only pending requests past their TTL', async (t) => {
  await runMigrations();
  const store = await DbApprovalRequestStore.open();
  t.after(() => store.close());

  const agentId = `test-approval-sweep-${randomUUID().slice(0, 8)}`;
  const base = {
    agentId,
    sessionId: 'sess-1',
    requesterId: 'user-1',
    resourceType: 'tool',
  };

  const shortTtl = await store.create({ ...base, resourceKey: 'exec', ttlMinutes: 1 });
  const longTtl = await store.create({ ...base, resourceKey: 'web_fetch', ttlMinutes: 60 });
  const resolved = await store.create({ ...base, resourceKey: 'file_write', ttlMinutes: 1 });
  await store.resolve(resolved.id, 'approved', 'owner-1');

  // Five minutes from now: only the 1-minute pending request is past TTL.
  const later = new Date(Date.now() + 5 * 60_000);
  const expired = await store.expireOld(later);
  assert.ok(expired >= 1, `expected at least one request expired, got ${expired}`);

  assert.equal((await store.get(shortTtl.id))?.status, 'expired');
  assert.equal((await store.get(longTtl.id))?.status, 'pending');
  assert.equal((await store.get(resolved.id))?.status, 'approved');

  // Idempotent: a second sweep at the same instant finds nothing of ours.
  await store.expireOld(later);
  assert.equal((await store.get(longTtl.id))?.status, 'pending');
});
