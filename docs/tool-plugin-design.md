# Tool Plugin Architecture

> Status: design. Not yet shipped. Tracks the introduction of in-process tool
> plugins as a peer to the existing channel plugin system. The MCP integration
> (`packages/store/src/schema.ts:298`, `apps/agent/src/mcp/*`) remains the
> out-of-process escape hatch and is unchanged by this work. For day-to-day
> operational reference once shipped, see (TBD) `tool-plugin-adapter.md`.

## Why

Today an agent's tool list is fixed at startup, composed in
`apps/agent/src/agent-runner.ts:1898-1965` (`createBuiltInToolsets` +
`mcpClientManager.getToolsets()`):

1. `createBuiltInToolsets(...)` from `apps/agent/src/tools.ts` — the hardcoded
   built-ins (memory, file, exec, schedule, …).
2. `mcpClientManager.getToolsets()` — tools provided by external MCP servers.

The `AgentEventBus` has hooks for **intercepting** tool calls
(`tool.before@v1`, `tool.after@v1`) but **no hook for contributing new tools**.
A third party who wants to ship a TS function (e.g. a corporate KB lookup, a
billing API wrapper) into every agent has two options today:

- **MCP** — works, but requires a separate process and the MCP protocol surface.
  No access to hermit's in-process store/security/exec backends.
- **Fork hermit** — change `tools.ts`. Obviously not viable.

Goal: make in-process tools first-class npm-installable plugins, **mirroring
the channel plugin model end-to-end** (manifest contract, registry,
`pluginPackages` config, CLI install/uninstall/list, per-agent enablement
flag). Adding a tool plugin is `npm install -g @vendor/tool-foo` followed by
flipping it on for the agents that should see it.

## Non-goals

- **Cross-language plugins.** Manifests are JS/TS modules. Anything else
  should keep going through MCP.
- **Replacing MCP.** MCP stays the recommended path for out-of-process tool
  servers and for vendors who prefer a stable wire protocol over an in-process
  contract. Tool plugins are for the "I need an in-process function with
  access to hermit's stores" case.
- **Hot reload.** Adding or removing a plugin requires a gateway/agent
  restart, same as channels today.
- **Dynamic toolset assembly inside a turn.** Toolsets are still gathered
  once per turn at the top of the agent loop. A plugin cannot mutate the
  toolset list mid-stream.
- **Per-session enablement.** Enablement is per-agent only, just like
  channels and MCP servers.

## Overview

```text
┌────────────────────────────────────────────────────────────────────────┐
│ agent process                                                          │
│                                                                        │
│  ┌──────────────────────────┐   ┌─────────────────────────────────┐    │
│  │ ToolManifestRegistry     │◄──│ PluginLoader                    │    │
│  │ (runtime)                │   │  • read toolPluginPackages cfg  │    │
│  └──────────────┬───────────┘   │  • dynamic-import each manifest │    │
│                 │               │  • register {key, namespace,    │    │
│                 │               │     parseConfig, start}         │    │
│                 ▼               └─────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │ AgentRunner.prepareTurnTools()                           │          │
│  │  built-ins  ─┐                                           │          │
│  │  MCP        ─┼──►  toolsets  ──► withApproval ──► tools │          │
│  │  PLUGINS    ─┘                                           │          │
│  └──────────────────────────────────────────────────────────┘          │
└────────────────────────────────────────────────────────────────────────┘
```

The runtime `ToolManifestRegistry` is the analogue of
`ChannelManifestRegistry` (`apps/gateway/src/channel-manifests.ts`). It lives
in the **agent process** rather than the gateway, because tools are consumed
where the agent loop runs. The registry is shared across all agents on that
process; per-agent enablement happens against the registry at turn-prep time.

`AgentRunner` already composes toolsets in one place
(`agent-runner.ts:1898-1965`). The plugin layer slots in alongside the MCP
block: enabled plugins are looked up in the registry, their `start()` is
called once per agent (cached in a per-agent `ToolPluginPool`), and the
returned toolsets get pushed through the same `withApproval` wrapping the
built-ins and MCP toolsets use.

## Tool Manifest

Every tool plugin package exports a default manifest. The shape deliberately
mirrors `ChannelManifest` (`packages/protocol/src/index.ts:393`):

