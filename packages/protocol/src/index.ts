export type KnownSourceKind = 'cli' | 'api' | 'channel' | 'schedule';

export type SourceKind = KnownSourceKind | (string & {});

export type MetadataValue = string | number | boolean;

export type SessionType = 'direct' | 'group';

export interface SessionSource {
  kind: SourceKind;
  interactive: boolean;
  platform?: string;
  triggerId?: string;
  type?: SessionType;
}

export interface MessageSender {
  channel: string;
  channelUserId: string;
  displayName?: string;
}

/**
 * A participant in a group session. Sent with each group message so the agent
 * knows who it can address: it strips a copied `[Name]` speaker tag and rewrites
 * `@Name` references into platform mention markup. `handle` is optional because
 * not every participant kind has one.
 */
export interface MessageParticipant {
  id: string;
  type: string;
  displayName: string;
  handle?: string;
}

export interface MessageMention {
  id: string;
  type: string;
}

export interface SessionSpec {
  sessionId: string;
  source: SessionSource;
  metadata?: Record<string, MetadataValue>;
  /**
   * Optional per-session prompt addendum stored on the session row at
   * create time. When non-empty, the runner appends it to the system
   * prompt as a dedicated section after agent-level instructions.
   * Immutable for the life of the session.
   */
  customInstruction?: string;
}

export type AttachmentMaterializationState =
  | 'pending'
  | 'copied'
  | 'failed';

/**
 * Attachment reference on a session message.
 *
 * Two input shapes are supported on `postMessage` / `appendMessage`:
 *
 * 1. **id-shape** — bytes already uploaded via `POST /attachments`; pass
 *    `{ type, id }`. Authoritative handle; durable bytes + metadata live on
 *    the gateway under that id.
 * 2. **url-passthrough** — bytes live in external storage (signed URL,
 *    public CDN, etc.); pass `{ type: 'file', url, mimeType?, name? }`.
 *    The gateway will GET the URL server-side, persist into
 *    `session_attachments`, materialize into the sandbox, and inject into
 *    the current turn's model context. Failures throw
 *    `attachment_fetch_failed` (400) — the whole `postMessage` fails so the
 *    caller can retry; bytes are never silently dropped. SSRF guard
 *    requires https and refuses private / loopback / link-local hosts.
 *
 * On output (history entries, events), only the id-shape is returned —
 * url-passthrough inputs are persisted and surfaced with their resolved
 * `id`. `sandboxPath` is a convenience pointer for the model and may go
 * stale if the sandbox is rebuilt; tools should resolve through `id`.
 *
 * Inline base64 (`data`) remains legacy / back-compat only.
 */
export interface SessionAttachment {
  id?: string;
  type: string;
  name?: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  sandboxPath?: string;
  materializationState?: AttachmentMaterializationState;
  /**
   * URL-passthrough input: gateway fetches and persists the URL into
   * `session_attachments` on receive, then injects the resolved attachment
   * into the current turn's model context. Must be https; gateway rejects
   * private / loopback / link-local / cloud-metadata hosts. Mutually
   * exclusive with `id` (id-shape wins).
   */
  url?: string;
  /** Legacy: inline base64 payload (kept for back-compat). */
  data?: string;
}

export interface SessionMessage {
  messageId?: string;
  text: string;
  attachments?: SessionAttachment[];
  sender?: MessageSender;
  /** Group roster for this message: who the agent can address / mention. */
  participants?: MessageParticipant[];
  metadata?: Record<string, unknown>;
  /** Whether the bot was explicitly mentioned. When false in a group session,
   *  the server may inject instead of prompting based on user role. */
  mentioned?: boolean;
  /**
   * Record this entry in session history under the given role instead of
   * the default `'user'`. **Only honoured by `appendMessage`**; rejected
   * on `postMessage` (which always represents a user-driven turn).
   *
   * Restricted to `'user' | 'assistant'`. Other history roles (`tool`,
   * `error`, `introspection`) are server-internal and cannot be forged
   * by clients.
   *
   * Primary use case: shared-account / autopilot flows where the owner
   * sometimes acts as the assistant directly inside a third-party
   * conversation, and the agent's history needs to record those turns
   * as assistant so the persona stays consistent when autopilot resumes.
   */
  appendAs?: 'user' | 'assistant';
  /**
   * Wall-clock time the message actually occurred at. When set on
   * `appendMessage`, used as the persisted entry's `ts`, so out-of-order
   * backfill preserves chronological history order. ISO 8601. Default =
   * server-now.
   */
  occurredAt?: string;
}

export type SessionHistoryRole = 'user' | 'assistant' | 'error' | 'tool' | 'introspection';

