import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Hono } from 'hono';
import { OpenHermitError, UnauthorizedError, NotFoundError, getErrorMessage } from '@openhermit/shared';
import {
  registerSessionPublishRoute,
  type SessionPublishDeps,
} from '../src/session-publish.js';

const ADMIN_TOKEN = 'test-admin-token';

interface BuildAppOptions {
  /** When true, resolveRunner throws NotFoundError (agent/runner gone). */
  runnerMissing?: boolean;
  /** Mock for the injected asset-ingest helper. Omit to leave ingest unconfigured. */
  ingestAttachment?: SessionPublishDeps['ingestAttachment'];
}

function buildApp(opts: BuildAppOptions = {}): {
  app: Hono;
  publishCalls: unknown[];
} {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof OpenHermitError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    }
    return c.json({ error: getErrorMessage(err) }, 500);
  });

  const publishCalls: unknown[] = [];
  const runner = {
    events: {
      publish: async (event: unknown) => {
        publishCalls.push(event);
      },
    },
  };

  const deps: SessionPublishDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instances: {} as any,
    requireAdmin: (authorization) => {
      if (authorization !== `Bearer ${ADMIN_TOKEN}`) {
        throw new UnauthorizedError('Invalid admin token.');
      }
    },
    resolveRunner: async () => {
      if (opts.runnerMissing) {
        throw new NotFoundError('Agent is not available.');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return runner as any;
    },
    ingestAttachment: opts.ingestAttachment,
  };

  registerSessionPublishRoute(app, deps);
  return { app, publishCalls };
}

function uniqueAgentSession(): { agentId: string; sessionId: string } {
  return {
    agentId: `test-pub-${randomUUID().slice(0, 8)}`,
    sessionId: `s-${randomUUID().slice(0, 8)}`,
  };
}

function eventsUrl(agentId: string, sessionId: string): string {
  return `http://localhost/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events`;
}

test('POST session events: missing/invalid token returns 401', async () => {
  const { app, publishCalls } = buildApp();
  const { agentId, sessionId } = uniqueAgentSession();

  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: { type: 'attachment', sessionId, attachmentId: 'att_1', mimeType: 'image/png', kind: 'image' },
    }),
  });

  assert.equal(res.status, 401);
  assert.equal(publishCalls.length, 0);
});

test('POST session events: valid token + valid attachment publishes and returns 202', async () => {
  const { app, publishCalls } = buildApp();
  const { agentId, sessionId } = uniqueAgentSession();

  const event = { type: 'attachment', sessionId, attachmentId: 'att_1', mimeType: 'image/png', kind: 'image' };
  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ event }),
  });

  assert.equal(res.status, 202);
  assert.equal(publishCalls.length, 1);
  assert.deepEqual(publishCalls[0], event);
});

test('POST session events: valid token + valid pending_media publishes and returns 202', async () => {
  const { app, publishCalls } = buildApp();
  const { agentId, sessionId } = uniqueAgentSession();

  const event = { type: 'pending_media', sessionId, correlationId: 'corr_1', kind: 'audio' };
  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ event }),
  });

  assert.equal(res.status, 202);
  assert.equal(publishCalls.length, 1);
  assert.deepEqual(publishCalls[0], event);
});

test('POST session events: disallowed event type returns 400', async () => {
  const { app, publishCalls } = buildApp();
  const { agentId, sessionId } = uniqueAgentSession();

  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ event: { type: 'text_delta', sessionId, text: 'hi' } }),
  });

  assert.equal(res.status, 400);
  assert.equal(publishCalls.length, 0);
});

test('POST session events: malformed body returns 400', async () => {
  const { app, publishCalls } = buildApp();
  const { agentId, sessionId } = uniqueAgentSession();

  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ notEvent: true }),
  });

  assert.equal(res.status, 400);
  assert.equal(publishCalls.length, 0);
});

test('POST session events: unknown/evicted runner returns 404', async () => {
  const { app, publishCalls } = buildApp({ runnerMissing: true });
  const { agentId, sessionId } = uniqueAgentSession();

  const event = { type: 'attachment', sessionId, attachmentId: 'att_1', mimeType: 'image/png', kind: 'image' };
  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ event }),
  });

  assert.equal(res.status, 404);
  assert.equal(publishCalls.length, 0);
});