```ts
// packages/protocol/src/index.ts (new)
export interface ToolPluginManifest {
  manifestVersion: 1;

  /** Stable identifier. Matches DB `agent_tool_plugins.plugin_key` and the
   *  admin config key. Lowercase, dash-separated. */
  key: string;

  /** Namespace prepended to tool names exported by this plugin. Mandatory:
   *  prevents collisions between two plugins that both ship a `search` tool.
   *  e.g. namespace="acme" + tool.name="lookup" → exposed to LLM as
   *  "acme.lookup". */
  namespace: string;

  /** Human-readable label for admin UI. */
  displayName: string;

  /** Optional Zod/manual validation of the per-agent config blob. */
  parseConfig?: (input: unknown) => unknown;

  /** Boot the plugin for one agent. Returns a handle whose `toolsets` get
   *  merged into the agent's toolset list, and whose `stop` is called when
   *  the agent shuts down or the plugin is disabled.
   *
   *  Called at most once per (agent, plugin) pair within a runner process. */
  start: (
    config: unknown,
    context: ToolPluginContext,
  ) => Promise<ToolPluginHandle | undefined>;

  /** Optional interactive multi-step setup (OAuth, key paste, etc.) — same
   *  state machine contract as ChannelSetup. Mounted at
   *  /api/agents/:id/tool-plugins/:key/setup/{begin|poll|submit|cancel}. */
  setup?: ToolPluginSetup;
}

export interface ToolPluginContext {
  /** Identity of the agent this instance is being booted for. */
  agentId: string;

  /** Logger that prefixes plugin key. Use instead of console.* so output
   *  lands in the gateway log with the right tags. */
  logger: (message: string) => void;

  /** Same secret-expansion semantics as channels: ${SECRET_NAME} references
   *  in the persisted config are pre-resolved before parseConfig runs. */
  secrets: SecretsView;

  /** Surface a fatal/recoverable error to the admin UI (lastError column on
   *  the agent_tool_plugins row). Same contract as channel.reportRuntimeError. */
  reportRuntimeError: (error: string | null) => void;
}

export interface ToolPluginHandle {
  /** One or more toolsets to contribute. A plugin almost always returns a
   *  single toolset, but the array shape matches MCP and channel ergonomics
   *  and lets a plugin group related tools under multiple toolset ids. */
  toolsets: Toolset[];

  /** Called when the agent unloads, the plugin is disabled, or the gateway
   *  shuts down. Plugins must release any handles, timers, sockets. */
  stop: () => Promise<void>;
}
```

`Toolset` and `AgentTool` (the per-tool object inside `toolsets[].tools`) are
re-exported from `apps/agent/src/tools.ts` and `@mariozechner/pi-agent-core`
respectively, so plugin authors get the same authoring contract that built-in
tools use. **Namespacing is enforced by the loader, not the plugin:** the
loader prepends `<namespace>.` to every tool name before merging into the
final tool list, so a plugin that ships `{ name: 'lookup' }` ends up exposed
to the LLM as `acme.lookup` without the plugin author having to think about
collisions.

## Discovery and loading

### Admin config

A new `toolPluginPackages: string[]` field on the gateway config (sibling of
the existing `channelPackages`, declared in `apps/gateway/src/config.ts:56`).
Same persistence path: gateway config table, mutated via
`gateway.putGatewayConfig()`.

### Loader

`apps/agent/src/tool-plugin-manifests.ts` (new) — direct port of
`apps/gateway/src/channel-manifests.ts:24-95`:

1. Built-in tool plugins (if any ever exist) registered first.
2. Then `await import(pkg)` for each package in `toolPluginPackages`.
3. Validate the default export against `ToolPluginManifest`. Bad export
   → log a warning, skip the package (non-fatal, same as channels).
4. Insert into `ToolManifestRegistry` keyed by `manifest.key`.

The loader runs **once per agent runner process** at startup, before any
session opens. Adding a plugin package requires a restart, identical to the
channel story.

### Per-agent enablement (DB)

New table, modeled on `agent_mcp_servers`
(`packages/store/src/schema.ts:309`):

