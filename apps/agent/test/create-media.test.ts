import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MessageStore, StoreScope } from '@openhermit/store';

import { Value } from 'typebox/value';

import {
  createImageTool,
  createMediaToolset,
  createMusicTool,
  createSfxTool,
  createTtsTool,
  createVideoTool,
  submitCreateJob,
} from '../src/tools/create-media.js';
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
  options?: { secrets?: Record<string, string> },
): Promise<{
  context: ToolContext;
  publishEvents: Record<string, unknown>[];
  appendedEntries: unknown[];
}> => {
  const { security, agentId } = await createSecurityFixture(
    t,
    options?.secrets ? { secrets: options.secrets } : undefined,
  );
  await security.load();
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
      twinId: 'twin-1',
    },
    { fetch: fakeFetch },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://x.test/api/create/jobs');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer clawd-faketoken');
  assert.deepEqual(bodyOf(calls[0]!), { prompt: 'lofi beat', twinId: 'twin-1' });

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
      twinId: 'twin-1',
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
      twinId: 'twin-1',
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
      twinId: 'twin-1',
    },
    { fetch: fakeFetch },
  );

  assert.equal(fetchCalled, false);
  assert.equal(publishEvents.length, 0);
  assert.equal(appendedEntries.length, 0);
  assert.equal((result.details as { error?: string }).error, 'missing_credentials');
});

test('submitCreateJob: empty twinId short-circuits without calling fetch or emitting pending_media', async (t) => {
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
      twinToken: 'clawd-faketoken',
      twinId: '',
    },
    { fetch: fakeFetch },
  );

  assert.equal(fetchCalled, false);
  assert.equal(publishEvents.length, 0);
  assert.equal(appendedEntries.length, 0);
  assert.equal((result.details as { error?: string }).error, 'missing_credentials');
});

// ---------------------------------------------------------------------------
// Per-mode create_* tools
// ---------------------------------------------------------------------------

const TWIN_SECRETS = {
  AMIKO_PLATFORM_URL: 'https://x.test',
  AMIKO_TWIN_TOKEN: 'clawd-tooltoken',
  AMIKO_TWIN_ID: 'twin-tool-id',
};

const captureFetch = (): { fetch: typeof fetch; calls: FakeFetchCall[] } => {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(202, { jobId: 'job-abc' });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const bodyOf = (call: FakeFetchCall): Record<string, unknown> =>
  JSON.parse(String(call.init?.body)) as Record<string, unknown>;

test('create_image: valid args submit an IMAGE job with mapped fields and resolved creds', async (t) => {
  const { context, publishEvents } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createImageTool(context, { fetch: fakeFetch });

  const args = { prompt: 'a cat astronaut', model: 'img-1', size: '1024x1024' };
  assert.equal(Value.Check(tool.parameters, args), true);

  await tool.execute('call-1', args, new AbortController().signal, () => {});

  assert.equal(calls.length, 1);
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['Authorization'], 'Bearer clawd-tooltoken');
  assert.deepEqual(bodyOf(calls[0]!), {
    mode: 'IMAGE',
    prompt: 'a cat astronaut',
    model: 'img-1',
    size: '1024x1024',
    twinId: TWIN_SECRETS.AMIKO_TWIN_ID,
  });
  assert.equal(publishEvents[0]?.mode, 'IMAGE');
});

test('create_image: schema rejects args missing the required prompt', () => {
  const tool = createImageTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { model: 'img-1', size: '1024x1024' }), false);
});

test('create_image: schema rejects an empty model', () => {
  const tool = createImageTool({ security: undefined as never });
  assert.equal(
    Value.Check(tool.parameters, { prompt: 'a cat', model: '', size: '1024x1024' }),
    false,
  );
});

test('create_image: missing twin credentials short-circuits without calling fetch', async (t) => {
  const { context } = await makeFakeContext(t);
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createImageTool(context, { fetch: fakeFetch });

  const result = await tool.execute(
    'call-1',
    { prompt: 'a cat', model: 'img-1', size: '1024x1024' },
    new AbortController().signal,
    () => {},
  );

  assert.equal(calls.length, 0);
  assert.equal((result.details as { error?: string }).error, 'missing_credentials');
});

test('create_image: empty AMIKO_TWIN_ID short-circuits without calling fetch', async (t) => {
  const { context } = await makeFakeContext(t, {
    secrets: {
      AMIKO_PLATFORM_URL: TWIN_SECRETS.AMIKO_PLATFORM_URL,
      AMIKO_TWIN_TOKEN: TWIN_SECRETS.AMIKO_TWIN_TOKEN,
      AMIKO_TWIN_ID: '',
    },
  });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createImageTool(context, { fetch: fakeFetch });

  const result = await tool.execute(
    'call-1',
    { prompt: 'a cat', model: 'img-1', size: '1024x1024' },
    new AbortController().signal,
    () => {},
  );

  assert.equal(calls.length, 0);
  assert.equal((result.details as { error?: string }).error, 'missing_credentials');
});

test('create_video: valid args submit a VIDEO job with explicit fields', async (t) => {
  const { context, publishEvents } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createVideoTool(context, { fetch: fakeFetch });

  const args = {
    prompt: 'a dog running',
    model: 'video-1',
    resolution: '720P' as const,
    seconds: 10 as const,
    aspectRatio: '16:9',
    firstFrameImage: 'https://x.test/frame.png',
  };
  assert.equal(Value.Check(tool.parameters, args), true);

  await tool.execute('call-1', args, new AbortController().signal, () => {});

  assert.deepEqual(bodyOf(calls[0]!), {
    mode: 'VIDEO',
    prompt: 'a dog running',
    model: 'video-1',
    resolution: '720P',
    seconds: 10,
    aspectRatio: '16:9',
    firstFrameImage: 'https://x.test/frame.png',
    twinId: TWIN_SECRETS.AMIKO_TWIN_ID,
  });
  assert.equal(publishEvents[0]?.mode, 'VIDEO');
});

