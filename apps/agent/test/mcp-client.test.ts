import assert from 'node:assert/strict';
import test from 'node:test';

import { McpClientManager } from '../src/mcp-client.js';

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
