---
title: Secrets
slug: secrets
order: 18
part: Part 4 — Configuring Your Agent
description: API keys, bot tokens, and other credentials — how to store them safely and where they get used.
---

# 18. Secrets

A **secret** is a credential the agent or one of its adapters needs but you do not want sitting in a config file in plain text. GitHub tokens, Slack bot tokens, model provider API keys, internal API credentials — all secrets. OpenHermit keeps them in a separate store and substitutes them into configs at runtime.

---

## 18.1 What Goes Where

| Credential | Used by | Stored as |
|---|---|---|
| Anthropic / OpenAI / etc. API key | Model calls | Gateway-level secret |
| Telegram / Discord / Slack bot token | Channel adapter | Per-agent or gateway secret |
| GitHub / Slack / etc. token for MCP | MCP server | Per-agent secret |
| Internal API key | Custom MCP server | Per-agent secret |

The pattern is: never paste a credential into the agent's instructions or messages. Put it in the secret store and reference it.

---

## 18.2 The `hermit config --agent ... secrets` Commands

```bash
# List secret names (values are not shown).
hermit config --agent main secrets list

# Set a secret.
hermit config --agent main secrets set GITHUB_TOKEN <value>

# Set a secret that should be passed through to MCP / channel adapter env.
hermit config --agent main secrets set GITHUB_TOKEN <value> --pass-through

# Set a secret you do NOT want exposed to subprocess env.
hermit config --agent main secrets set INTERNAL_KEY <value> --no-pass-through

# Delete.
hermit config --agent main secrets remove GITHUB_TOKEN
```

Gateway-level secrets (shared across all agents) typically live in environment variables on the gateway host, not in `hermit config --agent ... secrets`. Your operator controls those.

---

## 18.3 How Secrets Get Substituted

Configurations reference secrets by name with `${{NAME}}`:

```yaml
mcp_servers:
  github:
    env:
      GITHUB_TOKEN: ${{GITHUB_TOKEN}}
```

At startup time, the gateway substitutes the real value. The agent's prompt never sees the raw secret — it only sees the tools that use it.

---

## 18.4 Pass-Through

Many secrets need to reach subprocesses (an MCP server's environment, a channel adapter's runtime). `--pass-through` (default) means yes; `--no-pass-through` means the secret stays inside the gateway and can only be read by config substitution. Use the strict mode for credentials that should never leak into a child process's env table.

---

## 18.5 Web Admin UI

*Manage → Secrets* shows the secret names (values hidden) and lets you set / delete. Same store as the CLI.

---

## 18.6 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Read secret names | ✓ | — | — |
| Read secret values | ✓ (only via direct gateway access) | — | — |
| Set / delete | ✓ | — | — |

Even owners do not see secret values in the UI after setting them — set-only. To rotate, set again with the new value.

---

## 18.7 How-to Recipes

### 18.7.1 Rotate a GitHub token

```bash
hermit config --agent main secrets set GITHUB_TOKEN <new-token>
hermit mcp disable mcp_github --agent main
hermit mcp enable  mcp_github --agent main
```

The disable/enable cycle restarts the MCP server so it picks up the new value. Some adapters pick up changes hot — check your MCP server's behaviour.

**Verify** — ask the agent to do a GitHub action that requires the new permissions.

---

### 18.7.2 Move a credential from an instruction into a secret

You discover an old `instructions` section contains an API key in plain text. Fix:

```bash
hermit config --agent main secrets set MY_API_KEY <value>
hermit instructions get tools --agent main         # copy the body
# Edit locally — replace the raw key with ${{MY_API_KEY}}
hermit instructions set tools --file ./tools.md --agent main
```

**Verify** — `hermit instructions get tools` shows the placeholder, not the value.

---

### 18.7.3 Audit which secrets an agent has

```bash
hermit config --agent main secrets list
```

If you see names that no longer correspond to an enabled MCP or channel, delete them.

---

## 18.8 FAQ

**Where are secrets actually stored?** In the gateway's database, encrypted at rest with the gateway's key. Backup of that database is operator territory — make sure backups are encrypted too.

**Can the agent see a raw secret value?** No. The agent receives the configuration *after* substitution into the relevant env / tool definitions. It never receives the value in its prompt context.

**Can I version-control my secrets?** No. Treat secret values as ephemeral. Version-control the secret *names* and the reference shape; the values belong only in the secret store.

**What about per-user secrets?** Not supported. Secrets are per agent. If you need per-user credentials, run one agent per user.

---

## 18.9 Pointers

- MCP credential setup → [Chapter 9 · MCP Servers](09-mcp-servers.md).
- Channel tokens → [Chapter 17 · Channels](17-channels.md).
- Model provider credentials → [Chapter 16 · Models](16-models.md).
