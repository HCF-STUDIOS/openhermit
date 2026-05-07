# MCP Servers

MCP servers add executable external tools to an agent. Skills are prompt assets; MCP servers are live tool providers.

## Data Model

| Table | Purpose |
|-------|---------|
| `mcp_servers` | id, name, description, URL, headers, metadata |
| `agent_mcp_servers` | enabled assignment for `agent_id` or global `*` |

## Runtime

`AgentRunner` creates an `McpClientManager` when MCP stores are available. Connections are kicked off asynchronously — `connectAll()` is fire-and-forget so runner hydration never blocks on a slow or broken MCP server. Tools surface as each connection completes; a call against a still-connecting server returns `"MCP server … is still connecting. Try again in a moment."` Tool discovery is cached in the manager, and shutdown disconnects all clients.

Failure to connect one MCP server does not prevent the agent from running. Per-server status (`connecting` / `connected` / `disconnected` / `error`) is surfaced through `mcp_status` and the gateway UI/API.

MCP tools are namespaced:

```text
mcp__{serverId}__{toolName}
```

## Agent Tools

| Tool | Purpose |
|------|---------|
| `mcp_status` | list server connection states and discovered tools |
| `mcp_enable` | enable and connect a server for this agent |
| `mcp_disable` | disable and disconnect a server for this agent |

## Admin API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/mcp-servers` | list servers |
| `GET` | `/api/admin/mcp-servers/assignments` | list assignments |
| `GET` | `/api/admin/mcp-servers/{id}` | get one server |
| `POST` | `/api/admin/mcp-servers` | create or upsert a server |
| `DELETE` | `/api/admin/mcp-servers/{id}` | delete a server |
| `POST` | `/api/admin/mcp-servers/{id}/enable` | enable for `agentId` or global `*` |
| `POST` | `/api/admin/mcp-servers/{id}/disable` | disable for `agentId` or global `*` |

## Agent API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/{agentId}/mcp-servers` | list effective servers for an agent |
| `POST` | `/api/agents/{agentId}/mcp-servers/{serverId}/enable` | enable for agent |
| `POST` | `/api/agents/{agentId}/mcp-servers/{serverId}/disable` | disable for agent |

Agent API routes require owner or admin auth.

## Server Definition

```json
{
  "id": "github",
  "name": "GitHub",
  "description": "GitHub MCP tools",
  "url": "https://example.com/mcp",
  "headers": {
    "Authorization": "Bearer $TOKEN"
  },
  "metadata": {}
}
```

Headers are persisted as JSON. Store sensitive values in deployment secrets where possible.
