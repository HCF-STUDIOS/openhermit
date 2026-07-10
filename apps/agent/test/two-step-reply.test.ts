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

/** Scripts the reply-pass turn (second scripted streamFn call) for `postAndIdle`'s `responders` option. */
const replyTurn = (text: string) => () => createTextResponseStream(text);

/**
 * Stream where the model emits only a thinking block and no text, mirroring
 * the DeepSeek R1 / kimi-k2.6 final-thinking-only shape that isFinalThinkingOnly
 * rescues on the flag-off path (see agent-runner.test.ts's
 * createThinkingOnlyToolUseStream). stopReason 'stop' with zero tool calls
 * exercises the same guard as stopReason 'toolUse' with zero toolCall blocks.
 */
const createThinkingOnlyResponseStream = (thinking: string) => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage([{ type: 'thinking', thinking }]);

  stream.push({ type: 'start', partial: createAssistantMessage([]) });
  stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
  stream.push({ type: 'thinking_delta', contentIndex: 0, delta: thinking, partial: message });
  stream.push({ type: 'thinking_end', contentIndex: 0, content: thinking, partial: message });
  stream.push({ type: 'done', reason: 'stop', message });

  return stream;
};

/** Scripts a thinking-only draft turn for `postAndIdle`'s `responders` option. */
const thinkingOnlyTurn = (thinking: string) => () => createThinkingOnlyResponseStream(thinking);

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
      // The agent_end handler's text_final publish runs in a detached,
      // un-awaited IIFE (queue chaining lands in a later task), and now
      // does real work (generateStyledReply) when two-step is active, so
      // waitForSessionIdle can return before it settles. Give it a few
      // extra ticks so the backlog reflects the completed turn.
      for (let i = 0; i < 5000; i += 1) {
        const agentEnds = runner.events
          .getBacklog(sessionId)
          .filter((entry) => entry.event.type === 'agent_end').length;
        if (agentEnds >= messageCounter) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    backlog() {
      return runner.events.getBacklog(sessionId).map((entry) => entry.event);
    },
    /** Scripts the next raw streamFn call — used to drive generateStyledReply directly. */
    scriptReply(responder: () => ReturnType<typeof createAssistantMessageEventStream>): void {
      responders.push(responder);
    },
    /** Test-only accessor for the private reply-pass method (TS `private` is compile-time only). */
    generateStyledReplyForTest(session: RunnerSession, draftText: string): Promise<string | null> {
      return (runner as unknown as {
        generateStyledReply(session: RunnerSession, draftText: string): Promise<string | null>;
      }).generateStyledReply(session, draftText);
    },
    /** Test-only accessor for the private fidelity-guard predicate. */
    acceptRewriteForTest(draft: string, rewrite: string | null): boolean {
      return (runner as unknown as {
        acceptRewrite(draft: string, rewrite: string | null): boolean;
      }).acceptRewrite(draft, rewrite);
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

test('flag on + group source: message_end backstop flushes thinking_delta, not text_delta', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();
  const config = await security.readConfig();
  await security.writeConfig({ ...config, experiments: { two_step: { enabled: true } } });

  // An unclosed `[Name` tag never resolves without a text_end, so the
  // message_end backstop (not the text_end path) is what flushes it.
  const streamFn: StreamFn = async () => {
    const stream = createAssistantMessageEventStream();
    const text = '[Unclosed tag with no closing bracket';
    const partial = createAssistantMessage([{ type: 'text', text }]);
    stream.push({ type: 'start', partial: createAssistantMessage([]) });
    stream.push({ type: 'text_start', contentIndex: 0, partial });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
    // No text_end pushed: the provider skipped it, exercising the backstop.
    stream.push({ type: 'done', reason: 'stop', message: partial });
    return stream;
  };

  const runner = await AgentRunner.create({ workspace, security, streamFn });
  const sessionId = `group:backstop-${randomBytes(4).toString('hex')}`;
  await runner.openSession({
    sessionId,
    source: { kind: 'channel', interactive: false, type: 'group' },
  });
  await runner.postMessage(sessionId, {
    messageId: 'msg-1',
    text: 'hello group',
    mentioned: true,
    sender: { channel: 'web', channelUserId: 'u-1', displayName: 'User' },
    participants: [{ id: 'u-1', type: 'user', displayName: 'User' }],
  });
  await runner.waitForSessionIdle(sessionId);

  const kinds = runner.events.getBacklog(sessionId).map((entry) => entry.event.type);
  assert.equal(kinds.filter((k) => k === 'text_delta').length, 0);
  assert.ok(kinds.includes('thinking_delta'));
});

test('flag on: thinking-only draft is not promoted at message_end, but survives as the agent_end fallback', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true);
  await fx.postAndIdle('hi', { responders: [thinkingOnlyTurn('internal reasoning only')] });
  // isFinalThinkingOnly is gated off while two-step is active, so message_end
  // never promotes thinking to an early text_final. But latestAssistantText
  // still carries the draft's thinking as its fallback content, so agent_end
  // publishes exactly one text_final from it (no reply pass wired yet) --
  // the answer must never be silently dropped.
  const finals = fx.backlog().filter((e) => e.type === 'text_final');
  assert.equal(finals.length, 1);
  assert.match((finals[0] as { text: string }).text, /internal reasoning/);
});

