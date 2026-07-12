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
import type { LangfuseClientLike } from '../src/langfuse.js';
import { createSecurityFixture } from './helpers.js';

/** Mirrors agent-runner.test.ts's FakeLangfuseClient — records trace()/update() calls. */
class FakeLangfuseTrace {
  readonly updates: Array<Record<string, unknown>> = [];

  generation() {
    return { end: () => undefined };
  }

  update(body: Record<string, unknown>) {
    this.updates.push(body);
    return this;
  }
}

class FakeLangfuseClient implements LangfuseClientLike {
  readonly traces: Array<{ body: Record<string, unknown>; client: FakeLangfuseTrace }> = [];

  async flushAsync(): Promise<void> {}

  trace(body: Record<string, unknown>) {
    const client = new FakeLangfuseTrace();
    this.traces.push({ body, client });
    return client;
  }
}

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
type Responder = () =>
  | ReturnType<typeof createAssistantMessageEventStream>
  | Promise<ReturnType<typeof createAssistantMessageEventStream>>;

const createTwoStepFixture = async (t: TestContext, options?: { langfuse?: LangfuseClientLike }) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();

  const responders: Responder[] = [];
  let callIndex = 0;
  const streamFn: StreamFn = async () => {
    const responder = responders[callIndex];
    callIndex += 1;
    if (!responder) {
      throw new Error(`Unexpected stream call #${callIndex}`);
    }
    return responder();
  };

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn,
    ...(options?.langfuse ? { langfuse: options.langfuse } : {}),
  });

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
    async setFlag(enabled: boolean, extra?: { reply_timeout_ms?: number }): Promise<void> {
      const config = await security.readConfig();
      await security.writeConfig({ ...config, experiments: { two_step: { enabled, ...extra } } });
    },
    async postAndIdle(
      text: string,
      options?: { responders?: Responder[] },
    ): Promise<void> {
      messageCounter += 1;
      const ordinal = messageCounter;
      if (options?.responders?.length) {
        responders.push(...options.responders);
      } else {
        responders.push(() => createTextResponseStream(`response ${ordinal}`));
      }
      await runner.postMessage(sessionId, { messageId: `msg-${ordinal}`, text });
      await runner.waitForSessionIdle(sessionId);
      // The agent_end handler's text_final publish runs in a detached IIFE
      // (queue-chained via session.pendingReplyPass, not awaited by
      // waitForSessionIdle) and does real work (generateStyledReply) when
      // two-step is active, so waitForSessionIdle can return before it
      // settles. Give it a few extra real time to let the backlog reflect
      // the completed turn (time-bound, not iteration-bound -- iteration
      // counts don't map to a fixed amount of wall-clock time under load).
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const agentEnds = runner.events
          .getBacklog(sessionId)
          .filter((entry) => entry.event.type === 'agent_end').length;
        if (agentEnds >= ordinal) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`postAndIdle: turn ${ordinal} never reached agent_end within 10s`);
    },
    /**
     * Fire-and-continue variant of `postAndIdle`: queues the turn and
     * resolves once that turn's own `agent_end` has landed in the backlog,
     * without waiting for `session.queue`/`sideEffects` overall -- so two
     * calls can be launched back to back to exercise queue-chaining/ordering
     * across turns (see the queue-chaining tests).
     */
    async post(text: string, options?: { responders?: Responder[] }): Promise<void> {
      messageCounter += 1;
      const ordinal = messageCounter;
      const messageId = `msg-${ordinal}`;
      if (options?.responders?.length) {
        responders.push(...options.responders);
      } else {
        responders.push(() => createTextResponseStream(`response ${ordinal}`));
      }
      await runner.postMessage(sessionId, { messageId, text });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const agentEnds = runner.events
          .getBacklog(sessionId)
          .filter((entry) => entry.event.type === 'agent_end').length;
        if (agentEnds >= ordinal) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`timed out waiting for turn "${messageId}" to complete`);
    },
    backlog() {
      return runner.events.getBacklog(sessionId).map((entry) => entry.event);
    },
    /** Number of streamFn calls made so far -- used to observe queue ordering directly. */
    callCount(): number {
      return callIndex;
    },
    /** Scripts the next raw streamFn call — used to drive generateStyledReply directly. */
    scriptReply(responder: Responder): void {
      responders.push(responder);
    },
    /**
     * A gated responder: the stream is only produced once `release()` is
     * called, so it can hold a two-step reply pass open mid-flight to
     * exercise queue-chaining/teardown ordering.
     */
    deferReply(replyText = 'gated reply'): { responder: Responder; release: () => void } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        responder: async () => {
          await gate;
          return createTextResponseStream(replyText);
        },
        release,
      };
    },
    /** Test-only accessor for the private reply-pass method (TS `private` is compile-time only). */
    generateStyledReplyForTest(
      session: RunnerSession,
      draftText: string,
      lastUserMessageText?: string,
    ): Promise<string | null> {
      return (runner as unknown as {
        generateStyledReply(
          session: RunnerSession,
          draftText: string,
          lastUserMessageText: string | undefined,
        ): Promise<string | null>;
      }).generateStyledReply(session, draftText, lastUserMessageText);
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
  // Reasoning-only rewrite must fall back to the draft, never publish reasoning.
  ['real draft', '<think>just reasoning</think>', false],
  // An unclosed reasoning block is still reasoning-only and must be rejected.
  ['real draft', '<think>truncated reasoning that never closes', false],
  // A link re-punctuated in the rewrite is still preserved (no false reject).
  ['see https://example.com/docs. more', 'yo https://example.com/docs now', true],
  // A rewrite that redirects the link to a lookalike host is rejected (not a substring match).
  ['visit https://trusted.example', 'visit https://trusted.example.evil', false],
  // Unclosed/odd fence count in the rewrite is rejected even if >= the draft.
  ['```js\nx\n```', '```js\nx\n```\n```extra', false],
  // A draft URL dropped by the rewrite is rejected.
  ['see https://example.com/docs', 'see the docs', false],
  // A draft URL preserved verbatim is accepted.
  ['see https://example.com/docs', 'check out https://example.com/docs now', true],
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

test('two-step persists one assistant entry: content=reply, thinking=draft', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true);
  await fx.postAndIdle('hi', { responders: [draftTurn('raw draft'), replyTurn('styled reply')] });
  const entries = (await fx.runner.listSessionLogEntries(fx.session.spec.sessionId))
    .filter((e) => e.role === 'assistant');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.content, 'styled reply');
  assert.equal(entries[0]!.thinking, 'raw draft');
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

