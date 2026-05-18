import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  DbAttachmentStore,
  LocalAttachmentStorage,
  type AttachmentRecord,
} from '@openhermit/store';

async function openStore(t: import('node:test').TestContext) {
  const store = await DbAttachmentStore.open();
  t.after(() => store.close());
  return store;
}

function uniqueAgent(): string {
  return `test-att-${randomUUID().slice(0, 8)}`;
}

function makeInput(
  agentId: string,
  sessionId: string,
  overrides: Partial<Parameters<DbAttachmentStore['create']>[0]> = {},
) {
  return {
    agentId,
    sessionId,
    originalName: 'report.pdf',
    safeName: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    storageProvider: 'local',
    storageKey: `${agentId}/${sessionId}/att/report.pdf`,
    ...overrides,
  };
}

// ── DbAttachmentStore ───────────────────────────────────────────────────

test('DbAttachmentStore: create + get round-trips all fields', async (t) => {
  const store = await openStore(t);
  const agentId = uniqueAgent();

  const rec = await store.create(
    makeInput(agentId, 's1', { uploaderUserId: 'usr-1' }),
  );

  assert.ok(rec.id.startsWith('att_'));
  assert.equal(rec.agentId, agentId);
  assert.equal(rec.sessionId, 's1');
  assert.equal(rec.uploaderUserId, 'usr-1');
  assert.equal(rec.originalName, 'report.pdf');
  assert.equal(rec.mimeType, 'application/pdf');
  assert.equal(rec.sizeBytes, 1234);
  assert.equal(rec.materializationState, 'pending');
  assert.equal(rec.sandboxPath, null);

  const fetched = await store.get(rec.id);
  assert.deepEqual(fetched, rec);
});

test('DbAttachmentStore: list defaults to session scope', async (t) => {
  const store = await openStore(t);
  const agentId = uniqueAgent();

  const a = await store.create(makeInput(agentId, 's1', { originalName: 'a.txt' }));
  const b = await store.create(makeInput(agentId, 's1', { originalName: 'b.txt' }));
  await store.create(makeInput(agentId, 's2', { originalName: 'other.txt' }));

  const list = await store.list({ agentId }, 's1');
  const ids = list.map((r: AttachmentRecord) => r.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
});

test('DbAttachmentStore: list with scope=user spans sessions for the same user', async (t) => {
  const store = await openStore(t);
  const agentId = uniqueAgent();

  const fromS1 = await store.create(
    makeInput(agentId, 's1', { uploaderUserId: 'usr-1', originalName: 'one.txt' }),
  );
  const fromS2 = await store.create(
    makeInput(agentId, 's2', { uploaderUserId: 'usr-1', originalName: 'two.txt' }),
  );
  // Different user — must not appear.
  await store.create(
    makeInput(agentId, 's1', { uploaderUserId: 'usr-2', originalName: 'other.txt' }),
  );

  const list = await store.list(
    { agentId },
    's1', // sessionId is ignored in user scope, kept for API symmetry
    { scope: 'user', userId: 'usr-1' },
  );
  const ids = list.map((r: AttachmentRecord) => r.id).sort();
  assert.deepEqual(ids, [fromS1.id, fromS2.id].sort());
});

test('DbAttachmentStore: list with scope=user requires userId', async (t) => {
  const store = await openStore(t);
  const agentId = uniqueAgent();

  await assert.rejects(
    () => store.list({ agentId }, 's1', { scope: 'user' }),
    /requires options\.userId/,
  );
});

test('DbAttachmentStore: list never leaks across agents', async (t) => {
  const store = await openStore(t);
  const agentA = uniqueAgent();
  const agentB = uniqueAgent();

  await store.create(makeInput(agentA, 's1', { uploaderUserId: 'usr-1' }));
  await store.create(makeInput(agentB, 's1', { uploaderUserId: 'usr-1' }));

  const listA = await store.list({ agentId: agentA }, 's1');
  assert.equal(listA.length, 1);
  assert.equal(listA[0]?.agentId, agentA);

  const userScopedA = await store.list(
    { agentId: agentA },
    's1',
    { scope: 'user', userId: 'usr-1' },
  );
  assert.equal(userScopedA.length, 1);
  assert.equal(userScopedA[0]?.agentId, agentA);
});

test('DbAttachmentStore: setMaterialization updates state, sandbox path, and error', async (t) => {
  const store = await openStore(t);
  const agentId = uniqueAgent();
  const rec = await store.create(makeInput(agentId, 's1'));

  await store.setMaterialization(rec.id, {
    state: 'copied',
    sandboxId: 'sbx-1',
    sandboxPath: '/home/user/.openhermit/attachments/s1/x/report.pdf',
  });
  let after = await store.get(rec.id);
  assert.equal(after?.materializationState, 'copied');
  assert.equal(after?.sandboxId, 'sbx-1');
  assert.equal(
    after?.sandboxPath,
    '/home/user/.openhermit/attachments/s1/x/report.pdf',
  );
  assert.equal(after?.materializationError, null);

  await store.setMaterialization(rec.id, { state: 'failed', error: 'disk full' });
  after = await store.get(rec.id);
  assert.equal(after?.materializationState, 'failed');
  assert.equal(after?.materializationError, 'disk full');
});

test('DbAttachmentStore: delete removes the row', async (t) => {
  const store = await openStore(t);
  const agentId = uniqueAgent();
  const rec = await store.create(makeInput(agentId, 's1'));

  await store.delete(rec.id);
  assert.equal(await store.get(rec.id), undefined);
});

test('DbAttachmentStore: CHECK constraint rejects unknown materialization_state', async (t) => {
  const store = await openStore(t);
  const agentId = uniqueAgent();
  const rec = await store.create(makeInput(agentId, 's1'));

  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => store.setMaterialization(rec.id, { state: 'bogus' as any }),
    /materialization_state|check/i,
  );
});

