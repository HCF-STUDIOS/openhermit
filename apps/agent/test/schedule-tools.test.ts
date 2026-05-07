import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ValidationError } from '@openhermit/shared';
import type { ScheduleRecord, ScheduleRunRecord, ScheduleStore, StoreScope } from '@openhermit/store';

import { createScheduleToolset } from '../src/tools/schedule.js';
import type { ToolContext } from '../src/tools/shared.js';
import { createSecurityFixture } from './helpers.js';

// ── Helpers ────────────────────────────────────────────────────────

const getFirstText = (result: { content: Array<{ type: string; text?: string }> }): string => {
  const first = result.content.find((entry) => entry.type === 'text');
  return typeof first?.text === 'string' ? first.text : '';
};

const makeRecord = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  agentId: 'test-agent',
  scheduleId: 'sched-1',
  type: 'cron',
  status: 'active',
  cronExpression: '0 9 * * *',
  prompt: 'do something',
  delivery: { kind: 'silent' },
  policy: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  runCount: 0,
  consecutiveErrors: 0,
  ...overrides,
});

const makeRunRecord = (overrides: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord => ({
  id: 1,
  agentId: 'test-agent',
  scheduleId: 'sched-1',
  sessionId: 'schedule:sched-1',
  prompt: 'do something',
  status: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  durationMs: 60000,
  ...overrides,
});

const createMockStore = (overrides: Partial<ScheduleStore> = {}): ScheduleStore => ({
  create: async (_scope, input) => makeRecord({ ...input } as Partial<ScheduleRecord>),
  get: async (_scope, id) => makeRecord({ scheduleId: id }),
  list: async () => [],
  listDue: async () => [],
  listAllDue: async () => [],
  listAllOrphanedCron: async () => [],
  update: async (_scope, id, input) => makeRecord({ scheduleId: id, ...(input as Partial<ScheduleRecord>) }),
  delete: async () => {},
  markRun: async () => {},
  setNextRun: async () => {},
  startRun: async () => makeRunRecord(),
  finishRun: async () => makeRunRecord(),
  listRuns: async () => [],
  ...overrides,
});

const scope: StoreScope = { agentId: 'test-agent' };

const setupContext = async (
  t: import('node:test').TestContext,
  storeOverrides: Partial<ScheduleStore> = {},
  extra: Partial<ToolContext> = {},
): Promise<{ context: ToolContext; tools: ReturnType<typeof createScheduleToolset>['tools'] }> => {
  const { security } = await createSecurityFixture(t, {
  });
  await security.load();

  const context: ToolContext = {
    security,
    scheduleStore: createMockStore(storeOverrides),
    storeScope: scope,
    ...extra,
  };
  const { tools } = createScheduleToolset(context);
  return { context, tools };
};

const findTool = (tools: ReturnType<typeof createScheduleToolset>['tools'], name: string) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `Tool "${name}" not found`);
  return tool;
};

// ── Tests ──────────────────────────────────────────────────────────

test('schedule_list returns empty list', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_list');
  const result = await tool.execute('call-1', {});
  assert.ok(getFirstText(result).includes('No schedules found'));
});

test('schedule_list returns formatted schedules', async (t) => {
  const { tools } = await setupContext(t, {
    list: async () => [makeRecord(), makeRecord({ scheduleId: 'sched-2', type: 'once', runAt: '2026-06-01T00:00:00Z' })],
  });
  const tool = findTool(tools, 'schedule_list');
  const result = await tool.execute('call-1', {});
  const text = getFirstText(result);
  assert.ok(text.includes('sched-1'));
  assert.ok(text.includes('sched-2'));
});

test('schedule_create with cron type succeeds', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_create');
  const result = await tool.execute('call-1', {
    type: 'cron',
    prompt: 'check email',
    cron_expression: '0 9 * * *',
  });
  assert.ok(getFirstText(result).includes('Schedule created'));
});

test('schedule_create with once type succeeds', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_create');
  const result = await tool.execute('call-1', {
    type: 'once',
    prompt: 'remind me',
    run_at: '2026-06-01T09:00:00Z',
  });
  assert.ok(getFirstText(result).includes('Schedule created'));
});

