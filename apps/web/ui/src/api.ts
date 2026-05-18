// ─── Storage keys ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'openhermit_connection';
const DEVICE_KEY_STORAGE = 'openhermit_device_key';
const JWT_STORAGE = 'openhermit_jwt';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Connection {
  gatewayUrl: string;
  agentId: string;
  token?: string;
  role?: 'owner' | 'user' | 'guest';
}

export interface TokenExchangeResult {
  token: string;
  expiresAt: number;
  isNewDevice: boolean;
  userId: string;
  displayName?: string;
}

export interface AgentMembership {
  agentId: string;
  role: 'owner' | 'user' | 'guest';
  name?: string;
  status: 'active' | 'disabled';
}

export interface SessionSummary {
  sessionId: string;
  source: { kind: string; platform?: string; interactive: boolean };
  status: string;
  createdAt: string;
  lastActivityAt: string;
  lastEventId: number;
  messageCount: number;
  description?: string;
  lastMessagePreview?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionAttachment {
  id?: string;
  type: string;
  name?: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  sandboxPath?: string;
  materializationState?: 'pending' | 'copied' | 'failed';
  materializationError?: string;
}

export interface HistoryMessage {
  ts?: string;
  role: string;
  content: string;
  name?: string;
  thinking?: string;
  tool?: string;
  toolCallId?: string;
  toolPhase?: 'call' | 'result';
  toolIsError?: boolean;
  toolArgs?: unknown;
  introspection?: boolean;
  introspectionPhase?: 'start' | 'end';
  introspectionSummary?: string;
  actions?: { type: string; [key: string]: unknown }[];
  metadata?: Record<string, unknown>;
  attachments?: SessionAttachment[];
}

export interface OutboundEvent {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

// ─── Device Key (ECDSA P-256) ──────────────────────────────────────────────

const bufToBase64url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

interface KeyPairResult {
  isNew: boolean;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

interface StoredDevice {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  displayName?: string;
}

const readDeviceStorage = (): StoredDevice | null => {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY_STORAGE) || 'null');
  } catch {
    return null;
  }
};

const writeDeviceStorage = (data: StoredDevice): void => {
  localStorage.setItem(DEVICE_KEY_STORAGE, JSON.stringify(data));
};

const loadOrCreateKeyPair = async (): Promise<KeyPairResult> => {
  const stored = readDeviceStorage();
  if (stored) {
    try {
      return {
        isNew: false,
        publicKey: await crypto.subtle.importKey('jwk', stored.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
        privateKey: await crypto.subtle.importKey('jwk', stored.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
      };
    } catch {
      localStorage.removeItem(DEVICE_KEY_STORAGE);
    }
  }
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported: StoredDevice = {
    publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
  };
  writeDeviceStorage(exported);
  return { isNew: true, ...keyPair };
};

let deviceKeyPair: KeyPairResult | null = null;

export const isNewDevice = (): boolean => deviceKeyPair?.isNew ?? !localStorage.getItem(DEVICE_KEY_STORAGE);

export const getDeviceFingerprint = async (): Promise<string> => {
  if (!deviceKeyPair) deviceKeyPair = await loadOrCreateKeyPair();
  const rawPub = await crypto.subtle.exportKey('raw', deviceKeyPair.publicKey);
  const hash = await crypto.subtle.digest('SHA-256', rawPub);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const generateDeviceKeyCredential = async (): Promise<string> => {
  if (!deviceKeyPair) deviceKeyPair = await loadOrCreateKeyPair();
  const rawPub = await crypto.subtle.exportKey('raw', deviceKeyPair.publicKey);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = new TextEncoder().encode(timestamp);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, deviceKeyPair.privateKey, payload);
  return `${bufToBase64url(rawPub)}.${timestamp}.${bufToBase64url(signature)}`;
};

// ─── Connection ────────────────────────────────────────────────────────────
//
// Gateway is set in the first connect step (gatewayUrl + display name →
// JWT). Picking an agent in the second step is decoupled from gateway
// auth — the JWT is gateway-level, and per-agent membership is checked
// per request.
//

let apiBase = '';
let gatewayBase = '';
let currentAgentId = '';

const STORAGE_GATEWAY_URL = 'openhermit_gateway_url';

export const loadConnection = (): Connection | null => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
};

export const saveConnection = (conn: Connection): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
};

