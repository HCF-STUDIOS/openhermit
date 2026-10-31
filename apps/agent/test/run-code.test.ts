import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRunCodeTool, createRunCodeToolset } from '../src/tools/run-code.js';
import { createBuiltInToolsets } from '../src/tools.js';
import type { ToolContext } from '../src/tools/shared.js';

// --- Fakes ----------------------------------------------------------------

interface ExecCall {
  command: string;
  opts?: { cwd?: string; env?: Record<string, string> };
}

const makeFakeBackend = (sink: { execs: ExecCall[]; writes: { path: string; data: string }[] }) => ({
  id: 'sandbox-default',
  type: 'fake',
  label: 'Fake sandbox',
  username: 'agent',
  agentHome: '/home/agent',
  ensure: async () => {},
  exec: async (command: string, opts?: { cwd?: string; env?: Record<string, string> }) => {
    sink.execs.push({ command, ...(opts ? { opts } : {}) });
    return { stdout: 'hello from program', stderr: '', exitCode: 0, durationMs: 7 };
  },
  files: {
    write: async (path: string, data: Buffer) => {
      sink.writes.push({ path, data: data.toString('utf8') });
    },
  },
  syncSkills: async () => {},
  shutdown: async () => {},
});

const makeContext = (
  backend: ReturnType<typeof makeFakeBackend> | undefined,
  extra: Partial<ToolContext> = {},
): ToolContext =>
  ({
    security: {},
    agentId: 'agent-1',
    sessionId: 'session-1',
    ...(backend
      ? { execBackendManager: { get: (_alias?: string) => backend, list: () => [backend] } }
      : {}),
    ...extra,
  }) as unknown as ToolContext;

// --- Tool execution -------------------------------------------------------

test('run_code: is unavailable without an exec backend', async () => {
  const tool = createRunCodeTool(makeContext(undefined));
  const res = await tool.execute('call-1', { source: 'print(1)' });
  assert.match((res.content[0] as { text: string }).text, /unavailable/i);
});

test('run_code: writes the program and runs it with tsx by default', async () => {
  const sink = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  const tool = createRunCodeTool(makeContext(makeFakeBackend(sink)));
  const res = await tool.execute('call-1', { source: 'console.log("hi")' });

  // Program written under the agent home run-code dir with the .ts extension.
  assert.equal(sink.writes.length, 1);
  assert.match(sink.writes[0]!.path, /^\/home\/agent\/\.openhermit\/run-code\/program-call-1\.ts$/);
  assert.equal(sink.writes[0]!.data, 'console.log("hi")');

  // mkdir -p then tsx run.
  assert.match(sink.execs[0]!.command, /^mkdir -p /);
  assert.match(sink.execs[1]!.command, /npx --yes tsx .*program-call-1\.ts$/);

  const details = res.details as { exitCode: number; language: string; stdout: string };
  assert.equal(details.exitCode, 0);
  assert.equal(details.language, 'typescript');
  assert.equal(details.stdout, 'hello from program');
});

test('run_code: selects the runtime by language', async () => {
  const js = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  await createRunCodeTool(makeContext(makeFakeBackend(js))).execute('c', {
    source: 'x',
    language: 'javascript',
  });
  assert.match(js.execs[1]!.command, /^node .*\.js$/);

  const py = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  await createRunCodeTool(makeContext(makeFakeBackend(py))).execute('c', {
    source: 'x',
    language: 'python',
  });
  assert.match(py.execs[1]!.command, /^python3 .*\.py$/);
});

test('run_code: propagates session/agent identity env to the run', async () => {
  const sink = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  const tool = createRunCodeTool(makeContext(makeFakeBackend(sink)));
  await tool.execute('call-1', { source: 'x' });
  const runCall = sink.execs[1]!;
  assert.equal(runCall.opts?.env?.OPENHERMIT_SESSION_ID, 'session-1');
  assert.equal(runCall.opts?.env?.OPENHERMIT_AGENT_ID, 'agent-1');
  assert.equal(runCall.opts?.cwd, '/home/agent');
});

test('run_code: sanitizes an unsafe tool-call id into the filename', async () => {
  const sink = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  const tool = createRunCodeTool(makeContext(makeFakeBackend(sink)));
  await tool.execute('../../etc/passwd', { source: 'x' });
  assert.match(sink.writes[0]!.path, /program-_+etc_passwd\.ts$/);
  assert.ok(!sink.writes[0]!.path.includes('..'));
});

test('run_code: is owner-gated by default', () => {
  const tool = createRunCodeTool(makeContext(undefined));
  assert.deepEqual(tool.policy?.defaultGrants, [{ type: 'role', value: 'owner' }]);
});

// --- Registry gating ------------------------------------------------------

test('registry: run_code toolset is absent unless codeModeEnabled', () => {
  const sink = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  const ctx = makeContext(makeFakeBackend(sink));
  const toolsets = createBuiltInToolsets(ctx);
  assert.ok(!toolsets.some((ts) => ts.id === 'run_code'), 'run_code should be off by default');
});

test('registry: run_code toolset is present when codeModeEnabled', () => {
  const sink = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  const ctx = makeContext(makeFakeBackend(sink), { codeModeEnabled: true });
  const toolsets = createBuiltInToolsets(ctx);
  assert.ok(toolsets.some((ts) => ts.id === 'run_code'), 'run_code should be registered');
});

test('toolset: shape is well-formed', () => {
  const sink = { execs: [] as ExecCall[], writes: [] as { path: string; data: string }[] };
  const ts = createRunCodeToolset(makeContext(makeFakeBackend(sink)));
  assert.equal(ts.id, 'run_code');
  assert.equal(ts.tools.length, 1);
  assert.equal(ts.tools[0]!.name, 'run_code');
});
