# Plugin Architecture

> Status: design. Not yet shipped. Unifies the existing channel-plugin system,
> the proposed tool-plugin system (`docs/tool-plugin-design.md`, PR #140 — to
> be closed in favour of this doc), and a new hook-plugin capability under one
> manifest contract and one pair of tables. MCP servers remain a separate
> out-of-process mechanism (`packages/store/src/schema.ts:298`,
> `apps/agent/src/mcp/*`) and are not in scope.

## Why

Hermit has three nascent ways to extend an agent and they are diverging:

- **Channel plugins** — npm packages listed in `channelPackages: string[]`
  (`apps/gateway/src/config.ts:56`), loaded into a `ChannelManifestRegistry`
  (`apps/gateway/src/channel-manifests.ts:6-95`), per-binding state scattered
  across each channel's own connection tables. No `channels` catalog table.
- **Tool plugins** (proposed in #140) — own catalog table `tool_plugins`, own
  per-agent table `agent_tool_plugins`, own registry, own CLI.
- **Event hooks** — `AgentEventBus` already exposes `tool.before@v1` /
  `tool.after@v1` (`apps/agent/src/events.ts:154-155`) but has no contribution
  point for a third-party package to register a listener.

Three extension types, three mechanisms, three sets of tables. A single npm
package that wants to ship both a channel binding and an admin tool
(realistic: a Slack plugin shipping the Slack channel and a `slack_send_dm`
tool) cannot exist under the current designs.

Goal: one `PluginManifest` contract that lets a package self-declare any
combination of `tools`, `channel`, and `hooks` capabilities, persisted in one
catalog table + one per-agent enablement table.

## Non-goals

- **Cross-language plugins.** Manifests are JS/TS modules. Anything else
  should keep going through MCP.
- **Replacing MCP.** MCP stays the recommended path for out-of-process tool
  servers and for vendors who prefer a wire protocol over an in-process
  contract.
- **Hot reload.** Adding or removing a plugin requires a gateway restart, same
  as channels today.
- **Per-capability enablement.** A plugin is enabled or disabled as a whole
  package. A package author who needs finer granularity should split the
  package. See "Scope decisions" below.
- **Dynamic toolset assembly inside a turn.** Toolsets are still gathered
  once per turn at the top of the agent loop.

## Capability types

### Tier 1 — runtime-active, this design

These three capabilities all hook into the agent loop. A plugin can declare
any non-empty combination.

- **`tools`** — contributes one or more `Toolset`s. Tools flow through the
  same `wrapToolset` → `withApproval` chain
  (`apps/agent/src/agent-runner.ts:1937`) that built-ins and MCP tools use, so
  `policyStore`, approvals, and `tool.before@v1` / `tool.after@v1` all apply.
  No bypass.
- **`channel`** — provides an inbound message source. Same shape as the
  existing `ChannelManifest` (`packages/protocol/src/index.ts:393`) absorbed
  into the new manifest. Carries `ChannelSetup`
  (`packages/protocol/src/index.ts:545`) for OAuth / QR-link / key-paste flows.
- **`hooks`** — registers listeners on the `AgentEventBus`. v1 events:
  `tool.before@v1` (veto), `tool.after@v1` (listener). The bus already
  enforces veto-vs-listener semantics
  (`apps/agent/src/events.ts:183-184`); plugin contributions go through the
  same enforcement.

### Tier 2 — infrastructure provider capabilities, deferred

These exist today as provider selections rather than runtime capabilities that
an agent can enable many of at once. They may still become plugin-shaped, but
they should not be forced into the v1 `agent_plugins.enabled` model: a gateway
or agent usually chooses one storage provider, one memory provider, or one
sandbox backend from config.

- **Storage backend** — `local` / `s3` / `supabase` for attachments
  (`packages/store/src/impl/*-attachment-storage.ts`).
- **Exec backend** — `host` / `docker` / `e2b` / `daytona` sandboxes.
- **Memory provider** — in-tree today; future vector-store backends.
- **LLM provider** — already abstracted via pi-agent-core, but provider
  registration is not plugin-shaped.

Out of scope for v1. Future provider capabilities such as `storage`, `memory`,
or `sandbox` may use the same package registry, but their enablement and
selection model can be gateway-level or backend-config-level rather than
per-agent whole-plugin enablement.

### Out of scope entirely

- **Skill bundles** — skills remain a first-class filesystem-managed mechanism
  (`~/.openhermit/skills/user/`) and can already be registered directly. A
  plugin package may include files or an install script that places skills on
  disk, but `skills` is not a plugin capability.
- **Prompt modules / default instructions** — operator config, not plugins.
- **Telemetry sinks** — gateway config (currently Langfuse), not plugins.

## PluginManifest

A plugin package's default export. Each capability field is optional; the
manifest is invalid if all three are absent.

```ts
// packages/protocol/src/index.ts (new)
export interface PluginManifest {
  manifestVersion: 1;

  /** Stable identifier. Matches DB `plugins.manifest_key` and the admin
   *  config key. Lowercase, dash-separated. */
  key: string;

  /** Human-readable label for admin UI. */
  displayName: string;

  /** One-line summary surfaced in `hermit plugin list` and admin UI. */
  description: string;

  /** Optional Zod/manual validation of the persisted config blob. Runs
   *  before any capability `start` is called. */
  parseConfig?: (input: unknown) => unknown;

  tools?: ToolCapability;
  channel?: ChannelCapability;
  hooks?: HookCapability;
}

export interface ToolCapability {
  /** Namespace prepended to tool names by the loader. Mandatory: prevents
   *  collisions. e.g. namespace="acme" + tool.name="lookup" → exposed to
   *  the LLM as "acme.lookup". */
  namespace: string;

  /** Boot the tools for one agent. Called at most once per (agent, plugin)
   *  pair within a runner process. */
  start: (
    config: unknown,
    context: PluginContext,
  ) => Promise<ToolCapabilityHandle | undefined>;
}

export interface ChannelCapability {
  /** Absorbed from the current ChannelManifest. The channel start context
   *  must remain compatible with the existing ChannelContext (`agentBaseUrl`,
   *  `publicAgentBaseUrl`, `agentTokens`, channel-aware logging, runtime
   *  error reporting, etc.) so legacy ChannelManifest exports can be wrapped
   *  mechanically during the migration. */
  start: (config: unknown, context: PluginChannelContext) => Promise<ChannelHandle>;
  setup?: ChannelSetup;
  // … rest of the current ChannelManifest body, minus the duplicated
  // `key` / `displayName` / `parseConfig` which move up to PluginManifest.
}

export interface HookCapability {
  /** Static declaration of which events the plugin listens to. Used at
   *  registration time to validate the plugin against the bus's known
   *  events and reject unknown event names early. */
  events: AgentEventName[];

  /** Boot the hook subscriber for one agent. The returned handle holds the
   *  unsubscribe functions; the pool calls `stop()` to detach. */
  start: (
    config: unknown,
    context: PluginContext,
  ) => Promise<HookCapabilityHandle>;
}

export interface PluginContext {
  agentId: string;
  logger: (message: string) => void;
  /** ${SECRET} references in the persisted config are pre-resolved before
   *  parseConfig runs. Same semantics as the current channel context. */
  secrets: SecretsView;
  /** Surface a fatal/recoverable error to the admin UI (`agent_plugins.
   *  last_error`). Same contract as the existing channel
   *  `reportRuntimeError` (`packages/protocol/src/index.ts:336`). */
  reportRuntimeError: (error: string | null) => void;
}

export interface PluginChannelContext extends PluginContext {
  agentBaseUrl: string;
  publicAgentBaseUrl: string;
  agentTokens: Record<string, string>;
}
```

`Toolset` and `AgentTool` are re-exported from `apps/agent/src/tools.ts` and
`@mariozechner/pi-agent-core` respectively, so plugin authors get the same
authoring contract that built-in tools use. Namespacing is loader-enforced,
not plugin-enforced — see "Discovery and loading".

## Schema — two tables

Both tables must have entries in `packages/store/src/migrations/_journal.json`
or drizzle silently skips the migration.

```ts
export const plugins = pgTable('plugins', {
  id: text('id').primaryKey(),                              // generated
  packageName: text('package_name').notNull().unique(),     // npm package
  packageVersion: text('package_version').notNull(),        // resolved at load
  manifestKey: text('manifest_key').notNull().unique(),     // manifest.key
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  /** Machine-readable summary of declared capabilities. Populated from the
   *  manifest at registry-seed time. Shape:
   *    { tools?: { namespace: string },
   *      channel?: { hasSetup: boolean },
   *      hooks?: { events: string[] } }
   *  Admin UI uses this to render badges without instantiating the manifest. */
  capabilities: jsonb('capabilities').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentPlugins = pgTable('agent_plugins', {
  agentId: text('agent_id').notNull(),
  pluginId: text('plugin_id').notNull(),
  /** Master toggle. When false, none of the plugin's capabilities are
   *  active for this agent. */
  enabled: boolean('enabled').default(false).notNull(),
  /** Per-capability config. Shape:
   *    { tools?: {...}, channel?: {...}, hooks?: {...} }
   *  Plugin authors should treat the inner object as pre-`parseConfig`
   *  input. Top-level wrapper is enforced by the loader. */
  config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
  /** Transient state for an in-progress setup wizard. NULL once the
   *  wizard completes. Only used by `channel` capability today. */
  setupState: jsonb('setup_state'),
  /** Live state surfaced to admin UI (last heartbeat, connection status).
   *  Plugin-defined shape; opaque to the platform. */
  runtimeState: jsonb('runtime_state').$type<Record<string, unknown>>().default({}).notNull(),
  lastError: text('last_error'),
  lastErrorAt: text('last_error_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.pluginId] }),
  index('idx_agent_plugins_agent').on(table.agentId),
  index('idx_agent_plugins_enabled').on(table.agentId, table.enabled),
]);
```

`plugins` is the catalog (gateway-scoped, one row per installed package).
`agent_plugins` is per-agent enablement + config. Both rows must exist and
`enabled = true` for any of the plugin's capabilities to be active.

**Why this is enough:**

- One master `enabled` flag matches the existing channel/MCP convention. A
  plugin author who wants finer granularity should split into two packages.
- `setup_state` and `runtime_state` are short-lived or non-queryable; jsonb
  columns are cheaper than tables and don't require per-capability schema
  changes.
- Indexing `(agent_id, enabled)` covers the hot per-turn query "list enabled
  plugins for agent X."

**What's intentionally not here:**

- No per-capability enablement table. Decision documented in "Scope
  decisions"; a future `disabled_capabilities text[]` column can opt out
  selectively if the need actually appears.
- No separate setup-session table. Setup wizards have a state machine
  (begin/poll/submit/cancel) but the state never outlives the wizard and is
  never queried across agents.
- No event-subscription audit table. Hook firings are observable through the
  existing event bus telemetry path; persisting every hook invocation is out
  of scope.

## Discovery and loading

### Gateway config

A new `pluginPackages: string[]` field on the gateway config (sibling of the
existing `channelPackages` at `apps/gateway/src/config.ts:56`, which is
deprecated by this design — see Migration plan).

### Loader

`apps/gateway/src/plugin-manifests.ts` (new) — direct evolution of
`apps/gateway/src/channel-manifests.ts:24-95`:

1. Built-in plugin packages (if any) registered first.
2. `await import(pkg)` for each package in `pluginPackages`.
3. Validate the default export against `PluginManifest` (manifest version,
   at least one capability declared, namespace unique within `tools`
   capabilities, hook events known to the bus).
4. Bad export → log a warning, skip the package (non-fatal).
5. Insert into `PluginManifestRegistry` keyed by `manifest.key`.
6. Seed the `plugins` catalog table from the registry on startup
   (insert-or-update on `manifest_key`, refreshing `displayName`,
   `description`, `capabilities`, and `package_version`).

The loader runs once per gateway process at startup. Adding a package
requires a restart, identical to the channel story.

### Namespacing

Tool capability namespace is loader-enforced:

- The loader prepends `<namespace>.` to every tool name before merging into
  the agent's tool list. A plugin shipping `{ name: 'lookup' }` is exposed to
  the LLM as `acme.lookup`. Two plugins declaring the same `tools.namespace`
  cause the second to fail registration.
- `channel` capabilities don't need namespacing — they're identified by
  `manifest.key` at the channel-routing layer.
- `hooks` don't need namespacing — they're listeners, not addressable
  entities.

## Per-turn assembly

In `apps/agent/src/agent-runner.ts:1898-1980`, the existing toolset
composition becomes:

```ts
toolsets = createBuiltInToolsets({ ... });          // unchanged

if (this.mcpClientManager) { /* unchanged MCP block */ }

if (this.options.pluginPool) {
  const handles = await this.options.pluginPool.getEnabledForAgent(
    this.scope.agentId,
  );
  for (const handle of handles) {
    for (const ts of handle.toolsets) {              // tools capability
      toolsets.push(wrapToolset(ts));
    }
    // hook handles are registered with the AgentEventBus directly at pool
    // load time, not per-turn — see "Hook lifecycle" below.
  }
}

tools = toolsFromToolsets(toolsets);                 // unchanged
```

`wrapToolset` (`agent-runner.ts:1937`) is reused unchanged: plugin tools get
the same `withApproval`, `tool.before@v1` veto, `policyStore` check, and
audit logging as built-ins and MCP tools.

### PluginPool

`apps/agent/src/plugin-pool.ts` (new), keyed by `(agentId, pluginId)`. On
first access for an agent:

1. Load enabled `agent_plugins` rows.
2. For each row: resolve manifest in the registry, expand `${SECRET}`
   references in `config`, and run `manifest.parseConfig` if present. The
   returned value is the normalized config object passed to each declared
   capability's `start()` method.
3. For each declared capability, call its `start(config, context)` and cache
   the returned handle.
4. Hooks are subscribed to the `AgentEventBus` here, not per-turn.

On disable / config change / shutdown the pool calls each handle's `stop()`,
unsubscribes hooks, and evicts the cache entry.

### Hook lifecycle

Hook capabilities live longer than a single turn: a `tool.before@v1`
subscriber must be active before the very first tool call. The pool
subscribes hooks once per (agent, plugin), holds the unsubscribe handles, and
detaches them on disable / config change / shutdown.

This is the one place where the per-turn vs per-agent distinction matters.
Tools and channels can be looked up lazily on each turn; hooks must be
attached eagerly to the bus and survive across turns within the same agent
runner.

### Config-change semantics

Editing `agent_plugins.config` via admin REST evicts the pool entry: the
pool calls `stop()` on all handles for that (agent, plugin), unsubscribes
hooks, and re-instantiates on next access. This guarantees a rotated API key
or changed scope takes effect on the next turn without restarting the agent.

## CLI

`hermit plugin` subcommands replace `hermit channel`
(`apps/cli/src/commands/channels.ts`), with `hermit channel` kept as a
deprecated alias for one release:

- `hermit plugin install <pkg>` — runs `npm install -g`, appends to
  `pluginPackages` in gateway config, prints "restart gateway."
- `hermit plugin uninstall <pkg>` — removes from config, runs `npm
  uninstall -g`, prints "restart gateway."
- `hermit plugin list` — joins `pluginPackages` × live `PluginManifestRegistry`
  × `plugins` catalog. Marks each as `loaded` / `configured-but-failed-to-load`
  / `loaded-but-not-in-catalog`, and shows declared capabilities.
- `hermit plugin enable <key> --agent <agentId>` /
  `hermit plugin disable <key> --agent <agentId>` — flips
  `agent_plugins.enabled`. The CLI affordance is new (channels didn't have
  it); kept here because "install once, enable per agent" is the typical
  flow and shouldn't require the admin UI.
- `hermit plugin config <key> --agent <agentId>` — prints or sets the
  per-agent config blob.

## Admin REST API

Mounted under `/api/agents/:agentId/plugins`:

- `GET /api/agents/:agentId/plugins` — list available plugins (joined from
  registry × `plugins` × `agent_plugins`) with per-agent enabled/config/
  lastError/runtimeState.
- `PUT /api/agents/:agentId/plugins/:key` — set `{ enabled, config }`.
- `POST /api/agents/:agentId/plugins/:key/setup/{begin|poll|submit|cancel}`
  — interactive setup, mounted only when the plugin declares a `channel`
  capability with `setup`. State machine identical to the current channel
  setup (`docs/channel-plugin-design.md:132-136`).

## Lifecycle

1. **Package install.** `hermit plugin install @vendor/foo` resolves the
   package, writes the name into `pluginPackages`. Gateway restart required
   (same as channels today).
2. **Loader startup.** Gateway boots, builds `PluginManifestRegistry` from
   `pluginPackages`, seeds the `plugins` catalog (insert-or-update on
   `manifest_key`).
3. **Per-agent enable.** Admin or CLI flips `agent_plugins.enabled = true`,
   optionally with an initial `config` blob.
4. **First turn.** Agent runner asks the `PluginPool` for enabled plugins.
   Pool sees no live handles, instantiates each capability via its
   `start(config, context)`, caches handles, subscribes hooks. Returns
   toolsets.
5. **Setup wizard** (channel capability only). Admin POSTs through the
   `/setup/...` endpoints; the pool sees the resulting completed config and
   re-instantiates the plugin.
6. **Config change.** Admin PUTs new `config`. Pool evicts and re-starts.
7. **Disable.** Admin flips `enabled = false`. Pool stops handles,
   unsubscribes hooks. Tools disappear from the next turn.
8. **Package uninstall.** Manifest gone from registry on next gateway
   restart. `agent_plugins` rows preserved so reinstalling restores
   per-agent state.

## Security

- **All plugin tools flow through `withApproval`.** Same wrapper as
  built-ins and MCP. No bypass of `policyStore`, `approvalRequestStore`,
  `tool.before@v1`, or audit logging.
- **Namespace is loader-enforced.** A plugin cannot ship a tool named
  `file_read` and shadow a built-in; the loader prepends `<namespace>.`
  before merging.
- **Hook vetoes are bounded.** Hook capabilities subscribe through the
  existing veto/listener contract (`apps/agent/src/events.ts:183-184`).
  A buggy hook that always vetoes will be obvious from `tool.after@v1`
  telemetry and can be disabled per-agent without a gateway restart.
- **Secrets are resolved by the platform, then exposed in-process.** Plugin
  config can reference `${TOKEN}`; values are resolved from the secret store
  and provided to plugin code via `PluginContext.secrets` (not persisted back
  into plugin config rows by this flow). Plugins and their runtime environment
  must be trusted accordingly.
- **Untrusted plugin code is still in-process.** This is the central
  trust trade-off: an in-process plugin can do anything Node lets it do.
  Document loudly in the manual; recommend MCP for code from third parties
  without an established trust relationship.

## Scope decisions

### Whole-plugin enablement, not per-capability

`agent_plugins.enabled` is one boolean covering all of a plugin's
capabilities. Rationale:

- Matches the existing channel and MCP convention. Operators don't have to
  learn a new mental model for plugins.
- Plugin authors decide what bundles together. If "channel + tool" is the
  wrong bundle for an operator, the right fix is for the author to split
  into two packages, not for the platform to expose half-installs.
- Avoids a third table and the ambiguity of where `last_error` belongs when
  multiple capabilities are live.

If a future capability needs per-capability opt-out (e.g. "I want the tools
but my agent doesn't need the noisy `prompt.before` hook"), add a
`disabled_capabilities text[]` column. Don't add a table.

### Plugins, not MCP-style server connections

`plugins` is a catalog of npm packages, not of running instances. A plugin
that needs to talk to N external services should manage those connections
itself (per-agent config can list endpoints), or expose them as MCP servers.
We don't want a third "registry of opaque connections" alongside MCP.

### `hermit plugin enable` on the CLI

Channels today require the admin UI to flip enabled. Tool plugins (and now
the unified plugins) expose `enable/disable` on the CLI because "install
once, enable per agent" is the typical flow and shouldn't require a UI
round-trip. The admin REST endpoint is still the source of truth.

## Migration plan

Sequenced for smallest landable PRs first. Steps 1–4 are pure additions and
can land independently; step 5 is the channel-migration cutover.

1. **Protocol types only.** Add `PluginManifest`, `ToolCapability`,
   `ChannelCapability`, `HookCapability`, `PluginContext` and supporting
   types to `packages/protocol`. No runtime changes. Lets downstream
   packages start importing.
2. **Schema + store.** Add `plugins` + `agent_plugins` tables, the
   migration SQL, the `_journal.json` entry, and `PluginStore` (CRUD).
   Tests cover the store. No loader yet.
3. **Manifest registry + loader.** `PluginManifestRegistry`,
   `buildPluginManifestRegistry()`, `pluginPackages` config field. Unit
   tests against a fake plugin package with each capability type.
4. **PluginPool + tool & hook integration.** `PluginPool`, the
   `prepareTurnTools` hook between built-ins/MCP and `toolsFromToolsets`,
   the eager hook subscription path. Integration test: fake plugin with
   one tool + one hook, assert tool appears in tool list and hook fires on
   `tool.before@v1`.
5. **Channel migration.** Convert the existing channel plugins
   (`@openhermit/channel-telegram`, `-slack`, `-discord`, `-wechat`,
   `-signal`) to declare `channel` capabilities under `PluginManifest`.
   Backward-compat shim: at gateway boot, if the package's default export
   is a legacy `ChannelManifest`, wrap it in `{ channel: <legacy> }` so
   operators don't have to upgrade plugins in lockstep. Migration of the
   `channelPackages` config field into `pluginPackages` is mechanical: on
   first boot, merge the two arrays and persist as `pluginPackages`,
   leaving `channelPackages` writable but deprecated.
6. **CLI + admin REST.** `hermit plugin install/uninstall/list/enable/
   disable/config`, REST endpoints, setup wizard mount. Keep `hermit
   channel` as a deprecated alias for one release.
7. **First-party tool example.** A thin first-party plugin — candidate:
   `@openhermit/plugin-http` (per-agent allowlist + `http_get` tool) —
   that exercises the full tool pipeline. Optional second example with a
   `tool.before@v1` hook to demonstrate the hook capability.
8. **Manual + reference docs.** Add `docs/manual/<n>-plugins.md` and
   `docs/plugin-adapter.md` (operational reference). Mark
   `docs/channel-plugin-design.md` and `docs/tool-plugin-design.md` (#140)
   as superseded by this file. Update the status banner above to
   "shipped."

## Open questions

- **Hook event surface for v1.** `tool.before@v1` / `tool.after@v1` are
  enough for an MVP. Should v1 also expose `message.inbound@v1` (channel
  → agent) and `turn.end@v1` (post-completion)? Lean yes for inbound;
  defer turn.end until a concrete use case lands.
- **Per-plugin tool count cap.** A plugin could register 200 tools and
  blow the model's tool-list budget. Enforce a cap (suggest 64) at
  manifest registration; reject above that.
- **Plugin versioning.** Same `manifest_key` from a new package version
  with a breaking tool schema. Reject at registry-seed time if the new
  manifest is incompatible with persisted configs, or always accept and
  let `parseConfig` reject bad rows? Lean toward the latter — operator
  responsibility, surfaced via `last_error`.
- **Migration of running channel bindings.** Step 5 needs to preserve
  in-flight channel state (telegram bot session cookies, slack tokens)
  across the shim → native cutover. Concrete plan deferred to that PR.
- **Telemetry surface.** Should plugin `start()` failures bump
  `agentErrorsTotal` with `source: 'plugin'`? Lean yes; matches MCP
  connection-failure surfacing today.
