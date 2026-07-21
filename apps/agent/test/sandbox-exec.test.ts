import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSandboxExecTool } from '../src/tools/sandbox-exec.js';
import { ExecBackendManager, type ExecBackend, type ExecOpts, type ExecResult } from '../src/core/index.js';
import type { ToolContext } from '../src/tools/shared.js';

interface Recorder {
  lastCommand: string | undefined;
  lastOpts: ExecOpts | undefined;
  ensured: number;
}

function makeBackend(rec: Recorder): ExecBackend {
  return {
    id: 'default',
    type: 'host',
    label: 'test',
    username: 'tester',
    agentHome: '/home/agent',
    ensure: async () => { rec.ensured += 1; },
    exec: async (command: string, opts?: ExecOpts): Promise<ExecResult> => {
      rec.lastCommand = command;
      rec.lastOpts = opts;
      return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 };
    },
    syncSkills: async () => {},
    shutdown: async () => {},
    files: {
      read: async () => { throw new Error('not used'); },
      write: async () => { throw new Error('not used'); },
      list: async () => [],
      stat: async () => null,
      delete: async () => { throw new Error('not used'); },
    },
  };
}

function makeContext(rec: Recorder, over: Partial<ToolContext>): ToolContext {
  const mgr = new ExecBackendManager([makeBackend(rec)]);
  return {
    execBackendManager: mgr,
    ...over,
  } as unknown as ToolContext;
}

test('exec injects AMIKO_SESSION_ID and AMIKO_AGENT_ID when the context has them', async () => {
  const prev = process.env.AMIKO_AUTO_APPROVE_LIMIT;
  delete process.env.AMIKO_AUTO_APPROVE_LIMIT;
  try {
    const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
    const ctx = makeContext(rec, { sessionId: 'sess-42', agentId: 'agent-7' });
    const tool = createSandboxExecTool(ctx);
    await tool.execute('tc-1', { command: 'echo hi' });

    assert.equal(rec.ensured, 1);
    assert.deepEqual(rec.lastOpts?.env, {
      AMIKO_SESSION_ID: 'sess-42',
      AMIKO_AGENT_ID: 'agent-7',
    });
  } finally {
    if (prev === undefined) delete process.env.AMIKO_AUTO_APPROVE_LIMIT;
    else process.env.AMIKO_AUTO_APPROVE_LIMIT = prev;
  }
});

test('exec omits the env object entirely when there is no session/agent context', async () => {
  const prev = process.env.AMIKO_AUTO_APPROVE_LIMIT;
  delete process.env.AMIKO_AUTO_APPROVE_LIMIT;
  try {
    const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
    const ctx = makeContext(rec, {});
    const tool = createSandboxExecTool(ctx);
    await tool.execute('tc-1', { command: 'echo hi' });

    assert.equal(rec.lastOpts?.env, undefined);
  } finally {
    if (prev !== undefined) process.env.AMIKO_AUTO_APPROVE_LIMIT = prev;
  }
});

test('exec forwards AMIKO_AUTO_APPROVE_LIMIT from process env', async () => {
  const prev = process.env.AMIKO_AUTO_APPROVE_LIMIT;
  process.env.AMIKO_AUTO_APPROVE_LIMIT = '5.00';
  try {
    const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
    const ctx = makeContext(rec, { sessionId: 'sess-1', agentId: 'agent-1' });
    const tool = createSandboxExecTool(ctx);
    await tool.execute('tc-1', { command: 'echo hi' });

    assert.deepEqual(rec.lastOpts?.env, {
      AMIKO_SESSION_ID: 'sess-1',
      AMIKO_AGENT_ID: 'agent-1',
      AMIKO_AUTO_APPROVE_LIMIT: '5.00',
    });
  } finally {
    if (prev === undefined) delete process.env.AMIKO_AUTO_APPROVE_LIMIT;
    else process.env.AMIKO_AUTO_APPROVE_LIMIT = prev;
  }
});

test('exec forwards AMIKO_AUTO_APPROVE_LIMIT even without a session context', async () => {
  const prev = process.env.AMIKO_AUTO_APPROVE_LIMIT;
  process.env.AMIKO_AUTO_APPROVE_LIMIT = '2.50';
  try {
    const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
    const ctx = makeContext(rec, {});
    const tool = createSandboxExecTool(ctx);
    await tool.execute('tc-1', { command: 'echo hi' });

    assert.deepEqual(rec.lastOpts?.env, { AMIKO_AUTO_APPROVE_LIMIT: '2.50' });
  } finally {
    if (prev === undefined) delete process.env.AMIKO_AUTO_APPROVE_LIMIT;
    else process.env.AMIKO_AUTO_APPROVE_LIMIT = prev;
  }
});

test('exec passes cwd through alongside the session env', async () => {
  const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
  const ctx = makeContext(rec, { sessionId: 'sess-9', agentId: 'agent-9' });
  const tool = createSandboxExecTool(ctx);
  await tool.execute('tc-1', { command: 'ls', cwd: '/home/agent/work' });

  assert.equal(rec.lastOpts?.cwd, '/home/agent/work');
  assert.equal(rec.lastOpts?.env?.AMIKO_SESSION_ID, 'sess-9');
});