test('POST session events: attachment with assetUrl ingests then publishes with the returned attachmentId', async () => {
  const ingestCalls: unknown[] = [];
  const { app, publishCalls } = buildApp({
    ingestAttachment: async (input) => {
      ingestCalls.push(input);
      return { attachmentId: 'att_ingested_1', mimeType: 'image/png', size: 1234, sha256: 'deadbeef' };
    },
  });
  const { agentId, sessionId } = uniqueAgentSession();

  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      event: {
        type: 'attachment',
        sessionId,
        assetUrl: 'https://example.com/photo.png',
        correlationId: 'corr_1',
        caption: 'a photo',
      },
    }),
  });

  const body = await res.json();
  assert.equal(res.status, 202);
  assert.equal(ingestCalls.length, 1);
  assert.equal((ingestCalls[0] as { url: string }).url, 'https://example.com/photo.png');
  assert.equal((ingestCalls[0] as { sessionId: string }).sessionId, sessionId);
  assert.equal(publishCalls.length, 1);
  assert.deepEqual(publishCalls[0], {
    type: 'attachment',
    sessionId,
    attachmentId: 'att_ingested_1',
    mimeType: 'image/png',
    kind: 'image',
    size: 1234,
    sha256: 'deadbeef',
    caption: 'a photo',
    correlationId: 'corr_1',
  });
  assert.equal(body.attachmentId, 'att_ingested_1');
});

test('POST session events: attachment ingest failure returns 502 and does not publish', async () => {
  const { app, publishCalls } = buildApp({
    ingestAttachment: async () => {
      throw new Error('attachment_fetch_failed: upstream returned 404');
    },
  });
  const { agentId, sessionId } = uniqueAgentSession();

  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      event: { type: 'attachment', sessionId, assetUrl: 'https://example.com/missing.png' },
    }),
  });

  assert.equal(res.status, 502);
  assert.equal(publishCalls.length, 0);
});

test('POST session events: attachment ingest request with empty mimeType returns 400 and does not ingest', async () => {
  const ingestCalls: unknown[] = [];
  const { app, publishCalls } = buildApp({
    ingestAttachment: async (input) => {
      ingestCalls.push(input);
      return { attachmentId: 'att_should_not_happen', mimeType: 'image/png' };
    },
  });
  const { agentId, sessionId } = uniqueAgentSession();

  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      event: { type: 'attachment', sessionId, assetUrl: 'https://example.com/photo.png', mimeType: '' },
    }),
  });

  assert.equal(res.status, 400);
  // No ingest means no persisted row, so no orphan can exist.
  assert.equal(ingestCalls.length, 0);
  assert.equal(publishCalls.length, 0);
});

test('POST session events: attachment with assetUrl but no ingest helper configured returns 502', async () => {
  const { app, publishCalls } = buildApp();
  const { agentId, sessionId } = uniqueAgentSession();

  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      event: { type: 'attachment', sessionId, assetUrl: 'https://example.com/photo.png' },
    }),
  });

  assert.equal(res.status, 502);
  assert.equal(publishCalls.length, 0);
});

test('POST session events: attachment with attachmentId (no assetUrl) still publishes as-is', async () => {
  const ingestCalls: unknown[] = [];
  const { app, publishCalls } = buildApp({
    ingestAttachment: async (input) => {
      ingestCalls.push(input);
      return { attachmentId: 'unexpected', mimeType: 'image/png' };
    },
  });
  const { agentId, sessionId } = uniqueAgentSession();

  const event = { type: 'attachment', sessionId, attachmentId: 'att_existing', mimeType: 'image/png', kind: 'image' };
  const res = await app.request(eventsUrl(agentId, sessionId), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ event }),
  });

  assert.equal(res.status, 202);
  assert.equal(ingestCalls.length, 0);
  assert.equal(publishCalls.length, 1);
  assert.deepEqual(publishCalls[0], event);
});
