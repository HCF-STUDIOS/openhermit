import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import { DbInternalStateStore, standaloneScope } from '@openhermit/store';
import { createBuiltInTools, withApproval } from '../src/tools.js';
import { createFileReadTool } from '../src/tools/file.js';
import { createSessionListTool, createSessionReadTool, createSessionSummaryTool } from '../src/tools/session.js';
import { DefuddleWebProvider } from '../src/web/index.js';
import { ExecBackendManager } from '../src/core/index.js';
import type { ExecBackend } from '../src/core/index.js';
import { createSecurityFixture, createTempDir } from './helpers.js';

const defaultWebProvider = new DefuddleWebProvider();

const getFirstText = (result: {
  content: Array<{ type: string; text?: string }>;
}): string => {
  const first = result.content.find((entry) => entry.type === 'text');
  return typeof first?.text === 'string' ? first.text : '';
};

const findTool = (tools: ReturnType<typeof createBuiltInTools>, name: string) => {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `Tool "${name}" not found in createBuiltInTools`);
  return tool;
};

type FetchImpl = typeof fetch;

const makeFetchMock = (
  status: number,
  body: string,
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): FetchImpl =>
  (async (_url, _init) => {
    const encoder = new TextEncoder();
    return new Response(encoder.encode(body), { status, headers });
  }) as FetchImpl;

const makeFetchError = (message: string): FetchImpl =>
  (async (_url, _init) => {
    throw new Error(message);
  }) as FetchImpl;

const withMockFetch = async (mockFetch: FetchImpl, fn: () => Promise<void>): Promise<void> => {
  const globals = globalThis as typeof globalThis & { fetch: FetchImpl };
  const original = globals.fetch;
  globals.fetch = mockFetch;

  try {
    await fn();
  } finally {
    globals.fetch = original;
  }
};

test('withApproval forwards signal and onUpdate to the wrapped tool', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();

  const Params = Type.Object({
    value: Type.String(),
  });

  let capturedSignal: AbortSignal | undefined;
  let capturedOnUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
  let approvalArgs: unknown;
  const requestedCalls: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
  const startedCalls: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];

  const tool: AgentTool<typeof Params, { status: string }> = {
    name: 'dangerous_tool',
    label: 'Dangerous Tool',
    description: 'Tool used to verify approval forwarding.',
    parameters: Params,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      capturedSignal = signal;
      capturedOnUpdate = onUpdate;
      onUpdate?.({
        content: [{ type: 'text', text: `updating ${args.value}` }],
        details: { status: 'midway' },
      });

      return {
        content: [{ type: 'text', text: `done ${args.value}` }],
        details: { status: 'done' },
      };
    },
  };

  const wrapped = withApproval(
    tool,
    security,
    async (_toolName, _toolCallId, args) => {
      approvalArgs = args;
      return 'approved';
    },
    async (toolName, toolCallId, args) => {
      requestedCalls.push({ toolName, toolCallId, args });
    },
    async (toolName, toolCallId, args) => {
      startedCalls.push({ toolName, toolCallId, args });
    },
  );

  const abortController = new AbortController();
  const updates: Array<{ status: string }> = [];

  const result = await wrapped.execute(
    'call-1',
    { value: 'payload' },
    abortController.signal,
    ((partial) => {
      updates.push(partial.details);
    }) as AgentToolUpdateCallback<{ status: string }>,
  );

  assert.equal(capturedSignal, abortController.signal);
  assert.ok(capturedOnUpdate);
  assert.deepEqual(approvalArgs, { value: 'payload' });
  assert.deepEqual(requestedCalls, [
    {
      toolName: 'dangerous_tool',
      toolCallId: 'call-1',
      args: { value: 'payload' },
    },
  ]);
  assert.deepEqual(startedCalls, [
    {
      toolName: 'dangerous_tool',
      toolCallId: 'call-1',
      args: { value: 'payload' },
    },
  ]);
  assert.deepEqual(updates, [{ status: 'midway' }]);
  assert.deepEqual(result.details, { status: 'done' });
});

// Old test "withApproval distinguishes timeout from explicit rejection" removed:
// The security-based approval flow (autonomy_level + require_approval_for) has been
// replaced by the policy-based require_approval effect + ApprovalRequest flow.