test('two-step: A text_final precedes any B event', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true);
  const gate = fx.deferReply('A reply');

  const a = fx.post('A message', { responders: [draftTurn('A draft'), gate.responder] });
  // Wait for A's draft turn to finish and its reply pass to reach (and
  // block on) the gated streamFn call -- exactly 2 calls made so far.
  // Time-bound (not iteration-bound): the real DB round trips in
  // postMessage/refreshAgentConfiguration take a variable amount of wall
  // clock time under load.
  const draftDeadline = Date.now() + 5000;
  while (fx.callCount() < 2 && Date.now() < draftDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fx.callCount(), 2, 'expected A draft + gated A reply call before B is posted');

  const b = fx.post('B message', { responders: [draftTurn('B draft'), replyTurn('B reply')] });
  // Give B's queued turn real wall-clock time to attempt running while A's
  // reply pass is still gated open. Without chaining the next turn on
  // session.pendingReplyPass, nothing stops B's draft from starting here,
  // which would bump the call count to 3.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fx.callCount(), 2, "B's draft must not start until A's reply pass settles");

  gate.release();
  await Promise.all([a, b]);

  const backlog = fx.backlog();
  const idxAFinal = backlog.findIndex(
    (e) => e.type === 'text_final' && (e as { text: string }).text === 'A reply',
  );
  const idxBFirst = backlog.findIndex(
    (e) => 'correlationId' in e && (e as { correlationId?: string }).correlationId === 'msg-2',
  );
  assert.notEqual(idxAFinal, -1);
  assert.notEqual(idxBFirst, -1);
  assert.ok(idxAFinal < idxBFirst, `expected A's text_final (${idxAFinal}) before B's first event (${idxBFirst})`);
});

test('two-step: reply pass is awaited at teardown, not orphaned', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();
  const config = await security.readConfig();
  await security.writeConfig({ ...config, experiments: { two_step: { enabled: true } } });

  const responders: Responder[] = [];
  let callIndex = 0;
  const streamFn: StreamFn = async () => {
    const responder = responders[callIndex];
    callIndex += 1;
    if (!responder) {
      throw new Error(`Unexpected stream call #${callIndex}`);
    }
    return responder();
  };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  responders.push(
    () => createTextResponseStream('teardown draft'),
    async () => {
      await gate;
      return createTextResponseStream('teardown reply');
    },
  );

  const runner = await AgentRunner.create({ workspace, security, streamFn });
  const sessionId = `schedule:teardown-${randomBytes(4).toString('hex')}`;

  const teardown = runner.runScheduledJob(
    {
      agentId: security.agentId,
      scheduleId: `sched-${randomBytes(4).toString('hex')}`,
      type: 'once',
      status: 'active',
      prompt: 'run once',
      sessionMode: { kind: 'ephemeral' },
      delivery: { kind: 'silent' },
      policy: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 0,
      consecutiveErrors: 0,
    },
    sessionId,
  );

  // Release the gated reply responder before the teardown sequence
  // (session.queue -> session.sideEffects -> status='inactive') reaches its
  // sideEffects wait -- if the reply pass isn't chained into sideEffects,
  // teardown proceeds without it and the styled reply never lands.
  release();
  await teardown;

  const finals = runner.events
    .getBacklog(sessionId)
    .filter((entry) => entry.event.type === 'text_final')
    .map((entry) => entry.event);
  assert.equal(finals.length, 1);
  assert.equal((finals[0] as { text: string }).text, 'teardown reply');
});

