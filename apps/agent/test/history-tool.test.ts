import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MessageRow, StoreScope } from '@openhermit/store';

import { createHistoryToolset } from '../src/tools/history.js';
import type { ToolContext } from '../src/tools/shared.js';

const scope: StoreScope = { agentId: 'agent-1' };

const makeContext = (
  calls: Array<{ scope: StoreScope; sessionId: string; limit: number; offset: number | undefined }>,
  rows: MessageRow[],
): ToolContext => ({
  security: {} as ToolContext['security'],
  storeScope: scope,
  sessionId: 'session-1',
  messageStore: {
    listRecentMessages: async (
      s: StoreScope,
      sessionId: string,
      limit: number,
      offset?: number,
    ) => {
      calls.push({ scope: s, sessionId, limit, offset });
      return rows;
    },
  } as unknown as ToolContext['messageStore'],
});

test('createHistoryToolset exposes a fetch_full_history tool', () => {
  const toolset = createHistoryToolset(makeContext([], []));
  assert.equal(toolset.id, 'history');
  const tool = toolset.tools.find((t) => t.name === 'fetch_full_history');
  assert.ok(tool, 'fetch_full_history tool is registered');
});

test('fetch_full_history passes limit/offset through to listRecentMessages', async () => {
  const calls: Array<{ scope: StoreScope; sessionId: string; limit: number; offset: number | undefined }> = [];
  const rows: MessageRow[] = [
    { role: 'user', content: 'first older message', ts: '2026-07-01T00:00:00.000Z' },
    { role: 'assistant', content: 'second older message', ts: '2026-07-01T00:00:01.000Z' },
  ];
  const toolset = createHistoryToolset(makeContext(calls, rows));
  const tool = toolset.tools.find((t) => t.name === 'fetch_full_history')!;

  const result = await tool.execute('call-1', { limit: 50, offset: 0 });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { scope, sessionId: 'session-1', limit: 50, offset: 0 });

  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  assert.ok(text.includes('first older message'));
  assert.ok(text.includes('second older message'));
});

test('fetch_full_history defaults to limit 50 offset 0', async () => {
  const calls: Array<{ scope: StoreScope; sessionId: string; limit: number; offset: number | undefined }> = [];
  const toolset = createHistoryToolset(makeContext(calls, []));
  const tool = toolset.tools.find((t) => t.name === 'fetch_full_history')!;

  await tool.execute('call-2', {});

  assert.equal(calls[0]!.limit, 50);
  assert.equal(calls[0]!.offset, 0);
});
