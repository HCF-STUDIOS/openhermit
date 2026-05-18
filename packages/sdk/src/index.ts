export { parseSseFrames, type SseFrame } from './sse.js';

import {
  agentLocalRoutes,
  gatewayRoutes,
  type AgentInfo,
  type CreateAgentRequest,
  type OutboundEvent,
  type SessionHistoryMessage,
  type SessionCheckpointRequest,
  type SessionListQuery,
  type SessionAttachment,
  type SessionMessage,
  type SessionSummary,
  type SessionSpec,
  type SyncResponse,
  type ToolApprovalRequest,
  type WsRequest,
  type WsEvent,
  type WsServerMessage,
  isWsRequest,
} from '@openhermit/protocol';
import {
  OpenHermitError,
  type OpenHermitStatusCode,
  joinUrl,
} from '@openhermit/shared';

type FetchLike = typeof fetch;

export interface AgentLocalClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

export class AgentLocalClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: AgentLocalClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async openSession(spec: SessionSpec): Promise<{ sessionId: string }> {
    return this.postJson(agentLocalRoutes.sessions, spec);
  }

  async listSessions(query: SessionListQuery = {}): Promise<SessionSummary[]> {
    const searchParams = new URLSearchParams();

    if (query.kind) {
      searchParams.set('kind', query.kind);
    }

    if (query.platform) {
      searchParams.set('platform', query.platform);
    }

    if (query.interactive !== undefined) {
      searchParams.set('interactive', String(query.interactive));
    }

    if (query.limit !== undefined) {
      searchParams.set('limit', String(query.limit));
    }

    if (query.channel) {
      searchParams.set('channel', query.channel);
    }

    if (query.metadata) {
      for (const [key, value] of Object.entries(query.metadata)) {
        searchParams.set(`metadata.${key}`, value);
      }
    }

    const path = searchParams.size > 0
      ? `${agentLocalRoutes.sessions}?${searchParams.toString()}`
      : agentLocalRoutes.sessions;

    return this.getJson(path);
  }

  async listSessionMessages(sessionId: string): Promise<SessionHistoryMessage[]> {
    return this.getJson(agentLocalRoutes.sessionMessages(sessionId));
  }

  async postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }> {
    return this.postJson(agentLocalRoutes.sessionMessages(sessionId), message);
  }

  async appendMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; appended: boolean; deduped?: true }> {
    const path = `${agentLocalRoutes.sessionMessages(sessionId)}?append=true`;
    return this.postJson(path, message);
  }

  async submitApproval(
    sessionId: string,
    request: ToolApprovalRequest & { channelUserId?: string },
  ): Promise<{ resolved: boolean }> {
    const { channelUserId, ...body } = request;
    const headers = channelUserId ? { 'x-channel-user-id': channelUserId } : undefined;
    return this.postJson(agentLocalRoutes.sessionApprove(sessionId), body, headers);
  }

  async checkpointSession(
    sessionId: string,
    request: SessionCheckpointRequest = {},
  ): Promise<{ checkpointed: boolean }> {
    return this.postJson(agentLocalRoutes.sessionCheckpoint(sessionId), request);
  }

  async reviewApprovalRequest(
    requestId: string,
    input: { decision: 'approved' | 'rejected'; resolution?: 'once' | 'persistent'; reason?: string; channelUserId?: string },
  ): Promise<unknown> {
    const { channelUserId, ...body } = input;
    const headers = channelUserId ? { 'x-channel-user-id': channelUserId } : undefined;
    return this.postJson(`/approvals/${encodeURIComponent(requestId)}/review`, body, headers);
  }

  async reviewApprovalRequestByShortId(
    shortId: number,
    input: { decision: 'approved' | 'rejected'; resolution?: 'once' | 'persistent'; reason?: string; channelUserId?: string },
  ): Promise<unknown> {
    const { channelUserId, ...body } = input;
    const headers = channelUserId ? { 'x-channel-user-id': channelUserId } : undefined;
    return this.postJson(`/approvals/by-short/${encodeURIComponent(String(shortId))}/review`, body, headers);
  }

  async postMessageSync(
    sessionId: string,
    message: SessionMessage,
    options?: { timeout?: number },
  ): Promise<SyncResponse> {
    const params = new URLSearchParams({ wait: 'true' });
    if (options?.timeout) params.set('timeout', String(options.timeout));
    const path = `${agentLocalRoutes.sessionMessages(sessionId)}?${params.toString()}`;
    return this.postJson(path, message);
  }

  async *postMessageStream(
    sessionId: string,
    message: SessionMessage,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<OutboundEvent> {
    const path = `${agentLocalRoutes.sessionMessages(sessionId)}?stream=true`;
    const url = joinUrl(this.options.baseUrl, path);

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
      signal: options?.signal ?? null,
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new OpenHermitError(
        `Stream request failed (${response.status}): ${text || response.statusText}`,
        'agent_api_error',
        500,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6);
          try {
            yield JSON.parse(json) as OutboundEvent;
          } catch {
            // skip non-JSON frames (ping, etc.)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  buildEventsUrl(sessionId: string): string {
    return joinUrl(this.options.baseUrl, agentLocalRoutes.eventsUrl(sessionId));
  }

  buildWsUrl(): string {
    const base = this.options.baseUrl.replace(/^http/, 'ws');
    return `${joinUrl(base, agentLocalRoutes.ws)}?token=${encodeURIComponent(this.options.token)}`;
  }

  private buildFetchFailedError(path: string, error: unknown): OpenHermitError {
    const message = error instanceof Error ? error.message : String(error);

    return new OpenHermitError(
      `Agent local API is unavailable at ${joinUrl(this.options.baseUrl, path)}. `
      + `Make sure the gateway is running and the agent is started. `
      + `Underlying error: ${message}`,
      'agent_api_error',
      500,
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.options.baseUrl, path), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.options.token}`,
        },
      });
    } catch (error) {
      throw this.buildFetchFailedError(path, error);
    }

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new OpenHermitError(
        `Agent local API request failed (${response.status}): ${responseText || response.statusText}`,
        'agent_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.options.baseUrl, path), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw this.buildFetchFailedError(path, error);
    }

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new OpenHermitError(
        `Agent local API request failed (${response.status}): ${responseText || response.statusText}`,
        'agent_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// GatewayClient — talks to the multi-agent gateway
// ---------------------------------------------------------------------------

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

// ── Agent channel types ──────────────────────────────────────────────

export type AgentChannelKind = 'builtin' | 'external';

export interface AgentChannel {
  id: string;
  agentId: string;
  kind: AgentChannelKind;
  /** Adapter type: 'external', 'telegram', 'discord', 'slack', ... */
  channelType: string;
  /** Unique routing namespace per agent. */
  namespace: string;
  label: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Visible token prefix for UI display; full token only via createExternalChannel. */
  tokenPrefix: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Provider/model catalog entry returned by GET /api/providers. */
export interface ProviderModel {
  id: string;
  /** True for thinking-only / thinking-capable models in pi-ai. */
  reasoning: boolean;
}

export interface ProviderCatalogEntry {
  provider: string;
  models: ProviderModel[];
}

/** Builtin-channel secret-key descriptor surfaced by listAgentChannels. */
export interface AgentChannelSecretKey {
  key: string;
  label: string;
  placeholder: string;
}

export type AgentChannelRuntimeStatus =
  | 'running'
  | 'stopped'
  | 'error'
  | 'disabled'
  | 'unknown';

export interface AgentChannelListEntry extends AgentChannel {
  /** All required secret keys present on the agent. */
  secretsSet: boolean;
  /** Live bridge status. */
  runtimeStatus: AgentChannelRuntimeStatus;
  /** Builtin channels expose the secret keys they need. */
  secretKeys?: AgentChannelSecretKey[];
  /** Present when runtimeStatus === 'error'. */
  error?: string;
}

export interface CreatedAgentChannel extends AgentChannel {
  /** Plaintext token. Returned ONLY at creation time. */
  token: string;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Mint a user JWT via the admin-only trusted-issuer path. For external
   * platforms that authenticate their users elsewhere and want to hand
   * them a gateway token without going through device-key.
   *
   * The caller's `adminToken` is the trust boundary — never expose it to
   * end users. Pick a stable `channel` namespace for your platform (e.g.
   * "my-platform"); the same `(channel, channelUserId)` always resolves
   * to the same gateway user.
   */
  static async issueUserToken(input: {
    baseUrl: string;
    adminToken: string;
    channel: string;
    channelUserId: string;
    displayName?: string;
    fetch?: FetchLike;
  }): Promise<{
    token: string;
    expiresAt: number;
    userId: string;
    isNewDevice: boolean;
    displayName?: string;
  }> {
    const fetchImpl = input.fetch ?? fetch;
    const url = joinUrl(input.baseUrl, '/api/admin/auth/issue-token');
    const body: Record<string, unknown> = {
      channel: input.channel,
      channelUserId: input.channelUserId,
    };
    if (input.displayName !== undefined) body.displayName = input.displayName;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${url}: ${message}`,
        'gateway_api_error',
        500,
      );
    }

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;
      throw new OpenHermitError(
        `issueUserToken failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }

    return (await response.json()) as {
      token: string;
      expiresAt: number;
      userId: string;
      isNewDevice: boolean;
      displayName?: string;
    };
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.getJson(gatewayRoutes.agents);
  }

  /**
   * Snapshot of providers and models registered in the gateway's
   * pi-ai catalog. Used to populate provider/model pickers without
   * baking the registry into the client.
   */
  async listProviders(): Promise<ProviderCatalogEntry[]> {
    return this.getJson<ProviderCatalogEntry[]>('/api/providers');
  }

  async createAgent(request: CreateAgentRequest): Promise<AgentInfo> {
    return this.postJson(gatewayRoutes.agents, request);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.postJson(gatewayRoutes.agentManage(agentId, 'delete'), {});
  }

  async manageAgent(
    agentId: string,
    action: 'start' | 'stop' | 'restart' | 'enable' | 'disable',
  ): Promise<AgentInfo> {
    return this.postJson(gatewayRoutes.agentManage(agentId, action), {});
  }

  async agentHealth(agentId: string): Promise<{ agentId: string; ok: boolean; status: string }> {
    return this.getJson(gatewayRoutes.agentHealth(agentId));
  }

  async getAgentConfig(agentId: string): Promise<Record<string, unknown>> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/config`);
  }

  async putAgentConfig(agentId: string, config: Record<string, unknown>): Promise<void> {
    await this.putJson(`/api/agents/${encodeURIComponent(agentId)}/config`, config);
  }

  /**
   * Read or write the agent's security policy (autonomy, approvals,
   * `access` level, `access_token`, channel tokens). Owner / admin only.
   */
  async getAgentSecurity(agentId: string): Promise<Record<string, unknown>> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/security`);
  }

  async putAgentSecurity(agentId: string, policy: Record<string, unknown>): Promise<void> {
    await this.putJson(`/api/agents/${encodeURIComponent(agentId)}/security`, policy);
  }

  /**
   * Returns the agent's secrets, each as `{ masked, passThrough }`. The
   * value is **masked** server-side (e.g. "abcd********wxyz"); the
   * `passThrough` flag controls whether the secret is injected as an env
   * var into the agent's sandboxes at startup.
   */
  async getAgentSecrets(
    agentId: string,
  ): Promise<Record<string, { masked: string; passThrough: boolean }>> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/secrets`);
  }

  async setAgentSecret(
    agentId: string,
    name: string,
    value: string,
    options?: { passThrough?: boolean },
  ): Promise<void> {
    const body: Record<string, unknown> = { value };
    if (options?.passThrough !== undefined) body.passThrough = options.passThrough;
    await this.putJson(
      `/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(name)}`,
      body,
    );
  }

  async deleteAgentSecret(agentId: string, name: string): Promise<void> {
    await this.deleteJson(
      `/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(name)}`,
    );
  }

  // --- attachments (per-session) ---

  /**
   * Upload a file as a session attachment. The gateway sniffs the MIME
   * type, stores the bytes, and (for files under the sandbox-copy
   * threshold) eagerly materialises them into the agent's sandbox so
   * tools see a real on-disk path. Resolves with the attachment record;
   * `id` can then be embedded in a subsequent `postMessage` as
   * `{ type: 'file', id }`.
   *
   * Pass a `File` (the name is taken from `file.name`) or a `Blob` with
   * an explicit `filename`. The two-arg `File` form is the typical
   * browser path; the `Blob + filename` form is what Node callers use
   * after constructing a Blob from raw bytes.
   */
  async uploadAttachment(
    agentId: string,
    sessionId: string,
    file: File | Blob,
    filename?: string,
  ): Promise<SessionAttachment> {
    const form = new FormData();
    const resolvedName =
      filename ?? (file instanceof File ? file.name : undefined);
    if (!resolvedName) {
      throw new OpenHermitError(
        'uploadAttachment requires a filename when body is a Blob without a name.',
        'gateway_api_error',
        400,
      );
    }
    form.append('file', file, resolvedName);

    const path = gatewayRoutes.agentSessionAttachments(agentId, sessionId);
    const url = joinUrl(this.baseUrl, path);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
        body: form,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${url}: ${message}`,
        'gateway_api_error',
        500,
      );
    }

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;
      throw new OpenHermitError(
        `uploadAttachment failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }

    const body = (await response.json()) as { attachment: SessionAttachment };
    return body.attachment;
  }

  /**
   * List attachments for a session. Default scope is the current session
   * only; `scope: 'user'` widens the listing to every attachment the
   * caller has uploaded across the agent's sessions (requires an
   * authenticated user).
   */
  async listAttachments(
    agentId: string,
    sessionId: string,
    options?: { scope?: 'session' | 'user' },
  ): Promise<SessionAttachment[]> {
    let path = gatewayRoutes.agentSessionAttachments(agentId, sessionId);
    if (options?.scope === 'user') {
      path += '?scope=user';
    }
    const body = await this.getJson<{ attachments: SessionAttachment[] }>(path);
    return body.attachments;
  }

  /**
   * Fetch a single attachment's metadata by id. Returns the wire record
   * (id, mime, size, sha256, sandbox path, materialization state, etc.).
   */
  async getAttachment(
    agentId: string,
    sessionId: string,
    attachmentId: string,
  ): Promise<SessionAttachment> {
    const path = gatewayRoutes.agentSessionAttachmentById(
      agentId,
      sessionId,
      attachmentId,
    );
    const body = await this.getJson<{ attachment: SessionAttachment }>(path);
    return body.attachment;
  }

  // --- channels (per-agent) ---

  /**
   * List channels on an agent. Includes both builtin slots (telegram,
   * discord, slack — auto-seeded on agent create) and external channels
   * (created via `createExternalChannel`). The plaintext token is never
   * returned here; only `tokenPrefix` for display.
   */
  async listAgentChannels(agentId: string): Promise<AgentChannelListEntry[]> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/channels`);
  }

  /**
   * Create an external channel and return its plaintext token. The token
   * is only returned here — `listAgentChannels` will not re-derive it.
   * Builtin channels (telegram/discord/slack) are not created via this
   * method; they're seeded on agent create and configured by `updateAgentChannel`.
   */
  async createExternalChannel(
    agentId: string,
    input: {
      namespace: string;
      label?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ): Promise<CreatedAgentChannel> {
    return this.postJson(
      `/api/agents/${encodeURIComponent(agentId)}/channels`,
      input,
    );
  }

  /**
   * Patch a channel — toggle `enabled`, change `label`, or replace
   * `config`. For builtin channels, flipping `enabled` boots / stops the
   * in-process bridge (response then includes `runtimeStatus` / `error`).
   */
  async updateAgentChannel(
    agentId: string,
    channelId: string,
    input: {
      enabled?: boolean;
      label?: string | null;
      config?: Record<string, unknown>;
    },
  ): Promise<AgentChannel & { runtimeStatus?: AgentChannelRuntimeStatus; error?: string }> {
    return this.patchJson(
      `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelId)}`,
      input,
    );
  }

  /**
   * Delete a channel. External rows are soft-deleted (revoked); builtin
   * rows are hard-deleted and re-seeded on next agent create / boot.
   */
  async deleteAgentChannel(agentId: string, channelId: string): Promise<void> {
    await this.deleteJson(
      `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelId)}`,
    );
  }

  // --- sandboxes (per-agent) ---

  async listSandboxes(agentId: string): Promise<Array<{
    id: string;
    agentId: string;
    alias: string;
    type: string;
    status: string;
    config: Record<string, unknown>;
    createdAt: string;
  }>> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/sandboxes`);
  }

  async createSandbox(agentId: string, input: {
    alias?: string;
    type: 'host' | 'docker' | 'e2b' | 'daytona';
    config?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.postJson(`/api/agents/${encodeURIComponent(agentId)}/sandboxes`, input);
  }

  async deleteSandbox(agentId: string, alias: string): Promise<void> {
    await this.deleteJson(
      `/api/agents/${encodeURIComponent(agentId)}/sandboxes/${encodeURIComponent(alias)}`,
    );
  }

  // --- skills (admin) ---

  async listSkills(): Promise<unknown[]> {
    return this.getJson(`/api/admin/skills`);
  }

  async scanSkills(): Promise<unknown[]> {
    return this.getJson(`/api/admin/skills/scan`);
  }

  async registerSkill(input: {
    id: string;
    name: string;
    description: string;
    path: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.postJson(`/api/admin/skills`, input);
  }

  async deleteSkill(skillId: string): Promise<void> {
    await this.deleteJson(`/api/admin/skills/${encodeURIComponent(skillId)}`);
  }

  async listSkillAssignments(): Promise<Array<{ agentId: string; skillId: string; enabled: boolean }>> {
    return this.getJson(`/api/admin/skills/assignments`);
  }

  async enableSkill(skillId: string, agentId: string): Promise<void> {
    await this.postJson(`/api/admin/skills/${encodeURIComponent(skillId)}/enable`, { agentId });
  }

  async disableSkill(skillId: string, agentId: string): Promise<void> {
    await this.postJson(`/api/admin/skills/${encodeURIComponent(skillId)}/disable`, { agentId });
  }

  // --- instructions ---

  async listInstructions(agentId: string): Promise<Array<{ key: string; content: string; updatedAt: string }>> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/instructions`);
  }

  async fanoutInstruction(input: {
    mode: 'set' | 'append' | 'remove';
    key: string;
    content?: string;
  }): Promise<{ ok: boolean; mode: string; key: string; agents: string[] }> {
    return this.postJson(`/api/admin/instructions/fanout`, input);
  }

  async getInstruction(agentId: string, key: string): Promise<{ key: string; content: string; updatedAt: string } | undefined> {
    try {
      return await this.getJson(`/api/agents/${encodeURIComponent(agentId)}/instructions/${encodeURIComponent(key)}`);
    } catch (err) {
      if (err instanceof Error && /404|not_found/i.test(err.message)) return undefined;
      throw err;
    }
  }

  async setInstruction(agentId: string, key: string, content: string): Promise<void> {
    await this.putJson(`/api/agents/${encodeURIComponent(agentId)}/instructions/${encodeURIComponent(key)}`, { content });
  }

  async deleteInstruction(agentId: string, key: string): Promise<void> {
    await this.deleteJson(`/api/agents/${encodeURIComponent(agentId)}/instructions/${encodeURIComponent(key)}`);
  }

  // --- admin stats ---

  // --- gateway config (admin) ---

  async getGatewayConfig(): Promise<{
    config: Record<string, unknown>;
    source: 'db' | 'file' | 'defaults' | 'memory';
    persistent: boolean;
  }> {
    return this.getJson(`/api/admin/gateway/config`);
  }

  async putGatewayConfig(config: Record<string, unknown>): Promise<{
    ok: boolean;
    config: Record<string, unknown>;
    restart_required: boolean;
  }> {
    return this.putJson(`/api/admin/gateway/config`, config);
  }

  async getAdminStats(): Promise<{
    uptime: number;
    memory: { rss: number; heapUsed: number; heapTotal: number };
    agents: { running: number };
    counts: { users: number; sessions: number; sessionEvents: number };
  }> {
    return this.getJson(`/api/admin/stats`);
  }

  // --- mcp servers (admin) ---

  async listMcpServers(): Promise<unknown[]> {
    return this.getJson(`/api/admin/mcp-servers`);
  }

  async registerMcpServer(input: {
    id: string;
    name: string;
    description: string;
    url: string;
    headers?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.postJson(`/api/admin/mcp-servers`, input);
  }

  async listMcpAssignments(): Promise<Array<{ agentId: string; mcpServerId: string; enabled: boolean }>> {
    return this.getJson(`/api/admin/mcp-servers/assignments`);
  }

  async enableMcpServer(mcpServerId: string, agentId: string): Promise<void> {
    await this.postJson(`/api/admin/mcp-servers/${encodeURIComponent(mcpServerId)}/enable`, { agentId });
  }

  async disableMcpServer(mcpServerId: string, agentId: string): Promise<void> {
    await this.postJson(`/api/admin/mcp-servers/${encodeURIComponent(mcpServerId)}/disable`, { agentId });
  }

  /**
   * Returns an `AgentLocalClient` whose requests are routed through the
   * gateway at `/api/agents/:agentId/...`. The agent-local client sees
   * the same API surface as if it were talking to the agent directly.
   */
  async listSchedules(agentId: string): Promise<unknown[]> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/schedules`);
  }

  async createSchedule(agentId: string, input: {
    type: 'cron' | 'once';
    prompt: string;
    cronExpression?: string;
    runAt?: string;
    id?: string;
    delivery?: unknown;
    policy?: unknown;
  }): Promise<unknown> {
    return this.postJson(`/api/agents/${encodeURIComponent(agentId)}/schedules`, input);
  }

  async updateSchedule(agentId: string, scheduleId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.putJson(`/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, input);
  }

  async deleteSchedule(agentId: string, scheduleId: string): Promise<void> {
    await this.deleteJson(`/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`);
  }

  async listScheduleRuns(agentId: string, scheduleId: string, limit?: number): Promise<unknown[]> {
    const params = limit ? `?limit=${limit}` : '';
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/runs${params}`);
  }

  // --- policies ---

  async listPolicies(agentId: string, resourceType?: string): Promise<unknown[]> {
    const params = resourceType ? `?resourceType=${encodeURIComponent(resourceType)}` : '';
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/policies${params}`);
  }

  async upsertPolicy(agentId: string, input: {
    resourceType: string;
    resourceKey: string;
    effect?: string;
    grants: unknown[];
    scope?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.postJson(`/api/agents/${encodeURIComponent(agentId)}/policies`, input);
  }

  async deletePolicy(
    agentId: string,
    resourceType: string,
    resourceKey: string,
    effect?: string,
  ): Promise<void> {
    const qs = effect ? `?effect=${encodeURIComponent(effect)}` : '';
    await this.deleteJson(
      `/api/agents/${encodeURIComponent(agentId)}/policies/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceKey)}${qs}`,
    );
  }

  // ── Approval requests ─────────────────────────────────────────────

  async listApprovalRequests(agentId: string, status?: string): Promise<unknown[]> {
    const params = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/approvals${params}`);
  }

  async getApprovalRequest(agentId: string, id: string): Promise<unknown> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(id)}`);
  }

  async reviewApprovalRequest(agentId: string, id: string, input: {
    decision: 'approved' | 'rejected';
    resolution?: 'once' | 'persistent';
    reason?: string;
  }): Promise<unknown> {
    return this.postJson(`/api/agents/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(id)}/review`, input);
  }

  agent(agentId: string): AgentLocalClient {
    return new AgentLocalClient({
      baseUrl: joinUrl(this.baseUrl, `/api/agents/${encodeURIComponent(agentId)}`),
      token: this.token,
      fetch: this.fetchImpl,
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: 'GET',
        headers: { authorization: `Bearer ${this.token}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${joinUrl(this.baseUrl, path)}: ${message}`,
        'gateway_api_error',
        500,
      );
    }

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new OpenHermitError(
        `Gateway API request failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${joinUrl(this.baseUrl, path)}: ${message}`,
        'gateway_api_error',
        500,
      );
    }

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new OpenHermitError(
        `Gateway API request failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }

  private async putJson<T>(path: string, body: unknown): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${joinUrl(this.baseUrl, path)}: ${message}`,
        'gateway_api_error',
        500,
      );
    }

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new OpenHermitError(
        `Gateway API request failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }

  private async patchJson<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${joinUrl(this.baseUrl, path)}: ${message}`,
        'gateway_api_error',
        500,
      );
    }
    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;
      throw new OpenHermitError(
        `Gateway API request failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }
    return (await response.json()) as T;
  }

  private async deleteJson<T = unknown>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${this.token}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${joinUrl(this.baseUrl, path)}: ${message}`,
        'gateway_api_error',
        500,
      );
    }
    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;
      throw new OpenHermitError(
        `Gateway API request failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) as T : {} as T;
  }

}

