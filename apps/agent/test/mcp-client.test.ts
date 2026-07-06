import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { McpServerRecord } from '@openhermit/store';

import { McpClientManager } from '../src/mcp-client.js';

/**
 * Spins up a real MCP server over Streamable HTTP, backed by a `flaky_tool`
 * whose behavior is controlled at runtime via `behavior.mode`. This exercises
 * the actual `StreamableHTTPClientTransport` code path in McpClientManager
 * rather than mocking the transport away.
 */
async function startFlakyMcpServer(): Promise<{
  url: string;
  behavior: { mode: 'ok' | 'fail' };
  close: () => Promise<void>;
}> {
  const behavior: { mode: 'ok' | 'fail' } = { mode: 'ok' };

  // Each reconnect from the client sends a fresh `initialize` request, which
  // a real MCP server treats as a new session. To exercise that faithfully
  // (rather than a single pinned transport that would reject a second
  // initialize), route requests to a transport-per-session-id, mirroring how
  // a real stateful MCP HTTP server is typically wired.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const createSession = (): StreamableHTTPServerTransport => {
    const server = new McpServer({ name: 'flaky-test-server', version: '1.0.0' });
    server.registerTool(
      'flaky_tool',
      { description: 'Returns ok.' },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => sessions.set(sessionId, transport),
    });
    void server.connect(transport);
    return transport;
  };

  // `behavior.mode = 'fail'` simulates a dead/expired upstream session at the
  // transport level (connection reset), which is what actually causes
  // McpClientManager's callTool() promise to reject, as opposed to a tool
  // handler returning `isError: true`, which is a normal in-band result and
  // correctly does NOT tear down the connection.
  const httpServer = http.createServer((req, res) => {
    if (behavior.mode === 'fail') {
      req.destroy();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    const transport = existing ?? createSession();
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind test MCP server');
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    behavior,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test('[BUG REPRO] MCP client never recovers after a tool call fails mid-session', async () => {
  const { url, behavior, close } = await startFlakyMcpServer();
  try {
    const manager = new McpClientManager();
    const record: McpServerRecord = {
      id: 'flaky',
      name: 'Flaky Server',
      description: 'test',
      url,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    await manager.connect(record);
    assert.equal(manager.getStatus()[0]?.status, 'connected');

    const [toolset] = manager.getToolsets();
    const tool = toolset?.tools.find((t) => t.name === 'mcp__flaky__flaky_tool');
    assert.ok(tool, 'expected flaky_tool to be present after connecting');

    // First call succeeds.
    const first = await tool.execute('call-1', {});
    assert.equal((first.content[0] as { text: string }).text, 'ok');

    // Upstream now fails (simulating an expired/dead session on the server side).
    behavior.mode = 'fail';
    const second = await tool.execute('call-2', {});
    assert.match((second.content[0] as { text: string }).text, /MCP tool call failed/);
    assert.equal(manager.getStatus()[0]?.status, 'error');

    // Upstream recovers, but a healthy client should reconnect and let the
    // twin keep using the tool instead of being stuck in 'error' forever.
    behavior.mode = 'ok';
    const third = await tool.execute('call-3', {});
    assert.equal(
      (third.content[0] as { text: string }).text,
      'ok',
      `expected the client to self-heal after upstream recovered, got: ${JSON.stringify(third)}`,
    );
    assert.equal(manager.getStatus()[0]?.status, 'connected');

    await manager.disconnectAll();
  } finally {
    await close();
  }
});

interface CallToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Injects a fake "connected" MCP server state directly into the manager's
 * private connections map, bypassing real network connect/listTools. This
 * lets us exercise adaptTool()/getToolsets() without a live MCP server.
 */
function injectConnectedServer(
  manager: McpClientManager,
  serverId: string,
  toolName: string,
  callTool: (params: CallToolCall) => Promise<unknown>,
): void {
  const connections = (manager as unknown as { connections: Map<string, unknown> }).connections;
  connections.set(serverId, {
    serverId,
    serverName: `${serverId}-name`,
    status: 'connected',
    client: { callTool },
    tools: [{ name: toolName, description: 'a tool', inputSchema: { type: 'object' } }],
  });
}

test('getToolsets forwards agentId/sessionId as _meta on callTool', async () => {
  const manager = new McpClientManager();
  const calls: CallToolCall[] = [];
  injectConnectedServer(manager, 'srv1', 'do_thing', async (params) => {
    calls.push(params);
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  const [toolset] = manager.getToolsets({ agentId: 'a', sessionId: 's' });
  const tool = toolset!.tools[0]!;

  await tool.execute('call-1', { foo: 'bar' });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.arguments, { foo: 'bar' });
  assert.deepEqual(calls[0]!._meta, { agentId: 'a', sessionId: 's' });
  assert.ok(!('agentId' in (calls[0]!.arguments ?? {})));
  assert.ok(!('sessionId' in (calls[0]!.arguments ?? {})));
});

test('getToolsets omits _meta when no ctx is given', async () => {
  const manager = new McpClientManager();
  const calls: CallToolCall[] = [];
  injectConnectedServer(manager, 'srv2', 'do_thing', async (params) => {
    calls.push(params);
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  const [toolset] = manager.getToolsets();
  const tool = toolset!.tools[0]!;

  await tool.execute('call-1', { foo: 'bar' });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.arguments, { foo: 'bar' });
  assert.equal(calls[0]!._meta, undefined);
});

test('getToolsets omits _meta when ctx has no ids', async () => {
  const manager = new McpClientManager();
  const calls: CallToolCall[] = [];
  injectConnectedServer(manager, 'srv3', 'do_thing', async (params) => {
    calls.push(params);
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  const [toolset] = manager.getToolsets({});
  const tool = toolset!.tools[0]!;

  await tool.execute('call-1', {});

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!._meta, undefined);
});
