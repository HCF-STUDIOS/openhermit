import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { DbAttachmentStore, LocalAttachmentStorage } from '@openhermit/store';
import type { SessionAttachment } from '@openhermit/protocol';

import { prepareAttachmentContent } from '../src/agent-runner/message-utils.js';

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

async function setup(t: import('node:test').TestContext) {
  const store = await DbAttachmentStore.open();
  t.after(() => store.close());
  const root = await mkdtemp(path.join(tmpdir(), 'openhermit-prep-att-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalAttachmentStorage({ root });
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const sessionId = `s-${randomUUID().slice(0, 8)}`;

  const attachmentId = `att_${randomUUID()}`;
  const putResult = await storage.put({
    agentId,
    sessionId,
    attachmentId,
    filename: 'pic.png',
    contentType: 'image/png',
    body: Readable.from(PNG_BYTES),
  });
  const att = await store.create({
    id: attachmentId,
    agentId,
    sessionId,
    uploaderUserId: 'usr-1',
    originalName: 'pic.png',
    safeName: 'pic.png',
    mimeType: 'image/png',
    sizeBytes: putResult.sizeBytes,
    sha256: putResult.sha256,
    storageProvider: storage.name,
    storageKey: putResult.storageKey,
  });

  const sessionAttachment: SessionAttachment = {
    id: att.id,
    type: 'image/png',
    name: 'pic.png',
    mimeType: 'image/png',
    size: PNG_BYTES.length,
    sha256: putResult.sha256,
    sandboxPath: '/sandbox/pic.png',
    materializationState: 'ready',
  };

  return { store, storage, sessionAttachment };
}

test('prepareAttachmentContent inlines images when model supports image input', async (t) => {
  const { store, storage, sessionAttachment } = await setup(t);
  const blocks = await prepareAttachmentContent(
    [sessionAttachment],
    { attachmentStore: store, attachmentStorage: storage },
    { supportsImageInput: true },
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
});

test('prepareAttachmentContent downgrades images to text reference for text-only models', async (t) => {
  const { store, storage, sessionAttachment } = await setup(t);
  const blocks = await prepareAttachmentContent(
    [sessionAttachment],
    { attachmentStore: store, attachmentStorage: storage },
    { supportsImageInput: false },
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  const text = (blocks[0] as { text: string }).text;
  assert.match(text, /\[attachment\]/);
  assert.match(text, /mime: image\/png/);
  assert.match(text, /text-only/);
  assert.match(text, /sandbox_path: \/sandbox\/pic\.png/);
});

test('prepareAttachmentContent defaults to inlining when supportsImageInput omitted', async (t) => {
  const { store, storage, sessionAttachment } = await setup(t);
  const blocks = await prepareAttachmentContent(
    [sessionAttachment],
    { attachmentStore: store, attachmentStorage: storage },
    {},
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
});
