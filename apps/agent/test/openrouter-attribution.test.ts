import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StreamFn } from '@mariozechner/pi-agent-core';

import { withOpenRouterAttribution } from '../src/agent-runner/openrouter-attribution.js';

type StreamArgs = Parameters<StreamFn>;

const makeSpy = () => {
  const calls: StreamArgs[] = [];
  const fn: StreamFn = (async (...args: StreamArgs) => {
    calls.push(args);
    return { result: async () => ({} as never) } as never;
  }) as StreamFn;
  return { fn, calls };
};

const model = (provider: string) => ({ provider }) as Parameters<StreamFn>[0];
const context = {} as Parameters<StreamFn>[1];

test('non-openrouter providers pass through untouched', async () => {
  const spy = makeSpy();
  const wrapped = withOpenRouterAttribution(spy.fn);

  await wrapped(model('anthropic'), context, { temperature: 0.5 });

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]?.[2], { temperature: 0.5 });
});

test('openrouter requests get default attribution headers', async () => {
  const spy = makeSpy();
  const wrapped = withOpenRouterAttribution(spy.fn);

  await wrapped(model('openrouter'), context, undefined);

  const forwarded = spy.calls[0]?.[2];
  assert.deepEqual(forwarded?.headers, {
    'HTTP-Referer': 'https://openhermit.ai',
    'X-OpenRouter-Title': 'OpenHermit',
  });
});

test('caller-supplied headers override the defaults', async () => {
  const spy = makeSpy();
  const wrapped = withOpenRouterAttribution(spy.fn);

  await wrapped(model('openrouter'), context, {
    headers: { 'X-OpenRouter-Title': 'CustomEmbed', 'X-Trace-Id': 'abc' },
  });

  const forwarded = spy.calls[0]?.[2];
  assert.deepEqual(forwarded?.headers, {
    'HTTP-Referer': 'https://openhermit.ai',
    'X-OpenRouter-Title': 'CustomEmbed',
    'X-Trace-Id': 'abc',
  });
});
