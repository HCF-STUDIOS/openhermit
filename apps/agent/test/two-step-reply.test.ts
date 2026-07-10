import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Usage,
} from '@mariozechner/pi-ai';

import { AgentRunner } from '../src/agent-runner.js';
import type { RunnerSession } from '../src/agent-runner/types.js';
import { parseAgentRuntimeConfig } from '../src/core/security.js';
import { createSecurityFixture } from './helpers.js';

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const createAssistantMessage = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-opus-4-5',
  usage: zeroUsage,
  stopReason: 'stop',
  timestamp: Date.now(),
});

const createTextResponseStream = (text: string) => {
  const stream = createAssistantMessageEventStream();
  const partial = createAssistantMessage([{ type: 'text', text }]);

  stream.push({ type: 'start', partial: createAssistantMessage([]) });
  stream.push({ type: 'text_start', contentIndex: 0, partial });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
  stream.push({ type: 'done', reason: 'stop', message: partial });

  return stream;
};

/** Scripts a plain no-tools draft turn for `postAndIdle`'s `responders` option. */
const draftTurn = (text: string) => () => createTextResponseStream(text);

/**
 * Wraps createSecurityFixture + AgentRunner.create + openSession behind a
 * per-turn scripted streamFn, so a "turn" is just `postAndIdle(text)`.
 * Reused by every two-step task's tests.
 */
const createTwoStepFixture = async (t: TestContext) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();

  const responders: Array<() => ReturnType<typeof createAssistantMessageEventStream>> = [];
  let callIndex = 0;
  const streamFn: StreamFn = async () => {
    const responder = responders[callIndex];
    callIndex += 1;
    if (!responder) {
      throw new Error(`Unexpected stream call #${callIndex}`);
    }
    return responder();
  };

  const runner = await AgentRunner.create({ workspace, security, streamFn });

  const sessionId = `cli:two-step-${randomBytes(4).toString('hex')}`;
  await runner.openSession({
    sessionId,
    source: { kind: 'cli', interactive: true },
  });

  let messageCounter = 0;

  return {
    runner,
    sessionId,
    get session(): RunnerSession {
      return (runner as unknown as { sessions: Map<string, RunnerSession> }).sessions.get(sessionId)!;
    },
    async setFlag(enabled: boolean): Promise<void> {
      const config = await security.readConfig();
      await security.writeConfig({ ...config, experiments: { two_step: { enabled } } });
    },
    async postAndIdle(
      text: string,
      options?: { responders?: Array<() => ReturnType<typeof createAssistantMessageEventStream>> },
    ): Promise<void> {
      messageCounter += 1;
      if (options?.responders?.length) {
        responders.push(...options.responders);
      } else {
        responders.push(() => createTextResponseStream(`response ${messageCounter}`));
      }
      await runner.postMessage(sessionId, { messageId: `msg-${messageCounter}`, text });
      await runner.waitForSessionIdle(sessionId);
    },
    backlog() {
      return runner.events.getBacklog(sessionId).map((entry) => entry.event);
    },
  };
};

test('two_step config block validates and defaults to off when absent', () => {
  const on = parseAgentRuntimeConfig({ experiments: { two_step: { enabled: true, reply_timeout_ms: 8000 } } });
  assert.equal(on.experiments?.two_step?.enabled, true);
  assert.equal(on.experiments?.two_step?.reply_timeout_ms, 8000);

  const off = parseAgentRuntimeConfig({});
  assert.equal(off.experiments?.two_step, undefined);
});

test('twoStepActive re-stamps hot each turn', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(false);
  await fx.postAndIdle('hi');
  assert.equal(fx.session.twoStepActive, false);

  await fx.setFlag(true); // configStore.setConfig, no restart
  await fx.postAndIdle('again');
  assert.equal(fx.session.twoStepActive, true);
});

test('flag on: draft streams as thinking_delta, no text_delta', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true);
  await fx.postAndIdle('hello', { responders: [draftTurn('raw draft')] });
  const kinds = fx.backlog().map((e) => e.type);
  assert.equal(kinds.filter((k) => k === 'text_delta').length, 0);
  assert.ok(kinds.includes('thinking_delta'));
});

test('flag off: event stream unchanged (text_delta present)', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(false);
  await fx.postAndIdle('hello', { responders: [draftTurn('raw draft')] });
  assert.ok(fx.backlog().some((e) => e.type === 'text_delta'));
});
