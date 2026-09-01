import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleRecord } from '@openhermit/store';

import { AgentRunner, ScheduledRunModelError } from '../src/agent-runner.js';
import {
  awaitTriggeredTurn,
  surfaceRunError,
} from '../src/agent-runner/scheduled-turn.js';

test('awaitTriggeredTurn waits for model completion before resolving', async () => {
  const order: string[] = [];

  await awaitTriggeredTurn(
    async () => {
      order.push('triggered');
      return { triggered: true };
    },
    async () => {
      order.push('completed');
    },
  );

  assert.deepEqual(order, ['triggered', 'completed']);
});

test('awaitTriggeredTurn does not wait when no model turn was triggered', async () => {
  let waited = false;

  await awaitTriggeredTurn(
    async () => ({ triggered: false }),
    async () => {
      waited = true;
    },
  );

  assert.equal(waited, false);
});

test('surfaceRunError rethrows scheduled failures after surfacing them', async () => {
  const error = new Error('402 Insufficient credits');
  let surfaced: unknown;

  await assert.rejects(
    surfaceRunError('schedule', error, async (received) => {
      surfaced = received;
    }),
    error,
  );
  assert.equal(surfaced, error);
});

test('surfaceRunError keeps interactive error handling non-throwing', async () => {
  const error = new Error('provider unavailable');
  let surfaced: unknown;

  await surfaceRunError('channel', error, async (received) => {
    surfaced = received;
  });

  assert.equal(surfaced, error);
});

test('surfaceRunError preserves the scheduled run error when surfacing also fails', async () => {
  const runError = new Error('402 Insufficient credits');
  const surfaceError = new Error('session persistence failed');

  await assert.rejects(
    surfaceRunError('schedule', runError, async () => {
      throw surfaceError;
    }),
    runError,
  );
});

test('surfaceRunError still propagates an interactive surfacing failure', async () => {
  const surfaceError = new Error('session persistence failed');

  await assert.rejects(
    surfaceRunError('channel', new Error('provider unavailable'), async () => {
      throw surfaceError;
    }),
    surfaceError,
  );
});

test('runScheduledJob does not report success before a dedicated turn completes', async () => {
  const schedule: ScheduleRecord = {
    agentId: 'agent-1',
    scheduleId: 'schedule-1',
    type: 'cron',
    status: 'active',
    cronExpression: '* * * * *',
    prompt: 'check credits',
    sessionMode: { kind: 'dedicated' },
    delivery: { kind: 'silent' },
    policy: {},
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    runCount: 0,
    consecutiveErrors: 0,
  };
  const creditError = new Error('402 Insufficient credits');
  const order: string[] = [];
  const fakeRunner = {
    scope: { agentId: 'agent-1' },
    sessions: new Map(),
    bus: {
      transform: async (_event: string, payload: Record<string, unknown>) =>
        payload,
    },
    openSession: async () => {
      order.push('opened');
    },
    postMessage: async () => {
      order.push('queued');
      return { sessionId: 'schedule:schedule-1', triggered: true };
    },
    waitForSessionIdle: async () => {
      order.push('waited');
      throw creditError;
    },
  };

  await assert.rejects(
    (AgentRunner.prototype.runScheduledJob as Function).call(
      fakeRunner,
      schedule,
      'schedule:schedule-1',
    ),
    creditError,
  );
  assert.deepEqual(order, ['opened', 'queued', 'waited']);
});

test('runScheduledJob heals dedicated session.queue after a failed turn', async () => {
  const schedule: ScheduleRecord = {
    agentId: 'agent-1',
    scheduleId: 'schedule-1',
    type: 'cron',
    status: 'active',
    cronExpression: '* * * * *',
    prompt: 'check credits',
    sessionMode: { kind: 'dedicated' },
    delivery: { kind: 'silent' },
    policy: {},
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    runCount: 0,
    consecutiveErrors: 0,
  };
  const creditError = new Error('402 Insufficient credits');
  const sessionId = 'schedule:schedule-1';
  const session = {
    status: 'running',
    queue: Promise.reject(creditError),
  };
  // Avoid unhandled rejection from the pre-seeded rejected queue.
  session.queue.catch(() => undefined);
  const fakeRunner = {
    scope: { agentId: 'agent-1' },
    sessions: new Map([[sessionId, session]]),
    bus: {
      transform: async (_event: string, payload: Record<string, unknown>) =>
        payload,
    },
    openSession: async () => undefined,
    postMessage: async () => ({ sessionId, triggered: true }),
    waitForSessionIdle: async () => {
      throw creditError;
    },
  };

  await assert.rejects(
    (AgentRunner.prototype.runScheduledJob as Function).call(
      fakeRunner,
      schedule,
      sessionId,
    ),
    creditError,
  );

  assert.equal(fakeRunner.sessions.has(sessionId), true);
  await assert.doesNotReject(session.queue);
});