test('create_video: omitted resolution/seconds default to 768P/6', async (t) => {
  const { context } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createVideoTool(context, { fetch: fakeFetch });

  await tool.execute('call-1', { model: 'video-1' }, new AbortController().signal, () => {});

  const body = bodyOf(calls[0]!);
  assert.equal(body.resolution, '768P');
  assert.equal(body.seconds, 6);
});

test('create_video: schema rejects an invalid resolution enum value', () => {
  const tool = createVideoTool({ security: undefined as never });
  assert.equal(
    Value.Check(tool.parameters, { model: 'video-1', resolution: '4K' }),
    false,
  );
});

test('create_video: schema rejects an empty model', () => {
  const tool = createVideoTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { model: '' }), false);
});

test('create_tts: valid args submit a TTS job with mapped fields', async (t) => {
  const { context, publishEvents } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createTtsTool(context, { fetch: fakeFetch });

  const args = { prompt: 'hello there', model: 'tts-1', voiceId: 'voice-1' };
  assert.equal(Value.Check(tool.parameters, args), true);

  await tool.execute('call-1', args, new AbortController().signal, () => {});

  assert.deepEqual(bodyOf(calls[0]!), {
    mode: 'TTS',
    prompt: 'hello there',
    model: 'tts-1',
    voiceId: 'voice-1',
    twinId: TWIN_SECRETS.AMIKO_TWIN_ID,
  });
  assert.equal(publishEvents[0]?.mode, 'TTS');
});

test('create_tts: schema rejects args missing the required voiceId', () => {
  const tool = createTtsTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { prompt: 'hi', model: 'tts-1' }), false);
});

test('create_tts: schema rejects an empty model', () => {
  const tool = createTtsTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { prompt: 'hi', model: '', voiceId: 'voice-1' }), false);
});

test('create_sfx: valid args submit an SFX job with mapped fields', async (t) => {
  const { context, publishEvents } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createSfxTool(context, { fetch: fakeFetch });

  const args = { prompt: 'a door slamming', durationSeconds: 3 };
  assert.equal(Value.Check(tool.parameters, args), true);

  await tool.execute('call-1', args, new AbortController().signal, () => {});

  assert.deepEqual(bodyOf(calls[0]!), {
    mode: 'SFX',
    prompt: 'a door slamming',
    durationSeconds: 3,
    twinId: TWIN_SECRETS.AMIKO_TWIN_ID,
  });
  assert.equal(publishEvents[0]?.mode, 'SFX');
});

test('create_sfx: schema rejects a prompt over 500 characters', () => {
  const tool = createSfxTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { prompt: 'x'.repeat(501) }), false);
});

test('create_sfx: schema rejects a negative durationSeconds', () => {
  const tool = createSfxTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { prompt: 'boom', durationSeconds: -1 }), false);
});

test('create_music: valid args submit a MUSIC job with mapped fields', async (t) => {
  const { context, publishEvents } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createMusicTool(context, { fetch: fakeFetch });

  const args = { prompt: 'lofi beat', lyrics: 'la la la', durationMs: 30000, isInstrumental: false };
  assert.equal(Value.Check(tool.parameters, args), true);

  await tool.execute('call-1', args, new AbortController().signal, () => {});

  assert.deepEqual(bodyOf(calls[0]!), {
    mode: 'MUSIC',
    prompt: 'lofi beat',
    model: 'music-2.6',
    lyrics: 'la la la',
    durationMs: 30000,
    isInstrumental: false,
    twinId: TWIN_SECRETS.AMIKO_TWIN_ID,
  });
  assert.equal(publishEvents[0]?.mode, 'MUSIC');
});

test('create_music: model omitted defaults to music-2.6', async (t) => {
  const { context } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const { fetch: fakeFetch, calls } = captureFetch();
  const tool = createMusicTool(context, { fetch: fakeFetch });

  await tool.execute('call-1', {}, new AbortController().signal, () => {});

  assert.equal(bodyOf(calls[0]!).model, 'music-2.6');
});

test('create_music: schema rejects a non-numeric durationMs', () => {
  const tool = createMusicTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { durationMs: 'thirty-thousand' }), false);
});

test('create_music: schema rejects a non-integer durationMs', () => {
  const tool = createMusicTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { durationMs: 30000.5 }), false);
});

test('create_music: schema rejects a negative durationMs', () => {
  const tool = createMusicTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { durationMs: -100 }), false);
});

test('create_music: schema rejects lyrics over 3500 characters', () => {
  const tool = createMusicTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { lyrics: 'x'.repeat(3501) }), false);
});

test('create_music: schema accepts lyrics at exactly 3500 characters', () => {
  const tool = createMusicTool({ security: undefined as never });
  assert.equal(Value.Check(tool.parameters, { lyrics: 'x'.repeat(3500) }), true);
});

test('createMediaToolset: registers all five create_* tools under id create_media', async (t) => {
  const { context } = await makeFakeContext(t, { secrets: TWIN_SECRETS });
  const toolset = createMediaToolset(context);

  assert.equal(toolset.id, 'create_media');
  assert.deepEqual(
    toolset.tools.map((tool) => tool.name).sort(),
    ['create_image', 'create_music', 'create_sfx', 'create_tts', 'create_video'],
  );
});
