/**
 * Gateway-level channel connection pool.
 *
 * Owns Telegram/Slack/Discord bridge lifecycle independently of agent
 * runners. Boots once at gateway startup, stays alive across runner
 * eviction, and tears down only on gateway shutdown or explicit disable.
 *
 * The bridges call back into the gateway over HTTP (using `agentBaseUrl`),
 * so they don't need a live in-process runner reference. When an inbound
 * message arrives, the gateway's HTTP route hydrates the runner on demand.
 *
 * Decoupling channels from runner lifecycle is what unblocks LRU eviction
 * for agents with active channels (Phase 4 of the lazy-hydration plan).
 */
import type { AgentRunner } from '@openhermit/agent/agent-runner';
import {
  startSingleChannel,
  stopChannels as stopChannelHandles,
  type ChannelHandle,
  type ChannelStatus,
  type WebhookRequest,
  type WebhookResponse,
} from '@openhermit/agent/channels';
import { AgentSecurity, AgentWorkspace } from '@openhermit/agent/core';
import type { ChannelManifestRegistry } from '@openhermit/protocol';
import type {
  AgentConfigStore,
  AgentStore,
  DbAgentChannelStore,
  SecretStore,
} from '@openhermit/store';

import type { ChannelRegistry } from './auth.js';

export interface ChannelPoolOptions {
  agentStore: AgentStore;
  channelStore: DbAgentChannelStore;
  configStore: AgentConfigStore;
  secretStore: SecretStore;
  channelRegistry: ChannelRegistry;
  manifestRegistry: ChannelManifestRegistry;
  gatewayBaseUrl: string;
  /** Live-runner lookup so enable/disable can update the hot runner's outbounds. */
  getRunner: (agentId: string) => AgentRunner | undefined;
  log: (message: string) => void;
}

export class ChannelPool {
  private readonly handles = new Map<string, ChannelHandle[]>();
  private readonly statuses = new Map<string, ChannelStatus[]>();

  constructor(private readonly opts: ChannelPoolOptions) {}

