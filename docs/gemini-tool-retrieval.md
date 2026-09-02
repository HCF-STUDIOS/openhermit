# Gemini Tool Retrieval (Interactions API) + Amiko CLI catalog

> Internal / EAP. The `gemini-flash-tool-retrieval` model is a confidential
> Google early-access preview — do not enable it for end users or document the
> endpoint publicly.

## What this is

OpenHermit's normal Google path goes through pi-ai's `generateContentStream`
and sends **every** registered tool schema on each turn. Google Tool Retrieval
works differently: the model gets a single `tool_search` tool (client-side
execution), searches a catalog at runtime, and only then receives the matching
function declarations.

The adapter in
`apps/agent/src/providers/google-interactions-tool-retrieval.ts` implements
this over the Interactions API (`/v1beta/interactions`) for models configured
with `api: "google-interactions"`:

- the transport is a composable `StreamFn` wrapper — pi-agent-core still runs
  the tool loop, so session events, message persistence, approval gating, and
  Langfuse tracing all behave as usual;
- requests are stateless (`store: false`); the full step history is replayed
  each call, with Gemini thought signatures round-tripped via pi-ai's
  `thinkingSignature` / `thoughtSignature` fields;
- turn 1 advertises **only** `tool_search` (`execution: "client"`); after an
  `amiko_tool_search` result, exactly the searched declarations are added;
- server-side `defer_loading: true` with full parameters is known to return
  HTTP 400 on this EAP model (misleading JSON-syntax error). Do not add it —
  client-side execution is the supported mode.

The searchable catalog (`apps/agent/src/tools/amiko-cli-catalog.ts`) exposes
~25 readonly-leaning Amiko CLI commands (credits, wallets, chat, drive,
friends, users, notifications, memory, feed, markets). Execution shells out to
the `amiko` binary via `execFile` (no shell interpolation). Mutating entries
(e.g. `amiko_chat_send`) are owner-gated by policy.

## Configuration

Agent `config_json.model`:

```json
{
  "provider": "google",
  "model": "gemini-flash-tool-retrieval",
  "max_tokens": 8192,
  "thinking": "off",
  "base_url": "<EAP Interactions endpoint>"
}
```

Environment / secrets:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | API key with EAP access to the model |
| `GOOGLE_INTERACTIONS_BASE_URL` | Interactions endpoint, if not set via `base_url`. A bare host gets `/v1beta/interactions` appended; a URL ending in `/interactions` is used verbatim. **There is no default — the adapter errors without one.** |
| `AMIKO_BIN` | Path to the amiko CLI. Pin the Commander build (`@heyamiko/amiko-cli` ≥ 0.14.0-beta.25, e.g. a checkout's `dist/index.js`) — **not** the old 0.4.12 Ink TUI some machines have globally. `.js` paths are run through `node` automatically. |
| `AMIKO_CWD` | Directory whose `.amiko.json` provides twin auth. Tokens never appear on argv and are never logged. |

## Smoke test

Prompt an agent configured as above:

> Using Amiko CLI tools, what is my credits balance? Then show the amiko CLI
> version.

Success means the transcript shows the Tool Retrieval path — not the normal
tool loop:

1. Turn 1 request `tools` contains only `tool_search` (client execution).
2. Model calls `amiko_tool_search` (query ≈ credits / version).
3. Tool result carries function declarations for `amiko_credits_balance` /
   `amiko_version`.
4. Model calls those tools; the runner executes `amiko credits balance` and
   `amiko --version` and returns real output.
5. Final assistant text cites the live balance and version.

A run that answers via `exec` + the amiko skill, or via `web_search`, does
**not** validate Tool Retrieval.

Unit tests (no keys needed — Interactions is mocked):

```bash
cd apps/agent
node --import tsx --test test/amiko-cli-catalog.test.ts test/google-interactions-tool-retrieval.test.ts
```
