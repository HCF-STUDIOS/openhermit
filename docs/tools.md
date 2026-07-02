# Tools

OpenHermit builds toolsets per turn from available runtime capabilities and the resolved user role. Tools are wrapped by the approval gate according to the agent's security policy (`agents.security_json`).

## Built-In Tools

| Tool | Purpose |
|------|---------|
| `exec` | Run a shell command through the configured exec backend |
| `file_read` | Read a file by absolute path (supports line ranges via `offset`/`limit`, base64 for binary; 5 MiB cap) |
| `file_write` | Write a file (`overwrite` / `create` / `append` modes; auto-creates parent dirs) |
| `file_edit` | Find-and-replace text in a file (exact match, optional `replace_all`) |
| `file_list` | List directory entries (files + subdirectories) |
| `file_stat` | Stat a path: type, size, mtime (returns null if missing) |
| `file_delete` | Delete a single file (no recursive) |
| `web_search` | Search the web through the configured web provider |
| `web_fetch` | Fetch and extract web page content |
| `memory_get` | Read one memory by ID |
| `memory_list` | List memories by prefix |
| `memory_recall` | Search memories |
| `memory_add` | Create or replace a memory |
| `memory_update` | Update memory content/metadata |
| `memory_delete` | Delete a memory |
| `instruction_update` | Update an instruction key |
| `user_list` | List users, roles, and identities |
| `user_identity_link` | Link an identity to a user (owner) |
| `user_identity_unlink` | Remove an identity link (owner) |
| `user_role_set` | Set a user's role for the agent (owner) |
| `user_merge` | Merge one user into another (owner) |
| `identity_link_request` | Issue a short-lived token for cross-channel identity linking (any role) |
| `identity_link_confirm` | Redeem a link token from a different channel to join identities (any role) |
| `session_list` | List sessions (who it's with, type, canSend) — filter by channel/type/user_id/search, paginate, newest first |
| `session_read` | Read session history |
| `session_summary` | Read description, working memory, and recent activity |
| `session_send` | Send a proactive message through a connected channel |
| `schedule_list` | List schedules |
| `schedule_create` | Create cron or once schedules |
| `schedule_update` | Update schedule status/prompt/timing |
| `schedule_delete` | Delete a schedule |
| `schedule_trigger` | Run a schedule immediately |
| `schedule_runs` | List schedule run history |
| `mcp_status` | Show MCP connection/tool status |
| `mcp_enable` | Enable/connect an MCP server for this agent |
| `mcp_disable` | Disable/disconnect an MCP server for this agent |

Introspection-only tools:

- `working_memory_update`
- `session_description_update`

Connected MCP server tools are exposed as:

```text
mcp__{serverId}__{toolName}
```

## Runtime Requirements

| Tool area | Required capability |
|-----------|---------------------|
| exec | `agentId`, workspace, `ExecBackendManager` |
| file | `agentId`, workspace, `ExecBackendManager` (delegates to `FileBackend` on the exec backend) |
| web | configured web provider |
| memory | `memoryProvider` |
| instruction | `instructionStore` |
| users (owner) | `userStore`, owner role |
| identity link (any) | `userStore`, `currentUserId`, `currentChannel`, `currentChannelUserId` |
| sessions | `sessionStore` |
| schedules | `scheduleStore` |
| session_send | matching channel outbound adapter |
| MCP management | `McpClientManager` and MCP store |

## Access Policy

Tool access is controlled by the unified policy model (see [access-policy.md](./access-policy.md)). Each tool declares a `ToolPolicy` with `defaultGrants`. DB policy rows override defaults per-agent.

Tools whose `evaluateAccess` returns `deny` for the calling principal are excluded from the tool list — the agent never sees them.

### Default access by role

| Role | Typical tool access |
|------|-------------|
| `owner` | all tools |
| `user` | file read/list/stat, memory, web, sessions, identity link |
| `guest` | web, identity link (all else denied by default) |

Owners can widen or narrow any tool's access via policy rows or the Policies admin tab.

## Approval

When a policy row has `effect: 'require_approval'`, the system supports two modes:

- **Real-time**: owner is in an interactive session → inline approve/reject UI prompt (ApprovalGate).
- **Async**: owner is on a different channel → `ApprovalRequest` persisted, owner notified via configured channel (e.g. Telegram) with approve/reject buttons. The agent stops and tells the user to wait.

Approved requests are cached with a TTL (default 60 minutes). Owners can grant `persistent` approval to auto-create a permanent allow policy row.

See [access-policy.md](./access-policy.md) for full details on the approval flow and policy configuration.
