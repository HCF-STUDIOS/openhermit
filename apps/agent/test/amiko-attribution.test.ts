import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { StreamFn } from '@mariozechner/pi-agent-core';

import { withAmikoTwinAttribution } from '../src/agent-runner/amiko-attribution.js';

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

const TWIN_ID = 'cmruko0yq00051hc99t2goo2q';
let savedTwinId: string | undefined;

beforeEach(() => {
  savedTwinId = process.env.AMIKO_TWIN_ID;
});

afterEach(() => {
  if (savedTwinId === undefined) delete process.env.AMIKO_TWIN_ID;
  else process.env.AMIKO_TWIN_ID = savedTwinId;
});

test('amiko requests carry X-Amiko-Twin-Id when AMIKO_TWIN_ID is set', async () => {
  process.env.AMIKO_TWIN_ID = TWIN_ID;
  const spy = makeSpy();
  const wrapped = withAmikoTwinAttribution(spy.fn);

  await wrapped(model('amiko'), context, undefined);

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]?.[2], {
    headers: { 'X-Amiko-Twin-Id': TWIN_ID },
  });
});

test('non-amiko providers pass through untouched even with AMIKO_TWIN_ID set', async () => {
  process.env.AMIKO_TWIN_ID = TWIN_ID;
  const spy = makeSpy();
  const wrapped = withAmikoTwinAttribution(spy.fn);

  await wrapped(model('openrouter'), context, { temperature: 0.5 });

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]?.[2], { temperature: 0.5 });
});

test('amiko requests pass through untouched without AMIKO_TWIN_ID', async () => {
  delete process.env.AMIKO_TWIN_ID;
  const spy = makeSpy();
  const wrapped = withAmikoTwinAttribution(spy.fn);

  await wrapped(model('amiko'), context, { temperature: 0.1 });

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]?.[2], { temperature: 0.1 });
});

test('whitespace-only AMIKO_TWIN_ID is treated as absent', async () => {
  process.env.AMIKO_TWIN_ID = '   ';
  const spy = makeSpy();
  const wrapped = withAmikoTwinAttribution(spy.fn);

  await wrapped(model('amiko'), context, undefined);

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]?.[2], undefined);
});

test('caller-supplied headers win on conflict and other options survive', async () => {
  process.env.AMIKO_TWIN_ID = TWIN_ID;
  const spy = makeSpy();
  const wrapped = withAmikoTwinAttribution(spy.fn);

  await wrapped(model('amiko'), context, {
    temperature: 0.7,
    headers: { 'X-Amiko-Twin-Id': 'coverride00000000000000000', 'X-Trace-Id': 'abc' },
  });

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]?.[2], {
    temperature: 0.7,
    headers: {
      'X-Amiko-Twin-Id': 'coverride00000000000000000',
      'X-Trace-Id': 'abc',
    },
  });
});

test('caller-supplied twin header wins regardless of casing (no duplicate variants)', async () => {
  process.env.AMIKO_TWIN_ID = TWIN_ID;
  const spy = makeSpy();
  const wrapped = withAmikoTwinAttribution(spy.fn);

  await wrapped(model('amiko'), context, {
    headers: { 'x-amiko-twin-id': 'clowercase0000000000000000' },
  });

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]?.[2], {
    headers: { 'x-amiko-twin-id': 'clowercase0000000000000000' },
  });
});