// ---------------------------------------------------------------------------
// AgentWsClient — WebSocket transport
// ---------------------------------------------------------------------------

type WsEventHandler = (event: WsEvent) => void;
type WsCloseHandler = () => void;
type WsErrorHandler = (error: Error) => void;

export interface AgentWsClientOptions {
  url: string;
  token: string;
  WebSocket?: typeof globalThis.WebSocket;
}

export class AgentWsClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly eventHandlers: WsEventHandler[] = [];
  private readonly closeHandlers: WsCloseHandler[] = [];
  private readonly errorHandlers: WsErrorHandler[] = [];
  private readonly wsUrl: string;
  private readonly WsImpl: typeof globalThis.WebSocket;

  constructor(private readonly options: AgentWsClientOptions) {
    const sep = options.url.includes('?') ? '&' : '?';
    this.wsUrl = `${options.url}${sep}token=${encodeURIComponent(options.token)}`;
    this.WsImpl = options.WebSocket ?? globalThis.WebSocket;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.WsImpl(this.wsUrl);
      this.ws = ws as unknown as WebSocket;

      const onOpen = (): void => {
        ws.removeEventListener('error', onError);
        resolve();
      };

      const onError = (ev: Event): void => {
        ws.removeEventListener('open', onOpen);
        reject(new Error(`WebSocket connection failed: ${String(ev)}`));
      };

      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });

      ws.addEventListener('message', (ev: MessageEvent) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as WsServerMessage;
        } catch {
          return;
        }

        if (msg.kind === 'response') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if ('error' in msg) {
              p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
            } else {
              p.resolve(msg.result);
            }
          }
        } else if (msg.kind === 'event') {
          for (const handler of this.eventHandlers) {
            handler(msg);
          }
        }
      });

      ws.addEventListener('close', () => {
        for (const handler of this.closeHandlers) handler();
        // Reject all pending requests.
        for (const [, p] of this.pending) {
          p.reject(new Error('WebSocket closed'));
        }
        this.pending.clear();
      });

      ws.addEventListener('error', (ev: Event) => {
        const err = new Error(`WebSocket error: ${String(ev)}`);
        for (const handler of this.errorHandlers) handler(err);
      });
    });
  }

  close(): void {
    this.ws?.close();
  }

  on(event: 'event', handler: WsEventHandler): void;
  on(event: 'close', handler: WsCloseHandler): void;
  on(event: 'error', handler: WsErrorHandler): void;
  on(event: 'event' | 'close' | 'error', handler: WsEventHandler | WsCloseHandler | WsErrorHandler): void {
    switch (event) {
      case 'event':
        this.eventHandlers.push(handler as WsEventHandler);
        break;
      case 'close':
        this.closeHandlers.push(handler as WsCloseHandler);
        break;
      case 'error':
        this.errorHandlers.push(handler as WsErrorHandler);
        break;
    }
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws) {
      return Promise.reject(new Error('WebSocket not connected.'));
    }

    const id = String(this.nextId++);
    const msg: WsRequest = { kind: 'request', id, method: method as WsRequest['method'], ...(params ? { params } : {}) };
    this.ws.send(JSON.stringify(msg));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async sessionOpen(params: {
    sessionId: string;
    source: { kind: string; interactive: boolean; platform?: string; type?: string };
    metadata?: Record<string, unknown>;
    customInstruction?: string;
  }): Promise<{ sessionId: string }> {
    return this.request('session.open', params as Record<string, unknown>) as Promise<{ sessionId: string }>;
  }

  async sessionMessage(params: {
    sessionId: string;
    text: string;
    messageId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ sessionId: string; messageId?: string }> {
    return this.request('session.message', params) as Promise<{ sessionId: string; messageId?: string }>;
  }

  async sessionApprove(params: {
    sessionId: string;
    toolCallId: string;
    approved: boolean;
  }): Promise<{ resolved: boolean }> {
    return this.request('session.approve', params) as Promise<{ resolved: boolean }>;
  }

  async sessionCheckpoint(params: {
    sessionId: string;
    reason?: string;
  }): Promise<{ checkpointed: boolean }> {
    return this.request('session.checkpoint', params) as Promise<{ checkpointed: boolean }>;
  }

  async sessionInterrupt(params: {
    sessionId: string;
  }): Promise<{ interrupted: boolean }> {
    return this.request('session.interrupt', params) as Promise<{ interrupted: boolean }>;
  }

  async sessionList(params?: Record<string, unknown>): Promise<SessionSummary[]> {
    return this.request('session.list', params) as Promise<SessionSummary[]>;
  }

  async sessionHistory(params: {
    sessionId: string;
  }): Promise<SessionHistoryMessage[]> {
    return this.request('session.history', params) as Promise<SessionHistoryMessage[]>;
  }

  async subscribe(sessionId: string, lastEventId?: number): Promise<void> {
    await this.request('session.subscribe', {
      sessionId,
      ...(lastEventId !== undefined ? { lastEventId } : {}),
    });
  }

  async unsubscribe(sessionId: string): Promise<void> {
    await this.request('session.unsubscribe', { sessionId });
  }
}
