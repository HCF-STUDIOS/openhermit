import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  resolveAttachmentByUrl,
  resolveInboundAttachments,
} from '../src/attachments/index.js';
import {
  DbAttachmentStore,
  LocalAttachmentStorage,
} from '@openhermit/store';
import { OpenHermitError } from '@openhermit/shared';

interface StubRunner {
  materializeAttachmentToSandbox: (input: {
    sessionId: string;
    attachmentId: string;
    safeName: string;
    bytes: Buffer;
  }) => Promise<{ sandboxId: string; sandboxPath: string }>;
}

const makeRunner = (failMaterialization = false): StubRunner => ({
  materializeAttachmentToSandbox: async ({ attachmentId, safeName, sessionId }) => {
    if (failMaterialization) throw new Error('boom-sandbox');
    return {
      sandboxId: 'sandbox-test',
      sandboxPath: `/home/agent/.openhermit/attachments/${sessionId}/${attachmentId}/${safeName}`,
    };
  },
});

interface BuildCtx {
  attachmentStore: DbAttachmentStore;
  attachmentStorage: LocalAttachmentStorage;
  runner: StubRunner;
  storageRoot: string;
}

async function buildCtx(t: import('node:test').TestContext): Promise<BuildCtx> {
  const attachmentStore = await DbAttachmentStore.open();
  t.after(() => attachmentStore.close());

  const storageRoot = await mkdtemp(path.join(tmpdir(), 'openhermit-att-url-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const attachmentStorage = new LocalAttachmentStorage({ root: storageRoot });

  return {
    attachmentStore,
    attachmentStorage,
    runner: makeRunner(),
    storageRoot,
  };
}

function ids(): { agentId: string; sessionId: string } {
  return {
    agentId: `test-url-${randomUUID().slice(0, 8)}`,
    sessionId: `s-${randomUUID().slice(0, 8)}`,
  };
}

// ─── SSRF guards (pre-fetch refusals) ─────────────────────────────────────

test('resolveAttachmentByUrl: rejects http:// (SSRF guard, https-only)', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();
  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId,
        sessionId,
        uploaderUserId: null,
        url: 'http://example.com/a.png',
        maxBytes: 25 * 1024 * 1024,
        attachmentStore: ctx.attachmentStore,
        attachmentStorage: ctx.attachmentStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: ctx.runner as any,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError &&
      err.code === 'attachment_fetch_failed' &&
      /https only/i.test(err.message),
  );
});

test('resolveAttachmentByUrl: rejects link-local 169.254 metadata (SSRF guard)', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();
  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId,
        sessionId,
        uploaderUserId: null,
        url: 'https://169.254.169.254/latest/meta-data/',
        maxBytes: 25 * 1024 * 1024,
        attachmentStore: ctx.attachmentStore,
        attachmentStorage: ctx.attachmentStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: ctx.runner as any,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError && /SSRF guard/i.test(err.message),
  );
});

test('resolveAttachmentByUrl: rejects loopback 127.0.0.1 (SSRF guard)', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();
  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId,
        sessionId,
        uploaderUserId: null,
        url: 'https://127.0.0.1/x',
        maxBytes: 1024,
        attachmentStore: ctx.attachmentStore,
        attachmentStorage: ctx.attachmentStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: ctx.runner as any,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError && /SSRF guard/i.test(err.message),
  );
});

test('resolveAttachmentByUrl: rejects malformed URL', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();
  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId,
        sessionId,
        uploaderUserId: null,
        url: 'not-a-url',
        maxBytes: 1024,
        attachmentStore: ctx.attachmentStore,
        attachmentStorage: ctx.attachmentStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: ctx.runner as any,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError &&
      err.code === 'attachment_fetch_failed' &&
      /malformed URL/i.test(err.message),
  );
});

// ─── Success path via mock origin (bypassing SSRF by stubbing isBlockedHost
// is not possible without DI; instead we patch the URL parser. Since the
// SSRF guard blocks loopback, we test the success path by stubbing the
// `fetch` global with a server-shaped Response.)

test('resolveAttachmentByUrl: happy path persists row + materializes', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown) => {
    return new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const att = await resolveAttachmentByUrl({
    agentId,
    sessionId,
    uploaderUserId: 'usr-bob',
    url: 'https://cdn.example.com/path/logo.png?token=abc',
    hintMimeType: 'image/png',
    hintName: 'logo.png',
    maxBytes: 25 * 1024 * 1024,
    attachmentStore: ctx.attachmentStore,
    attachmentStorage: ctx.attachmentStorage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime: ctx.runner as any,
  });

  assert.ok(att.id && att.id.startsWith('att_'));
  assert.equal(att.type, 'file');
  assert.equal(att.mimeType, 'image/png');
  assert.equal(att.size, png.length);
  assert.equal(att.name, 'logo.png');
  assert.equal(att.materializationState, 'copied');
  assert.ok(att.sandboxPath?.endsWith('/logo.png'));

  const row = await ctx.attachmentStore.get(att.id!);
  assert.ok(row);
  assert.equal(row!.uploaderUserId, 'usr-bob');
  assert.equal(row!.mimeType, 'image/png');
  assert.equal(row!.materializationState, 'copied');
});