test('flag off: thinking-only promotion behavior is unchanged', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(false);
  await fx.postAndIdle('hi', { responders: [thinkingOnlyTurn('internal reasoning only')] });
  // Matches agent-runner.test.ts's kimi-k2.6 regression: message_end promotes
  // thinking to text_final, and agent_end double-publishes it, so >= 1.
  const finals = fx.backlog().filter((e) => e.type === 'text_final');
  assert.ok(finals.length >= 1);
  for (const final of finals) {
    assert.match((final as { text: string }).text, /internal reasoning/);
  }
});

test('generateStyledReply returns rewrite on success, null on failure', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true);

  fx.scriptReply(() => createTextResponseStream('styled reply'));
  const ok = await fx.generateStyledReplyForTest(fx.session, 'raw draft');
  assert.equal(typeof ok, 'string');
  assert.equal(ok, 'styled reply');

  fx.scriptReply(() => { throw new Error('provider down'); });
  const bad = await fx.generateStyledReplyForTest(fx.session, 'raw draft');
  assert.equal(bad, null);
});

const fidelityCases: [string, string, boolean][] = [
  ['plain draft', 'plain reply', true],
  ['```js\nx\n```', 'no fence here', false],
  ['has content', '', false],
];
for (const [draft, rewrite, keepRewrite] of fidelityCases) {
  test(`fidelity guard: ${draft.slice(0, 12)}`, async (t) => {
    const fx = await createTwoStepFixture(t);
    assert.equal(fx.acceptRewriteForTest(draft, rewrite), keepRewrite);
  });
}

test('NO_REPLY draft skips the pass', async (t) => {
  const fx = await createTwoStepFixture(t);
  assert.equal(fx.acceptRewriteForTest('<NO_REPLY>', 'anything'), false);
});

test('two-step: one text_final carrying the reply', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true);
  await fx.postAndIdle('hi', { responders: [draftTurn('raw draft'), replyTurn('styled reply')] });
  const finals = fx.backlog().filter((e) => e.type === 'text_final');
  assert.equal(finals.length, 1);
  assert.equal((finals[0] as { text: string }).text, 'styled reply');
});

test('two-step: reply failure falls back to draft in text_final', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true);
  await fx.postAndIdle('hi', {
    responders: [
      draftTurn('raw draft'),
      () => {
        throw new Error('boom');
      },
    ],
  });
  const finals = fx.backlog().filter((e) => e.type === 'text_final');
  assert.equal(finals.length, 1);
  assert.equal((finals[0] as { text: string }).text, 'raw draft');
});