export interface SessionHistoryMessage {
  ts: string;
  role: SessionHistoryRole;
  content: string;
  name?: string;
  messageId?: string;
  attachments?: SessionAttachment[];
  provider?: string;
  model?: string;
  stopReason?: string;
  thinking?: string;
  tool?: string;
  toolCallId?: string;
  toolPhase?: 'call' | 'result';
  toolIsError?: boolean;
  toolArgs?: unknown;
  /** True for tool_call/tool_result entries emitted as part of an introspection turn. */
  introspection?: boolean;
  introspectionPhase?: 'start' | 'end';
  introspectionSummary?: string;
  /** Per-message metadata supplied by the caller on user turns. Persisted
   *  alongside the log entry; surfaced for plugins/tools, not the model. */
  metadata?: Record<string, unknown>;
  /** Inline interactive affordances rendered with this message
   *  (e.g. approval Approve/Reject buttons on owner inbox notifications). */
  actions?: ChannelMessageAction[];
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'inactive';

export interface SessionSummary {
  sessionId: string;
  source: SessionSource;
  createdAt: string;
  lastActivityAt: string;
  lastEventId: number;
  messageCount: number;
  description?: string;
  lastMessagePreview?: string;
  status: SessionStatus;
  metadata?: Record<string, MetadataValue>;
  /**
   * Internal userIds that participate in this session. Populated by the
   * gateway when the caller's auth mode warrants exposure (admin, owner
   * observation mode) so the UI can identify "whose session is this"; left
   * undefined for ordinary user-mode listings.
   */
  userIds?: string[];
}

export interface SessionListQuery {
  kind?: SourceKind;
  platform?: string;
  interactive?: boolean;
  limit?: number;
  /** Filter by session ID prefix (e.g. "telegram:" to match a channel namespace). */
  channel?: string;
  /** Filter by metadata key-value pairs (e.g. { telegram_chat_id: "123" }). */
  metadata?: Record<string, string>;
  /** Include inactive sessions (replaced by /new). Default false. */
  includeInactive?: boolean;
  /**
   * Owner observation mode: return sessions on this agent where the caller
   * is NOT a participant. Requires the caller's role on the agent to be
   * `owner`; ignored (returns []) for other roles. Used by the web UI's
   * "Observation Mode" view to let owners peek into channel sessions they
   * weren't part of.
   */
  observe?: boolean;
}

/**
 * Identity of the caller making a WS/HTTP request.
 * Used to resolve the internal userId before session operations.
 * Channels attach this based on their authentication mechanism
 * (e.g. Telegram user_id, web device UUID, OS username for CLI).
 */
export interface CallerIdentity {
  channel: string;
  channelUserId: string;
}

export const isCallerIdentity = (value: unknown): value is CallerIdentity =>
  isRecord(value) &&
  typeof value.channel === 'string' &&
  typeof value.channelUserId === 'string';

/**
 * Body of an outbound event without the per-event identifier. Producers emit
 * this shape; the runtime mints `eventId` before delivering to consumers.
 *
 * `correlationId` (where present) is the inbound user-message id that
 * triggered the turn. It is NOT a per-event id — multiple events in the same
 * turn share the same `correlationId`. Consumers persisting events by id
 * MUST use `eventId` (added by the runtime), not `correlationId`.
 */
export type OutboundEventBody =
  | { type: 'thinking_delta'; sessionId: string; text: string; correlationId?: string }
  | { type: 'thinking_final'; sessionId: string; text: string; correlationId?: string }
  | { type: 'text_delta'; sessionId: string; text: string; correlationId?: string }
  | {
      type: 'text_final';
      sessionId: string;
      text: string;
      correlationId?: string;
      /** Group participants the agent mentioned in this reply (for notifications). */
      mentions?: MessageMention[];
    }
  | { type: 'tool_call'; sessionId: string; tool: string; toolCallId: string; args?: unknown; correlationId?: string }
  | {
      type: 'tool_result';
      sessionId: string;
      tool: string;
      toolCallId: string;
      isError: boolean;
      text?: string;
      details?: unknown;
      correlationId?: string;
    }
  | {
      type: 'approval_requested';
      sessionId: string;
      requestId?: string;
      resourceType: string;
      resourceKey: string;
      toolCallId?: string;
      args?: unknown;
      mode: 'realtime' | 'async';
    }
  | {
      type: 'approval_pending';
      sessionId: string;
      requestId?: string;
      resourceType: string;
      resourceKey: string;
      requesterId: string;
      requesterSessionId: string;
      args?: unknown;
      mode: 'async';
    }
  | {
      type: 'approval_resolved';
      sessionId: string;
      requestId?: string;
      resourceType: string;
      resourceKey: string;
      toolCallId?: string;
      decision: 'approved' | 'rejected' | 'timed_out' | 'cancelled';
      resolution?: 'once' | 'persistent';
      reviewerId?: string;
      mode: 'realtime' | 'async';
    }
  | { type: 'user_message'; sessionId: string; text: string; name?: string }
  | {
      /**
       * Outbound attachment emitted by the agent (e.g. `attachment_send`
       * tool). Channels subscribe to this event to deliver the bytes to the
       * end user — Telegram streams via Bot API, the web UI inlines via
       * `<img>` / `<audio>` / `<video>` etc. Bytes are fetched lazily by
       * the channel against `GET /api/agents/:agentId/sessions/:sessionId/attachments/:attachmentId/bytes`.
       */
      type: 'attachment';
      sessionId: string;
      attachmentId: string;
      mimeType: string;
      /** Coarse rendering hint: image, audio, video, document (other/binary). */
      kind: 'image' | 'audio' | 'video' | 'document';
      name?: string;
      size?: number;
      sha256?: string;
      caption?: string;
      correlationId?: string;
    }
  | { type: 'agent_start'; sessionId: string; correlationId?: string }
  | { type: 'agent_end'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string };

export type OutboundEvent = OutboundEventBody & { eventId: string };

// ── Channel Outbound ──────────────────────────────────────────────────

export interface ChannelOutboundResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface ChannelMessageAction {
  type: 'approval_review';
  requestId: string;
  shortId: number;
  label?: string;
}

/**
 * Interface for channel adapters that support outbound (proactive) messaging.
 * Implementations send the message via the channel API. The caller (e.g. the
 * `session_send` tool) is responsible for recording the delivery as an
 * assistant log entry in the target session.
 */
export interface ChannelOutbound {
  readonly channel: string;
  send(params: {
    sessionId: string;
    to: string;
    text: string;
    actions?: ChannelMessageAction[];
  }): Promise<ChannelOutboundResult>;
}

/**
 * Per-agent, per-channel credential storage exposed to channel manifests.
 *
 * The gateway scopes implementations to one `(agentId, channelType)` before
 * handing them to plugins, so plugins only address profiles and keys. Values
 * are opaque strings; the backing store decides encryption and persistence.
 */
export interface ChannelCredentialStore {
  get(profile: string, key: string): Promise<string | undefined>;
  list(profile: string): Promise<Record<string, string>>;
  set(profile: string, key: string, value: string): Promise<void>;
  delete(profile: string, key: string): Promise<void>;
  replace(profile: string, values: Record<string, string>): Promise<void>;
  clear(profile: string): Promise<void>;
}

// ── Channel Plugin Contract ───────────────────────────────────────────
//
// The types below define the stable contract a channel plugin package
// implements. Third-party channel packages (e.g. `@vendor/channel-foo`)
// should depend only on `@openhermit/protocol` for these types so they
// stay decoupled from the agent/gateway runtime internals.
//
// See `docs/channel-plugin-design.md` for the architecture and
// migration plan.

/**
 * Per-agent boot context passed to a manifest's `start()`. The adapter
 * uses `agentBaseUrl` + `agentTokens[<key>]` to authenticate callbacks
 * into the agent HTTP API.
 */
export interface ChannelContext {
  agentBaseUrl: string;
  /**
   * Public-facing equivalent of `agentBaseUrl`. Used by manifests that
   * register a URL with an external service that must POST back over
   * the public internet (e.g. Telegram `setWebhook`). Falls back to
   * `agentBaseUrl` when the gateway has no public URL configured.
   */
  publicAgentBaseUrl: string;
  agentTokens: Record<string, string>;
  logger: (channel: string, message: string) => void;
  /**
   * Report a transient runtime error (e.g. long-poll auth failure,
   * upstream rate-limit) so the gateway can surface it in the channels
   * list. Pass `null` once the channel recovers. Repeating the same
   * value is cheap — the gateway dedupes.
   */
  reportRuntimeError: (error: string | null) => void;
  /**
   * Optional durable credential storage for channel-owned auth state
   * (for example Baileys signal keys). Available only when the gateway has
   * DB-backed encrypted credential storage configured.
   */
  credentialStore?: ChannelCredentialStore;
}

/**
 * HTTP request handed to a channel's webhook handler. The gateway
 * forwards `POST /api/agents/:agentId/channels/:namespace/webhook` to
 * this handler when present.
 */
export interface WebhookRequest {
  headers: Record<string, string>;
  rawBody: string;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse>;

/**
 * Live channel instance returned from `start()`. The gateway's
 * ChannelPool owns the handle and calls `stop()` on shutdown / disable.
 */
export interface ChannelHandle {
  name: string;
  outbound?: ChannelOutbound;
  stop: () => Promise<void>;
  /**
   * Optional webhook handler. When present, the gateway forwards
   * `POST /api/agents/:agentId/channels/:namespace/webhook` here. The
   * adapter is responsible for verifying authenticity (Telegram
   * `secret_token`, Slack HMAC, Discord ed25519, …).
   */
  handleWebhook?: WebhookHandler;
}

/**
 * A channel plugin's default export. Describes the channel to the
 * runtime registry, the admin UI, and the boot sequence.
 *
 * Plugin authors export this as the package default:
 *
 * ```ts
 * const manifest: ChannelManifest = {
 *   key: 'signal',
 *   namespace: 'signal',
 *   displayName: 'Signal',
 *   start: startSignal,
 * };
 * export default manifest;
 * ```
 */
/** Highest manifest version supported by this build of the protocol. */
export const CHANNEL_MANIFEST_VERSION = 1 as const;

/**
 * A secret the channel needs at runtime. Surfaces in the admin UI as a
 * masked input; the value is written to the agent's secret store under
 * `key` and the persisted config references it via the `${{KEY}}`
 * placeholder.
 */
export interface ChannelSecretKeySpec {
  /** Env-var-style key, e.g. `DEBOX_API_KEY`. */
  key: string;
  /** Label rendered next to the input. */
  label: string;
  /** Placeholder shown in the empty input. */
  placeholder?: string;
  /**
   * When `true`, the channel can start without this secret set — the
   * gateway won't include it in the "secrets missing" check, and the
   * plugin's `start()` is expected to treat the unresolved placeholder
   * as unset (see Debox API Secret for the canonical example).
   */
  optional?: boolean;
}

/**
 * A non-secret config field rendered by the admin UI. Plugins declare a
 * `configFields` array; the UI renders a typed control per entry and
 * merges the captured values into the persisted config (on top of
 * `defaultConfig`).
 *
 * The `showWhen` predicate lets a field appear conditionally based on
 * another field's value — e.g. a webhook-URL panel that only shows when
 * `mode === 'webhook'`.
 */
export type ChannelConfigField =
  | {
      kind: 'select';
      key: string;
      label: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      defaultValue?: string;
      help?: string;
      showWhen?: { field: string; equals: string };
    }
  | {
      kind: 'text';
      key: string;
      label: string;
      placeholder?: string;
      help?: string;
      showWhen?: { field: string; equals: string };
    }
  | {
      kind: 'string_list';
      key: string;
      label: string;
      placeholder?: string;
      help?: string;
      showWhen?: { field: string; equals: string };
    }
  | {
      /**
       * Read-only display of the webhook URL the gateway will dispatch
       * to. The UI computes the URL from `window.location.origin` plus
       * the channel's namespace; no `key` is needed because nothing is
       * persisted.
       */
      kind: 'webhook_url';
      label: string;
      help?: string;
      showWhen?: { field: string; equals: string };
    };

export interface ChannelManifest {
  /**
   * Manifest contract version. Always `1` in this revision. Plugins built
   * against a future, incompatible revision will set a higher number; the
   * loader rejects unknown versions with a clear error so an operator can
   * pin a compatible plugin version.
   *
   * Bump policy: add optional fields without bumping; bump on any required
   * field addition, semantic change, or signature change to `start` or
   * `setup`.
   */
  manifestVersion: 1;
  /** Stable key. Matches the DB `channel_type` column and the key under `ChannelsConfig`. */
  key: string;
  /** Identity namespace used in `sender.channel`. Usually equal to `key`. */
  namespace: string;
  /** Human-readable label for the admin UI. */
  displayName: string;
  /**
   * Secrets the admin UI should prompt for. Each entry yields a masked
   * input; on save the value is written to the agent's secret store and
   * referenced from `defaultConfig` via `${{KEY}}`.
   */
  secretKeys?: ReadonlyArray<ChannelSecretKeySpec>;
  /**
   * Non-secret structured fields to render in the admin edit form. When
   * unset (or empty), the UI falls back to a raw JSON textarea for this
   * channel.
   */
  configFields?: ReadonlyArray<ChannelConfigField>;
  /**
   * Skeleton config persisted when the user saves the structured form.
   * The UI merges captured `configFields` values on top of this object,
   * so put `${{SECRET}}` placeholders for secret references here.
   */
  defaultConfig?: Record<string, unknown>;
  /**
   * Optional config parser. When set, the loader calls this before
   * `start()` to validate the persisted config. The shape is left
   * opaque so plugin authors can use Zod (`schema.parse`), a manual
   * function, or skip validation entirely. Returning a value replaces
   * the raw config passed to `start()`; throwing aborts the start.
   */
  parseConfig?: (input: unknown) => unknown;
  /**
   * Boot the channel for one agent. Returns the live handle, or
   * `undefined` if startup failed in a way the caller logged but
   * should not treat as fatal.
   */
  start: (config: unknown, context: ChannelContext) => Promise<ChannelHandle | undefined>;
  /**
   * Optional interactive setup machine. Channels that need a multi-step
   * auth flow (Signal QR-link, WhatsApp pairing, OAuth, etc.) implement
   * this; the gateway exposes REST routes that drive it and the admin
   * UI renders a generic wizard from the returned `ChannelSetupState`.
   *
   * Token-only channels (telegram/slack/discord) leave this unset — the
   * existing "fill the secrets form, save the row" path keeps working.
   */
  setup?: ChannelSetup;
}

// ─── Channel setup contract ──────────────────────────────────────────────
//
// The setup machine runs *before* a channel row's persistent config is
// written. The plugin owns its own session state (keyed by an opaque
// `sessionId` it generates in `begin`); the gateway only routes HTTP
// calls into it and shuttles `ChannelSetupState` back to the UI.
//
// Lifecycle (driven by the UI):
//   1. UI POSTs initial input  -> manifest.setup.begin()  -> { sessionId, state }
//   2. UI renders `state` and either:
//        - polls (state.kind === 'awaiting_external')      -> manifest.setup.poll()
//        - collects more input (state.kind === 'awaiting_user_input') -> manifest.setup.submit()
//   3. On `state.kind === 'done'`, the UI takes `state.config` and POSTs
//      it to the existing `POST /api/agents/:id/channels` (or PATCH) to
//      persist the channel row. The setup session is then dropped.
//   4. UI may DELETE the session at any time -> manifest.setup.cancel().
//
// Session lifetime is the plugin's responsibility; the gateway should
// surface a sensible default (e.g. 10 min) but does not enforce it.

/** Context passed to every setup method. */
export interface ChannelSetupContext {
  /** Agent the setup is running for. */
  agentId: string;
  /** Per-session logger (prefixed with channel key + agent id by caller). */
  logger: (message: string) => void;
  /**
   * Optional durable credential storage scoped to this setup's channel.
   * Setup flows may write temporary profiles and return a final config that
   * references the promoted profile.
   */
  credentialStore?: ChannelCredentialStore;
}

/**
 * A single form field the UI should render during an `awaiting_user_input`
 * step. The shape is intentionally narrow — channels with truly bespoke
 * UI needs are expected to ship their own admin-UI plugin in a future
 * iteration of the spec.
 */
export interface ChannelSetupFieldSpec {
  /** Field name; becomes a key in the input object passed to `submit()`. */
  key: string;
  /** Human-readable label rendered next to the input. */
  label: string;
  /** Input semantics. `password` masks the value. */
  type: 'text' | 'phone' | 'password' | 'number';
  required?: boolean;
  placeholder?: string;
  /** Optional help text rendered below the field. */
  help?: string;
}

/**
 * What the UI should show / do next. Returned by every setup method.
 * Discriminated by `kind` so the UI can switch-render.
 */
export type ChannelSetupState =
  | {
      kind: 'awaiting_user_input';
      /** Human-readable prompt rendered above the form. */
      instructions?: string;
      fields: ChannelSetupFieldSpec[];
    }
  | {
      kind: 'awaiting_external';
      /** Human-readable prompt (e.g. "Scan this QR code in Signal"). */
      instructions: string;
      /**
       * Underlying string (URI, token, anything) for the UI to encode as
       * a QR code with its own renderer. Used for scan-from-another-device
       * flows — Signal's `sgnl://linkdevice?...`, WeChat web login, etc.
       *
       * Plugins whose upstream only returns a pre-rendered PNG (e.g.
       * signal-cli-rest-api) decode it once with a QR-decode library and
       * return the embedded text here.
       */
      qrText?: string;
      /**
       * URL the user should open in *this* browser to complete
       * authentication (OAuth device flow, hosted login pages). Rendered
       * as a button or link. May be combined with `qrText` when the same
       * target can be opened on this device or scanned from another.
       *
       * Note: the gateway does not host a callback endpoint for this URL.
       * Plugins detect completion by polling their own backend; classic
       * OAuth redirect flows that require an inbound callback are out of
       * scope for v1.
       */
      redirectUrl?: string;
      /** Hint to the UI about how often to poll, in ms. */
      pollIntervalMs: number;
    }
  | {
      kind: 'done';
      /**
       * The final channel config to persist. The UI takes this and
       * POSTs it to `/api/agents/:id/channels` (or PATCHes an existing
       * row) — the setup contract itself does not write to the DB.
       */
      config: Record<string, unknown>;
    }
  | {
      kind: 'error';
      /** Operator-facing message; UI renders verbatim. */
      message: string;
    };

/**
 * Interactive setup machine for a channel. All methods are optional except
 * `begin` and `poll`; `submit` is only needed when the flow has more than
 * one user-input step, and `cancel` only when the plugin holds external
 * resources (sockets, daemon processes) it needs to clean up.
 */
export interface ChannelSetup {
  /**
   * Open a new setup session. Returns the plugin-chosen `sessionId`
   * (used by all subsequent calls) and the first `ChannelSetupState`
   * to show. Most flows start with `awaiting_user_input` to collect
   * a phone number / account name.
   */
  begin: (
    input: Record<string, unknown>,
    ctx: ChannelSetupContext,
  ) => Promise<{ sessionId: string; state: ChannelSetupState }>;
  /**
   * Re-check the session's state. Called by the UI on a timer while
   * `awaiting_external` (e.g. polling for QR scan completion). Plugins
   * with no async progress can return the same state until something
   * changes.
   */
  poll: (
    sessionId: string,
    ctx: ChannelSetupContext,
  ) => Promise<ChannelSetupState>;
  /**
   * Advance the session with new user input. Called when the UI
   * submits the form fields from an `awaiting_user_input` step.
   */
  submit?: (
    sessionId: string,
    input: Record<string, unknown>,
    ctx: ChannelSetupContext,
  ) => Promise<ChannelSetupState>;
  /**
   * Drop in-progress session state. Called on explicit UI cancel; the
   * gateway also calls this on session timeout. Should be idempotent.
   */
  cancel?: (sessionId: string, ctx: ChannelSetupContext) => Promise<void>;
}

/**
 * In-memory registry of channel manifests. Populated once at gateway
 * boot from (a) bundled-default channels and (b) packages listed in
 * the `channel_packages` config, then consulted by the channel
 * launcher and the admin UI's "available channels" endpoint.
 *
 * Single-process, non-thread-safe (Node is single-threaded for
 * userland code; the registry is constructed before any request
 * handling begins).
 */
export type ChannelManifestOrigin = 'built-in' | 'external';

export class ChannelManifestRegistry {
  private readonly byKey = new Map<string, ChannelManifest>();
  private readonly originByKey = new Map<string, ChannelManifestOrigin>();