test('resolveAttachmentByUrl: upstream 404 → attachment_fetch_failed', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('', { status: 404 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId,
        sessionId,
        uploaderUserId: null,
        url: 'https://cdn.example.com/missing.jpg',
        maxBytes: 25 * 1024 * 1024,
        attachmentStore: ctx.attachmentStore,
        attachmentStorage: ctx.attachmentStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: ctx.runner as any,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError &&
      err.code === 'attachment_fetch_failed' &&
      err.statusCode === 400 &&
      /404/.test(err.message),
  );
});

test('resolveAttachmentByUrl: oversize content-length → attachment_too_large', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from('xx'), {
      status: 200,
      headers: { 'content-length': '99999999', 'content-type': 'text/plain' },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId,
        sessionId,
        uploaderUserId: null,
        url: 'https://cdn.example.com/big.bin',
        maxBytes: 1024,
        attachmentStore: ctx.attachmentStore,
        attachmentStorage: ctx.attachmentStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: ctx.runner as any,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError && err.code === 'attachment_too_large',
  );
});

test('resolveAttachmentByUrl: oversize body (no content-length) → attachment_too_large', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.alloc(2048, 0), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId,
        sessionId,
        uploaderUserId: null,
        url: 'https://cdn.example.com/big.bin',
        maxBytes: 1024,
        attachmentStore: ctx.attachmentStore,
        attachmentStorage: ctx.attachmentStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: ctx.runner as any,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError && err.code === 'attachment_too_large',
  );
});

test('resolveAttachmentByUrl: response content-type beats hint mime', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();
  // Plain text bytes (no magic). Hint says image/png, server says text/plain.
  // resolveMimeType prefers magic-sniff > extension > server header > hint.
  // For a plain-text body with no extension, sniff fails, extension fails,
  // so we should land on the server-provided content-type.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from('hello world'), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const att = await resolveAttachmentByUrl({
    agentId,
    sessionId,
    uploaderUserId: null,
    url: 'https://cdn.example.com/note', // no extension
    hintMimeType: 'image/png',
    hintName: 'note',
    maxBytes: 1024 * 1024,
    attachmentStore: ctx.attachmentStore,
    attachmentStorage: ctx.attachmentStorage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime: ctx.runner as any,
  });
  assert.match(att.mimeType!, /^text\/plain/);
});

test('resolveAttachmentByUrl: materialization failure still creates row (state=failed)', async (t) => {
  const ctx: BuildCtx = { ...(await buildCtx(t)), runner: makeRunner(true) };
  const { agentId, sessionId } = ids();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from('ab'), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const att = await resolveAttachmentByUrl({
    agentId,
    sessionId,
    uploaderUserId: null,
    url: 'https://cdn.example.com/x.txt',
    maxBytes: 1024,
    attachmentStore: ctx.attachmentStore,
    attachmentStorage: ctx.attachmentStorage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime: ctx.runner as any,
  });
  assert.equal(att.materializationState, 'failed');
  const row = await ctx.attachmentStore.get(att.id!);
  assert.equal(row!.materializationState, 'failed');
  assert.match(row!.materializationError ?? '', /boom-sandbox/);
});

// ─── resolveInboundAttachments ────────────────────────────────────────────

test('resolveInboundAttachments: no url entries → returns input untouched', async (t) => {
  const ctx = await buildCtx(t);
  const input = [
    { id: 'att_existing', type: 'file', name: 'x' },
    { type: 'file', sha256: 'abc' },
  ];
  const out = await resolveInboundAttachments(input, {
    agentId: 'a',
    sessionId: 's',
    uploaderUserId: null,
    maxBytes: 1024,
    attachmentStore: ctx.attachmentStore,
    attachmentStorage: ctx.attachmentStorage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime: ctx.runner as any,
  });
  assert.strictEqual(out, input);
});

test('resolveInboundAttachments: id-shape entries pass through; url entries resolve in order', async (t) => {
  const ctx = await buildCtx(t);
  const { agentId, sessionId } = ids();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(Buffer.from(`bytes-${calls}`), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const out = await resolveInboundAttachments(
    [
      { id: 'att_keep_1', type: 'file' },
      { type: 'file', url: 'https://a.example.com/a.txt', name: 'a.txt' },
      { id: 'att_keep_2', type: 'file' },
      { type: 'file', url: 'https://b.example.com/b.txt', name: 'b.txt' },
    ],
    {
      agentId,
      sessionId,
      uploaderUserId: null,
      maxBytes: 1024,
      attachmentStore: ctx.attachmentStore,
      attachmentStorage: ctx.attachmentStorage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime: ctx.runner as any,
    },
  );

  assert.ok(out);
  assert.equal(out!.length, 4);
  assert.equal(out![0]!.id, 'att_keep_1');
  assert.equal(out![2]!.id, 'att_keep_2');
  assert.ok(out![1]!.id?.startsWith('att_'));
  assert.ok(out![3]!.id?.startsWith('att_'));
  assert.notEqual(out![1]!.id, out![3]!.id);
});

