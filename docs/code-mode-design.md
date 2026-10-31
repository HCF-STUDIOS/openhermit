# Code Mode (Programmatic Tool Calling) — Design

**Status:** Draft / scaffold landed behind a flag (off by default)
**Flag:** `OPENHERMIT_CODE_MODE=1` (per-process; see *Rollout*)
**Tracking:** borrow item #4 from the DeepSeek Harness study (`project_dsh_harness_study`)

## Summary

Today an agent drives tools one JSON tool-call at a time: the model emits a
`toolCall`, we run it, and the full result is appended to the transcript as a
`toolResult` the model has to re-read on the next step. For turns that touch
many tools — a feed scan that emits 20+ `attachment_fetch` / `web_fetch` /
`session_read` results — this is both slow (one model round-trip per call) and
expensive (every intermediate result sits in context and forces compaction
every ~2 turns).

**Code mode** gives the model a different modality: instead of calling tools one
at a time, it writes a short program (TypeScript by default) that calls tools
through a *generated SDK*, runs the whole program in the agent's sandbox in a
single step, and returns only the values the program chose to surface. Loops,
filtering, and fan-out happen inside the program — in the sandbox, not in the
transcript — so the context only ever sees the distilled output.

This is the pattern DeepSeek Harness calls PTC (programmatic tool calling) and
that Anthropic/Cloudflare have described as "code mode." The win for us is
concentrated on exactly our worst turns: high-fan-out, read-heavy scans.

## Why it helps us specifically

| Dimension | One-call-at-a-time | Code mode |
|---|---|---|
| Model round-trips for N tool calls | N | 1 |
| Intermediate results in context | all N | only what the program returns |
| Compaction pressure on scan turns | every ~2 turns | rare |
| Control flow (loop/filter/retry) | model re-prompted each step | ordinary code |

It does **not** replace single tool calls — for a one-shot `web_search` the
JSON path is simpler and cheaper. Code mode is an *additional* tool the model
reaches for when a task is inherently programmatic (batch, join, filter,
multi-step transform).

## Architecture

```
model ──run_code(source)──▶ AgentRunner
                               │  write program + generated SDK into sandbox
                               ▼
                          ExecBackend (per-agent sandbox)
                               │  node/tsx (or python) runs the program
                               │  SDK calls tools via a bridge ◀─┐
                               ▼                                  │ RPC
                          program stdout / returned value ────────┘
                               │
                               ▼
                   structured toolResult (distilled output only)
```

Three pieces:

1. **`run_code` tool** (this PR, scaffold): accepts `source` + `language`,
   materializes it into the sandbox, executes it with the language runtime, and
   returns stdout/stderr/exit code as a structured result. This is the transport
   and execution shell.

2. **Generated SDK** (future): for the tools the agent is allowed to use, we
   generate a typed client module (e.g. `openhermit`) injected alongside the
   program, so the model writes `await oh.web_fetch({ url })` instead of shelling
   out. The SDK's method surface and TypeScript types are derived from the same
   TypeBox schemas that already define each tool's parameters — single source of
   truth, no drift.

3. **Tool bridge** (future, the hard part): the SDK calls have to reach back
   into the *host* tool layer (policy checks, approval gates, stores) — the
   sandbox cannot be trusted to run tools itself. See *Tool bridge* below.

This PR lands only piece (1), behind a flag, so the shape is reviewable and the
registry wiring is exercised without committing to the bridge design yet.

## Tool bridge (the core future work)

The sandboxed program must not get direct access to stores, credentials, or the
policy engine — that would make the sandbox a trust-boundary bypass. So SDK
calls run as RPC *out* of the sandbox and back into the host runtime, where the
exact same `withApproval` / policy-evaluation path that guards normal tool calls
applies. Options, roughly in order of preference:

- **Unix socket / named pipe into the sandbox.** The runner mounts a socket; the
  injected SDK marshals `{tool, args}` over it; the host dispatches through the
  real tool registry (policy + approval + hook bus) and marshals the result
  back. Keeps one dispatch path; the sandbox never holds a credential.
- **HTTP loopback to a per-session, per-nonce endpoint.** Simpler to implement
  across backend types (docker/e2b/ssh) but needs careful auth so only *this*
  program for *this* turn can call it.