```ts
export const toolPlugins = pgTable('tool_plugins', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),       // manifest.key
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentToolPlugins = pgTable('agent_tool_plugins', {
  agentId: text('agent_id').notNull(),
  pluginKey: text('plugin_key').notNull(),   // foreign-key to toolPlugins.key
  enabled: boolean('enabled').default(false).notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
  lastError: text('last_error'),
  lastErrorAt: text('last_error_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.pluginKey] }),
  index('idx_agent_tool_plugins_agent').on(table.agentId),
]);
```

`tool_plugins` is a thin catalog (no secrets; one row per registered manifest,
seeded from the registry on startup). `agent_tool_plugins` carries per-agent
state: enabled flag, plugin-specific config blob (e.g. an API base URL), and
the last error surfaced via `reportRuntimeError`. Secrets continue to live in
the gateway secret store and are referenced as `${NAME}` inside the config
blob — same convention as channels.

**Both rows must exist for tools to be exposed**: an agent only sees a
plugin's tools if (a) the manifest is registered in the process, (b) a
`tool_plugins` row exists for that key, and (c) `agent_tool_plugins.enabled
= true` for that (agentId, key). Installing a package without flipping an
agent flag is a no-op — matches the user requirement.

Remember the migration journal: any new table requires both the SQL migration
file *and* an entry in `packages/store/src/migrations/_journal.json`,
otherwise drizzle silently skips it.

### Per-turn assembly

In `agent-runner.ts:1898-1965`, after the MCP block and before
`tools = toolsFromToolsets(toolsets)`, add:

```ts
if (this.options.toolPluginStore) {
  const plugins = await this.toolPluginPool.getEnabledForAgent(this.scope.agentId);
  for (const handle of plugins) {
    for (const ts of handle.toolsets) {
      toolsets.push(wrapToolset(ts));   // existing wrapToolset → withApproval
    }
  }
}
```

`ToolPluginPool` (new, `apps/agent/src/tool-plugin-pool.ts`) is the per-agent
cache: on first access it calls `manifest.start(config, context)` and stores
the returned handle; on disable or shutdown it calls `handle.stop()`. The
pool keys on `(agentId, pluginKey)` so the same agent re-using the runner
for many sessions doesn't reboot the plugin every turn.

`wrapToolset` is the same function already used for MCP toolsets at
`agent-runner.ts:1937`. This means tool plugins get the **identical**
policy/approval/hook treatment as built-ins and MCP: `tool.before@v1` can
veto plugin tools, `policyStore` can deny them by name, and the existing
`require_approval` flow applies. **No bypass.**

## CLI

Direct port of `apps/cli/src/commands/channels.ts:54-126`:

- `hermit tool-plugin install <pkg>` — runs `npm install -g <spec>`, appends
  to `toolPluginPackages` in gateway config, prints "restart gateway".
- `hermit tool-plugin uninstall <pkg>` — removes from config, runs `npm
  uninstall -g`, prints "restart gateway".
- `hermit tool-plugin list` — prints the `toolPluginPackages` array, marked
  with whether each is currently registered in the live registry (so users
  can tell "configured but failed to load" from "loaded fine").
- `hermit tool-plugin enable <key> --agent <agentId>` /
  `hermit tool-plugin disable <key> --agent <agentId>` — flips
  `agent_tool_plugins.enabled` for one agent. This is the new shape that
  doesn't exist for channels (channels are enabled via the admin REST API);
  for tool plugins we expose it on the CLI from day one because the typical
  flow is "install once, enable per agent" and we don't want users to need
  the admin UI just to flip a bool.

## Admin REST API

Mounted under `/api/agents/:agentId/tool-plugins`:

- `GET /api/agents/:agentId/tool-plugins` — list available plugins (joined
  from registry × `tool_plugins`) with per-agent enabled/config/lastError.
- `PUT /api/agents/:agentId/tool-plugins/:key` — set `{ enabled, config }`.
- `POST /api/agents/:agentId/tool-plugins/:key/setup/{begin|poll|submit|cancel}`
  — optional setup wizard, identical contract to channel setup
  (`docs/channel-plugin-design.md:132-136`).

## Lifecycle

1. **Package install.** `hermit tool-plugin install @vendor/tool-foo`
   resolves the package, writes the name into `toolPluginPackages`. Gateway
   is restarted (manually for now — same as channels).
2. **Loader startup.** Each agent runner process boots, builds its
   `ToolManifestRegistry` from `toolPluginPackages`, and seeds the
   `tool_plugins` catalog table from the registry (insert-on-missing).
