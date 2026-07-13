import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { DbAttachmentStore, LocalAttachmentStorage } from '@openhermit/store';
import type { SessionAttachment } from '@openhermit/protocol';

import {
  createAttachmentUploadTool,
  createAttachmentSendTool,
} from '../src/tools/attachment.js';
import type { ToolContext } from '../src/tools/shared.js';
import { createSecurityFixture } from './helpers.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function setup(t: import('node:test').TestContext) {
  const store = await DbAttachmentStore.open();
  t.after(() => store.close());

  const root = await mkdtemp(path.join(tmpdir(), 'openhermit-att-send-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalAttachmentStorage({ root });

  const fixture = await createSecurityFixture(t);
  const agentId = fixture.agentId;
  const sessionId = `s-${randomUUID().slice(0, 8)}`;

  const events: Array<Record<string, unknown>> = [];
  const baseCtx: ToolContext = {
    security: fixture.security,
    attachmentStore: store,
    attachmentStorage: storage,
    storeScope: { agentId },
    sessionId,
    currentUserId: 'usr-1',
    currentUserRole: 'user',
    publishEvent: (e) => { events.push(e); },
  };

  return { store, storage, agentId, sessionId, baseCtx, events };
}

async function uploadRow(opts: {
  store: DbAttachmentStore;
  storage: LocalAttachmentStorage;
  agentId: string;
  sessionId: string;
  name: string;
  body: Buffer;
  mime: string;
}): Promise<string> {
  const id = `att_${randomUUID()}`;
  const { sha256, sizeBytes } = await opts.storage.put({
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    attachmentId: id,
    filename: opts.name,
    contentType: opts.mime,
    body: Readable.from(opts.body),
  });
  await opts.store.create({
    id,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    uploaderUserId: 'usr-1',
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

function kindOf(event: Record<string, unknown>): string {
  return event['kind'] as string;
}

// ── attachment_upload: pending_media skeleton ────────────────────────────

test('attachment_upload emits pending_media with correlationId = new attachment id for renderable media', async (t) => {
  const { agentId, sessionId, baseCtx, events } = await setup(t);
  const uploaded: SessionAttachment = {
    id: `att_${randomUUID()}`,
    type: 'file',
    name: 'render.png',
    mimeType: 'image/png',
    size: 128,
    sha256: 'deadbeef',
    sandboxPath: `/home/agent/out/render.png`,
  };
  const tool = createAttachmentUploadTool({
    ...baseCtx,
    uploadSandboxAttachment: async () => uploaded,
  });
  await tool.execute('tc-1', { path: 'out/render.png' });

  const pending = events.find((e) => e['type'] === 'pending_media');
  assert.ok(pending, 'expected a pending_media event');
  assert.equal(pending!['correlationId'], uploaded.id);
  assert.equal(kindOf(pending!), 'image');
  assert.equal(pending!['sessionId'], sessionId);
  void agentId;
});

test('attachment_upload emits no pending_media for a non-renderable mime', async (t) => {
  const { baseCtx, events } = await setup(t);
  const uploaded: SessionAttachment = {
    id: `att_${randomUUID()}`,
    type: 'file',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 10,
    sha256: 'abc123',
  };
  const tool = createAttachmentUploadTool({
    ...baseCtx,
    uploadSandboxAttachment: async () => uploaded,
  });
  await tool.execute('tc-1', { path: 'notes.txt' });

  assert.equal(events.find((e) => e['type'] === 'pending_media'), undefined);
});

// ── attachment_send: correlationId + kind alias map ──────────────────────

test('attachment_send emits an attachment event whose correlationId is the row id', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx, events } = await setup(t);
  const id = await uploadRow({
    store, storage, agentId, sessionId,
    name: 'pic.png', body: Buffer.concat([PNG_HEADER, Buffer.from('x')]), mime: 'image/png',
  });
  const tool = createAttachmentSendTool(baseCtx);
  await tool.execute('tc-1', { id });

  const evt = events.find((e) => e['type'] === 'attachment');
  assert.ok(evt, 'expected an attachment event');
  assert.equal(evt!['attachmentId'], id);
  // correlationId must match the id used by attachment_upload's skeleton so
  // the client resolves the placeholder instead of appending a new bubble.
  assert.equal(evt!['correlationId'], id);
  assert.equal(kindOf(evt!), 'image');
});

test('attachment_send maps model-speak kind aliases to canonical kinds', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx, events } = await setup(t);
  const id = await uploadRow({
    store, storage, agentId, sessionId,
    name: 'pic.png', body: Buffer.concat([PNG_HEADER, Buffer.from('x')]), mime: 'image/png',
  });

  for (const [alias, expected] of [
    ['photo', 'image'],
    ['picture', 'image'],
    ['img', 'image'],
    ['pic', 'image'],
    ['PHOTO', 'image'],
  ] as const) {
    events.length = 0;
    const tool = createAttachmentSendTool(baseCtx);
    await tool.execute('tc-1', { id, kind: alias });
    const evt = events.find((e) => e['type'] === 'attachment')!;
    assert.equal(kindOf(evt), expected, `alias ${alias} should map to ${expected}`);
  }
});

test('attachment_send falls back to the MIME-derived kind for an unrecognized alias', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx, events } = await setup(t);
  const id = await uploadRow({
    store, storage, agentId, sessionId,
    name: 'pic.png', body: Buffer.concat([PNG_HEADER, Buffer.from('x')]), mime: 'image/png',
  });
  const tool = createAttachmentSendTool(baseCtx);
  await tool.execute('tc-1', { id, kind: 'totally-bogus' });
  const evt = events.find((e) => e['type'] === 'attachment')!;
  assert.equal(kindOf(evt), 'image');
});

test('attachment_send infers kind from MIME when no kind is provided', async (t) => {
  const { store, storage, agentId, sessionId, baseCtx, events } = await setup(t);
  const audioId = await uploadRow({
    store, storage, agentId, sessionId,
    name: 'clip.mp3', body: Buffer.from('ID3audio'), mime: 'audio/mpeg',
  });
  const docId = await uploadRow({
    store, storage, agentId, sessionId,
    name: 'report.pdf', body: Buffer.from('%PDF-1.4'), mime: 'application/pdf',
  });

  const tool = createAttachmentSendTool(baseCtx);
  await tool.execute('tc-1', { id: audioId });
  assert.equal(kindOf(events.find((e) => e['type'] === 'attachment')!), 'audio');

  events.length = 0;
  await tool.execute('tc-2', { id: docId });
  assert.equal(kindOf(events.find((e) => e['type'] === 'attachment')!), 'document');
});