test('runScheduledJob preserves the run error when ephemeral teardown also fails', async () => {
  const schedule: ScheduleRecord = {
    agentId: 'agent-1',
    scheduleId: 'schedule-1',
    type: 'cron',
    status: 'active',
    cronExpression: '* * * * *',
    prompt: 'check credits',
    sessionMode: { kind: 'ephemeral' },
    delivery: { kind: 'silent' },
    policy: {},
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    runCount: 0,
    consecutiveErrors: 0,
  };
  const runError = new Error('402 Insufficient credits');
  const teardownError = new Error('session persistence failed');
  const sessionId = 'schedule:schedule-1:ephemeral';
  const fakeRunner = {
    scope: { agentId: 'agent-1' },
    sessions: new Map([[sessionId, { status: 'running' }]]),
    bus: {
      transform: async (_event: string, payload: Record<string, unknown>) =>
        payload,
      emit: async () => undefined,
    },
    openSession: async () => undefined,
    postMessage: async () => ({ sessionId, triggered: true }),
    waitForSessionIdle: async () => {
      throw runError;
    },
    clearIdleSummaryTimer: () => undefined,
    persistSessionIndex: async () => {
      throw teardownError;
    },
    logRuntime: () => undefined,
  };

  await assert.rejects(
    (AgentRunner.prototype.runScheduledJob as Function).call(
      fakeRunner,
      schedule,
      sessionId,
    ),
    runError,
  );
});

test('runScheduledJob fails a cron run whose turn ended in a model error (in-band, no throw)', async () => {
  // A 402 leaves the turn with stopReason==='error' — the turn "completes"
  // (waitForSessionIdle resolves) but produced no reply. Without surfacing it,
  // the scheduler records success and re-fires at full cadence. lastTurnModelError
  // is what handleAgentEvent stamps on the session at message_end.
  const schedule: ScheduleRecord = {
    agentId: 'agent-1',
    scheduleId: 'schedule-1',
    type: 'cron',
    status: 'active',
    cronExpression: '* * * * *',
    prompt: 'scan feed',
    sessionMode: { kind: 'dedicated' },
    delivery: { kind: 'silent' },
    policy: {},
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    runCount: 0,
    consecutiveErrors: 0,
  };
  const sessionId = 'schedule:schedule-1';
  const session = {
    status: 'running',
    queue: Promise.resolve(),
    lastTurnModelError: { kind: 'quota' as const, message: '402 Insufficient credits' },
  };
  const fakeRunner = {
    scope: { agentId: 'agent-1' },
    sessions: new Map([[sessionId, session]]),
    bus: {
      transform: async (_event: string, payload: Record<string, unknown>) => payload,
    },
    openSession: async () => undefined,
    postMessage: async () => ({ sessionId, triggered: true }),
    // Turn completes normally; the error is in-band, not thrown.
    waitForSessionIdle: async () => undefined,
  };

  await assert.rejects(
    (AgentRunner.prototype.runScheduledJob as Function).call(fakeRunner, schedule, sessionId),
    (err: unknown) => err instanceof ScheduledRunModelError && err.kind === 'quota',
  );
  // Dedicated cron: the queue is healed so later checkpoints aren't skipped.
  await assert.doesNotReject(session.queue);
});

test('runScheduledJob leaves a once run untouched on a model error', async () => {
  // once firings never re-fire, so their completion semantics must not change.
  const schedule = {
    agentId: 'agent-1',
    scheduleId: 'schedule-1',
    type: 'once',
    status: 'active',
    prompt: 'one-shot',
    sessionMode: { kind: 'dedicated' },
    delivery: { kind: 'silent' },
    policy: {},
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    runCount: 0,
    consecutiveErrors: 0,
  } as unknown as ScheduleRecord;
  const sessionId = 'schedule:schedule-1';
  const session = {
    status: 'running',
    lastTurnModelError: { kind: 'quota' as const, message: '402 Insufficient credits' },
  };
  const fakeRunner = {
    scope: { agentId: 'agent-1' },
    sessions: new Map([[sessionId, session]]),
    bus: {
      transform: async (_event: string, payload: Record<string, unknown>) => payload,
      emit: async () => undefined,
    },
    openSession: async () => undefined,
    postMessage: async () => ({ sessionId, triggered: true }),
    waitForSessionIdle: async () => undefined,
    clearIdleSummaryTimer: () => undefined,
    persistSessionIndex: async () => undefined,
  };

  await assert.doesNotReject(
    (AgentRunner.prototype.runScheduledJob as Function).call(fakeRunner, schedule, sessionId),
  );
  // once => teardown drops the in-memory session.
  assert.equal(fakeRunner.sessions.has(sessionId), false);
});

test('runScheduledJob propagates an ephemeral teardown failure after a successful run', async () => {
  const schedule: ScheduleRecord = {
    agentId: 'agent-1',
    scheduleId: 'schedule-1',
    type: 'cron',
    status: 'active',
    cronExpression: '* * * * *',
    prompt: 'check credits',
    sessionMode: { kind: 'ephemeral' },
    delivery: { kind: 'silent' },
    policy: {},
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    runCount: 0,
    consecutiveErrors: 0,
  };
  const teardownError = new Error('session persistence failed');
  const sessionId = 'schedule:schedule-1:ephemeral';
  const fakeRunner = {
    scope: { agentId: 'agent-1' },
    sessions: new Map([[sessionId, { status: 'running' }]]),
    bus: {
      transform: async (_event: string, payload: Record<string, unknown>) =>
        payload,
      emit: async () => undefined,
    },
    openSession: async () => undefined,
    postMessage: async () => ({ sessionId, triggered: true }),
    waitForSessionIdle: async () => undefined,
    clearIdleSummaryTimer: () => undefined,
    persistSessionIndex: async () => {
      throw teardownError;
    },
    logRuntime: () => undefined,
  };

  await assert.rejects(
    (AgentRunner.prototype.runScheduledJob as Function).call(
      fakeRunner,
      schedule,
      sessionId,
    ),
    teardownError,
  );
});