  /**
   * Register a manifest. Throws on duplicate `key` — the caller (the
   * plugin loader) decides whether to swallow the error to allow an
   * external manifest to override a bundled default.
   *
   * `origin` tags the manifest as bundled-default (`built-in`) or
   * plugin-loaded (`external`). The gateway uses it to decide whether to
   * pre-seed an `agent_channels` row when an agent is created — only
   * built-ins are auto-seeded; externals are added on demand via the UI.
   */
  register(manifest: ChannelManifest, origin: ChannelManifestOrigin = 'external'): void {
    if (!manifest.key) {
      throw new Error('ChannelManifestRegistry.register: manifest.key is required');
    }
    if (manifest.manifestVersion !== CHANNEL_MANIFEST_VERSION) {
      throw new Error(
        `ChannelManifestRegistry.register: unsupported manifestVersion ${String(
          manifest.manifestVersion,
        )} for channel "${manifest.key}" (this build supports ${CHANNEL_MANIFEST_VERSION})`,
      );
    }
    if (this.byKey.has(manifest.key)) {
      throw new Error(`ChannelManifestRegistry.register: duplicate channel key "${manifest.key}"`);
    }
    this.byKey.set(manifest.key, manifest);
    this.originByKey.set(manifest.key, origin);
  }

  /**
   * Register or override a manifest by key. Inserts when absent, overwrites
   * when present. Validates `key` and `manifestVersion` with the same rules
   * as `register()`; only the duplicate-key check is relaxed.
   */
  replace(manifest: ChannelManifest, origin: ChannelManifestOrigin = 'external'): void {
    if (!manifest.key) {
      throw new Error('ChannelManifestRegistry.replace: manifest.key is required');
    }
    if (manifest.manifestVersion !== CHANNEL_MANIFEST_VERSION) {
      throw new Error(
        `ChannelManifestRegistry.replace: unsupported manifestVersion ${String(
          manifest.manifestVersion,
        )} for channel "${manifest.key}" (this build supports ${CHANNEL_MANIFEST_VERSION})`,
      );
    }
    this.byKey.set(manifest.key, manifest);
    this.originByKey.set(manifest.key, origin);
  }

