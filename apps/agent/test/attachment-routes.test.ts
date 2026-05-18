import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';
import {
  registerAttachmentRoutes,
  type AttachmentRoutesDeps,
} from '../../../apps/gateway/src/attachment-routes.js';
import {
  DbAttachmentStore,
  LocalAttachmentStorage,
} from '@openhermit/store';
import {
  OpenHermitError,
  getErrorMessage,
} from '@openhermit/shared';

interface StubRunner {
  materializeAttachmentToSandbox: (input: {
    sessionId: string;
    attachmentId: string;
    safeName: string;
    bytes: Buffer;
  }) => Promise<{ sandboxId: string; sandboxPath: string }>;
}

interface BuildAppOptions {
  failMaterialization?: boolean;
  sandboxCopyMaxBytes?: number;
  maxBytes?: number;
  uploaderUserId?: string | null;
}

async function buildApp(
  t: import('node:test').TestContext,
  opts: BuildAppOptions = {},
): Promise<{
  app: Hono;
  attachmentStore: DbAttachmentStore;
  storageRoot: string;
}> {
  const attachmentStore = await DbAttachmentStore.open();
  t.after(() => attachmentStore.close());

  const storageRoot = await mkdtemp(path.join(tmpdir(), 'openhermit-att-routes-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const attachmentStorage = new LocalAttachmentStorage({ root: storageRoot });

  const runner: StubRunner = {
    materializeAttachmentToSandbox: async ({ attachmentId, safeName, sessionId }) => {
      if (opts.failMaterialization) {
        throw new Error('boom');
      }
      return {
        sandboxId: 'sandbox-test',
        sandboxPath: `/home/agent/.openhermit/attachments/${sessionId}/${attachmentId}/${safeName}`,
      };
    },
  };

  const app = new Hono();

  // Wire global error handler so thrown OpenHermitErrors become JSON
  // responses (mirrors apps/gateway/src/app.ts behavior).
  app.onError((err, c) => {
    if (err instanceof OpenHermitError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    }
    return c.json({ error: getErrorMessage(err) }, 500);
  });

  const deps: AttachmentRoutesDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instances: {} as any,
    attachmentStore,
    attachmentStorage,
    maxBytes: opts.maxBytes ?? 50 * 1024 * 1024,
    sandboxCopyMaxBytes: opts.sandboxCopyMaxBytes ?? 1024 * 1024,
    requireAuth: () => ({
      mode: 'user',
      channel: 'web',
      channelUserId: 'web:42',
    }),
    enforceSessionNamespace: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveRunner: async () => runner as any,
    requireSessionAccessHttp: async () =>
      opts.uploaderUserId === null ? undefined : opts.uploaderUserId ?? 'usr-test',
  };

  registerAttachmentRoutes(app, deps);

  return { app, attachmentStore, storageRoot };
}

function uniqueAgentSession(): { agentId: string; sessionId: string } {
  return {
    agentId: `test-att-${randomUUID().slice(0, 8)}`,
    sessionId: `s-${randomUUID().slice(0, 8)}`,
  };
}

function attachmentsUrl(agentId: string, sessionId: string): string {
  return `http://localhost/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/attachments`;
}

test('POST attachments: uploads, persists row, materializes small file', async (t) => {
  const { app, attachmentStore, storageRoot } = await buildApp(t);
  const { agentId, sessionId } = uniqueAgentSession();

  const form = new FormData();
  // PNG magic bytes so MIME sniff hits image/png even though we send
  // an arbitrary tail.
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const body = Buffer.concat([pngHeader, Buffer.from('hello-png-tail')]);
  form.append('file', new Blob([body], { type: 'image/png' }), 'shot.png');

  const res = await app.request(attachmentsUrl(agentId, sessionId), {
    method: 'POST',
    body: form,
  });

  assert.equal(res.status, 201);
  const json = (await res.json()) as { attachment: Record<string, unknown> };
  const att = json.attachment;
  assert.ok(typeof att.id === 'string' && att.id.startsWith('att_'));
  assert.equal(att.type, 'file');
  assert.equal(att.name, 'shot.png');
  assert.equal(att.mimeType, 'image/png');
  assert.equal(att.size, body.length);
  assert.equal(att.materializationState, 'copied');
  assert.equal(
    att.sandboxPath,
    `/home/agent/.openhermit/attachments/${sessionId}/${att.id as string}/shot.png`,
  );
  assert.equal(att.sandboxId, 'sandbox-test');

  // Storage row exists with persisted fields.
  const row = await attachmentStore.get(att.id as string);
  assert.ok(row);
  assert.equal(row!.uploaderUserId, 'usr-test');
  assert.equal(row!.storageProvider, 'local');
  assert.equal(row!.materializationState, 'copied');
  assert.equal(row!.sandboxPath, att.sandboxPath);

  // The storage layout puts the file under
  // <root>/<agent>/<session>/<attachmentId>/<safeName>
  const onDisk = path.join(
    storageRoot,
    agentId,
    sessionId,
    att.id as string,
    'shot.png',
  );
  await assert.doesNotReject(() => import('node:fs/promises').then((fs) => fs.stat(onDisk)));
});

test('POST attachments: large file skips sandbox copy', async (t) => {
  const { app, attachmentStore } = await buildApp(t, {
    sandboxCopyMaxBytes: 8, // anything bigger than 8 bytes is "large"
  });
  const { agentId, sessionId } = uniqueAgentSession();

  const form = new FormData();
  const body = Buffer.from('this content is bigger than eight bytes');
  form.append('file', new Blob([body], { type: 'text/plain' }), 'note.txt');

  const res = await app.request(attachmentsUrl(agentId, sessionId), {
    method: 'POST',
    body: form,
  });

  assert.equal(res.status, 201);
  const { attachment } = (await res.json()) as { attachment: Record<string, unknown> };
  assert.equal(attachment.materializationState, 'skipped');
  assert.equal(attachment.sandboxPath, null);

  const row = await attachmentStore.get(attachment.id as string);
  assert.equal(row!.materializationState, 'skipped');
});

test('POST attachments: materialization error is captured, row still created', async (t) => {
  const { app, attachmentStore } = await buildApp(t, { failMaterialization: true });
  const { agentId, sessionId } = uniqueAgentSession();

  const form = new FormData();
  const body = Buffer.from('boom-body');
  form.append('file', new Blob([body], { type: 'text/plain' }), 'b.txt');

  const res = await app.request(attachmentsUrl(agentId, sessionId), {
    method: 'POST',
    body: form,
  });

  assert.equal(res.status, 201);
  const { attachment } = (await res.json()) as { attachment: Record<string, unknown> };
  assert.equal(attachment.materializationState, 'failed');
  assert.match(String(attachment.materializationError), /boom/);

  const row = await attachmentStore.get(attachment.id as string);
  assert.equal(row!.materializationState, 'failed');
  assert.ok(row!.materializationError?.includes('boom'));
});

test('POST attachments: rejects oversize uploads', async (t) => {
  const { app } = await buildApp(t, { maxBytes: 16 });
  const { agentId, sessionId } = uniqueAgentSession();

  const form = new FormData();
  form.append(
    'file',
    new Blob([Buffer.alloc(32, 'x')], { type: 'text/plain' }),
    'big.txt',
  );

  const res = await app.request(attachmentsUrl(agentId, sessionId), {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
});

test('POST attachments: rejects empty file', async (t) => {
  const { app } = await buildApp(t);
  const { agentId, sessionId } = uniqueAgentSession();

  const form = new FormData();
  form.append('file', new Blob([], { type: 'text/plain' }), 'empty.txt');

  const res = await app.request(attachmentsUrl(agentId, sessionId), {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
});

test('POST attachments: rejects missing file field', async (t) => {
  const { app } = await buildApp(t);
  const { agentId, sessionId } = uniqueAgentSession();

  const form = new FormData();
  form.append('not-file', 'hello');

  const res = await app.request(attachmentsUrl(agentId, sessionId), {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
});

test('GET attachments: lists scoped to session by default', async (t) => {
  const { app } = await buildApp(t);
  const { agentId, sessionId } = uniqueAgentSession();

  // Upload two files.
  for (const name of ['a.txt', 'b.txt']) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from(`body-${name}`)], { type: 'text/plain' }),
      name,
    );
    const res = await app.request(attachmentsUrl(agentId, sessionId), {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 201);
  }

  // Upload one in a different session — must not show up under sessionId.
  const otherSession = `s-${randomUUID().slice(0, 8)}`;
  {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from('elsewhere')], { type: 'text/plain' }),
      'c.txt',
    );
    const res = await app.request(attachmentsUrl(agentId, otherSession), {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 201);
  }

  const listRes = await app.request(attachmentsUrl(agentId, sessionId));
  assert.equal(listRes.status, 200);
  const { attachments } = (await listRes.json()) as {
    attachments: Array<{ name: string }>;
  };
  assert.equal(attachments.length, 2);
  const names = attachments.map((a) => a.name).sort();
  assert.deepEqual(names, ['a.txt', 'b.txt']);
});

test('GET attachments?scope=user: lists this user across sessions', async (t) => {
  const { app } = await buildApp(t);
  const { agentId, sessionId } = uniqueAgentSession();

  const upload = async (sid: string, name: string) => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from('body-' + name)], { type: 'text/plain' }),
      name,
    );
    await app.request(attachmentsUrl(agentId, sid), {
      method: 'POST',
      body: form,
    });
  };

  await upload(sessionId, 'one.txt');
  const otherSession = `s-${randomUUID().slice(0, 8)}`;
  await upload(otherSession, 'two.txt');

  const listRes = await app.request(
    attachmentsUrl(agentId, sessionId) + '?scope=user',
  );
  assert.equal(listRes.status, 200);
  const { attachments } = (await listRes.json()) as {
    attachments: Array<{ name: string }>;
  };
  const names = attachments.map((a) => a.name).sort();
  assert.deepEqual(names, ['one.txt', 'two.txt']);
});

test('GET attachments/:id 404s for cross-session lookup', async (t) => {
  const { app } = await buildApp(t);
  const { agentId, sessionId } = uniqueAgentSession();

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hi')], { type: 'text/plain' }), 'x.txt');
  const upload = await app.request(attachmentsUrl(agentId, sessionId), {
    method: 'POST',
    body: form,
  });
  const { attachment } = (await upload.json()) as {
    attachment: { id: string };
  };

  // Same agent + attachmentId, but a different session id.
  const otherSession = `s-${randomUUID().slice(0, 8)}`;
  const wrongRes = await app.request(
    attachmentsUrl(agentId, otherSession) + '/' + attachment.id,
  );
  assert.equal(wrongRes.status, 404);
});