  /**
   * Boot all enabled builtin channels for all known agents. Also registers
   * every channel row's token (builtin + external) into ChannelRegistry so
   * inbound auth works even before the runner hydrates.
   */
  async start(): Promise<void> {
    const allActive = await this.opts.channelStore.loadActive();
    const byAgent = new Map<string, typeof allActive>();
    for (const ch of allActive) {
      const arr = byAgent.get(ch.agentId);
      if (arr) arr.push(ch);
      else byAgent.set(ch.agentId, [ch]);
    }

    for (const [agentId, channels] of byAgent) {
      // Always register tokens, even for disabled / external rows — they
      // need to authenticate inbound webhooks regardless of bridge state.
      for (const ch of channels) {
        this.opts.channelRegistry.register({
          channelId: ch.id,
          apiKey: ch.token,
          namespace: ch.namespace,
          agentId,
        });
      }

      const enabledBuiltins = channels.filter((c) => c.kind === 'builtin' && c.enabled);
      if (enabledBuiltins.length === 0) continue;

      try {
        await this.startBuiltinsForAgent(agentId, enabledBuiltins);
      } catch (err) {
        this.opts.log(
          `[${agentId}] failed to start channels: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Construct an AgentSecurity for `agentId` solely to expand
   * `${{SECRET}}` placeholders in channel configs. We don't keep this
   * around — channel configs only need expansion at start time.
   */
  private async loadSecurity(agentId: string): Promise<AgentSecurity> {
    const record = await this.opts.agentStore.get(agentId);
    if (!record) throw new Error(`agent ${agentId} not found`);
    const workspace = new AgentWorkspace(record.workspaceDir);
    const security = new AgentSecurity({
      agentId,
      workspace,
      configStore: this.opts.configStore,
      secretStore: this.opts.secretStore,
    });
    await security.load();
    return security;
  }

  private async startBuiltinsForAgent(
    agentId: string,
    rows: Array<{ channelType: string; token: string; config: Record<string, unknown> }>,
  ): Promise<void> {
    const security = await this.loadSecurity(agentId);
    const agentBaseUrl = `${this.opts.gatewayBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;
    const startedHandles: ChannelHandle[] = [];
    const startedStatuses: ChannelStatus[] = [];

    for (const row of rows) {
      const manifest = this.opts.manifestRegistry.get(row.channelType);
      if (!manifest) {
        this.opts.log(
          `[${agentId}] [${row.channelType}] no manifest registered — skipping`,
        );
        startedStatuses.push({
          name: row.channelType,
          status: 'error',
          error: `no manifest registered for channel "${row.channelType}"`,
        });
        continue;
      }
      const resolved = await security.expandSecrets({ ...row.config, enabled: true });
      const { handle, status } = await startSingleChannel(manifest, resolved, {
        agentBaseUrl,
        agentTokens: { [manifest.key]: row.token },
        logger: (channel, msg) => this.opts.log(`[${agentId}] [${channel}] ${msg}`),
      });
      if (handle) startedHandles.push(handle);
      startedStatuses.push(status);
    }

    if (startedHandles.length > 0) this.handles.set(agentId, startedHandles);
    if (startedStatuses.length > 0) this.statuses.set(agentId, startedStatuses);
    if (startedHandles.length > 0) {
      this.opts.log(
        `[${agentId}] pool started ${startedHandles.length} channel(s): ${startedHandles.map((h) => h.name).join(', ')}`,
      );
    }
  }

  /**
   * Outbounds to register on a freshly hydrated runner so it can send
   * messages back through the bridges held by the pool.
   */
  getOutbounds(agentId: string): ChannelHandle[] {
    return this.handles.get(agentId) ?? [];
  }

  getStatuses(agentId: string): ChannelStatus[] {
    return this.statuses.get(agentId) ?? [];
  }

  /** Webhook dispatch — called by the gateway HTTP webhook route. */
  async dispatchWebhook(
    agentId: string,
    channelName: string,
    req: WebhookRequest,
  ): Promise<WebhookResponse> {
    const handles = this.handles.get(agentId) ?? [];
    const handle = handles.find((h) => h.name === channelName);
    if (!handle || !handle.handleWebhook) {
      return { status: 404, body: 'channel not active or does not accept webhooks' };
    }
    return handle.handleWebhook(req);
  }

  /**
   * Start a single builtin channel (called from the channel-enable API).
   * If a runner is hot for the agent, the new outbound is also registered
   * on it so it can immediately send replies.
   *
   * Idempotent: if a handle already exists, it is stopped and replaced so
   * the bridge always reflects the current DB row (config/token changes
   * applied via PATCH take effect on the next enable call).
   */
  async enableChannel(agentId: string, channelName: string): Promise<ChannelStatus> {
    if (!this.opts.gatewayBaseUrl) {
      return { name: channelName, status: 'error', error: 'gateway base url not set' };
    }
    const row = await this.opts.channelStore.findBuiltin(agentId, channelName);
    if (!row || !row.enabled) {
      return { name: channelName, status: 'error', error: `Builtin channel ${channelName} is not enabled` };
    }
    const all = await this.opts.channelStore.loadActive();
    const loaded = all.find((c) => c.id === row.id);
    if (!loaded) {
      return { name: channelName, status: 'error', error: 'Failed to decrypt channel token' };
    }

    // Stop any existing handle for this channel so we never stack pollers.
    // Telegram getUpdates conflicts and stale-token 401s both trace back
    // to multiple bridges running for the same row.
    const existingHandles = this.handles.get(agentId) ?? [];
    const staleIdx = existingHandles.findIndex((h) => h.name === channelName);
    if (staleIdx !== -1) {
      const stale = existingHandles[staleIdx]!;
      try {
        await stale.stop();
      } catch (err) {
        this.opts.log(
          `[${agentId}] error stopping stale ${channelName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      existingHandles.splice(staleIdx, 1);
      const runner = this.opts.getRunner(agentId);
      if (runner) runner.getChannelOutbound().delete(channelName);
    }

    this.opts.channelRegistry.register({
      channelId: row.id,
      apiKey: loaded.token,
      namespace: row.namespace,
      agentId,
    });

    const manifest = this.opts.manifestRegistry.get(channelName);
    if (!manifest) {
      const errorStatus: ChannelStatus = {
        name: channelName,
        status: 'error',
        error: `no manifest registered for channel "${channelName}"`,
      };
      const statuses = this.statuses.get(agentId) ?? [];
      const existingIdx = statuses.findIndex((s) => s.name === channelName);
      if (existingIdx !== -1) statuses[existingIdx] = errorStatus;
      else statuses.push(errorStatus);
      this.statuses.set(agentId, statuses);
      return errorStatus;
    }

    const security = await this.loadSecurity(agentId);
    const resolved = await security.expandSecrets({ ...row.config, enabled: true });
    const agentBaseUrl = `${this.opts.gatewayBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;

    const { handle, status } = await startSingleChannel(manifest, resolved, {
      agentBaseUrl,
      agentTokens: { [manifest.key]: loaded.token },
      logger: (channel, msg) => this.opts.log(`[${agentId}] [${channel}] ${msg}`),
    });

    if (handle) {
      const handles = this.handles.get(agentId) ?? [];
      handles.push(handle);
      this.handles.set(agentId, handles);
      const runner = this.opts.getRunner(agentId);
      if (runner && handle.outbound) runner.registerChannelOutbound(handle.outbound);
      this.opts.log(`[${agentId}] pool started channel: ${channelName}`);
    }

    const statuses = this.statuses.get(agentId) ?? [];
    const existingIdx = statuses.findIndex((s) => s.name === channelName);
    if (existingIdx !== -1) statuses[existingIdx] = status;
    else statuses.push(status);
    this.statuses.set(agentId, statuses);

    return status;
  }

  /**
   * Stop a single builtin channel and unregister its outbound from a
   * hot runner if one exists.
   */
  async disableChannel(agentId: string, channelName: string): Promise<void> {
    const handles = this.handles.get(agentId) ?? [];
    const idx = handles.findIndex((h) => h.name === channelName);
    if (idx !== -1) {
      const handle = handles[idx]!;
      try {
        await handle.stop();
      } catch (err) {
        this.opts.log(
          `[${agentId}] error stopping ${channelName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      handles.splice(idx, 1);
      if (handles.length === 0) this.handles.delete(agentId);

      const runner = this.opts.getRunner(agentId);
      if (runner) runner.getChannelOutbound().delete(channelName);
    }

    this.opts.channelRegistry.unregister(`${agentId}:${channelName}:builtin`);

    const statuses = this.statuses.get(agentId) ?? [];
    const sIdx = statuses.findIndex((s) => s.name === channelName);
    if (sIdx !== -1) statuses.splice(sIdx, 1);
    if (statuses.length === 0) this.statuses.delete(agentId);

    this.opts.log(`[${agentId}] pool stopped channel: ${channelName}`);
  }

  /** Tear down all channels for one agent (e.g. on agent deletion). */
  async removeAgent(agentId: string): Promise<void> {
    const handles = this.handles.get(agentId);
    if (handles) {
      await stopChannelHandles(handles);
      this.handles.delete(agentId);
    }
    this.statuses.delete(agentId);
    this.opts.channelRegistry.unregisterByAgent(agentId);
  }

  /** Stop every bridge — gateway shutdown only. */
  async stopAll(): Promise<void> {
    const ids = [...this.handles.keys()];
    await Promise.all(ids.map((id) => this.removeAgent(id)));
  }
}
