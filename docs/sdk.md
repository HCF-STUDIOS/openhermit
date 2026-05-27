# `@openhermit/sdk`

TypeScript client for the OpenHermit gateway and agent APIs. Targets external
integrations that need to provision agents, manage their configuration, and
talk to live sessions over HTTP/WS without re-implementing the wire format.

```bash
npm install @openhermit/sdk
```

```ts
import { GatewayClient } from '@openhermit/sdk';

const gw = new GatewayClient({
  baseUrl: 'https://test.openhermit.ai',
  token: process.env.OPENHERMIT_ADMIN_TOKEN,
});

const agents = await gw.listAgents();
```

## Auth model

There are two distinct caller identities. Pick the right token for each call:

- **Admin token** — long-lived value from gateway config. Authorises every
  `/api/admin/...` route plus all per-agent CRUD. Use for back-office /
  server-to-server provisioning.
- **User JWT** — issued either via `POST /api/auth/token` (device-key
  exchange) or `GatewayClient.issueUserToken(...)` (admin-minted on behalf of
  a user authenticated by your own system). Scoped to that user's agents.

`GatewayClient` accepts either as `token`. `AgentClient` (live session calls)
expects a user JWT.

## What the SDK supports today

### `GatewayClient` — control plane

**Auth / identity**
- `GatewayClient.issueUserToken({ baseUrl, adminToken, channel, channelUserId, displayName?, purpose?, ttlSeconds? })` — admin-only mint of a user JWT for a `(channel, channelUserId)` identity. Use to bridge users authenticated by an external system into OpenHermit without device-key exchange.
  - `purpose: 'session'` (default) returns a normal 24h credential.
  - `purpose: 'exchange'` returns a single-use short-lived token (≤600s, default 120s) intended for the web `/connect#token=…` deep-link flow.
- `GatewayClient.exchangeConnectToken({ baseUrl, token })` — swap an `exchange` token for a 24h session JWT. The token is the credential (no admin token needed) and is rejected on a second redemption. Backs the `/connect` SSO flow described below.

#### SSO deep link: `/connect#token=…`

For platforms that already authenticate their own users, the simplest way to drop them into the OpenHermit web UI is a short-lived exchange JWT:

