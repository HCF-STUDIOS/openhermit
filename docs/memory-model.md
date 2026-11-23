# Memory Model

OpenHermit has three memory layers:

- **Session history:** persisted event log in `session_events`
- **Working memory:** session-local summary stored on `sessions`
- **Long-term memory:** key/content entries in `memories`

## Long-Term Memory

Long-term memory is implemented by `DbMemoryProvider`.

| Field | Meaning |
|-------|---------|
| `memory_key` | stable memory ID |
| `content` | memory text |
| `metadata_json` | arbitrary metadata |
| `created_at` / `updated_at` | timestamps |
| `content_tsv` | generated PostgreSQL FTS column, created by SQL migration/lazy setup |

Search first uses PostgreSQL `tsvector` ranking, then falls back to per-word `ILIKE` over key and content. The fallback matters for partial matches, keys, and non-English text.

## Memory Tools

Main agent memory tools:

- `memory_get`
- `memory_list`
- `memory_recall`
- `memory_add`
- `memory_update`
- `memory_delete`

Introspection-only tools:

- `working_memory_update`
- `session_description_update`

## Context Injection

At turn start, the prompt can include:

- agent instructions
- recent session history
- current session working memory
- skill index
- user/role context

Long-term memories are not auto-injected; the agent retrieves them on demand with the memory tools above. (`memory.context_entry_limit` is still accepted in config but is currently unused.)

## Introspection

Introspection is program-triggered and model-executed. It sees recent unsummarized history, previous working memory, current description, and memory tools. It may:

- add/update/delete long-term memories
- update working memory
- update the session description

Config:

```json
{
  "memory": {
    "context_entry_limit": 10,
    "introspection": {
      "enabled": true,
      "turn_interval": 5,
      "idle_timeout_minutes": 10,
      "max_tool_calls": 10,
      "model": null
    }
  }
}
```

## Compaction

Compaction is separate from introspection. It reduces model context when history grows too large, preserving recent continuity and summarized older context. It does not decide what belongs in long-term memory.

## Ownership

Memory content is agent-generated or user-requested, but memory lifecycle is runtime-controlled. The runtime decides when introspection runs and what transcript range it sees.
