# Channel Plugin Architecture (Design Draft)

> Status: draft — partially implemented. The manifest contract and `ChannelManifestRegistry` have landed in `@openhermit/protocol`; nothing consumes the registry yet (see migration plan below). Supersedes the "External Channel Adapter API" open question in `pending-decisions.md`.

## Why

Today the built-in channel set (`telegram`, `slack`, `discord`) is hardcoded:

- `BUILTIN_CHANNELS` in `apps/agent/src/core/types.ts` is a static array.
- `apps/agent/src/channels.ts` ships a `starters` map that dynamically imports each `@openhermit/channel-*` package by name, but the keys are written by hand.
- `apps/cli/tsup.config.ts` bundles `@openhermit/channel-telegram` (via `noExternal`) into the CLI binary; the others resolve from `node_modules` at runtime, but only because they happen to be runtime dependencies of the CLI.
- The admin UI reads the same hardcoded list to render the "available channels" registry.

Adding a new channel — Signal (PR #81), Weixin, Debox — currently means touching all four places and shipping it inside the CLI. This couples the CLI release cadence to every new channel and bloats the binary for users who only need one.

Goal: make channels first-class npm-installable plugins. The CLI still bundles a default set for the out-of-box experience, but additional channels can be added by `npm install -g @vendor/channel-foo` without re-releasing the CLI.

## Non-goals

- Out-of-process or non-Node channels. The existing external-channel HTTP slot (DB row + bearer token + `AgentLocalClient`) remains the escape hatch for those cases. A dedicated `channels-gateway` sidecar is deferred until a real driver appears.
- Hot reload. Adding/removing a plugin requires a gateway restart in this phase.
- Cross-language plugins. Manifests are JS/TS modules.

## Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│ gateway process                                                     │
│                                                                     │
│  ┌──────────────────────────┐  ┌─────────────────────────────────┐  │
│  │ ChannelManifestRegistry  │← │ PluginLoader                    │  │
│  │ (runtime)                │  │  • read channel_packages config │  │
│  └──────────────────────────┘  │  • dynamic-import each manifest │  │
│         ▲                      │  • register {key, namespace,    │  │
│         │                      │     parseConfig, start}         │  │
│  ┌──────┴───────────┐          └─────────────────────────────────┘  │
│  │ ChannelPool      │  boots bridges by looking up                  │
│  │ (per-agent ×     │  registered start() — no hardcoded            │
│  │  per-channel)    │  switch on key                                │
│  └──────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
```

The runtime `ChannelManifestRegistry` replaces the compile-time `BUILTIN_CHANNELS` constant. `ChannelPool` (`apps/gateway/src/channel-pool.ts`) keeps its current per-agent-per-channel semantics — only the lookup of `start()` changes.

The name `ChannelManifestRegistry` (not `ChannelRegistry`) is deliberate: `apps/gateway/src/auth.ts` already exports a `ChannelRegistry` class that handles per-channel auth-token registration. Manifest registration is a separate concern; keeping the names distinct avoids confusion at call sites.

## Channel Manifest

Every channel package exports a default manifest:

```ts
// @openhermit/channel-signal/src/index.ts
import type { ChannelManifest } from '@openhermit/protocol';
import { z } from 'zod';
import { startSignal } from './start.js';

const SignalConfig = z.object({
  restUrl: z.string().url(),
  selfNumber: z.string(),
  // ...
});

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'signal',                              // ChannelsConfig key + DB channel_type
  namespace: 'signal',                        // sender.channel namespace
  displayName: 'Signal',                      // admin UI label
  parseConfig: (input) => SignalConfig.parse(input),
  start: startSignal,                         // (config, context) => Promise<ChannelHandle>
};

export default manifest;
```

The shape lives in `packages/protocol/src/index.ts`:

```ts
export const CHANNEL_MANIFEST_VERSION = 1 as const;