  get(key: string): ChannelManifest | undefined {
    return this.byKey.get(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  all(): ChannelManifest[] {
    return Array.from(this.byKey.values());
  }

  keys(): string[] {
    return Array.from(this.byKey.keys());
  }

  originOf(key: string): ChannelManifestOrigin | undefined {
    return this.originByKey.get(key);
  }

  keysByOrigin(origin: ChannelManifestOrigin): string[] {
    const out: string[] = [];
    for (const [key, o] of this.originByKey) {
      if (o === origin) out.push(key);
    }
    return out;
  }
}

export interface ToolApprovalRequest {
  toolCallId: string;
  approved: boolean;
}

export interface SessionCheckpointRequest {
  reason?: 'manual' | 'new_session' | 'turn_limit' | 'idle';
}

export const agentLocalRoutes = {
  health: '/health',
  sessions: '/sessions',
  sessionEventsPattern: '/sessions/:sessionId/events',
  sessionEvents: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/events`,
  sessionMessagesPattern: '/sessions/:sessionId/messages',
  sessionMessages: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
  sessionApprovePattern: '/sessions/:sessionId/approve',
  sessionApprove: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/approve`,
  sessionCheckpointPattern: '/sessions/:sessionId/checkpoint',
  sessionCheckpoint: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
  sessionAttachmentsPattern: '/sessions/:sessionId/attachments',
  sessionAttachments: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/attachments`,
  sessionAttachmentByIdPattern: '/sessions/:sessionId/attachments/:attachmentId',
  sessionAttachmentById: (sessionId: string, attachmentId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
  sessionAttachmentBytesPattern: '/sessions/:sessionId/attachments/:attachmentId/bytes',
  sessionAttachmentBytes: (sessionId: string, attachmentId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/bytes`,
  eventsUrl: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/events`,
  voiceStt: '/voice/stt',
  voiceTts: '/voice/tts',
  ws: '/ws',
} as const;

export type AgentStatus =
  | 'registered'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error';

export interface AgentInfo {
  agentId: string;
  status: AgentStatus;
  name?: string;
  workspaceDir?: string;
  port?: number;
  error?: string;
}

export interface CreateAgentRequest {
  agentId: string;
  name?: string;
  workspaceDir?: string;
  ownerUserId?: string;
  /**
   * Sandbox provisioning at create time:
   * - omitted: auto-provision using the gateway's configured default preset
   * - string : provision using the named preset
   * - null   : do not provision any sandbox
   */
  sandbox?: string | null;
  /**
   * Initial access level written into the agent's security policy.
   * Defaults to 'public' if omitted. For 'protected', set the
   * access_token afterwards via the security policy endpoint.
   */
  access?: 'public' | 'protected' | 'private';
}

export const gatewayRoutes = {
  agents: '/api/agents',
  agentHealth: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/health`,
  agentHealthPattern: '/api/agents/:agentId/health',
  agentSessions: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions`,
  agentSessionsPattern: '/api/agents/:agentId/sessions',
  agentSessionMessages: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
  agentSessionMessagesPattern:
    '/api/agents/:agentId/sessions/:sessionId/messages',
  agentSessionEvents: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events`,
  agentSessionEventsPattern:
    '/api/agents/:agentId/sessions/:sessionId/events',
  agentSessionApprove: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/approve`,
  agentSessionApprovePattern:
    '/api/agents/:agentId/sessions/:sessionId/approve',
  agentSessionCheckpoint: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
  agentSessionCheckpointPattern:
    '/api/agents/:agentId/sessions/:sessionId/checkpoint',
  agentSessionInterrupt: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/interrupt`,
  agentSessionInterruptPattern:
    '/api/agents/:agentId/sessions/:sessionId/interrupt',
  agentSessionAttachments: (agentId: string, sessionId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/attachments`,
  agentSessionAttachmentsPattern:
    '/api/agents/:agentId/sessions/:sessionId/attachments',
  agentSessionAttachmentById: (
    agentId: string,
    sessionId: string,
    attachmentId: string,
  ): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
  agentSessionAttachmentByIdPattern:
    '/api/agents/:agentId/sessions/:sessionId/attachments/:attachmentId',
  agentSessionAttachmentBytes: (
    agentId: string,
    sessionId: string,
    attachmentId: string,
  ): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/bytes`,
  agentSessionAttachmentBytesPattern:
    '/api/agents/:agentId/sessions/:sessionId/attachments/:attachmentId/bytes',
  agentManage: (agentId: string, action: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/manage/${encodeURIComponent(action)}`,
  agentManagePattern: '/api/agents/:agentId/manage/:action',

  /** Sandbox CRUD per agent. */
  agentSandboxes: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sandboxes`,
  agentSandboxesPattern: '/api/agents/:agentId/sandboxes',
  agentSandboxByAlias: (agentId: string, alias: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/sandboxes/${encodeURIComponent(alias)}`,
  agentSandboxByAliasPattern: '/api/agents/:agentId/sandboxes/:alias',

  /** Voice STT/TTS pass-through endpoints; consumed by channel adapters. */
  agentVoiceStt: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/voice/stt`,
  agentVoiceSttPattern: '/api/agents/:agentId/voice/stt',
  agentVoiceTts: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/voice/tts`,
  agentVoiceTtsPattern: '/api/agents/:agentId/voice/tts',

  /** Gateway-level token exchange (device key → user JWT). */
  authToken: '/api/auth/token',
  /** Admin-only global user create (CLI bootstrap). */
  users: '/api/users',
  /** Membership ops on an agent. */
  agentMembers: (agentId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/members`,
  agentMemberByUser: (agentId: string, userId: string): string =>
    `/api/agents/${encodeURIComponent(agentId)}/members/${encodeURIComponent(userId)}`,
  /** List the current JWT subject's agent memberships. */
  meAgents: '/api/users/me/agents',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMetadataValue = (value: unknown): value is MetadataValue =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const MATERIALIZATION_STATES = new Set<string>([
  'pending',
  'copied',
  'failed',
]);

const isOptionalString = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === 'string';

const isAttachment = (value: unknown): value is SessionAttachment => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (!isOptionalString(value.id)) return false;
  if (!isOptionalString(value.name)) return false;
  if (!isOptionalString(value.mimeType)) return false;
  if (!isOptionalString(value.sha256)) return false;
  if (!isOptionalString(value.sandboxPath)) return false;
  if (!isOptionalString(value.url)) return false;
  if (!isOptionalString(value.data)) return false;

  if (
    value.size !== undefined &&
    value.size !== null &&
    (typeof value.size !== 'number' || !Number.isFinite(value.size))
  ) {
    return false;
  }

  if (
    value.materializationState !== undefined &&
    value.materializationState !== null &&
    (typeof value.materializationState !== 'string' ||
      !MATERIALIZATION_STATES.has(value.materializationState))
  ) {
    return false;
  }

  return true;
};

export const isSessionSpec = (value: unknown): value is SessionSpec => {
  if (!isRecord(value) || typeof value.sessionId !== 'string') {
    return false;
  }

  if (!isRecord(value.source)) {
    return false;
  }

  if (
    typeof value.source.kind !== 'string' ||
    typeof value.source.interactive !== 'boolean'
  ) {
    return false;
  }

  if (
    value.source.platform !== undefined &&
    typeof value.source.platform !== 'string'
  ) {
    return false;
  }

  if (
    value.source.triggerId !== undefined &&
    typeof value.source.triggerId !== 'string'
  ) {
    return false;
  }

  if (
    value.source.type !== undefined &&
    value.source.type !== 'direct' &&
    value.source.type !== 'group'
  ) {
    return false;
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      return false;
    }

    for (const metadataValue of Object.values(value.metadata)) {
      if (!isMetadataValue(metadataValue)) {
        return false;
      }
    }
  }

  if (value.customInstruction !== undefined && typeof value.customInstruction !== 'string') {
    return false;
  }

  return true;
};

const isSender = (value: unknown): value is MessageSender => {
  if (!isRecord(value)) return false;
  if (typeof value.channel !== 'string' || typeof value.channelUserId !== 'string') return false;
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return false;
  return true;
};

const isMessageParticipant = (value: unknown): value is MessageParticipant => {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.type !== 'string') return false;
  if (typeof value.displayName !== 'string') return false;
  if (value.handle !== undefined && typeof value.handle !== 'string') return false;
  return true;
};

export const isSessionMessage = (value: unknown): value is SessionMessage => {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return false;
  }

  if (value.messageId !== undefined && typeof value.messageId !== 'string') {
    return false;
  }

  if (value.sender !== undefined && !isSender(value.sender)) {
    return false;
  }

  if (value.participants !== undefined) {
    if (!Array.isArray(value.participants) || !value.participants.every(isMessageParticipant)) {
      return false;
    }
  }

  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) {
      return false;
    }

    if (!value.attachments.every(isAttachment)) {
      return false;
    }
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata) || Array.isArray(value.metadata)) {
      return false;
    }
  }