test('memory_add stores entry, memory_recall finds it, and memory_get returns full content', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const memoryProvider = store.memories;
  const tools = createBuiltInTools({
    security,
    memoryProvider,
    storeScope: standaloneScope,
  });
  const addTool = findTool(tools, 'memory_add');
  const getTool = findTool(tools, 'memory_get');
  const recallTool = findTool(tools, 'memory_recall');

  const addResult = await addTool.execute('call-memory-add', {
    key: 'lang-pref',
    content: 'The user prefers TypeScript for new examples.',
    metadata: { title: 'Language preference' },
  });

  const addDetails = addResult.details as Record<string, unknown>;
  assert.equal(addDetails.id, 'lang-pref');

  const recallResult = await recallTool.execute('call-memory-recall', {
    query: 'TypeScript',
    limit: 3,
  });

  const recallText = getFirstText(recallResult);
  assert.match(recallText, /TypeScript/);

  const recallDetails = recallResult.details as Record<string, unknown>;
  assert.equal(recallDetails.query, 'TypeScript');
  assert.equal(recallDetails.count, 1);

  const getResult = await getTool.execute('call-memory-get', {
    key: 'lang-pref',
  });
  const getDetails = getResult.details as Record<string, unknown>;
  assert.equal(getDetails.id, 'lang-pref');
  assert.equal(
    getDetails.content,
    'The user prefers TypeScript for new examples.',
  );
});

test('memory_add creates entries and memory_recall searches them', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const memoryProvider = store.memories;
  const tools = createBuiltInTools({
    security,
    memoryProvider,
    storeScope: standaloneScope,
  });
  const addTool = findTool(tools, 'memory_add');
  const recallTool = findTool(tools, 'memory_recall');

  await addTool.execute('call-memory-add-focus', {
    key: 'current-focus',
    content: 'I am currently working in session:web:abc on the OpenHermit web UI.',
  });
  await addTool.execute('call-memory-add-project', {
    key: 'project/openhermit/plan',
    content: 'Next up: scheduler and identity split.',
  });

  const recallResult = await recallTool.execute('call-memory-recall-search', {
    query: 'scheduler',
  });

  const recallDetails = recallResult.details as Record<string, unknown>;
  assert.equal(recallDetails.count, 1);
  assert.equal(
    (recallDetails.matches as Array<Record<string, unknown>>)[0]?.id,
    'project/openhermit/plan',
  );
});

test('memory_get rejects unknown IDs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const memoryProvider = store.memories;
  const tools = createBuiltInTools({
    security,
    memoryProvider,
    storeScope: standaloneScope,
  });
  const getTool = findTool(tools, 'memory_get');

  await assert.rejects(
    () =>
      getTool.execute('call-memory-get-missing', {
        key: 'project/missing',
      }),
    (error: unknown) =>
      error instanceof ValidationError
      && /Memory not found: project\/missing/.test(error.message),
  );
});

// Old test "memory_add is blocked in readonly mode" removed:
// The readonly autonomy_level has been replaced by policy rows with effect='deny'.

test('web_fetch returns status headers and body for a successful GET', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(
    makeFetchMock(200, 'Hello, world!', { 'content-type': 'text/plain' }),
    async () => {
      const result = await tool.execute('call-web-1', {
        url: 'https://example.com/',
        output: 'raw',
      });

      const text = getFirstText(result);
      assert.match(text, /Hello, world!/);

      const details = result.details as Record<string, unknown>;
      assert.equal(details.url, 'https://example.com/');
      assert.equal(details.output, 'raw');
      assert.equal(details.contentBytes, 13);
      assert.equal(details.truncated, false);
    },
  );
});

// Old test "web_fetch is still wrapped by approval callbacks" removed:
// The security-based approval callback flow has been replaced by policy-based approvals.

test('web_fetch truncates large responses at max_bytes', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const bigBody = 'x'.repeat(500);
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, bigBody), async () => {
    const result = await tool.execute('call-web-3', {
      url: 'https://example.com/big',
      max_bytes: 100,
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.truncated, true);
    assert.equal(details.contentBytes, 500);
    assert.match(getFirstText(result), /truncated/i);
  });
});

test('web_fetch caps max_bytes at the hard 200 KB limit', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, 'small body'), async () => {
    const result = await tool.execute('call-web-4', {
      url: 'https://example.com/',
      max_bytes: 999_999_999,
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.truncated, false);
    assert.match(getFirstText(result), /small body/);
  });
});

test('web_fetch rejects non-http/https URLs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(
    () =>
      tool.execute('call-web-5', {
        url: 'ftp://example.com/file',
        output: 'raw',
      }),
    ValidationError,
  );
});

test('web_fetch rejects malformed URLs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(() =>
    tool.execute('call-web-6', { url: 'not a url at all', output: 'raw' }),
  );
});

test('web_fetch rejects non-positive max_bytes', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(
    () =>
      tool.execute('call-web-7', {
        url: 'https://example.com/',
        max_bytes: 0,
        output: 'raw',
      }),
    ValidationError,
  );
});

