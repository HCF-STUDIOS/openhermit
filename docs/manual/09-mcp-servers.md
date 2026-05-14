---
title: MCP Servers
slug: mcp-servers
order: 9
part: Part 2 — Daily Use
description: Connect external tools — GitHub, Slack, Linear, your own APIs — through the Model Context Protocol.
---

# 9. MCP Servers

The **Model Context Protocol** (MCP) is a standard way for AI agents to call external tools. An **MCP server** exposes a set of tools to the agent: read a GitHub issue, post a Slack message, query a database, hit a custom endpoint. Connecting an MCP server is how you give the agent reach beyond its own workspace.

This chapter is about using MCP servers from a user's perspective: register, enable, talk to the agent and have it pick the right tool. Authoring an MCP server is a different topic that lives upstream in the MCP project itself.

---

## 9.1 What MCP Looks Like in Practice

You enable, say, an MCP server called `mcp_github`. After enabling, the agent has access to tools like `list_issues`, `create_pr`, `read_file`. You then talk to the agent normally:

> What issues are open on the `infra` repo right now?

The agent calls `list_issues` with the right arguments, gets the data, summarises it. You did not type any tool names. The MCP layer is invisible at the chat layer; it shows up in the *tool calls* expansion if you look in the web UI.

---

## 9.2 Where MCP Servers Come From

OpenHermit does not ship default MCP servers — the catalog is whatever you (or the wider MCP ecosystem) registers with the instance. Typical sources:

- **Official MCP servers** — published by the protocol authors and ecosystem partners. Often distributed as npm packages or container images.
- **Community servers** — third parties publishing servers for popular services.
- **Your own** — internal APIs you wrap as an MCP server.

Registration usually happens through OpenHermit's MCP store / configuration. The exact way an operator added them to your instance varies; from your side, what matters is which ones are present and enabled.

---

## 9.3 The `hermit mcp` Commands

```bash
# List MCP servers registered with this instance.
hermit mcp list

# Show which servers are enabled on which agents.
hermit mcp assignments

# Enable an MCP server for one agent.
hermit mcp enable mcp_github --agent main

# Enable for every agent.
hermit mcp enable mcp_github --all

# Disable.
hermit mcp disable mcp_github --agent main
```

Toggling an MCP server is hot — the agent picks up the change on the next message.

---

## 9.4 Authentication and Secrets

Most useful MCP servers need credentials (a GitHub token, a Slack bot token, an internal API key). The pattern is:

1. Store the credential as a **secret** (see [Chapter 18 · Secrets](18-secrets.md)):

   ```bash
   hermit config --agent main secrets set GITHUB_TOKEN ghp_xxx --pass-through
   ```

2. The MCP server's configuration references the secret as `${{GITHUB_TOKEN}}`. The gateway substitutes the value when the server starts.

You manage the credential rotation through `hermit config --agent ... secrets`, not through the MCP server's config.

---

## 9.5 Web Admin UI

The *Manage → MCP* tab lists the registered servers and shows toggles per agent. If your instance exposes an MCP catalog browser, you may also be able to install new servers from there.

---

## 9.6 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Use MCP tools the agent has access to | ✓ | ✓ (default) | ✓ (default) |
| Enable / disable MCP servers | ✓ | — | — |
| Register a new MCP server | ✓ | — | — |

The agent's role-filtered toolset includes MCP tools by default for users; depending on the server, you may want to tighten this with policy. For example, an MCP server that can `create_pr` should probably not be reachable by guests — set a policy rule that blocks it, see [Chapter 15](15-policy-and-approval.md).

---

## 9.7 How-to Recipes

### 9.7.1 Enable GitHub access for your agent

**Scenario** — you want the agent to read issues, comment, and open PRs in a few repos.

**Prerequisites** — an MCP server like `mcp_github` is registered with the instance. (If not, ask the operator to install it.)

**Steps**

```bash
# 1. Store your GitHub token as a secret.
hermit config --agent main secrets set GITHUB_TOKEN <ghp_...> --pass-through

# 2. Enable the MCP server.
hermit mcp enable mcp_github --agent main
```

**Verify** — ask the agent:

> List the most recent issues on the `org/repo` repository.

It should reply with real data from GitHub.

---

### 9.7.2 Tighten an MCP server to read-only for users

**Scenario** — you enabled `mcp_github` and now you want users (not owners) to be able to *read* but not to open PRs or delete branches.

**Steps**

This is policy work. Open [Chapter 15 · Policy and Approval](15-policy-and-approval.md) and add a deny rule for write-y tools when the principal role is `user`. The MCP server stays enabled; the gateway gates individual tools.

---

### 9.7.3 Switch off an MCP server while you investigate

**Scenario** — an MCP server is behaving badly and you want it gone until you fix it.

```bash
hermit mcp disable mcp_slack --agent main
```

Re-enable when ready. No data is lost; the credential and config stay in place.

---

### 9.7.4 Roll an MCP out fleet-wide

```bash
hermit mcp enable mcp_research --all
```

**Verify** — `hermit mcp assignments` shows the server enabled on every agent.

---

## 9.8 FAQ

**Why is the agent suddenly slower after I enabled an MCP server?** Each enabled MCP server contributes its tool definitions to every prompt, raising the input token count. Disable servers you do not use.

**Can the agent pick which MCP server to use?** Yes — tool definitions are tagged with the server name, and the agent routes calls to whichever server exposes the matching tool.

**Can multiple MCP servers expose the same tool name?** Yes; the gateway disambiguates by server prefix. If you have collisions, the agent's tool calls will include the prefix.

**Do MCP servers run in the same sandbox as my workspace?** No — MCP servers are separate processes on the gateway side, talking to the agent over the MCP protocol. They do not have access to your workspace files unless they explicitly expose tools that read them.

**Where do I find more MCP servers?** Check the official MCP project's directory and the GitHub topic `mcp-server`. The ecosystem is growing fast.

---

## 9.9 Pointers

- Manage the credential an MCP server uses → [Chapter 18 · Secrets](18-secrets.md).
- Limit which roles can call a particular MCP tool → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- Skills vs MCP — when to reach for which → [Chapter 8 · Skills](08-skills.md), section 8.8.