test('two-step: reply pass traces to langfuse under <sid>:reply with twoStep metadata', async (t) => {
  const langfuse = new FakeLangfuseClient();
  const fx = await createTwoStepFixture(t, { langfuse });
  await fx.setFlag(true);
  await fx.postAndIdle('hi', { responders: [draftTurn('raw draft'), replyTurn('styled reply')] });

  const replyTrace = langfuse.traces.find((tr) => tr.body.name === 'openhermit.two_step_reply');
  assert.ok(replyTrace, 'expected a openhermit.two_step_reply trace');
  assert.equal(replyTrace!.body.sessionId, `${fx.sessionId}:reply`);

  const metadata = replyTrace!.client.updates.at(-1)?.metadata as Record<string, unknown> | undefined;
  assert.equal(metadata?.twoStep, true);
  assert.equal(metadata?.draftText, 'raw draft');
  assert.equal(metadata?.replyText, 'styled reply');
  assert.equal(typeof metadata?.rewriteLatencyMs, 'number');
});

test('flag off: no reply-pass trace is created', async (t) => {
  const langfuse = new FakeLangfuseClient();
  const fx = await createTwoStepFixture(t, { langfuse });
  await fx.setFlag(false);
  await fx.postAndIdle('hi', { responders: [draftTurn('raw draft')] });

  assert.equal(langfuse.traces.filter((tr) => tr.body.name === 'openhermit.two_step_reply').length, 0);
});

test('flag off: exact baseline event sequence and call count', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(false);
  // createSequentialStreamFn-style responders throw on an unexpected extra call -- a stray reply pass fails the test
  await fx.postAndIdle('hi', { responders: [draftTurn('answer')] }); // exactly one turn allowed
  const kinds = fx.backlog().map((e) => e.type);
  assert.ok(kinds.includes('text_delta'));
  assert.equal(kinds.filter((k) => k === 'text_final').length, 1);
  assert.ok(!kinds.includes('thinking_delta')); // no gating when off
});

test('two-step: reply pass that overruns the deadline falls back to the draft', async (t) => {
  const fx = await createTwoStepFixture(t);
  await fx.setFlag(true, { reply_timeout_ms: 50 });
  // The reply responder never resolves, so agent.prompt/waitForIdle hangs past
  // the 50ms deadline. generateStyledReply must abort and return null, and the
  // turn must publish the draft rather than stall forever or lose the answer.
  const neverResolves: Responder = () => new Promise(() => {});
  await fx.postAndIdle('hi', { responders: [draftTurn('raw draft'), neverResolves] });
  const finals = fx.backlog().filter((e) => e.type === 'text_final');
  assert.equal(finals.length, 1);
  assert.equal((finals[0] as { text: string }).text, 'raw draft');
});

test('two-step: reply pass honors reply_model and threads the user text + draft into its prompt', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
  });
  await security.load();
  const config = await security.readConfig();
  await security.writeConfig({
    ...config,
    experiments: {
      two_step: {
        enabled: true,
        // Default model is openrouter; the reply pass must route through this
        // anthropic override instead (and its ANTHROPIC_API_KEY resolves).
        reply_model: { provider: 'anthropic', model: 'claude-opus-4-5', max_tokens: 4096 },
      },
    },
  });

  // Capture (model, context) of every streamFn call so we can inspect the
  // second (reply) call: draft = call #1, styled reply = call #2.
  const calls: Array<{ model: { provider?: string; id?: string }; contextText: string }> = [];
  let callIndex = 0;
  const streamFn: StreamFn = async (model, context) => {
    callIndex += 1;
    const contextText = JSON.stringify(context);
    calls.push({ model: model as { provider?: string; id?: string }, contextText });
    return callIndex === 1
      ? createTextResponseStream('raw draft')
      : createTextResponseStream('styled reply');
  };

  const runner = await AgentRunner.create({ workspace, security, streamFn });
  const sessionId = `cli:reply-model-${randomBytes(4).toString('hex')}`;
  await runner.openSession({ sessionId, source: { kind: 'cli', interactive: true } });
  await runner.postMessage(sessionId, { messageId: 'msg-1', text: 'what is up' });
  await runner.waitForSessionIdle(sessionId);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (runner.events.getBacklog(sessionId).some((e) => e.event.type === 'agent_end')) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(calls.length, 2, 'expected a draft call and a reply call');
  const draftCall = calls[0]!;
  const replyCall = calls[1]!;
  assert.equal(draftCall.model.provider, 'openrouter', 'draft uses the base model');
  assert.equal(draftCall.model.id, 'google/gemini-3-flash-preview', 'draft uses the base model id');
  assert.equal(replyCall.model.provider, 'anthropic', 'reply pass uses reply_model override');
  assert.equal(replyCall.model.id, 'claude-opus-4-5', 'reply pass uses the configured reply_model id');
  // buildReplyInput folds the last user message and the draft into the prompt.
  assert.match(replyCall.contextText, /User: what is up/);
  assert.match(replyCall.contextText, /Draft: raw draft/);
});
