import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  jsonb,
  serial,
  bigserial,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const agents = pgTable('agents', {
  agentId: text('agent_id').primaryKey(),
  name: text('name'),
  workspaceDir: text('workspace_dir').notNull(),
  /** Canonical agent runtime config (JSON-stringified). Replaces config.json. */
  configJson: text('config_json'),
  /** Canonical agent security policy (JSON-stringified). Replaces security.json. */
  securityJson: text('security_json'),
  backendState: jsonb('backend_state').$type<Record<string, unknown>>(),
  /**
   * Source of truth for whether this agent accepts requests. The gateway's
   * in-memory runner Map is just a hydration cache; this column decides
   * policy. Values: 'active' | 'disabled'.
   */
  status: text('status').default('active').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_agents_status').on(table.status),
]);

export const sessions = pgTable('sessions', {
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourcePlatform: text('source_platform'),
  interactive: integer('interactive').notNull(),
  createdAt: text('created_at').notNull(),
  lastActivityAt: text('last_activity_at').notNull(),
  description: text('description'),
  descriptionSource: text('description_source'),
  messageCount: integer('message_count').default(0).notNull(),
  completedTurnCount: integer('completed_turn_count').default(0).notNull(),
  lastMessagePreview: text('last_message_preview'),
  workingMemory: text('working_memory'),
  workingMemoryUpdatedAt: text('working_memory_updated_at'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  status: text('status').default('idle').notNull(),
  type: text('type').default('direct').notNull(),
  userIds: jsonb('user_ids').$type<string[]>().default([]).notNull(),
  /** Caller-supplied per-session prompt addendum, set once at create. */
  customInstruction: text('custom_instruction'),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.sessionId] }),
  index('idx_sessions_agent').on(table.agentId, table.lastActivityAt),
  // GIN index supports `WHERE user_ids @> '["..."]'` containment lookups
  // used to find every session a given user has touched.
  index('idx_sessions_user_ids_gin').using('gin', table.userIds),
]);

export const sessionEvents = pgTable('session_events', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  ts: text('ts').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  content: text('content'),
  userId: text('user_id'),
}, (table) => [
  index('idx_session_events_agent_session').on(table.agentId, table.sessionId, table.ts),
  index('idx_session_events_type').on(table.agentId, table.sessionId, table.eventType, table.id),
]);

/**
 * Per-agent channel registrations — both built-in (telegram/discord/slack
 * adapters running in-process) and owner-issued external channels. Each
 * row carries:
 *  - an AES-256-GCM-encrypted access token (the bridge sends it as
 *    `Bearer …`; resolved into a ChannelRegistration scoped to the
 *    row's namespace);
 *  - a per-channel config blob (bot tokens, webhook URLs, etc. — the
 *    same shape that used to live in agents.config_json.channels.X);
 *  - an enabled flag toggled by owner / admin.
 *
 * Built-in rows are auto-created when an agent is created (one per
 * supported builtin channel kind, all initially disabled). External rows
 * are created on demand via POST /api/agents/:id/channels.
 */
export const agentChannels = pgTable('agent_channels', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  /** 'builtin' or 'external'. */
  kind: text('kind').notNull(),
  /** For builtin: the adapter type ('telegram', 'discord', 'slack').
   *  For external: identical to namespace, free-form. */
  channelType: text('channel_type').notNull(),
  namespace: text('namespace').notNull(),
  label: text('label'),
  enabled: boolean('enabled').default(false).notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
  /** Plaintext prefix (first 12 chars) for display in admin UI. */
  tokenPrefix: text('token_prefix').notNull(),
  /** Full token, encrypted with OPENHERMIT_SECRETS_KEY. */
  tokenCiphertext: text('token_ciphertext').notNull(),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  /** Last bridge-start error, surfaced in the channels list UI. */
  lastError: text('last_error'),
  lastErrorAt: text('last_error_at'),
}, (table) => [
  index('idx_agent_channels_agent').on(table.agentId),
]);

/**
 * Per-agent secrets, encrypted at rest with AES-256-GCM. The wire format
 * stored in `value_ciphertext` is `iv:authTag:ciphertext` (base64), and
 * the encryption key comes from the OPENHERMIT_SECRETS_KEY env var (32
 * bytes after base64 decoding).
 */
