import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backfillSandboxes } from '../src/sandbox-backfill.js';

test('sandbox backfill preserves legacy exec config when any backend is unsupported', async () => {
  const config = {
    model: { provider: 'test' },
    exec: {
      default_backend: 'future',
      backends: [
        { id: 'docker', type: 'docker', image: 'ubuntu:24.04' },
        { id: 'future', type: 'future-provider' },
      ],
    },
  };
  const created: unknown[] = [];
  const writes: unknown[] = [];
  const logs: string[] = [];

  await backfillSandboxes(
    { list: async () => [{ agentId: 'agent-1' }] } as never,
    {
      getConfig: async () => config,
      setConfig: async (_agentId: string, value: unknown) => { writes.push(value); },
    } as never,
    {
      listByAgent: async () => [],
      create: async (value: unknown) => { created.push(value); },
    } as never,
    (message) => logs.push(message),
  );

  assert.deepEqual(created, []);
  assert.deepEqual(writes, []);
  assert.ok(logs.some((message) => message.includes('future-provider')));
});
