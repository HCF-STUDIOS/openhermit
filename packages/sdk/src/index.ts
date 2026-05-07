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
  ): Promise<{ sessionId: string; appended: boolean }> {
    const path = `${agentLocalRoutes.sessionMessages(sessionId)}?append=true`;
    return this.postJson(path, message);
  }

  async submitApproval(
    sessionId: string,
    request: ToolApprovalRequest,
  ): Promise<{ resolved: boolean }> {
    return this.postJson(agentLocalRoutes.sessionApprove(sessionId), request);
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

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.getJson(gatewayRoutes.agents);
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
   * Returns the agent's secrets with values **masked** server-side
   * (e.g. "abcd********wxyz"). Use setAgentSecret to write a new value.
   */
  async getAgentSecrets(agentId: string): Promise<Record<string, string>> {
    return this.getJson(`/api/agents/${encodeURIComponent(agentId)}/secrets`);
  }

  async setAgentSecret(agentId: string, name: string, value: string): Promise<void> {
    await this.putJson(
      `/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(name)}`,
      { value },
    );
  }

  async deleteAgentSecret(agentId: string, name: string): Promise<void> {
    await this.deleteJson(
      `/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(name)}`,
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
  }): Promise<{ sessionId: string }> {
    return this.request('session.open', params as Record<string, unknown>) as Promise<{ sessionId: string }>;
  }

  async sessionMessage(params: {
    sessionId: string;
    text: string;
    messageId?: string;
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
