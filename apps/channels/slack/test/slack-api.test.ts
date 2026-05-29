import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SlackApi } from '../src/slack-api.js';

/** Build a Response whose body streams `bytes` in fixed-size chunks. */
function streamingResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  const chunkSize = 4;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

/** Swap the global fetch for the duration of `fn`. */
async function withFetch(impl: typeof fetch, fn: (api: SlackApi) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn(new SlackApi('xoxb-test'));
  } finally {
    globalThis.fetch = original;
  }
}

test('downloadFile returns bytes when under the cap', async () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5]);
  await withFetch(async () => streamingResponse(data), async (api) => {
    const out = await api.downloadFile('https://files.slack.com/x', 1024);
    assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5]);
  });
});

test('downloadFile rejects up front on an oversized content-length', async () => {
  const data = new Uint8Array(50);
  await withFetch(
    async () => streamingResponse(data, { 'content-length': '999999' }),
    async (api) => {
      await assert.rejects(
        () => api.downloadFile('https://files.slack.com/x', 100),
        /exceeds the 100-byte limit \(content-length/,
      );
    },
  );
});

test('downloadFile aborts mid-stream when a mislabeled file crosses the cap', async () => {
  // 200 bytes, but no content-length header — only the streaming guard catches it.
  const data = new Uint8Array(200);
  await withFetch(async () => streamingResponse(data), async (api) => {
    await assert.rejects(
      () => api.downloadFile('https://files.slack.com/x', 100),
      /exceeds the 100-byte limit/,
    );
  });
});