export const clearConnection = (): void => {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(JWT_STORAGE);
};

export const loadGatewayUrl = (): string | null =>
  localStorage.getItem(STORAGE_GATEWAY_URL);

export const saveGatewayUrl = (url: string): void => {
  localStorage.setItem(STORAGE_GATEWAY_URL, url);
};

export const setGateway = (url: string): void => {
  gatewayBase = url.replace(/\/+$/, '');
};

export const setConnection = (conn: Connection): void => {
  const base = conn.gatewayUrl.replace(/\/+$/, '');
  gatewayBase = base;
  currentAgentId = conn.agentId;
  apiBase = `${base}/api/agents/${encodeURIComponent(conn.agentId)}`;
};

export const getApiBase = (): string => apiBase;
export const getGatewayBase = (): string => gatewayBase;

// ─── Device key export (for backup / multi-device) ─────────────────────────

/**
 * Export the device's JWK keypair as a JSON string. This is the FULL
 * private key — anyone who has it can authenticate as this device.
 * Treat it like a password and never paste into untrusted forms.
 */
export const exportDeviceKey = (): string | null => {
  const stored = readDeviceStorage();
  if (!stored) return null;
  return JSON.stringify({
    publicKey: stored.publicKey,
    privateKey: stored.privateKey,
    ...(stored.displayName ? { displayName: stored.displayName } : {}),
  }, null, 2);
};

/**
 * Restore a device key from a previously exported JSON string. Returns
 * `true` on success. Caller should then call `exchangeToken()` to get a
 * fresh JWT.
 */
export const importDeviceKey = (json: string): boolean => {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return false;
    if (!parsed.publicKey || !parsed.privateKey) return false;
    writeDeviceStorage({
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    });
    deviceKeyPair = null; // force reload on next use
    jwtToken = null;
    jwtExpiresAt = 0;
    localStorage.removeItem(JWT_STORAGE);
    return true;
  } catch {
    return false;
  }
};

// ─── Display name ──────────────────────────────────────────────────────────

export const getDisplayName = (): string | null => readDeviceStorage()?.displayName ?? null;

export const setDisplayName = (name: string): void => {
  const stored = readDeviceStorage();
  if (stored) {
    stored.displayName = name;
    writeDeviceStorage(stored);
  }
};

// ─── JWT management ────────────────────────────────────────────────────────

let jwtToken: string | null = null;
let jwtExpiresAt = 0;
let userRole: string | null = null;
let userId: string | null = null;

const loadJwt = (): void => {
  try {
    const stored = JSON.parse(localStorage.getItem(JWT_STORAGE) || 'null');
    if (stored?.token && stored?.expiresAt) {
      jwtToken = stored.token;
      jwtExpiresAt = stored.expiresAt;
    }
  } catch {
    localStorage.removeItem(JWT_STORAGE);
  }
};

const saveJwt = (token: string, expiresAt: number): void => {
  jwtToken = token;
  jwtExpiresAt = expiresAt;
  localStorage.setItem(JWT_STORAGE, JSON.stringify({ token, expiresAt }));
};

const isJwtValid = (): boolean =>
  !!jwtToken && jwtExpiresAt > Math.floor(Date.now() / 1000) + 60;

/**
 * Exchange the device key for a gateway-level JWT. This is the FIRST
 * step — only requires gateway URL + display name. The returned JWT
 * proves identity but grants nothing yet; per-agent access is gated by
 * subsequent /api/agents/:id/members calls.
 */
