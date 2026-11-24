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
    type: 'docker',
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

test('exec injects OPENHERMIT_SESSION_ID and OPENHERMIT_AGENT_ID when the context has them', async () => {
  const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
  const ctx = makeContext(rec, { sessionId: 'sess-42', agentId: 'agent-7' });
  const tool = createSandboxExecTool(ctx);
  await tool.execute('tc-1', { command: 'echo hi' });

  assert.equal(rec.ensured, 1);
  assert.deepEqual(rec.lastOpts?.env, {
    OPENHERMIT_SESSION_ID: 'sess-42',
    OPENHERMIT_AGENT_ID: 'agent-7',
  });
});

test('exec omits the env object entirely when there is no session/agent context', async () => {
  const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
  const ctx = makeContext(rec, {});
  const tool = createSandboxExecTool(ctx);
  await tool.execute('tc-1', { command: 'echo hi' });

  assert.equal(rec.lastOpts?.env, undefined);
});

test('exec passes cwd through alongside the session env', async () => {
  const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
  const ctx = makeContext(rec, { sessionId: 'sess-9', agentId: 'agent-9' });
  const tool = createSandboxExecTool(ctx);
  await tool.execute('tc-1', { command: 'ls', cwd: '/home/agent/work' });

  assert.equal(rec.lastOpts?.cwd, '/home/agent/work');
  assert.equal(rec.lastOpts?.env?.OPENHERMIT_SESSION_ID, 'sess-9');
});

test('exec is hard-denied for guests even without a policy store', async () => {
  const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
  const ctx = makeContext(rec, { sessionId: 'sess-g', agentId: 'agent-g', currentUserRole: 'guest' });
  const tool = createSandboxExecTool(ctx);

  await assert.rejects(
    () => tool.execute('tc-1', { command: 'echo hi' }),
    /exec is not available to guest users/,
  );
  // The guest block sits above the backend: nothing was ensured or executed.
  assert.equal(rec.ensured, 0);
  assert.equal(rec.lastCommand, undefined);
});

test('exec allows non-guest roles (owner) through the guest gate', async () => {
  const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
  const ctx = makeContext(rec, { sessionId: 'sess-o', agentId: 'agent-o', currentUserRole: 'owner' });
  const tool = createSandboxExecTool(ctx);
  await tool.execute('tc-1', { command: 'echo hi' });

  assert.equal(rec.ensured, 1);
  assert.equal(rec.lastCommand, 'echo hi');
});

test('exec authorizes and runs the same normalized cwd', async () => {
  const rec: Recorder = { ensured: 0, lastCommand: undefined, lastOpts: undefined };
  const denyRow = {
    effect: 'deny',
    scope: { sandbox: 'default', command: '*', cwd: '/home/agent/secrets' },
    grants: [{ type: 'any' }],
  };
  const ctx = makeContext(rec, {
    agentId: 'agent-c',
    currentUserId: 'usr-o',
    currentUserRole: 'owner',
    policyStore: { list: async () => [denyRow] } as never,
  });
  const tool = createSandboxExecTool(ctx);

  // Both a dot-dot path and a relative path land in the denied directory,
  // so policy must see them there (not as raw strings) and refuse.
  for (const cwd of ['/home/agent/work/../secrets', 'secrets', './secrets/keys']) {
    await assert.rejects(() => tool.execute('tc-1', { command: 'ls', cwd }), /Access denied/, cwd);
  }
  assert.equal(rec.lastCommand, undefined);

  // An allowed cwd is executed exactly as it was evaluated.
  await tool.execute('tc-1', { command: 'ls', cwd: 'work/./sub/../proj' });
  assert.equal(rec.lastOpts?.cwd, '/home/agent/work/proj');
});