3. **Per-agent enable.** Admin (or CLI) flips
   `agent_tool_plugins.enabled = true` for `(agentId, pluginKey)`, optionally
   POSTing a config blob.
4. **First turn.** `AgentRunner.prepareTurnTools()` queries the pool. The
   pool sees no live handle, looks up the manifest by key, calls
   `manifest.start(config, context)`, caches the handle, and returns its
   toolsets. Subsequent turns hit the cache.
5. **Disable.** Admin flips the row to `enabled = false`. The pool calls
   `handle.stop()` on next access (or on a debounced eviction tick). Tools
   disappear from the next turn.
6. **Package uninstall.** Manifest disappears from the registry on next
   gateway restart. Any agent still flagged `enabled = true` for that key
   loses the tools silently; `tool_plugins` catalog row is left behind
   intentionally so re-installing the same key restores configs.

## Security posture

- **All plugin tools flow through `withApproval`.** Same wrapper used for
  built-ins and MCP. No bypass of `policyStore`, `approvalRequestStore`,
  `tool.before@v1`, or audit logging.
- **Namespace is loader-enforced.** A plugin cannot ship a tool named
  `file_read` and shadow the built-in; the loader prepends `<namespace>.`
  before merging. Two plugins with the same `namespace` cause the second
  to be rejected at registration time.
- **Secrets stay in the secret store.** The plugin's config blob can
  reference `${TOKEN}` but the plaintext value lives in the same encrypted
  channel-style storage. Plugins should treat their config object as
  pre-expanded but not log it.
- **Untrusted plugin code is still in-process.** This is the central
  trust trade-off: an in-process plugin can do anything Node lets it do.
  We document this loudly in the manual and recommend MCP for code from
  third parties without an established trust relationship.

## Open questions

- **Telemetry surface.** Should plugin `start()` failures bump
  `agentErrorsTotal` with a new `source: 'tool_plugin'` label? Lean yes;
  it matches how MCP connection failures are surfaced today.
- **Tool count cap.** A poorly written plugin could register 200 tools and
  blow the model's tool-list budget. Probably enforce a per-plugin cap (say
  64) at registration time; reject above that with a clear error.
- **First-party tool plugin.** Pick a thin first-party example to ship
  alongside the infrastructure — analog of `@openhermit/channel-wechat`.
  Candidate: a generic HTTP request plugin (`@openhermit/tool-http`) with
  per-agent allowlist config, so we have one shipped manifest exercising
  the full pipeline.

## Migration plan

Sequencing, smallest landable PRs first:

1. **Protocol types only.** Add `ToolPluginManifest`, `ToolPluginContext`,
   `ToolPluginHandle`, `ToolPluginSetup` to `packages/protocol`. No
   runtime changes. Lets downstream packages start importing the contract.
2. **DB schema + store.** Add `tool_plugins` / `agent_tool_plugins` tables,
   write the migration SQL + `_journal.json` entry, ship `ToolPluginStore`
   (CRUD only, no loader yet). Tests cover the store; no agent-runner
   changes yet.
3. **Manifest registry + loader.** `ToolManifestRegistry`,
   `buildToolPluginManifestRegistry()`, `toolPluginPackages` config field.
   Loader is wired but no agent-runner integration. Unit tests against a
   fake plugin package.
4. **Agent-runner integration.** `ToolPluginPool`, the `prepareTurnTools`
   hook between built-ins/MCP and `toolsFromToolsets`. Integration test:
   register a fake plugin, enable it for an agent, assert its tool shows
   up in the captured tool list and that disabling removes it.
5. **CLI + admin REST.** `hermit tool-plugin install/uninstall/list/enable/
   disable`, REST endpoints, optional setup wizard mount.
6. **First-party example.** `@openhermit/tool-http` (or similar) — proves
   the whole pipeline end-to-end and gives us a manifest to point at in
   the manual.
7. **Manual + reference docs.** Add `docs/manual/<n>-tool-plugins.md` and
   `docs/tool-plugin-adapter.md` (operational reference), and update this
   file's status banner to "shipped" once #6 lands.

Steps 1–3 are pure additions with no behavior change for existing agents
and can land independently. Step 4 is the first one that touches the
hot agent-loop path and warrants the most test coverage.