export const exchangeToken = async (displayName?: string | null): Promise<TokenExchangeResult> => {
  if (!gatewayBase) throw new Error('Gateway URL not set; call setGateway() first.');
  const deviceKey = await generateDeviceKeyCredential();
  const body: Record<string, unknown> = { grant_type: 'device-key', device_key: deviceKey };
  if (displayName) body.display_name = displayName;

  const response = await fetch(`${gatewayBase}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } }).error?.message || `Token exchange failed (${response.status})`);
  }

  const result = await response.json() as TokenExchangeResult;
  saveJwt(result.token, result.expiresAt);
  userId = result.userId;
  return result;
};

export const getJwt = async (): Promise<string> => {
  if (isJwtValid()) return jwtToken!;
  const result = await exchangeToken(getDisplayName());
  return result.token;
};

/** List the agents the current JWT subject has membership on. */
export const listMyAgents = async (): Promise<AgentMembership[]> => {
  if (!gatewayBase) throw new Error('Gateway URL not set.');
  const token = await getJwt();
  const res = await fetch(`${gatewayBase}/api/users/me/agents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } }).error?.message || `Failed to list agents (${res.status})`);
  }
  return res.json() as Promise<AgentMembership[]>;
};

/** Join an agent (assign self a guest membership; for protected agents
 *  the access token is required). After this, web can connect a chat. */
export const joinAgent = async (agentId: string, accessToken?: string): Promise<AgentMembership> => {
  if (!gatewayBase) throw new Error('Gateway URL not set.');
  const token = await getJwt();
  const body: Record<string, unknown> = {};
  if (accessToken) body.accessToken = accessToken;
  const res = await fetch(
    `${gatewayBase}/api/agents/${encodeURIComponent(agentId)}/members`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } }).error?.message || `Failed to join agent (${res.status})`);
  }
  return res.json() as Promise<AgentMembership>;
};

export const initJwt = (): void => { loadJwt(); };

// ─── WebSocket RPC client ─────────────────────────────────────────────────

type WsMethod =
  | 'session.open'
  | 'session.message'
  | 'session.approve'
  | 'session.checkpoint'
  | 'session.delete'
  | 'session.list'
  | 'session.history'
  | 'session.subscribe'
  | 'session.unsubscribe';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export type WsEventHandler = (eventId: number, sessionId: string, event: OutboundEvent) => void;
export type WsStatusHandler = (status: 'connecting' | 'connected' | 'disconnected') => void;

export class AgentWsClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private onEvent: WsEventHandler;
  private onStatus: WsStatusHandler;
  private onReconnect: (() => void) | null = null;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, number>(); // sessionId → lastEventId

  constructor(onEvent: WsEventHandler, onStatus: WsStatusHandler) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  setOnReconnect(cb: () => void): void { this.onReconnect = cb; }

  async connect(): Promise<void> {
    const token = await getJwt();
    const httpBase = getApiBase();
    const wsBase = httpBase.replace(/^http/, 'ws');
    const url = `${wsBase}/ws?token=${encodeURIComponent(token)}`;

    this.onStatus('connecting');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.onStatus('connected');
        resolve();
      };

      ws.onerror = () => {
        if (!this.ws) reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
        this.pending.clear();
        this.ws = null;
        if (!this.disposed) {
          this.onStatus('disconnected');
          this.scheduleReconnect();
        }
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.kind === 'response') {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } else if (msg.kind === 'event') {
            this.onEvent(msg.eventId, msg.sessionId, msg.event);
          }
        } catch { /* ignore malformed messages */ }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.onStatus('connecting');
      this.connect()
        .then(() => this.resubscribe())
        .then(() => this.onReconnect?.())
        .catch(() => {});
    }, delay);
  }

  private async resubscribe(): Promise<void> {
    for (const [sessionId, lastEventId] of this.subscriptions) {
      await this.send('session.subscribe', { sessionId, lastEventId }).catch(() => {});
    }
  }

  private send<T = unknown>(method: WsMethod, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }

  async listSessions(
    options: { limit?: number; observe?: boolean } = {},
  ): Promise<SessionSummary[]> {
    const { limit = 50, observe } = options;
    return this.send('session.list', { limit, ...(observe ? { observe: true } : {}) });
  }

  async openSession(sessionId: string): Promise<void> {
    await this.send('session.open', {
      sessionId,
      source: { kind: 'api', interactive: true, platform: 'web' },
      metadata: {},
    });
  }

  async getHistory(sessionId: string): Promise<HistoryMessage[]> {
    return this.send('session.history', { sessionId });
  }

  async subscribe(sessionId: string, lastEventId?: number): Promise<void> {
    this.subscriptions.set(sessionId, lastEventId ?? 0);
    await this.send('session.subscribe', { sessionId, lastEventId });
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.subscriptions.delete(sessionId);
    await this.send('session.unsubscribe', { sessionId }).catch(() => {});
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: SessionAttachment[],
  ): Promise<void> {
    await this.send('session.message', {
      sessionId,
      text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  }

  async approve(sessionId: string, toolCallId: string, approved: boolean): Promise<void> {
    await this.send('session.approve', { sessionId, toolCallId, approved });
  }

  async checkpoint(sessionId: string, reason: string): Promise<void> {
    await this.send('session.checkpoint', { sessionId, reason });
  }

  async interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
    return await this.send('session.interrupt', { sessionId }) as { interrupted: boolean };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.send('session.delete', { sessionId });
  }

  checkConnection(): void {
    if (this.disposed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.scheduleReconnect();
    }
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.ws?.close();
    this.ws = null;
  }

  private handleVisibility = (): void => {
    if (document.visibilityState === 'visible') this.checkConnection();
  };

  startVisibilityCheck(): void {
    document.addEventListener('visibilitychange', this.handleVisibility);
  }
}