1. Server-side (on the trusted platform), mint an exchange token:
   ```ts
   const { token } = await GatewayClient.issueUserToken({
     baseUrl: 'https://hermit.example.com',
     adminToken: process.env.OPENHERMIT_ADMIN_TOKEN!,
     channel: 'my-platform',
     channelUserId: user.id,
     displayName: user.name,
     purpose: 'exchange',
   });
   const url = `https://hermit.example.com/connect?agent_id=${agentId}#token=${token}`;
   ```
2. Redirect the user to `url`. The web app reads the token from the URL fragment (so it never hits the server log or `referer`), strips it, swaps it via `POST /api/auth/exchange`, and persists the resulting session JWT in `localStorage`.
3. The exchange token is single-use — a replay (e.g. someone scraping the URL out of browser history) is rejected with 401.

The browser's existing device-key identity, if any, is left untouched so the same browser can hold both an SSO-issued identity and a device-key identity.

**Catalog**
- `listProviders(): ProviderCatalogEntry[]` — provider/model snapshot from pi-ai.

**Agents**
- `listAgents()` — admin: every agent in the fleet.
- `createAgent(request)` / `deleteAgent(agentId)`.
- `manageAgent(agentId, 'start' | 'stop' | 'restart' | 'enable' | 'disable')`.
- `agentHealth(agentId)`.

**Per-agent config**
- `getAgentConfig(agentId)` / `putAgentConfig(agentId, config)`.
- `getAgentSecurity(agentId)` / `putAgentSecurity(agentId, policy)`.

**Secrets** (per-agent, encrypted server-side)
- `getAgentSecrets(agentId)` — returns masked previews + `passThrough` flags.
- `setAgentSecret(agentId, name, value, { passThrough? })`.
- `deleteAgentSecret(agentId, name)`.

**Channels** (built-in adapters and external webhook channels)
- `listAgentChannels(agentId)` — all channels with runtime status.
- `createExternalChannel(agentId, input)` — returns the plaintext token once.
- `updateAgentChannel(agentId, channelId, input)`.
- `deleteAgentChannel(agentId, channelId)`.

**Sandboxes** (per-agent exec environments)
- `listSandboxes(agentId)`.
- `createSandbox(agentId, input)`.
- `deleteSandbox(agentId, alias)`.

**Skills** (admin)
- `listSkills()` / `scanSkills()` / `getSkill(...)`.
- `registerSkill(input)` / `deleteSkill(skillId)`.
- `listSkillAssignments()` / `enableSkill(skillId, agentId)` / `disableSkill(skillId, agentId)`.

**MCP servers** (admin)
- `listMcpServers()` / `registerMcpServer(input)`.
- `listMcpAssignments()` / `enableMcpServer(mcpServerId, agentId)` / `disableMcpServer(...)`.

**Instructions** (per-agent prompts)
- `listInstructions(agentId)` / `getInstruction(agentId, key)`.
- `setInstruction(agentId, key, content)` / `deleteInstruction(agentId, key)`.
- `fanoutInstruction(input)` — admin: push the same key to many agents.

**Schedules** (per-agent crons)
- `listSchedules(agentId)` / `createSchedule(agentId, input)`.
- `updateSchedule(agentId, scheduleId, input)` / `deleteSchedule(agentId, scheduleId)`.
- `listScheduleRuns(agentId, scheduleId, limit?)`.

**Policies** (per-agent resource access)
- `listPolicies(agentId, resourceType?)`.
- `upsertPolicy(agentId, input)` / `deletePolicy(agentId, resourceType, resourceKey)`.

**Approvals** (per-agent tool-call approvals)
- `listApprovalRequests(agentId, status?)` / `getApprovalRequest(agentId, id)`.
- `reviewApprovalRequest(agentId, id, { decision, ... })`.

**Gateway-level config** (admin)
- `getGatewayConfig()` / `putGatewayConfig(config)`.
- `getAdminStats()`.

### `AgentClient` — runtime session

For talking to a running agent over HTTP/SSE/WS as a user.

- `openSession(spec)` / `listSessions(query?)` / `listSessionMessages(sessionId)`.
  - `spec.customInstruction?: string` — optional per-session prompt addendum.
    Stored once on the session row at create time and appended to the system
    prompt as a dedicated section after agent-level instructions. Immutable
    for the lifetime of the session (subsequent `openSession` calls for the
    same `sessionId` ignore the field).
- `postMessage(...)` / `appendMessage(...)` — non-streaming.
- `postMessageSync(...)` — wait for the assistant turn to complete.
- `postMessageStream(...)` — async iterable of session events (SSE under the hood).
- `submitApproval(...)` / `checkpointSession(...)`.
- `reviewApprovalRequest(...)` / `reviewApprovalRequestByShortId(...)`.

### `AgentRealtimeClient` — WebSocket client (chat-style consumers)

- `sessionOpen` / `sessionMessage` / `sessionApprove` / `sessionCheckpoint`.
- `sessionList` / `sessionHistory`.
- `subscribe(sessionId, lastEventId?)` / `unsubscribe(sessionId)`.

## Not yet covered

The gateway exposes more routes than the SDK currently wraps. If you need any
of these, drop a method in `packages/sdk/src/index.ts` matching the existing
style. Prioritised by the hole they represent:

**Multi-tenant / membership**
- `POST /api/users` — create users from outside the device-key flow.
- `GET /api/agents/:agentId/members` — list users with access to an agent.
- `POST /api/agents/:agentId/members` — share an agent with a user.
- `DELETE /api/agents/:agentId/members/:userId` — revoke access.
- `POST /api/agents/:agentId/users/:userId/promote-to-owner`.
- `GET /api/agents/:agentId/ownership` / `GET /api/agents/:agentId/info`.
- `GET /api/users/me/agents` — current-user's accessible agents (currently only `listAgents()` admin variant is wrapped).

**Admin observability**
- `GET /health`, `GET /metrics`.
- `GET /api/admin/agents/fleet` (admin fleet dashboard).
- `GET /api/admin/sandboxes` (cross-agent sandbox view).
- `GET /api/admin/users` / `GET /api/admin/users/:userId/identities` / `GET /api/admin/users/:userId/agents`.
- `GET /api/admin/logs` (server log tail).
- `GET /api/admin/schedules` (cross-agent schedule view).
- `GET /api/sandbox-presets` (read-only catalog of sandbox templates).

**Sessions / events**
- `DELETE /api/agents/:agentId/sessions/:sessionId` — delete a session.
- `GET /api/agents/:agentId/sessions/:sessionId/events` — raw SSE event stream (`AgentClient.postMessageStream` covers the message-driven case but not arbitrary subscription).

**Channels**
- `POST /api/agents/:agentId/channels/:namespace/webhook` — inbound webhook
  delivery. External integrations call this directly with the token from
  `createExternalChannel`; the SDK currently doesn't wrap it because typical
  consumers are *receiving* webhooks, not posting them programmatically.

**Schedules**
- `POST /api/agents/:agentId/schedules/:scheduleId/trigger` — manual fire of
  a cron entry (useful for "test run now" buttons).

**Approvals**
- `POST /api/agents/:agentId/approvals/by-short/:shortId/review` — review by
  short-id (the long-id form is wrapped).

## Versioning

Semver-ish. Additive methods are minor/patch bumps; type-breaking changes are
minor (we're pre-1.0). The ESM build is published from `dist/`; the
`development` export condition is stripped at pack time via `prepack` so
in-monorepo dev keeps reading `src/` directly without polluting the published
tarball.

See [`packages/sdk/src/index.ts`](../packages/sdk/src/index.ts) for the
authoritative type surface.
