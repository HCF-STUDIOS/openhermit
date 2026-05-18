import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { DbAttachmentStore, LocalAttachmentStorage } from '@openhermit/store';

import {
  createAttachmentListTool,
  createAttachmentFetchTool,
} from '../src/tools/attachment.js';
import type { ToolContext } from '../src/tools/shared.js';
import { createSecurityFixture } from './helpers.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function setup(t: import('node:test').TestContext) {
  const store = await DbAttachmentStore.open();
  t.after(() => store.close());

  const root = await mkdtemp(path.join(tmpdir(), 'openhermit-att-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalAttachmentStorage({ root });

  const fixture = await createSecurityFixture(t);
  const agentId = fixture.agentId;
  const sessionId = `s-${randomUUID().slice(0, 8)}`;

  const baseCtx: ToolContext = {
    security: fixture.security,
    attachmentStore: store,
    attachmentStorage: storage,
    storeScope: { agentId },
    sessionId,
    currentUserId: 'usr-1',
    currentUserRole: 'user',
  };

  return { store, storage, root, agentId, sessionId, baseCtx };
}

async function uploadFile(opts: {
  store: DbAttachmentStore;
  storage: LocalAttachmentStorage;
  agentId: string;
  sessionId: string;
  name: string;
  body: Buffer;
  mime: string;
  uploaderUserId?: string;
}): Promise<string> {
  const id = `att_${randomUUID()}`;
  const { sha256, sizeBytes } = await opts.storage.put({
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    attachmentId: id,
    filename: opts.name,
    contentType: opts.mime,
    body: bufferToStream(opts.body),
  });
  await opts.store.create({
    id,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    uploaderUserId: opts.uploaderUserId ?? 'usr-1',
    originalName: opts.name,
    safeName: opts.name,
    mimeType: opts.mime,
    sizeBytes,
    sha256,
    storageProvider: 'local',
    storageKey: `${opts.agentId}/${opts.sessionId}/${id}/${opts.name}`,
  });
  return id;
}

function bufferToStream(buf: Buffer): NodeJS.ReadableStream {
  return Readable.from(buf);
}

function jsonOf(text: string): unknown {
  return JSON.parse(text);
}

// ── attachment_list ─────────────────────────────────────────────────────

test('attachment_list: returns only this-session uploads by default', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  await uploadFile({
    store, storage, agentId, sessionId,
    name: 'a.txt', body: Buffer.from('a'), mime: 'text/plain',
  });
  await uploadFile({
    store, storage, agentId, sessionId,
    name: 'b.txt', body: Buffer.from('b'), mime: 'text/plain',
  });
  // Different session, same agent — must NOT appear.
  await uploadFile({
    store, storage, agentId, sessionId: 'other-session',
    name: 'c.txt', body: Buffer.from('c'), mime: 'text/plain',
  });

  const tool = createAttachmentListTool(baseCtx);
  const out = await tool.execute('tc-1', {});
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  const arr = jsonOf(text) as Array<{ name: string }>;
  const names = arr.map((r) => r.name).sort();
  assert.deepEqual(names, ['a.txt', 'b.txt']);
});

test('attachment_list scope=user: spans sessions for same user', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  await uploadFile({
    store, storage, agentId, sessionId,
    name: 'one.txt', body: Buffer.from('1'), mime: 'text/plain',
  });
  await uploadFile({
    store, storage, agentId, sessionId: 'other-session',
    name: 'two.txt', body: Buffer.from('2'), mime: 'text/plain',
    uploaderUserId: 'usr-1',
  });
  // Another user — must not appear.
  await uploadFile({
    store, storage, agentId, sessionId,
    name: 'three.txt', body: Buffer.from('3'), mime: 'text/plain',
    uploaderUserId: 'usr-2',
  });

  const tool = createAttachmentListTool(baseCtx);
  const out = await tool.execute('tc-1', { scope: 'user' });
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  const names = (jsonOf(text) as Array<{ name: string }>).map((r) => r.name).sort();
  assert.deepEqual(names, ['one.txt', 'two.txt']);
});

test('attachment_list scope=user requires a resolved user', async (t) => {
  const { baseCtx } = await setup(t);
  const tool = createAttachmentListTool({ ...baseCtx, currentUserId: undefined });
  await assert.rejects(
    () => tool.execute('tc-1', { scope: 'user' }),
    /requires a resolved user/,
  );
});

// ── attachment_fetch ────────────────────────────────────────────────────

test('attachment_fetch auto: text/plain returns inline text', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const id = await uploadFile({
    store, storage, agentId, sessionId,
    name: 't.txt', body: Buffer.from('hello world'), mime: 'text/plain',
  });
  const tool = createAttachmentFetchTool(baseCtx);
  const out = await tool.execute('tc-1', { attachment_id: id });
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  assert.match(text, /hello world/);
});

test('attachment_fetch auto: image/png returns image content block', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const body = Buffer.concat([PNG_HEADER, Buffer.from('tail')]);
  const id = await uploadFile({
    store, storage, agentId, sessionId,
    name: 'pic.png', body, mime: 'image/png',
  });
  const tool = createAttachmentFetchTool(baseCtx);
  const out = await tool.execute('tc-1', { attachment_id: id });
  const blocks = out.content as Array<Record<string, unknown>>;
  const image = blocks.find((b) => b.type === 'image');
  assert.ok(image, 'expected an image content block');
  assert.equal(image!.mimeType, 'image/png');
  assert.equal(typeof image!.data, 'string');
});