// ─── User role ────────────────────────────────────────────────────────────

export const getUserRole = (): string | null => userRole;
export const getUserId = (): string | null => userId;

// ─── REST API helpers for management ──────────────────────────────────────

async function rawFetch<T>(url: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const token = await getJwt();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let bodyStr: string | undefined;
  if (options?.body !== undefined) {
    headers['content-type'] = 'application/json';
    bodyStr = JSON.stringify(options.body);
  }
  const res = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    ...(bodyStr ? { body: bodyStr } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } }).error?.message || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function apiFetch<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  return rawFetch<T>(`${gatewayBase}/api/agents/${encodeURIComponent(currentAgentId)}${path}`, options);
}

/** Call a non-agent-scoped gateway endpoint (e.g. /api/providers). */
export async function apiFetchGlobal<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  return rawFetch<T>(`${gatewayBase}${path}`, options);
}

/**
 * Upload a single file to the gateway and return the attachment wire shape
 * (id, name, mimeType, size, sandboxPath, …). Caller passes the returned
 * record on the next `session.message` so the agent runner can reference it.
 */
export async function uploadAttachment(
  sessionId: string,
  file: File,
): Promise<SessionAttachment> {
  const token = await getJwt();
  const form = new FormData();
  form.append('file', file, file.name);
  const url = `${gatewayBase}/api/agents/${encodeURIComponent(currentAgentId)}/sessions/${encodeURIComponent(sessionId)}/attachments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { error?: { message?: string } }).error?.message
        || `Upload failed (${res.status})`,
    );
  }
  const data = (await res.json()) as { attachment: SessionAttachment };
  return data.attachment;
}

// Agent info
export interface AgentInfo { agentId: string; name: string; status: string }
export const fetchAgentInfo = () => apiFetch<AgentInfo>('/info');

// Skills
export interface SkillInfo { id: string; name: string; description: string; path: string; source: string }
export const fetchSkills = () => apiFetch<SkillInfo[]>('/skills');
export const enableSkill = (id: string) => apiFetch<{ ok: boolean }>(`/skills/${encodeURIComponent(id)}/enable`, { method: 'POST' });
export const disableSkill = (id: string) => apiFetch<{ ok: boolean }>(`/skills/${encodeURIComponent(id)}/disable`, { method: 'POST' });

// MCP Servers
export interface McpServerInfo { id: string; name: string; description: string; url: string }
export const fetchMcpServers = () => apiFetch<McpServerInfo[]>('/mcp-servers');
export const enableMcpServer = (id: string) => apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(id)}/enable`, { method: 'POST' });
export const disableMcpServer = (id: string) => apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(id)}/disable`, { method: 'POST' });

// Schedules
export interface ScheduleInfo {
  scheduleId: string; type: string; status: string; prompt: string;
  cronExpression?: string; runAt?: string; delivery?: unknown;
  runCount: number; nextRunAt?: string; lastRunAt?: string;
  consecutiveErrors: number; createdAt: string; updatedAt: string;
}
export interface ScheduleRunInfo {
  runId: string; status: string; startedAt: string; finishedAt?: string;
  durationMs?: number; sessionId?: string; error?: string;
}
export const fetchSchedules = () => apiFetch<ScheduleInfo[]>('/schedules');
export const createSchedule = (data: Record<string, unknown>) => apiFetch<ScheduleInfo>('/schedules', { method: 'POST', body: data });
export const updateSchedule = (id: string, data: Record<string, unknown>) => apiFetch<ScheduleInfo>(`/schedules/${encodeURIComponent(id)}`, { method: 'PUT', body: data });
export const deleteSchedule = (id: string) => apiFetch<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const triggerSchedule = (id: string) => apiFetch<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}/trigger`, { method: 'POST' });
export const fetchScheduleRuns = (id: string) => apiFetch<ScheduleRunInfo[]>(`/schedules/${encodeURIComponent(id)}/runs`);

