import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MessageStore, StoreScope } from '@openhermit/store';

import { submitCreateJob } from '../src/tools/create-media.js';
import type { ToolContext } from '../src/tools/shared.js';
import { createSecurityFixture } from './helpers.js';

const getFirstText = (result: { content: Array<{ type: string; text?: string }> }): string => {
  const first = result.content.find((entry) => entry.type === 'text');
  return typeof first?.text === 'string' ? first.text : '';
};

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

const makeFakeContext = async (
  t: import('node:test').TestContext,
): Promise<{
  context: ToolContext;
  publishEvents: Record<string, unknown>[];
  appendedEntries: unknown[];
}> => {
  const { security, agentId } = await createSecurityFixture(t);
  const publishEvents: Record<string, unknown>[] = [];
  const appendedEntries: unknown[] = [];

  const storeScope: StoreScope = { agentId };
  const messageStore = {
    appendLogEntry: async (_scope: StoreScope, _sessionId: string, entry: unknown) => {
      appendedEntries.push(entry);
      return 1;
    },
  } as unknown as MessageStore;

  const context: ToolContext = {
    security,
    sessionId: 'sess-1',
    storeScope,
    messageStore,
    publishEvent: (event) => {
      publishEvents.push(event);
    },
  };

  return { context, publishEvents, appendedEntries };
};

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

test('submitCreateJob: success emits pending_media, persists, and returns queued result', async (t) => {
  const { context, publishEvents, appendedEntries } = await makeFakeContext(t);
  const calls: FakeFetchCall[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(202, { jobId: 'j1' });
  }) as unknown as typeof fetch;

  const result = await submitCreateJob(
    context,
    {
      mode: 'MUSIC',
      jobBody: { prompt: 'lofi beat' },
      baseUrl: 'https://x.test',
      twinToken: 'clawd-faketoken',
    },
    { fetch: fakeFetch },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://x.test/api/create/jobs');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer clawd-faketoken');

  assert.equal(publishEvents.length, 1);
  assert.deepEqual(publishEvents[0], {
    type: 'pending_media',
    sessionId: 'sess-1',
    jobId: 'j1',
    mode: 'MUSIC',
  });

  assert.equal(appendedEntries.length, 1);

  const text = getFirstText(result);
  assert.match(text, /j1/);
  assert.match(text, /queued/);
  assert.deepEqual(result.details, { jobId: 'j1', mode: 'MUSIC' });
});

test('submitCreateJob: non-2xx submit returns an error result without emitting pending_media', async (t) => {
  const { context, publishEvents, appendedEntries } = await makeFakeContext(t);
  const fakeFetch = (async () => jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;

  const result = await submitCreateJob(
    context,
    {
      mode: 'IMAGE',
      jobBody: { prompt: 'a cat' },
      baseUrl: 'https://x.test',
      twinToken: 'clawd-faketoken',
    },
    { fetch: fakeFetch },
  );

  assert.equal(publishEvents.length, 0);
  assert.equal(appendedEntries.length, 0);
  assert.equal((result.details as { error?: string }).error, 'http_500');
  const text = getFirstText(result);
  assert.match(text, /500/);
});

test('submitCreateJob: network error returns an error result without emitting pending_media', async (t) => {
  const { context, publishEvents, appendedEntries } = await makeFakeContext(t);
  const fakeFetch = (async () => {
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;

  const result = await submitCreateJob(
    context,
    {
      mode: 'TTS',
      jobBody: { prompt: 'hello' },
      baseUrl: 'https://x.test',
      twinToken: 'clawd-faketoken',
    },
    { fetch: fakeFetch },
  );

  assert.equal(publishEvents.length, 0);
  assert.equal(appendedEntries.length, 0);
  assert.equal((result.details as { error?: string }).error, 'network_error');
  const text = getFirstText(result);
  assert.match(text, /ECONNRESET/);
});

test('submitCreateJob: empty twinToken short-circuits without calling fetch or emitting pending_media', async (t) => {
  const { context, publishEvents, appendedEntries } = await makeFakeContext(t);
  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    return jsonResponse(202, { jobId: 'j1' });
  }) as unknown as typeof fetch;

  const result = await submitCreateJob(
    context,
    {
      mode: 'SFX',
      jobBody: { prompt: 'boom' },
      baseUrl: 'https://x.test',
      twinToken: '',
    },
    { fetch: fakeFetch },
  );

  assert.equal(fetchCalled, false);
  assert.equal(publishEvents.length, 0);
  assert.equal(appendedEntries.length, 0);
  assert.equal((result.details as { error?: string }).error, 'missing_credentials');
});
