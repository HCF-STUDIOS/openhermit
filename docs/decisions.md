# Architecture Decisions

This file records decisions that are still relevant to the current implementation.

## ADR-000: Platform-First Runtime

OpenHermit optimizes for hosted multi-agent operation instead of a single local assistant process. The gateway is the control plane, and agents are registered resources with durable state and lifecycle management.

## ADR-001: Internal State Is Outside The Workspace

Conversation history, memories, instructions, users, schedules, skills, MCP assignments, and sandbox rows (per-agent execution environments) are internal state. They live in PostgreSQL, scoped by `agent_id` where applicable.

The workspace is external task state: user files, generated artifacts, repositories, and mounted data.

## ADR-002: PostgreSQL With Drizzle Stores

`packages/store` uses Drizzle and PostgreSQL. SQL migrations live in `packages/store/drizzle/`; schema definitions live in `packages/store/src/schema.ts`.

PostgreSQL gives shared durable state for many agents, indexed event/session queries, and full-text memory search. Drizzle keeps query code close to TypeScript types without introducing a generated ORM client.

## ADR-003: Gateway-Managed In-Process Agents

The current gateway starts `AgentRunner` instances in-process through `AgentInstanceManager`. This is simpler than a reverse proxy over per-agent processes while preserving explicit `/api/agents/{agentId}/...` routing and per-agent lifecycle.

The `AgentInfo.port` field remains protocol-compatible metadata, but current managed agents do not require per-agent ports.

## ADR-004: Durable Sessions Do Not Close Permanently

Sessions are durable threads. They can be idle, running, awaiting approval, or inactive. `/new` and channel session switching mark old sessions inactive rather than destroying history.

## ADR-005: User Identity Is Channel-Based And Role-Gated

Users are resolved from `(channel, channelUserId)` identities. Roles are per-agent: `owner`, `user`, or `guest`.

Owners get full management tools. Users get standard memory/web/session access. Guests are intentionally restricted. Channel adapters can auto-create unknown identities as guests.

## ADR-006: Introspection And Compaction Are Separate

Compaction keeps model context within limits. Introspection maintains long-term memory, working memory, and session descriptions. They run on different triggers and use different tool surfaces.

## ADR-007: Program-Driven Scheduler

Scheduling is a first-class subsystem with cron and one-shot schedules. Schedules are stored in PostgreSQL, run through `Scheduler`, and post prompts back into agent sessions through `AgentRunner` host callbacks.

## ADR-008: Skills Are Prompt Assets, MCP Servers Are Tool Providers

Skills are directories containing `SKILL.md` and optional supporting files. They are indexed in the prompt and synced into each exec backend's sandbox at `<agent_home>/.openhermit/skills/system/` via `runner.syncSkills`.

MCP servers are executable external tool providers. Their tools are discovered at runtime and exposed as namespaced `mcp__{serverId}__{toolName}` tools.

## ADR-009: Built-In Channels Run Beside Agents

Telegram, Discord, and Slack adapters are built-in channel packages. The gateway starts them when the agent config enables them, registers per-channel bearer tokens, and records status for the UI/API.

Adapters use the OpenHermit SDK over gateway agent routes instead of reaching into runner internals.

## ADR-010: Execution Backends Are Pluggable

The `exec` tool runs through an `ExecBackendManager`, built from per-agent rows in the `sandboxes` table. Four backends are implemented: `docker`, `host`, `e2b`, and `daytona`. Gateway-created agents auto-provision a sandbox from the preset named by `autoProvisionSandbox` in `gateway.json` (default: `docker-ubuntu`); the `host` backend is reserved for the privileged "devops" agent (see [`sandbox-model.md`](./sandbox-model.md)).

## ADR-011: Track Upstream pi (`@earendil-works/pi-*`), Delete What Upstream Solves

The agent loop, provider adapters and model registry come from pi (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`, 1.x; formerly `@mariozechner/pi-*` 0.x). We stay on the current upstream line and treat our own provider workarounds as debt: when upstream covers a case, our copy goes.

pi 1.x carries the system prompt and tool declarations inside the transcript as `role: "system"` messages. The runner keeps that system head intact across its in-place transcript rewrites (`agent-runner/system-message.ts`); resumption, compaction and the wire-shape repairs work on the conversation part only. Provider-facing calls take a `TranscriptContext` built with `normalizeContext`.

Removed in the 1.x migration because upstream now handles them:

- `downgradeImagesForTextModel`: pi-ai's `transformMessages` replaces image blocks with a placeholder for models whose `input` lacks `image`.
- The DeepSeek `reasoning_content` replay hack (placeholder thinking blocks and assistant provider/model rewriting): openai-completions auto-detects `requiresReasoningContentOnAssistantMessages` for DeepSeek and replays thinking for same-model turns. Resumed assistant turns now carry the active model's `api`, so pi treats them as same-model.
- The `LOCAL_MODELS` registry overrides (`deepseek-flash`, MiniMax-M3): the 1.x registry carries them.

Kept because upstream still does not cover them: inline `<think>` tag parsing, the stream idle timeout, pre-token stream retry and stream-cut salvage, user/assistant alternation merging and the interleaved tool-result hoist (MiniMax error 2013), orphan tool-result dropping (upstream only synthesizes missing results), the image payload byte cap, thinking-only promotion, and the OpenRouter thinking-format pin for gateways that proxy OpenRouter under another base URL.

pi 1.x prunes retired model ids from its registry. `resolveModel` falls back to the closest same-provider sibling (shared family words, then shared prefix) and keeps the configured id on the wire, so an agent configured with a pruned id (e.g. `deepseek-v4-flash`) still resolves instead of failing at session open. The fallback only covers our side: whether the request succeeds is up to the provider, and an id the provider itself has retired still errors and needs a config migration to a current model. Upstream requires Node.js 22.19 or newer.
