import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleRecord } from '@openhermit/store';

import { AgentRunner } from '../src/agent-runner.js';
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