export const agentSecrets = pgTable('agent_secrets', {
  agentId: text('agent_id').notNull(),
  name: text('name').notNull(),
  valueCiphertext: text('value_ciphertext').notNull(),
  /**
   * When true, the secret's plaintext value is injected into sandboxes as
   * an environment variable at startup. Tools running inside the sandbox
   * can then read it via `process.env[NAME]`. Default false — secrets are
   * only used for agent config interpolation.
   */
  passThrough: boolean('pass_through').default(false).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.name] }),
]);

export const memories = pgTable('memories', {
  agentId: text('agent_id').notNull(),
  memoryKey: text('memory_key').notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  grants: jsonb('grants').$type<unknown[]>().default([]).notNull(),
  createdAt: text('created_at').default('').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.memoryKey] }),
  index('idx_memories_agent').on(table.agentId, table.updatedAt),
]);

/**
 * One row per agent sandbox. Replaces the old `containers` table and
 * subsumes the per-agent `agents.backend_state` blob. The DB is now the
 * source of truth for "what sandboxes exist for this agent" — agent boot
 * reads this table, no exec.backends[] in agent config anymore.
 *
 * Each row is identified by a uuid `id`. Within an agent, sandboxes have
 * a unique `alias` (default `default`) used by exec callers to pick a
 * target. `external_id` holds the backend-specific handle (docker
 * container name, e2b sandbox id; null for host).
 */
export const sandboxes = pgTable('sandboxes', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  alias: text('alias').notNull(),
  /** 'host' | 'docker' | 'e2b' | 'daytona' (future) */
  type: text('type').notNull(),
  externalId: text('external_id'),
  /** 'pending' | 'provisioned' | 'deleted' — see SandboxStatus type. */
  status: text('status').default('pending').notNull(),
  /** Backend creation params: image/template, agent_home, username, lifecycle/timeouts. */
  config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
  /** Mutable runtime state (e.g. e2b pendingSkillManifest). Updated as needed. */
  runtimeState: jsonb('runtime_state').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSeenAt: text('last_seen_at'),
}, (table) => [
  index('idx_sandboxes_agent').on(table.agentId),
  index('idx_sandboxes_agent_alias').on(table.agentId, table.alias),
  index('idx_sandboxes_type_external').on(table.type, table.externalId),
]);

export const approvalRequests = pgTable('approval_requests', {
  id: text('id').primaryKey(),
  shortId: bigserial('short_id', { mode: 'number' }).notNull(),
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  requesterId: text('requester_id').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceKey: text('resource_key').notNull(),
  scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('pending'),
  resolution: text('resolution'),
  resolvedBy: text('resolved_by'),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  ttlMinutes: integer('ttl_minutes').notNull().default(60),
}, (table) => [
  index('idx_approval_requests_agent').on(table.agentId, table.status),
  index('idx_approval_requests_lookup').on(table.agentId, table.requesterId, table.resourceType, table.resourceKey, table.status),
  uniqueIndex('idx_approval_requests_short_id').on(table.shortId),
]);

export const agentPolicies = pgTable('agent_policies', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceKey: text('resource_key').notNull(),
  effect: text('effect').notNull().default('allow'),
  grants: jsonb('grants').$type<unknown[]>().notNull().default([]),
  scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_agent_policies_agent_type').on(table.agentId, table.resourceType),
]);

export const instructions = pgTable('instructions', {
  agentId: text('agent_id').notNull(),
  key: text('key').notNull(),
  content: text('content').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.key] }),
]);

export const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  name: text('name'),
  mergedInto: text('merged_into'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_users_updated').on(table.updatedAt),
]);

export const userAgents = pgTable('user_agents', {
  userId: text('user_id').notNull(),
  agentId: text('agent_id').notNull(),
  role: text('role').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.agentId] }),
  index('idx_user_agents_agent').on(table.agentId),
]);

export const userIdentities = pgTable('user_identities', {
  userId: text('user_id').notNull(),
  channel: text('channel').notNull(),
  channelUserId: text('channel_user_id').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.channel, table.channelUserId] }),
  index('idx_user_identities_user').on(table.userId),
]);