export interface ChannelManifest {
  manifestVersion: 1;       // pinned literal; bumped on breaking changes
  key: string;
  namespace: string;
  displayName: string;
  /** Optional config parser. Throws on invalid; returned value is what start() receives. */
  parseConfig?: (input: unknown) => unknown;
  start: (config: unknown, context: ChannelContext) => Promise<ChannelHandle | undefined>;
}
```

The `manifestVersion: 1` literal is required from day one. The registry refuses to register a manifest whose `manifestVersion` doesn't match `CHANNEL_MANIFEST_VERSION`, throwing a clear error. Plugins survive a protocol bump by either continuing to declare `1` (if the loader still accepts it) or shipping a new release pinned to the new version. Bump policy:

- **No bump** for adding *optional* fields to the manifest, the handle, or the context.
- **Bump required** for adding required fields, changing the `start()` signature, or any semantic change a v1 plugin couldn't have anticipated.

`parseConfig` is intentionally opaque — plugin authors can use Zod (`schema.parse`), a hand-rolled validator, or skip validation entirely. The contract is "throws if invalid; returns the value passed to `start()`."

Webhook ingress (Telegram secret_token, Slack HMAC, Discord ed25519) lives on the live `ChannelHandle.handleWebhook` returned from `start()`, not on the manifest, because some channels switch between polling and webhook based on per-agent config (e.g. Telegram).

Existing built-in channels (`telegram`, `slack`, `discord`) are refactored to expose the same default-exported manifest. The `start*` functions and config types already exist; only the export shape changes.

## Interactive Setup

Token-only channels (telegram, slack, discord) start with a known config: the operator pastes a bot token into the admin UI, the row is saved, the channel is enabled. Some channels — Signal (QR-link via [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)), WhatsApp-Web, anything OAuth — have a multi-step interactive flow that produces the persistent config only *after* the user completes an external action (scanning a QR, granting consent in a browser).

The `setup` field on `ChannelManifest` describes a state machine for this flow:

```ts
export interface ChannelManifest {
  // ...existing fields
  setup?: ChannelSetup;
}

export interface ChannelSetup {
  begin: (input, ctx) => Promise<{ sessionId: string; state: ChannelSetupState }>;
  poll: (sessionId, ctx) => Promise<ChannelSetupState>;
  submit?: (sessionId, input, ctx) => Promise<ChannelSetupState>;
  cancel?: (sessionId, ctx) => Promise<void>;
}

export type ChannelSetupState =
  | { kind: 'awaiting_user_input'; instructions?: string; fields: ChannelSetupFieldSpec[] }
  | { kind: 'awaiting_external'; instructions: string; qrText?: string; redirectUrl?: string; pollIntervalMs: number }
  | { kind: 'done'; config: Record<string, unknown> }
  | { kind: 'error'; message: string };
```

The plugin owns its session state, keyed by an opaque `sessionId` it generates in `begin`. The gateway exposes four REST routes that wrap the four methods:

```
POST   /api/agents/:id/channels/:type/setup/begin              -> { sessionId, state }
GET    /api/agents/:id/channels/:type/setup/:sessionId         -> { sessionId, state }   (= poll)
POST   /api/agents/:id/channels/:type/setup/:sessionId         -> { sessionId, state }   (= submit)
DELETE /api/agents/:id/channels/:type/setup/:sessionId         -> { ok: true }            (= cancel)
```

A Signal flow looks like:

```text
UI                           gateway                     manifest.setup
 │                              │                              │
 │ POST .../setup/begin         │                              │
 │ { phone_number: '+1...' }    │                              │
 │ ──────────────────────────►  │ begin(input, ctx)            │
 │                              │ ──────────────────────────►  │
 │                              │                              │ signal-cli-rest-api:
 │                              │                              │   POST /v1/qrcodelink/+1...
 │                              │                              │   ◄── PNG bytes
 │                              │                              │ decode PNG → sgnl:// URI
 │                              │                              │
 │ { sessionId, state:          │                              │
 │   awaiting_external,         │                              │
 │   qrText: 'sgnl://...',      │  ◄── { sessionId, state }    │
 │   pollIntervalMs: 1000 }     │                              │
 │ ◄──────────────────────────  │                              │
 │                              │                              │
 │ <QRCode value={qrText}/>     │                              │
 │ user scans QR in Signal app  │                              │
 │                              │                              │
 │ GET .../setup/:sessionId     │                              │
 │ (every 1s)                   │ poll(sessionId, ctx)         │
 │ ──────────────────────────►  │ ──────────────────────────►  │
 │                              │                              │ check linked-device status
 │ { state: done,               │                              │
 │   config: {...} }            │  ◄── { kind: 'done', ... }   │
 │ ◄──────────────────────────  │                              │
 │                              │                              │
 │ POST /api/agents/:id/channels                               │
 │ { namespace: 'signal',       │                              │
 │   config: <state.config>,    │                              │
 │   enabled: true }            │                              │
 │ ──────────────────────────►  │ (existing channel CRUD;      │
 │                              │  setup contract does NOT     │
 │                              │  write to the DB itself)     │
