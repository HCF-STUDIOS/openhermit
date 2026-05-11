import { Type, type Static } from '@mariozechner/pi-ai';
import type { McpServerStore } from '@openhermit/store';

import type { McpClientManager } from '../mcp-client.js';
import { type PolicyAwareTool, asTextContent, formatJson, type Toolset } from './shared.js';

const McpEnableParams = Type.Object({
  serverId: Type.String({ description: 'The ID of the MCP server to enable.' }),
});

const McpDisableParams = Type.Object({
  serverId: Type.String({ description: 'The ID of the MCP server to disable.' }),
});

export const createMcpStatusTool = (
  mcpClientManager: McpClientManager,
): PolicyAwareTool<any> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'mcp_status',
  label: 'MCP Status',
  description: 'View the connection status of all MCP servers, including available tools and errors.',
  parameters: Type.Object({}),
  execute: async () => {
    const status = mcpClientManager.getStatus();
    if (status.length === 0) {
      return { content: asTextContent('No MCP servers configured.'), details: {} };
    }
    return { content: asTextContent(formatJson(status)), details: {} };
  },
});

export const createMcpEnableTool = (
  mcpClientManager: McpClientManager,
  mcpServerStore: McpServerStore,
  agentId: string,
): PolicyAwareTool<typeof McpEnableParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'mcp_enable',
  label: 'MCP Enable',
  description: 'Enable and connect an MCP server for this agent. The server must already be registered in the system.',
  parameters: McpEnableParams,
  execute: async (_toolCallId, args: Static<typeof McpEnableParams>) => {
    const server = await mcpServerStore.get(args.serverId);
    if (!server) {
      return { content: asTextContent(`MCP server "${args.serverId}" not found.`), details: {} };
    }
    await mcpServerStore.enable(agentId, args.serverId);
    await mcpClientManager.connect(server);
    const status = mcpClientManager.getStatus().find((s) => s.serverId === args.serverId);
    return { content: asTextContent(formatJson(status ?? { serverId: args.serverId, status: 'unknown' })), details: {} };
  },
});

export const createMcpDisableTool = (
  mcpClientManager: McpClientManager,
  mcpServerStore: McpServerStore,
  agentId: string,
): PolicyAwareTool<typeof McpDisableParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'mcp_disable',
  label: 'MCP Disable',
  description: 'Disable and disconnect an MCP server for this agent.',
  parameters: McpDisableParams,
  execute: async (_toolCallId, args: Static<typeof McpDisableParams>) => {
    await mcpClientManager.disconnect(args.serverId);
    await mcpServerStore.disable(agentId, args.serverId);
    return { content: asTextContent(`MCP server "${args.serverId}" disabled and disconnected.`), details: {} };
  },
});

export const createMcpManagementToolset = (
  mcpClientManager: McpClientManager,
  mcpServerStore: McpServerStore,
  agentId: string,
): Toolset => ({
  id: 'mcp_management',
  description: 'Tools for managing MCP server connections.',
  tools: [
    createMcpStatusTool(mcpClientManager),
    createMcpEnableTool(mcpClientManager, mcpServerStore, agentId),
    createMcpDisableTool(mcpClientManager, mcpServerStore, agentId),
  ],
});

export const createMcpStatusOnlyToolset = (
  mcpClientManager: McpClientManager,
): Toolset => ({
  id: 'mcp_management',
  description: 'Tools for viewing MCP server connection status.',
  tools: [
    createMcpStatusTool(mcpClientManager),
  ],
});
