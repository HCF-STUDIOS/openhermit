import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { AssistantMessage, Model } from '@mariozechner/pi-ai';

import {
  createLangfuseClientFromEnv,
  createLangfuseTracedStreamFn,
  loadEnvironmentFile,
  type LangfuseClientLike,
  type LangfuseTraceLike,
} from '../src/langfuse.js';
import { createTempDir } from './helpers.js';

test('loadEnvironmentFile reads .env values without overriding existing env', async (t) => {
  const tempDir = await createTempDir(t, 'openhermit-langfuse-env-');
  const envPath = path.join(tempDir, '.env');
  const originalSecret = process.env.LANGFUSE_SECRET_KEY;
  const originalPublic = process.env.LANGFUSE_PUBLIC_KEY;
  const originalBaseUrl = process.env.LANGFUSE_BASE_URL;

  process.env.LANGFUSE_SECRET_KEY = 'existing-secret';
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_BASE_URL;

  t.after(() => {
    if (originalSecret === undefined) {
      delete process.env.LANGFUSE_SECRET_KEY;
    } else {
      process.env.LANGFUSE_SECRET_KEY = originalSecret;
    }

    if (originalPublic === undefined) {
      delete process.env.LANGFUSE_PUBLIC_KEY;
    } else {
      process.env.LANGFUSE_PUBLIC_KEY = originalPublic;
    }

    if (originalBaseUrl === undefined) {
      delete process.env.LANGFUSE_BASE_URL;
    } else {
      process.env.LANGFUSE_BASE_URL = originalBaseUrl;
    }
  });

  await fs.writeFile(
    envPath,
    [
      'LANGFUSE_SECRET_KEY=from-file-secret',
      'LANGFUSE_PUBLIC_KEY="from-file-public"',
      'LANGFUSE_BASE_URL=https://langfuse.example.com',
    ].join('\n'),
    'utf8',
  );

  const loaded = await loadEnvironmentFile(envPath);

  assert.equal(loaded, 2);
  assert.equal(process.env.LANGFUSE_SECRET_KEY, 'existing-secret');
  assert.equal(process.env.LANGFUSE_PUBLIC_KEY, 'from-file-public');
  assert.equal(process.env.LANGFUSE_BASE_URL, 'https://langfuse.example.com');
});

test('createLangfuseClientFromEnv requires both Langfuse keys', () => {
  const logs: string[] = [];
  const incomplete = createLangfuseClientFromEnv({
    env: {
      LANGFUSE_PUBLIC_KEY: 'pk-test',
    },
    logger: (message) => {
      logs.push(message);
    },
  });

  assert.equal(incomplete, undefined);
  assert.match(logs[0] ?? '', /Langfuse disabled/);

  const client = createLangfuseClientFromEnv({
    env: {
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: 'sk-test',
      LANGFUSE_BASE_URL: 'https://langfuse.example.com',
    },
  });

  assert.ok(client);
});

// --- generation usage/cost reporting ---

const assistantMessage = (
  usage: AssistantMessage['usage'],
): AssistantMessage =>
  ({
    role: 'assistant',
    provider: 'amiko',
    model: 'google/gemini-3.1-flash-lite-preview',
    stopReason: 'stop',
    usage,
    content: 'ok',
    timestamp: 0,
  } as unknown as AssistantMessage);

const runTracedStream = async (message: AssistantMessage) => {
  const generationEnds: Record<string, unknown>[] = [];
  const trace: LangfuseTraceLike = {
    generation: () => ({
      end: (body: Record<string, unknown>) => {
        generationEnds.push(body);
      },
    }),
    update: () => undefined,
  };
  const langfuse: LangfuseClientLike = {
    trace: () => trace,
  };
  const baseStreamFn = () =>
    ({
      async *[Symbol.asyncIterator]() {},
      result: async () => message,
    } as never);

  const streamFn = createLangfuseTracedStreamFn(langfuse, baseStreamFn, {
    currentTrace: trace,
  });
  const stream = await streamFn!(
    { id: message.model, provider: message.provider, api: 'openai-completions' } as Model<any>,
    { messages: [] },
    undefined,
  );
  await stream.result();
  return generationEnds;
};

test('generation.end reports usage in top-level usageDetails/costDetails, not just metadata', async () => {
  const ends = await runTracedStream(
    assistantMessage({
      input: 2954,
      output: 18,
      cacheRead: 4045,
      cacheWrite: 0,
      totalTokens: 7017,
      cost: {
        input: 0.0007385,
        output: 0.000027,
        cacheRead: 0.000101125,
        cacheWrite: 0,
        total: 0.000866625,
      },
    }),
  );

  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0]!.usageDetails, {
    input: 2954,
    output: 18,
    cache_read_input_tokens: 4045,
    cache_creation_input_tokens: 0,
    total: 7017,
  });
  assert.deepEqual(ends[0]!.costDetails, {
    input: 0.0007385,
    output: 0.000027,
    cache_read_input_tokens: 0.000101125,
    cache_creation_input_tokens: 0,
    total: 0.000866625,
  });
});

test('zero client-side cost omits costDetails so Langfuse can infer from its own price table', async () => {
  const ends = await runTracedStream(
    assistantMessage({
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }),
  );

  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0]!.usageDetails, {
    input: 100,
    output: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total: 110,
  });
  assert.equal('costDetails' in ends[0]!, false);
});

test('missing totalTokens falls back to the component sum', async () => {
  const ends = await runTracedStream(
    assistantMessage({
      input: 5,
      output: 7,
      cacheRead: 11,
      cacheWrite: 13,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }),
  );

  assert.equal((ends[0]!.usageDetails as { total: number }).total, 36);
});