// Channels — unified for builtin (telegram/discord/slack) and external
// (owner-issued) tokens. The server returns a single list with `kind` and
// runtime status enriched on top of the DB row.
export type ChannelKind = 'builtin' | 'external';
export interface ChannelSecretKey { key: string; label: string; placeholder: string }
export interface ChannelInfo {
  id: string;
  agentId: string;
  kind: ChannelKind;
  channelType: string;
  namespace: string;
  label: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  /** Only for builtin rows: which env-var keys feed this channel. */
  secretKeys?: ChannelSecretKey[];
  /** Server-side check that those env vars are populated. */
  secretsSet: boolean;
  /** 'connected' | 'disabled' | 'error' | 'unknown' — derived from runtime. */
  runtimeStatus?: string;
  error?: string;
}
export interface CreatedChannel extends ChannelInfo {
  /** Plaintext token, only included on the create response. */
  token: string;
}
export const fetchChannels = () => apiFetch<ChannelInfo[]>('/channels');
export const patchChannel = (id: string, patch: { enabled?: boolean; label?: string | null; config?: Record<string, unknown> }) =>
  apiFetch<ChannelInfo>(`/channels/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
export const removeChannel = (id: string) =>
  apiFetch<{ ok: boolean }>(`/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const createExternalChannel = (input: { namespace: string; label?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
  apiFetch<CreatedChannel>('/channels', { method: 'POST', body: input });
export const createBuiltinChannel = (input: { channelType: string; label?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
  apiFetch<ChannelInfo>('/channels', { method: 'POST', body: input });

// Channel manifest catalog — drives the "Add channel" picker.
export interface ChannelManifestSummary {
  key: string;
  namespace: string;
  displayName: string;
  origin: 'built-in' | 'external';
  supportsSetup: boolean;
  secretKeys?: ChannelSecretKey[];
  defaultConfig?: Record<string, unknown>;
}
export const fetchChannelManifests = () =>
  apiFetchGlobal<ChannelManifestSummary[]>('/api/channel-manifests');

// Channel setup (interactive auth) — shuttles bytes between the UI and the
// plugin's `ChannelSetup.{begin,poll,submit,cancel}` handlers.
export interface ChannelSetupStateAwaitingInput {
  kind: 'awaiting_user_input';
  instructions?: string;
  fields: Array<{ name: string; label: string; type?: 'text' | 'password'; placeholder?: string }>;
}
export interface ChannelSetupStateAwaitingExternal {
  kind: 'awaiting_external';
  instructions?: string;
  qrText?: string;
  redirectUrl?: string;
  pollIntervalMs?: number;
}
export interface ChannelSetupStateDone {
  kind: 'done';
  config: Record<string, unknown>;
}
export interface ChannelSetupStateError {
  kind: 'error';
  message: string;
}
export type ChannelSetupState =
  | ChannelSetupStateAwaitingInput
  | ChannelSetupStateAwaitingExternal
  | ChannelSetupStateDone
  | ChannelSetupStateError;

export interface ChannelSetupResponse { sessionId: string; state: ChannelSetupState }

export const beginChannelSetup = (channelType: string, body: Record<string, unknown> = {}) =>
  apiFetch<ChannelSetupResponse>(
    `/channels/${encodeURIComponent(channelType)}/setup/begin`,
    { method: 'POST', body },
  );
export const pollChannelSetup = (channelType: string, sessionId: string) =>
  apiFetch<ChannelSetupResponse>(
    `/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
  );
export const submitChannelSetup = (channelType: string, sessionId: string, body: Record<string, unknown>) =>
  apiFetch<ChannelSetupResponse>(
    `/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
    { method: 'POST', body },
  );
export const cancelChannelSetup = (channelType: string, sessionId: string) =>
  apiFetch<{ ok: boolean }>(
    `/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );

// Agent config (basic settings)
export interface AgentConfig {
  workspace_root?: string;
  model: { provider: string; model: string; max_tokens?: number; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high'; base_url?: string; api?: string };
  [key: string]: unknown;
}
export const fetchAgentConfig = () => apiFetch<AgentConfig>('/config');
export const putAgentConfig = (config: AgentConfig) => apiFetch<{ ok: boolean }>('/config', { method: 'PUT', body: config });

// Provider catalog (static, global — sourced from pi-ai's model registry)
export interface ProviderCatalogEntry { provider: string; models: { id: string; reasoning: boolean }[] }
export const fetchProviderCatalog = () => apiFetchGlobal<ProviderCatalogEntry[]>('/api/providers');

// Policies
export interface PolicyInfo {
  id: string;
  agentId: string;
  resourceType: string;
  resourceKey: string;
  effect: 'allow' | 'deny' | 'require_approval';
  grants: Array<{ type: 'any' | 'role' | 'user'; value?: string }>;
  scope: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export const fetchPolicies = (resourceType?: string) => {
  const params = resourceType ? `?resourceType=${encodeURIComponent(resourceType)}` : '';
  return apiFetch<PolicyInfo[]>(`/policies${params}`);
};
export const upsertPolicy = (data: {
  resourceType: string;
  resourceKey: string;
  effect?: string;
  grants: Array<{ type: string; value?: string }>;
  scope?: Record<string, unknown>;
}) => apiFetch<PolicyInfo>('/policies', { method: 'POST', body: data });
export const deletePolicy = (resourceType: string, resourceKey: string, effect?: string) => {
  const qs = effect ? `?effect=${encodeURIComponent(effect)}` : '';
  return apiFetch<{ ok: boolean }>(`/policies/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceKey)}${qs}`, { method: 'DELETE' });
};

// ── Approval Requests ──────────────────────────────────────────────

export interface ApprovalRequestInfo {
  id: string;
  agentId: string;
  sessionId: string;
  requesterId: string;
  resourceType: string;
  resourceKey: string;
  scope: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  resolution: 'once' | 'persistent' | null;
  resolvedBy: string | null;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  ttlMinutes: number;
}

export const fetchApprovalRequests = (status?: string) => {
  const params = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<ApprovalRequestInfo[]>(`/approvals${params}`);
};

export const reviewApprovalRequest = (id: string, data: {
  decision: 'approved' | 'rejected';
  resolution?: 'once' | 'persistent';
  reason?: string;
}) => apiFetch<ApprovalRequestInfo>(`/approvals/${encodeURIComponent(id)}/review`, {
  method: 'POST',
  body: data,
});

// Secrets — server returns each entry as { masked, passThrough }. When
// passThrough is true, the secret is injected as an env var into the
// agent's sandboxes at startup. Use setAgentSecret / deleteAgentSecret
// for per-key edits.
export interface AgentSecretEntry {
  masked: string;
  passThrough: boolean;
}
export const fetchAgentSecrets = () =>
  apiFetch<Record<string, AgentSecretEntry>>('/secrets');
export const setAgentSecret = (
  name: string,
  value: string,
  options?: { passThrough?: boolean },
) =>
  apiFetch<{ ok: boolean }>(`/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: options?.passThrough !== undefined
      ? { value, passThrough: options.passThrough }
      : { value },
  });
export const setAgentSecretPassThrough = (name: string, passThrough: boolean) =>
  apiFetch<{ ok: boolean }>(`/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: { passThrough },
  });
export const deleteAgentSecret = (name: string) =>
  apiFetch<{ ok: boolean }>(`/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