```

Key design choices:

- **Plugin owns session state.** The gateway is stateless; sessions live in the plugin's own `Map<sessionId, State>` for the gateway lifetime. This matches how `start()` plugins already own their in-process state (sockets, pollers). Plugins are responsible for their own timeouts/GC.
- **Setup does not write the DB.** `done.config` is returned to the UI, which then calls the existing `POST /api/agents/:id/channels` (or PATCH) to persist the row. This keeps the setup contract focused on producing config and leaves the persistence/enable path unchanged.
- **The UI wizard is generic.** The admin UI switch-renders on `state.kind` — input form, `awaiting_external` (renders QR and/or "open link" button from `qrText` / `redirectUrl`, polls every `pollIntervalMs`), done, error. No channel-specific UI code. Channels with truly bespoke needs can ship their own admin-UI panel later (out of scope for this contract).
- **`awaiting_external` covers QR scans, OAuth device flow, and any "open this URL in your browser, finish, we'll poll for you" pattern.** Plugins set `qrText`, `redirectUrl`, or both. What is explicitly out of scope for v1 is the classic OAuth redirect flow where the provider posts a `code` back to a callback URL the gateway hosts — that needs per-plugin callback routing and is deferred. Channels that support device-flow OAuth (Google, GitHub, Slack via device code) work today; channels that *only* support the redirect flavor cannot use the setup contract yet and must fall back to the existing token-paste path.
- **All fields except `begin` and `poll` are optional.** Plugins with a single-step external flow (just a QR) don't implement `submit`. Plugins with no external resources (sockets, sub-processes) to clean up don't implement `cancel`.

`setup` is itself optional on `ChannelManifest`. Token-only channels (telegram/slack/discord) leave it unset and continue to use the existing "fill the form, save the row, enable" path.

## Discovery and Loading

Plugins are loaded from two sources, in order:

1. **CLI-bundled defaults.** Manifests imported directly in `apps/cli/src/cli.ts` (or a dedicated `default-channels.ts`) and registered before reading external config. These are bundled by `tsup` and always available.
2. **External packages listed in config.** Read from `config.yaml`:

   ```yaml
   channel_packages:
     - '@heyamiko/channel-signal'
     - '@heyamiko/channel-weixin'
   ```

   At gateway boot, each name is passed to `await import(name)`. Node's module resolution finds the package in the same `node_modules` tree the CLI itself lives in.

If the same `key` is registered twice (e.g. a vendor publishes their own `@vendor/channel-telegram`), the external one wins and a `plugin.duplicate@v1` warning is logged. This lets operators override a default without forking.

### Why global `node_modules` works

When the CLI is installed via `npm install -g @openhermit/cli`, both the CLI and any `npm install -g @vendor/channel-foo` package land as siblings in the same global tree (`/usr/local/lib/node_modules/` on most systems, `~/.npm-global/lib/node_modules/` if the user prefixed npm). Node's normal upward resolution from the CLI's runtime location finds external channel packages without any custom `NODE_PATH` manipulation.

v1 supports npm-installed CLI only — pnpm, bun, homebrew, and standalone-binary distributions are out of scope (see "Scope Decisions" below). For development inside the monorepo, channel packages are workspace deps and resolution is trivial.

## CLI Bundling Policy

| Channel | Bundled in CLI? | Loaded via |
|---|---|---|
| `@openhermit/channel-telegram` | yes (default) | static import + manifest registration |
| `@openhermit/channel-slack` | yes (default) | static import + manifest registration |
| `@openhermit/channel-discord` | yes (default) | static import + manifest registration |
| `@openhermit/channel-signal` | no | global `node_modules` + `channel_packages` config |
| `@heyamiko/channel-weixin` | no | global `node_modules` + `channel_packages` config |
| `@heyamiko/channel-debox` | no | global `node_modules` + `channel_packages` config |

This honors "default-bundle the three established channels so `hermit` is usable out-of-box" while keeping the loading path uniform — both bundled and external go through the same manifest registration, so there is no special-case code for the built-ins.

`apps/cli/tsup.config.ts` needs no new entries beyond what's there today; the three default channels keep their `noExternal` treatment (slack and discord need to be added; only telegram is listed currently).

## Migration Plan

Sequenced so each step is independently shippable:

1. **Manifest contract.** Add `ChannelManifest` type and `ChannelManifestRegistry` runtime class in `packages/protocol` and `apps/gateway`. No behavioral change yet — `BUILTIN_CHANNELS` becomes a thin wrapper that constructs three manifests internally.
2. **Refactor built-ins to export manifests.** `@openhermit/channel-telegram`, `-slack`, `-discord` add `export default manifest`. The CLI imports and registers them explicitly at boot.
3. **Add `channel_packages` config.** Gateway reads the list, dynamic-imports each, registers. Empty list = no-op, fully backwards compatible.
4. **Delete `BUILTIN_CHANNELS` constant.** All consumers (`channels.ts` `starters` map, admin UI registry, backfill) now read from the runtime registry. Backfill becomes: "for each manifest registered at boot, ensure an `agent_channels` row exists per active agent."
5. **Ship Signal as the first external-default channel.** PR #81 rebased: drop from `BUILTIN_CHANNELS`, drop from `tsup` `noExternal`, add `export default manifest`. Operators add `@openhermit/channel-signal` to `channel_packages` to enable.
6. **Admin UI registry.** `/api/channels/available` returns the runtime registry instead of a hardcoded list. Form rendering uses each manifest's `parseConfig` (or a richer descriptor we add later — `parseConfig` is opaque by design, so the UI may eventually want an explicit JSON-Schema or Zod field for form generation).

Steps 1–4 are pure infrastructure with no user-visible change. Step 5 is the first user-visible delivery; step 6 polishes the admin UX.

## Scope Decisions

### v1 supports npm only

- **No pnpm or bun global resolution.** Their global layouts use symlink trees that Node's default upward resolution from the CLI's location does not traverse. Supporting them is feasible (custom `createRequire` paths, `PNPM_HOME`-aware loader) but each adds a code path that must be maintained. Operators wanting pnpm/bun can install the CLI and channel packages into a project-local `node_modules` and point the gateway at it via env var — but this is unsupported in v1.
- **No homebrew / `curl | sh` / standalone-binary distributions.** Those install the CLI outside any `node_modules` tree, so a sibling-resolution model doesn't apply. v1 is `npm install -g @openhermit/cli` only. Other distribution channels are a future-work item.

These constraints are documented in the operator-facing channel install docs (added in PR2 alongside the `hermit channel install` command) so users picking pnpm/bun/brew aren't surprised.

### `hermit channel install` ships in PR2

A thin wrapper around `npm install -g <pkg>` that also appends the package to `channel_packages` in the gateway config. Without it, operators have to run npm directly and edit the config file by hand — workable but not first-class. PR2 includes it as part of the user-visible delivery.

### Supply-chain trust is the operator's responsibility

The gateway loads arbitrary npm packages whose `start()` runs with full gateway permissions. v1 takes no position on signing, sandboxing, or capability restriction; the operator-facing docs say plainly:

> Installing a channel plugin grants the plugin's code the same authority as the gateway process. Only install plugins from sources you trust — pin versions, audit changes, and treat `npm install -g @vendor/channel-foo` with the same caution as `sudo`.

Signing / capability-scoped sandboxing is a future-work item. Out of scope for v1.

## Open Questions

None at this revision. Future revisions land here as the design hits real-world friction.