export const skills = pgTable('skills', {
  // Storage PK. For source='system' this equals `slug`. For source='user' it
  // is encoded as `user:<owner_agent_id>:<slug>` so the same slug can coexist
  // across owners. Consumers should treat this as opaque and use `slug` for
  // the user-visible identifier (folder name, prompt index).
  id: text('id').primaryKey(),
  // User-visible identifier — becomes the basename of the synced skill
  // directory and the id the LLM sees. Unique among system skills; unique
  // per (owner_agent_id) among user skills (enforced via partial unique
  // indexes added in migration 0030).
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  path: text('path').notNull(),
  // 'system' = operator-managed; synced into <agentHome>/.openhermit/skills/system/.
  // 'user'   = owner-installed via skill_install; synced into .../skills/user/.
  source: text('source').notNull().default('system'),
  // Only set for source='user'. Server-side guard so an owner can't uninstall
  // a peer's skill (or a system skill) by guessing the id.
  ownerAgentId: text('owner_agent_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_skills_owner_agent').on(table.ownerAgentId),
  // Mirrors the partial unique indexes created in migration 0030. Source of
  // truth lives here so drizzle-kit generate stays consistent with the
  // applied schema.
  uniqueIndex('skills_system_slug_unique')
    .on(table.slug)
    .where(sql`source = 'system'`),
  uniqueIndex('skills_user_owner_slug_unique')
    .on(table.ownerAgentId, table.slug)
    .where(sql`source = 'user'`),
]);

export const agentSkills = pgTable('agent_skills', {
  agentId: text('agent_id').notNull(),
  skillId: text('skill_id').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.skillId] }),
  index('idx_agent_skills_agent').on(table.agentId),
]);

export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  url: text('url').notNull(),
  headers: jsonb('headers').$type<Record<string, string>>().default({}).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentMcpServers = pgTable('agent_mcp_servers', {
  agentId: text('agent_id').notNull(),
  mcpServerId: text('mcp_server_id').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.mcpServerId] }),
  index('idx_agent_mcp_servers_agent').on(table.agentId),
]);

export const schedules = pgTable('schedules', {
  agentId: text('agent_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  type: text('type').notNull(),
  status: text('status').default('active').notNull(),
  cronExpression: text('cron_expression'),
  runAt: text('run_at'),
  prompt: text('prompt').notNull(),
  sessionMode: text('session_mode').default('dedicated').notNull(),
  delivery: jsonb('delivery').$type<unknown>().default({ kind: 'silent' }).notNull(),
  policy: jsonb('policy').$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  runCount: integer('run_count').default(0).notNull(),
  consecutiveErrors: integer('consecutive_errors').default(0).notNull(),
  lastError: text('last_error'),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.scheduleId] }),
  index('idx_schedules_agent_status').on(table.agentId, table.status),
  index('idx_schedules_next_run').on(table.agentId, table.nextRunAt),
]);

/**
 * Per-session uploaded files. The byte payload lives in an
 * `AttachmentStorage` provider (local disk / s3 / supabase); this row is
 * the metadata of record. See `docs/file-attachments-design.md`.
 *
 * `materialization_state` tracks whether the file is currently mirrored
 * into the agent's sandbox as a regular file (so `file_read` / `exec`
 * can see it directly). Multimodal user prompts inline small images
 * directly into the model context; everything else is referenced by
 * its sandbox path or fetched via `attachment_fetch`.
 */
export const sessionAttachments = pgTable('session_attachments', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  /** Authenticated user who uploaded the file, when known. */
  uploaderUserId: text('uploader_user_id'),
  /** Original client-supplied filename, preserved for display. */
  originalName: text('original_name').notNull(),
  /** Sanitized filename used in sandbox paths. */
  safeName: text('safe_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  /** 'local' | 's3' | 'supabase' (future) */
  storageProvider: text('storage_provider').notNull(),
  /** Provider-internal object key — never exposed to the model. */
  storageKey: text('storage_key').notNull(),
  /** Sandbox that currently has a materialized copy, if any. */
  sandboxId: text('sandbox_id'),
  /** Agent-visible path inside the sandbox, if materialized. */
  sandboxPath: text('sandbox_path'),
  /** 'pending' | 'copied' | 'failed' — guarded by a CHECK constraint. */
  materializationState: text('materialization_state').default('pending').notNull(),
  materializationError: text('materialization_error'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_session_attachments_session').on(table.agentId, table.sessionId, table.createdAt),
  // Powers `attachment_list` with `scope: 'user'` — every file a given
  // user uploaded under this agent, newest first.
  index('idx_session_attachments_user').on(table.agentId, table.uploaderUserId, table.createdAt),
  index('idx_session_attachments_sha256').on(table.sha256),
]);

export const scheduleRuns = pgTable('schedule_runs', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  status: text('status').notNull(),
  sessionId: text('session_id'),
  prompt: text('prompt').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  durationMs: integer('duration_ms'),
  error: text('error'),
}, (table) => [
  index('idx_schedule_runs_schedule').on(table.agentId, table.scheduleId, table.startedAt),
]);