  if (value.appendAs !== undefined && value.appendAs !== 'user' && value.appendAs !== 'assistant') {
    return false;
  }

  if (value.occurredAt !== undefined) {
    if (typeof value.occurredAt !== 'string') return false;
    // Strict ISO 8601 with timezone (Z or ±HH:MM). Date.parse is too lenient.
    const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!iso8601.test(value.occurredAt)) return false;
    if (Number.isNaN(Date.parse(value.occurredAt))) return false;
  }

  return true;
};

export const createTextFinalEvent = (
  sessionId: string,
  text: string,
): OutboundEventBody => ({
  type: 'text_final',
  sessionId,
  text,
});

export const createAgentEndEvent = (sessionId: string): OutboundEventBody => ({
  type: 'agent_end',
  sessionId,
});

export const isToolApprovalRequest = (
  value: unknown,
): value is ToolApprovalRequest => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.toolCallId === 'string' &&
    typeof value.approved === 'boolean'
  );
};

// ---------------------------------------------------------------------------
// HTTP sync response (POST /sessions/:id/messages?wait=true)
// ---------------------------------------------------------------------------

export interface SyncToolCall {
  tool: string;
  args?: unknown;
  isError: boolean;
  text?: string;
  details?: unknown;
}

export interface SyncResponse {
  sessionId: string;
  messageId?: string;
  text: string | null;
  toolCalls: SyncToolCall[];
  error?: string;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type WsMethod =
  | 'session.open'
  | 'session.message'
  | 'session.approve'
  | 'session.checkpoint'
  | 'session.interrupt'
  | 'session.delete'
  | 'session.list'
  | 'session.history'
  | 'session.subscribe'
  | 'session.unsubscribe';

export interface WsRequest {
  kind: 'request';
  id: string;
  method: WsMethod;
  params?: Record<string, unknown>;
}

export interface WsResponseOk {
  kind: 'response';
  id: string;
  result: unknown;
}

export interface WsResponseError {
  kind: 'response';
  id: string;
  error: { code: WsErrorCode; message: string };
}

export type WsResponse = WsResponseOk | WsResponseError;

export type WsErrorCode =
  | 'INVALID_PARAMS'
  | 'SESSION_NOT_FOUND'
  | 'NOT_SUBSCRIBED'
  | 'UNAUTHORIZED'
  | 'INBOX_READ_ONLY'
  | 'INTERNAL_ERROR';

export interface WsEvent {
  kind: 'event';
  eventId: number;
  sessionId: string;
  event: OutboundEvent;
}

export type WsServerMessage = WsResponse | WsEvent;
export type WsClientMessage = WsRequest;

export const isWsRequest = (value: unknown): value is WsRequest => {
  if (!isRecord(value)) return false;
  return value.kind === 'request' && typeof value.id === 'string' && typeof value.method === 'string';
};

export const isSessionCheckpointRequest = (
  value: unknown,
): value is SessionCheckpointRequest => {
  if (value === null) {
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.reason === undefined) {
    return true;
  }

  return (
    value.reason === 'manual' ||
    value.reason === 'new_session' ||
    value.reason === 'turn_limit' ||
    value.reason === 'idle'
  );
};