test('web_fetch surfaces network errors as thrown exceptions', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchError('ECONNREFUSED'), async () => {
    await assert.rejects(
      () =>
        tool.execute('call-web-8', {
          url: 'https://localhost:9/',
          output: 'raw',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ECONNREFUSED/);
        return true;
      },
    );
  });
});

test('web_fetch returns non-200 status without throwing', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(404, 'Not Found'), async () => {
    const result = await tool.execute('call-web-9', {
      url: 'https://example.com/missing',
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, 404);
    assert.match(getFirstText(result), /Not Found/);
  });
});

test('web_fetch output markdown extracts main content as Markdown', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const tool = findTool(tools, 'web_fetch');

  const html = `
<!DOCTYPE html>
<html>
<head><title>Test Article</title><meta name="author" content="Jane Doe"></head>
<body>
  <nav>Skip</nav>
  <main><article>
    <h1>Test Article</h1>
    <p>Main paragraph content here.</p>
  </article></main>
  <footer>Footer</footer>
</body>
</html>`;

  await withMockFetch(
    makeFetchMock(200, html, { 'content-type': 'text/html; charset=utf-8' }),
    async () => {
      const result = await tool.execute('call-web-defuddle', {
        url: 'https://example.com/article',
        output: 'markdown',
      });

      const details = result.details as Record<string, unknown>;
      assert.equal(details.output, 'markdown');
      assert.equal(details.status, 200);
      assert.ok(
        typeof details.title === 'string' || typeof details.contentBytes === 'number',
        'markdown output returns title or contentBytes',
      );

      const text = getFirstText(result);
      assert.match(text, /Main paragraph content here\./);
    },
  );
});

test('instruction_update stores an entry and verifies via store', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const stateStore = await DbInternalStateStore.open();
  t.after(() => stateStore.close());

  const scope = { agentId: 'agent-test' };
  const tools = createBuiltInTools({
    security,
    instructionStore: stateStore.instructions,
    storeScope: scope,
  });

  const updateTool = findTool(tools, 'instruction_update');
  await updateTool.execute('call-id-1', {
    key: 'identity',
    content: '# IDENTITY\n\nName: TestBot\nRole: A test agent.',
  });

  const entry = await stateStore.instructions.get(scope, 'identity');
  assert.ok(entry);
  assert.match(entry.content, /TestBot/);
});

// Old test "instruction_update is blocked in readonly mode" removed:
// The readonly autonomy_level has been replaced by policy rows with effect='deny'.

// ── Session tool access control tests ──────────────────────────────

test('session_list filters sessions by currentUserId', async (t) => {
  const { security, agentId } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const scope = { agentId };

  // Create two sessions: one with user-A, one with user-B
  const now = new Date().toISOString();
  await store.sessions.upsert(scope, {
    sessionId: 'sess-a',
    source: { kind: 'cli', interactive: true },
    createdAt: now,
    lastActivityAt: now,
    messageCount: 1,
    userIds: ['user-A'],
  });
  await store.sessions.upsert(scope, {
    sessionId: 'sess-only-b',
    source: { kind: 'channel', interactive: true, platform: 'telegram' },
    createdAt: now,
    lastActivityAt: now,
    messageCount: 2,
    userIds: ['user-B'],
  });
  await store.sessions.upsert(scope, {
    sessionId: 'sess-both',
    source: { kind: 'cli', interactive: true },
    createdAt: now,
    lastActivityAt: now,
    messageCount: 3,
    userIds: ['user-A', 'user-B'],
  });

  // user-A should see sess-a and sess-both, not sess-b
  const listTool = createSessionListTool({
    security,
    sessionStore: store.sessions,
    storeScope: scope,
    currentUserId: 'user-A',
  });

  const result = await listTool.execute('call-list-a', {});
  const details = result.details as { count: number; total: number };
  assert.equal(details.count, 2, 'user-A should see 2 sessions');

  const text = getFirstText(result);
  assert.match(text, /sess-a/);
  assert.match(text, /sess-both/);
  assert.ok(!text.includes('sess-only-b'), 'sess-only-b should not be visible to user-A');

  // Owner (no currentUserId) should see all 3
  const ownerListTool = createSessionListTool({
    security,
    sessionStore: store.sessions,
    storeScope: scope,
  });

  const ownerResult = await ownerListTool.execute('call-list-owner', {});
  const ownerDetails = ownerResult.details as { count: number; total: number };
  assert.equal(ownerDetails.count, 3, 'owner should see all 3 sessions');
});