- **Batch manifest (no live bridge).** The program emits a list of intended
  tool calls; the host executes them between runs. Loses in-program control flow
  (the main point), so this is a fallback only.

Whichever we pick, the invariants are fixed (see *Security model*).

## Security model

Code mode must not widen the trust boundary that `exec` already establishes.

- **Same sandbox, same isolation.** `run_code` runs in the agent's existing
  per-agent `ExecBackend` — the same place `exec` runs shell commands. It adds
  no new execution surface; an agent that can `exec` can already run arbitrary
  code. Code mode is ergonomics on top of that, not new privilege.
- **Tool calls re-enter the guarded path.** Every SDK tool call is dispatched by
  the host through `withApproval` + `evaluateAccess` (policy rows) + the hook
  bus — identical to a direct `toolCall`. A program cannot call a tool the model
  couldn't have called directly, and `require_approval` still prompts the owner.
- **No credentials in the sandbox.** Provider keys, store handles, and the DB
  connection never cross into the program. Only the tool *results* the host
  chooses to return do.
- **Policy gate on `run_code` itself.** The tool defaults to `owner`-only grants
  (same as `exec`), so in multi-tenant deployments a guest/user caller cannot
  invoke it unless an owner widens the policy.
- **Resource bounds.** Wall-clock timeout, output truncation (reuse
  `MAX_TOOL_RESULT_CHARS`), and the existing sandbox CPU/memory limits apply.
  The bridge enforces a per-run cap on the number of tool calls.

## Multi-tenant / sandbox fit

- **Per-agent sandbox, not per-process.** Unlike dsh (single-user, local
  process), our sandboxes are per-agent and support pause/resume. `run_code`
  uses `ExecBackendManager.get(alias)` exactly like `exec`, so it inherits
  sandbox selection, `ensure()` (resume-from-pause), and lifecycle idle timers.
- **Session/agent identity propagation.** The same `OPENHERMIT_SESSION_ID` /
  `OPENHERMIT_AGENT_ID` env the exec tool injects is available to the program,
  so in-sandbox CLIs it spawns route async results back to the right session.
- **No persistent-volume assumption.** The program is materialized fresh per run
  under the agent home; nothing new has to survive a volume-free restart.

## SDK generation (future)

The generated client is derived from each tool's TypeBox `parameters` schema —
the same schema the JSON tool-call path validates against:

- Emit a `.d.ts` + a thin runtime module exposing one async method per allowed
  tool, named identically to the tool (`web_fetch`, `attachment_fetch`, …).
- Argument and return types come straight from the TypeBox `Static<>` types, so
  the model gets real autocomplete-grade types and we get zero schema drift.
- Only tools the current principal is *allowed* to call (post policy
  evaluation) appear in the generated surface for that run — the SDK is
  generated per-turn, per-principal, not once globally.

## Scope of this PR

- `docs/code-mode-design.md` — this document.
- `apps/agent/src/tools/run-code.ts` — the `run_code` tool + toolset, policy-
  gated to `owner`, materialize-and-execute in the sandbox. **No tool bridge and
  no generated SDK yet** — the program runs with plain runtime access only, and
  the tool's description says so.
- `codeModeEnabled` flag on `ToolContext`; the toolset is only registered when
  the flag is set. The flag is read from `OPENHERMIT_CODE_MODE` in the runner.
- Unit tests driving the tool against a fake `ExecBackend`.

Everything is **off by default**: with the flag unset, `createBuiltInToolsets`
never adds the toolset, so there is zero behavior change in production.

## Rollout

1. Land scaffold behind `OPENHERMIT_CODE_MODE` (this PR) — no default change.
2. Build the tool bridge + generated SDK behind the same flag.
3. Dogfood on a single agent (set the env on one deploy), measure
   compaction-frequency and latency on feed-scan turns.
4. Promote from env flag to per-agent config once the bridge is proven.

## Open questions

- Runtime for TS: `tsx` (needs the dep present in every sandbox image) vs.
  pre-transpile on the host and ship JS. Leaning host-transpile to avoid a
  per-image dependency.
- Bridge transport across all three backend types (docker / e2b / ssh) —
  loopback HTTP is the most portable but needs the tightest auth.
- Per-run tool-call budget and how to surface "budget exhausted" back into the
  program vs. aborting the run.
