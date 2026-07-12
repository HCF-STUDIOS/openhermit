import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Type } from '@mariozechner/pi-ai';
import type { McpServerRecord } from '@openhermit/store';
import { asTextContent, type PolicyAwareTool, type Toolset } from './tools/shared.js';

export type McpConnectionStatusValue = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Caller context forwarded to MCP servers as request _meta on tool calls. */
export interface McpToolsetCtx {
  agentId?: string;
  sessionId?: string;
}

export interface McpConnectionStatus {
  serverId: string;
  serverName: string;
  status: McpConnectionStatusValue;
  toolCount: number;
  lastError?: string;
  connectedAt?: string;
}

interface McpToolInfo {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
}

interface McpConnectionState {
  serverId: string;
  serverName: string;
  /** Kept so a tool call that finds this connection in 'error' can reconnect. */
  server: McpServerRecord;
  status: McpConnectionStatusValue;
  client?: Client;
  transport?: StreamableHTTPClientTransport;
  tools: McpToolInfo[];
  lastError?: string;
  connectedAt?: string;
  /** Resolves when the in-flight connect attempt for this state finishes (success or error). */
  ready?: Promise<void>;
}

export class McpClientManager {
  private connections = new Map<string, McpConnectionState>();

  /**
   * Start connecting to all servers in parallel. Returns immediately —
   * connections continue in the background. Each server's status moves
   * through `connecting` → `connected` | `error` and is observable via
   * {@link getStatus}. Callers that want to await completion can use
   * {@link connect} per-server or {@link whenAllSettled}.
   */
  connectAll(servers: McpServerRecord[]): void {
    for (const s of servers) void this.connect(s);
  }

  /**
   * Connect (or reconnect) to a single server. Returns a Promise that
   * resolves once the attempt has settled. Errors are captured into the
   * connection state rather than thrown, so `await connect()` never
   * rejects — the caller should inspect {@link getStatus} after.
   */
  async connect(server: McpServerRecord): Promise<void> {
    await this.disconnect(server.id);

    const state: McpConnectionState = {
      serverId: server.id,
      serverName: server.name,
      server,
      status: 'connecting',
      tools: [],
    };
    this.connections.set(server.id, state);

    state.ready = (async () => {
      try {
        const headers: Record<string, string> = {
          ...server.headers,
        };
        const transport = new StreamableHTTPClientTransport(
          new URL(server.url),
          { requestInit: { headers } },
        );
        const client = new Client({ name: 'openhermit', version: '0.2.0' });
        await client.connect(transport as Transport);

        const { tools } = await client.listTools();

        if (this.connections.get(server.id) !== state) return;

        state.client = client;
        state.transport = transport;
        state.status = 'connected';
        state.connectedAt = new Date().toISOString();
        state.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));
      } catch (err) {
        if (this.connections.get(server.id) !== state) return;
        state.status = 'error';
        state.lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] failed to connect to ${server.id}: ${state.lastError}`);
      }
    })();

    await state.ready;
  }

  /** Await all in-flight connection attempts (does not throw). Useful for tests. */
  async whenAllSettled(): Promise<void> {
    await Promise.all([...this.connections.values()].map((s) => s.ready ?? Promise.resolve()));
  }

  async disconnect(serverId: string): Promise<void> {
    const state = this.connections.get(serverId);
    if (!state) return;

    if (state.client) {
      try { await state.client.close(); } catch { /* ignore */ }
    }
    this.connections.delete(serverId);
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  getToolsets(ctx?: McpToolsetCtx): Toolset[] {
    const toolsets: Toolset[] = [];
    for (const state of this.connections.values()) {
      if (state.status !== 'connected' || state.tools.length === 0) continue;

      const tools: PolicyAwareTool[] = state.tools.map((mcpTool) =>
        this.adaptTool(state, mcpTool, ctx),
      );

      toolsets.push({
        id: `mcp__${state.serverId}`,
        description: `Tools from MCP server: ${state.serverName}`,
        tools,
      });
    }
    return toolsets;
  }

  getStatus(): McpConnectionStatus[] {
    return [...this.connections.values()].map((s) => ({
      serverId: s.serverId,
      serverName: s.serverName,
      status: s.status,
      toolCount: s.tools.length,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      ...(s.connectedAt ? { connectedAt: s.connectedAt } : {}),
    }));
  }

  hasServer(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  private adaptTool(
    state: McpConnectionState,
    mcpTool: McpToolInfo,
    ctx?: McpToolsetCtx,
  ): PolicyAwareTool {
    const toolName = `mcp__${state.serverId}__${mcpTool.name}`;
    const meta: Record<string, string> = {};
    if (ctx?.agentId !== undefined) meta.agentId = ctx.agentId;
    if (ctx?.sessionId !== undefined) meta.sessionId = ctx.sessionId;

    return {
      // MCP tools default to owner-only. Owner must explicitly grant
      // wider access via tool/mcp policy rows (per-tool or per-server).
      policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
      name: toolName,
      label: `[${state.serverName}] ${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${state.serverName}`,
      parameters: Type.Unsafe(mcpTool.inputSchema),
      execute: async (_toolCallId, params) => {
        // Re-read the live connection state rather than the one captured when
        // this tool wrapper was built. A prior call may have flipped it to
        // 'error' via a transport failure mid-session. A tool built before
        // that happened would otherwise be stuck referencing a dead client
        // forever with no way to recover.
        let current = this.connections.get(state.serverId) ?? state;

        if (current.status === 'error') {
          // The upstream session may have simply expired. Try once to
          // reconnect before giving up so the agent self-heals instead of
          // requiring an owner to manually run mcp_enable again.
          await this.connect(current.server).catch(() => {});
          current = this.connections.get(state.serverId) ?? current;
        }

        if (current.status === 'connecting') {
          return {
            content: asTextContent(
              `MCP server "${current.serverName}" is still connecting. Try again in a moment.`,
            ),
            details: {},
          };
        }
        if (!current.client || current.status !== 'connected') {
          const detail = current.lastError ? ` (last error: ${current.lastError})` : '';
          return {
            content: asTextContent(`MCP server "${current.serverName}" is not connected${detail}.`),
            details: {},
          };
        }
        try {
          const result = await current.client.callTool({
            name: mcpTool.name,
            arguments: params as Record<string, unknown>,
            ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
          });

          const textParts: string[] = [];
          if (Array.isArray(result.content)) {
            for (const part of result.content) {
              if (part.type === 'text') textParts.push(part.text);
              else if (part.type === 'image') textParts.push(`[image: ${part.mimeType}]`);
              else textParts.push(JSON.stringify(part));
            }
          }

          const text = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(result);
          return {
            content: asTextContent(result.isError ? `Error: ${text}` : text),
            details: {},
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          current.status = 'error';
          current.lastError = msg;
          return {
            content: asTextContent(`MCP tool call failed: ${msg}`),
            details: {},
          };
        }
      },
    };
  }
}