test('attachment_fetch text on a binary attachment rejects', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const id = await uploadFile({
    store, storage, agentId, sessionId,
    name: 'pic.png', body: PNG_HEADER, mime: 'image/png',
  });
  const tool = createAttachmentFetchTool(baseCtx);
  await assert.rejects(
    () => tool.execute('tc-1', { attachment_id: id, mode: 'text' }),
    /text mimetype/,
  );
});

test('attachment_fetch metadata-only returns row without bytes', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const id = await uploadFile({
    store, storage, agentId, sessionId,
    name: 'f.bin', body: Buffer.alloc(64, 0xff), mime: 'application/octet-stream',
  });
  const tool = createAttachmentFetchTool(baseCtx);
  const out = await tool.execute('tc-1', { attachment_id: id, mode: 'metadata' });
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  const obj = jsonOf(text) as { id: string; mimeType: string };
  assert.equal(obj.id, id);
  assert.equal(obj.mimeType, 'application/octet-stream');
});

test('attachment_fetch: cross-session lookup is blocked for non-uploaders', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const id = await uploadFile({
    store, storage, agentId, sessionId: 'other-session',
    name: 's.txt', body: Buffer.from('secret'), mime: 'text/plain',
    uploaderUserId: 'usr-other',
  });
  const tool = createAttachmentFetchTool({
    ...baseCtx,
    sessionId,
    currentUserId: 'usr-1',
    currentUserRole: 'user',
  });
  await assert.rejects(
    () => tool.execute('tc-1', { attachment_id: id }),
    /not visible/,
  );
});

test('attachment_fetch: uploader can read their own attachment from a different session', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const id = await uploadFile({
    store, storage, agentId, sessionId: 'other-session',
    name: 'mine.txt', body: Buffer.from('mine'), mime: 'text/plain',
    uploaderUserId: 'usr-1',
  });
  const tool = createAttachmentFetchTool({
    ...baseCtx,
    sessionId,
    currentUserId: 'usr-1',
    currentUserRole: 'user',
  });
  const out = await tool.execute('tc-1', { attachment_id: id });
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  assert.match(text, /mine/);
});

test('attachment_fetch auto: large text falls back to metadata + sandbox pointer', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const big = Buffer.alloc(4096, 'x');
  const id = await uploadFile({
    store, storage, agentId, sessionId,
    name: 'big.txt', body: big, mime: 'text/plain',
  });
  const tool = createAttachmentFetchTool(baseCtx);
  const out = await tool.execute('tc-1', { attachment_id: id, max_bytes: 16 });
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  assert.match(text, /exceeds max_bytes/);
});

test('attachment_fetch: self-heals materialization when row is failed/pending', async (t) => {
  // Simulates a fresh upload that landed in storage but never got copied
  // into the sandbox (sandbox was down at upload time). attachment_fetch
  // should call materializeAttachment, persist the new sandbox path, and
  // return the bytes inline as text.
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const id = await uploadFile({
    store, storage, agentId, sessionId,
    name: 'orphan.txt', body: Buffer.from('healed bytes'), mime: 'text/plain',
  });
  // Mark the row as failed materialization so the heal path fires.
  await store.setMaterialization(id, { state: 'failed', error: 'sandbox down at upload' });

  let healCalls = 0;
  const tool = createAttachmentFetchTool({
    ...baseCtx,
    materializeAttachment: async ({ sessionId: sid, attachmentId, safeName, bytes }) => {
      healCalls += 1;
      assert.equal(attachmentId, id);
      assert.equal(safeName, 'orphan.txt');
      assert.equal(bytes.toString('utf8'), 'healed bytes');
      return {
        sandboxId: 'sandbox-heal',
        sandboxPath: `/home/agent/.openhermit/attachments/${sid}/${attachmentId}/${safeName}`,
      };
    },
  });

  const out = await tool.execute('tc-1', { attachment_id: id });
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  assert.match(text, /healed bytes/);
  assert.equal(healCalls, 1);

  const row = await store.get(id);
  assert.equal(row!.materializationState, 'copied');
  assert.equal(row!.sandboxId, 'sandbox-heal');
  assert.ok(row!.sandboxPath?.endsWith('/orphan.txt'));
});

test('attachment_fetch: heal failure is recorded, content still returned', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx } = await setup(t);
  const id = await uploadFile({
    store, storage, agentId, sessionId,
    name: 'still-orphan.txt', body: Buffer.from('inline ok'), mime: 'text/plain',
  });
  await store.setMaterialization(id, { state: 'pending' });

  const tool = createAttachmentFetchTool({
    ...baseCtx,
    materializeAttachment: async () => {
      throw new Error('sandbox still down');
    },
  });

  const out = await tool.execute('tc-1', { attachment_id: id });
  const text = (out.content as Array<{ type: string; text: string }>)
    .find((c) => c.type === 'text')!.text;
  assert.match(text, /inline ok/);

  const row = await store.get(id);
  assert.equal(row!.materializationState, 'failed');
  assert.match(row!.materializationError ?? '', /sandbox still down/);
});