test('schedule_create cron without cron_expression throws ValidationError', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_create');
  await assert.rejects(
    () => tool.execute('call-1', { type: 'cron', prompt: 'test' }),
    ValidationError,
  );
});

test('schedule_create once without run_at throws ValidationError', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_create');
  await assert.rejects(
    () => tool.execute('call-1', { type: 'once', prompt: 'test' }),
    ValidationError,
  );
});

test('schedule_create does NOT pass sessionMode', async (t) => {
  let capturedInput: Record<string, unknown> = {};
  const { tools } = await setupContext(t, {
    create: async (_scope, input) => {
      capturedInput = input as Record<string, unknown>;
      return makeRecord();
    },
  });
  const tool = findTool(tools, 'schedule_create');
  await tool.execute('call-1', { type: 'cron', prompt: 'test', cron_expression: '0 * * * *' });
  assert.equal(capturedInput.sessionMode, undefined, 'create input should not have sessionMode');
});

test('schedule_create with delivery config passes through correctly', async (t) => {
  let capturedInput: Record<string, unknown> = {};
  const { tools } = await setupContext(t, {
    create: async (_scope, input) => {
      capturedInput = input as Record<string, unknown>;
      return makeRecord({ delivery: { kind: 'session', sessionId: 'sess-abc' } });
    },
  });
  const tool = findTool(tools, 'schedule_create');
  await tool.execute('call-1', {
    type: 'cron',
    prompt: 'test',
    cron_expression: '0 * * * *',
    delivery: { session: 'sess-abc' },
  });
  assert.deepEqual(capturedInput.delivery, { kind: 'session', sessionId: 'sess-abc' });
});

test('schedule_update succeeds', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_update');
  const result = await tool.execute('call-1', { id: 'sched-1', status: 'paused' });
  assert.ok(getFirstText(result).includes('Schedule updated'));
});

test('schedule_update for nonexistent schedule throws ValidationError', async (t) => {
  const { tools } = await setupContext(t, {
    get: async () => undefined,
  });
  const tool = findTool(tools, 'schedule_update');
  await assert.rejects(
    () => tool.execute('call-1', { id: 'nope' }),
    ValidationError,
  );
});

test('schedule_delete succeeds', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_delete');
  const result = await tool.execute('call-1', { id: 'sched-1' });
  assert.ok(getFirstText(result).includes('Schedule deleted'));
});

test('schedule_delete for nonexistent schedule throws ValidationError', async (t) => {
  const { tools } = await setupContext(t, {
    get: async () => undefined,
  });
  const tool = findTool(tools, 'schedule_delete');
  await assert.rejects(
    () => tool.execute('call-1', { id: 'nope' }),
    ValidationError,
  );
});

test('schedule_trigger succeeds', async (t) => {
  const { tools } = await setupContext(t);
  const tool = findTool(tools, 'schedule_trigger');
  const result = await tool.execute('call-1', { id: 'sched-1' });
  assert.ok(getFirstText(result).includes('triggered'));
});

test('schedule_runs returns run history', async (t) => {
  const { tools } = await setupContext(t, {
    listRuns: async () => [makeRunRecord(), makeRunRecord({ id: 2, status: 'failed', error: 'timeout' })],
  });
  const tool = findTool(tools, 'schedule_runs');
  const result = await tool.execute('call-1', { id: 'sched-1' });
  const text = getFirstText(result);
  assert.ok(text.includes('completed'));
  assert.ok(text.includes('timeout'));
});

test('schedule_create throws when no scheduleStore configured', async (t) => {
  const { security } = await createSecurityFixture(t, {});
  await security.load();
  const context: ToolContext = { security, storeScope: scope };
  const { tools } = createScheduleToolset(context);

  for (const name of ['schedule_create', 'schedule_update', 'schedule_delete', 'schedule_trigger']) {
    const tool = findTool(tools, name);
    const args = name === 'schedule_create'
      ? { type: 'cron', prompt: 'x', cron_expression: '* * * * *' }
      : { id: 'x' };
    await assert.rejects(() => tool.execute('call-1', args), ValidationError);
  }
});