// ── LocalAttachmentStorage ──────────────────────────────────────────────

async function tempRoot(t: import('node:test').TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'openhermit-att-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('LocalAttachmentStorage: put stores bytes, returns size + sha256', async (t) => {
  const root = await tempRoot(t);
  const storage = new LocalAttachmentStorage({ root });

  const body = randomBytes(2048);
  const expectedSha = createHash('sha256').update(body).digest('hex');

  const result = await storage.put({
    agentId: 'agent-a',
    sessionId: 's1',
    attachmentId: 'att_xyz',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    body: Readable.from(body),
  });

  assert.equal(result.storageKey, 'agent-a/s1/att_xyz/report.pdf');
  assert.equal(result.sizeBytes, body.length);
  assert.equal(result.sha256, expectedSha);

  const onDisk = await readFile(path.join(root, result.storageKey));
  assert.deepEqual(onDisk, body);
});

test('LocalAttachmentStorage: readStream + delete', async (t) => {
  const root = await tempRoot(t);
  const storage = new LocalAttachmentStorage({ root });

  const body = Buffer.from('hello attachments');
  const { storageKey } = await storage.put({
    agentId: 'agent-a',
    sessionId: 's1',
    attachmentId: 'att_1',
    filename: 'note.txt',
    contentType: 'text/plain',
    body: Readable.from(body),
  });

  const chunks: Buffer[] = [];
  const stream = await storage.readStream(storageKey);
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello attachments');

  await storage.delete(storageKey);
  await assert.rejects(stat(path.join(root, storageKey)), { code: 'ENOENT' });
});

test('LocalAttachmentStorage: getSignedUrl returns null (no URL concept)', async (t) => {
  const root = await tempRoot(t);
  const storage = new LocalAttachmentStorage({ root });
  assert.equal(
    await storage.getSignedUrl('agent-a/s1/att_1/note.txt', { expiresInSeconds: 60 }),
    null,
  );
});

test('LocalAttachmentStorage: rejects traversal in storage keys', async (t) => {
  const root = await tempRoot(t);
  const storage = new LocalAttachmentStorage({ root });
  await assert.rejects(
    () => storage.readStream('../etc/passwd'),
    /traversal|escapes root/,
  );
});

test('LocalAttachmentStorage: rejects non-absolute root', () => {
  assert.throws(
    () => new LocalAttachmentStorage({ root: 'relative/path' }),
    /must be absolute/,
  );
});

test('LocalAttachmentStorage: written file has 0o644 perms, dirs 0o700', async (t) => {
  // Perm bits aren't meaningful on Windows; node:test doesn't expose
  // os, so just inspect — the test still asserts something useful on
  // posix and is harmless elsewhere.
  const root = await tempRoot(t);
  const storage = new LocalAttachmentStorage({ root });
  const { storageKey } = await storage.put({
    agentId: 'agent-perms',
    sessionId: 's-perms',
    attachmentId: 'att_perms',
    filename: 'note.txt',
    contentType: 'text/plain',
    body: Readable.from(Buffer.from('hi')),
  });
  const fileStat = await stat(path.join(root, storageKey));
  const dirStat = await stat(path.dirname(path.join(root, storageKey)));
  if (process.platform !== 'win32') {
    assert.equal(fileStat.mode & 0o777, 0o644);
    assert.equal(dirStat.mode & 0o777, 0o700);
  }
});