test('session_read denies access when user is not a participant', async (t) => {
  const { security, agentId } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const scope = { agentId };

  const now = new Date().toISOString();
  await store.sessions.upsert(scope, {
    sessionId: 'sess-private',
    source: { kind: 'cli', interactive: true },
    createdAt: now,
    lastActivityAt: now,
    messageCount: 1,
    userIds: ['user-owner'],
  });

  const readTool = createSessionReadTool({
    security,
    sessionStore: store.sessions,
    messageStore: store.messages,
    storeScope: scope,
    currentUserId: 'user-intruder',
  });

  await assert.rejects(
    () => readTool.execute('call-read-denied', { session_id: 'sess-private' }),
    (err: any) => err.message.includes('Access denied'),
    'should reject access for non-participant',
  );
});

test('session_summary denies access when user is not a participant', async (t) => {
  const { security, agentId } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const scope = { agentId };

  const now = new Date().toISOString();
  await store.sessions.upsert(scope, {
    sessionId: 'sess-summary-private',
    source: { kind: 'cli', interactive: true },
    createdAt: now,
    lastActivityAt: now,
    messageCount: 1,
    userIds: ['user-owner'],
  });

  const summaryTool = createSessionSummaryTool({
    security,
    sessionStore: store.sessions,
    messageStore: store.messages,
    storeScope: scope,
    currentUserId: 'user-intruder',
  });

  await assert.rejects(
    () => summaryTool.execute('call-summary-denied', { session_id: 'sess-summary-private' }),
    (err: any) => err.message.includes('Access denied'),
    'should reject access for non-participant',
  );
});

// ── file_read: skill-path bypass ─────────────────────────────────────────

const makeReadOnlyBackend = (agentHome: string, files: Map<string, Buffer>): ExecBackend => ({
  id: 'host',
  type: 'host',
  label: 'host',
  username: 'tester',
  agentHome,
  ensure: async () => {},
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
  syncSkills: async () => {},
  shutdown: async () => {},
  files: {
    read: async (filePath: string) => {
      const data = files.get(filePath);
      if (!data) throw new Error(`fake backend: file not found: ${filePath}`);
      return { data };
    },
    write: async () => { throw new Error('not used'); },
    list: async () => [],
    stat: async () => null,
    delete: async () => { throw new Error('not used'); },
  },
});

test('file_read returns skill-path content verbatim (no line numbers)', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();

  const agentHome = '/home/user';
  const skillPath = `${agentHome}/.openhermit/skills/system/demo/SKILL.md`;
  const skillBody = '---\nname: demo\ndescription: x\n---\n\nline one\nline two\nline three\n';
  const backend = makeReadOnlyBackend(agentHome, new Map([[skillPath, Buffer.from(skillBody, 'utf8')]]));
  const execBackendManager = new ExecBackendManager([backend]);

  const tool = createFileReadTool({ security, execBackendManager });
  const result = await tool.execute('call-skill', { path: skillPath });

  // Content shape is the observable signal that the tool classified this
  // as a skill read internally (skipped line numbering + byte cap). The
  // truncation-bypass decision is owned by agent-runner; covered by
  // `isSkillReadResult` tests in skills.test.ts.
  const text = (result.content[0] as { type: string; text: string }).text;
  assert.equal(text, skillBody, 'skill files are returned without line-number prefixes');

  const details = result.details as { path: string };
  assert.equal(details.path, skillPath);
});

test('file_read on a non-skill path numbers lines', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();

  const agentHome = '/home/user';
  const filePath = `${agentHome}/notes.txt`;
  const body = 'alpha\nbeta\n';
  const backend = makeReadOnlyBackend(agentHome, new Map([[filePath, Buffer.from(body, 'utf8')]]));
  const execBackendManager = new ExecBackendManager([backend]);

  const tool = createFileReadTool({ security, execBackendManager });
  const result = await tool.execute('call-plain', { path: filePath });

  const text = (result.content[0] as { type: string; text: string }).text;
  assert.ok(text.startsWith('1\talpha'), 'non-skill paths still get line-number prefixes');
});

test('file_read does not bypass numbering for paths only superficially matching skills root', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();

  const agentHome = '/home/user';
  // Path contains "/.openhermit/skills/" but resolves outside agentHome via "..".
  // isSkillPath should reject — the bypass must not apply.
  const escapingPath = `${agentHome}/.openhermit/skills/../../etc/passwd`;
  const body = 'root:x:0:0\n';
  const backend = makeReadOnlyBackend(
    agentHome,
    new Map([[escapingPath, Buffer.from(body, 'utf8')]]),
  );
  const execBackendManager = new ExecBackendManager([backend]);

  const tool = createFileReadTool({ security, execBackendManager });
  const result = await tool.execute('call-escape', { path: escapingPath });

  const text = (result.content[0] as { type: string; text: string }).text;
  assert.ok(text.startsWith('1\troot:x:0:0'), 'paths with .. segments are treated as non-skill — line numbers applied');
});
