---
title: Models
slug: models
order: 16
part: Part 4 — Configuring Your Agent
description: Pick which LLM the agent uses, and switch between providers without losing memory or sessions.
---

# 16. Models

The **model** is the LLM driving the agent's replies. OpenHermit is provider-agnostic — Anthropic Claude, OpenAI, OpenRouter, your own self-hosted endpoint, anything that speaks a supported API. You can change it at any time without losing memory, sessions, or skills.

---

## 16.1 What Choosing a Model Affects

- **Quality of replies** — bigger / newer models reason better.
- **Latency** — smaller models are faster.
- **Cost per turn** — varies dramatically; tool-heavy agents amplify the spread.
- **Tool-use reliability** — some models follow tool schemas more strictly than others. If the agent often picks wrong arguments, the model is a likely culprit.
- **Context window** — bigger windows let the agent juggle more files in one turn.

Everything else (memory, instructions, skills, MCPs, workspace) is independent of the model.

---

## 16.2 The `hermit config` Commands

Model selection lives under the agent's config tree, not as a flag on `hermit agents`. Two keys matter:

- `model.provider` — which provider the gateway routes to (`anthropic`, `openai`, `openrouter`, …).
- `model.model` — the model identifier the provider expects.

```bash
hermit config --agent main show                     # see all current config, including model.*
hermit config --agent main get model.model          # one key
hermit config --agent main set model.provider anthropic
hermit config --agent main set model.model claude-opus-4-7

# Other useful model knobs:
hermit config --agent main set model.max_tokens 16384
```

The model identifier is whatever string the provider expects. The gateway hands it through.

---

## 16.3 Providers and Credentials

The gateway routes calls to the provider implied by the model ID. Provider credentials are stored as secrets at the gateway level — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and so on. See [Chapter 18 · Secrets](18-secrets.md).

If you switch to a provider whose credential is not set, the agent will error on the next turn with a clear message. Fix the secret and retry.

---

## 16.4 Switching Mid-Conversation

You can change the model in the middle of an active session. The next turn uses the new model, with the same session history. This is useful for:

- Escalating from a cheap model to a strong one when a task gets hard.
- Dropping to a cheap model for routine follow-ups.

Be aware of context-window mismatches: switching from a 200K-window model to a 32K-window one mid-session can truncate history.

---

## 16.5 Web Admin UI

*Manage → Basic* has the model selector — a dropdown with the models the gateway has been told about.

---

## 16.6 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| See current model | ✓ | ✓ | — |
| Change model | ✓ | — | — |

---

## 16.7 How-to Recipes

### 16.7.1 Try a stronger model for a hard task

```bash
hermit config --agent main set model.provider anthropic
hermit config --agent main set model.model claude-opus-4-7
```

Ask the question. If the answer is good and the latency tolerable, leave it. If you only needed the strength for one task, switch back when done.

---

### 16.7.2 Make the agent cheaper for routine use

Pick a faster, smaller model for everyday chat:

```bash
hermit config --agent main set model.model claude-haiku-4-5
```

Watch tool-use reliability for the first few turns; smaller models occasionally pick the wrong tool. If you see drift, fall back to a mid-tier model.

---

### 16.7.3 Use a self-hosted or alternate endpoint

If your gateway is configured with a custom provider (e.g., a local llama.cpp instance, an Azure OpenAI deployment), set `model.provider` to that provider's name and `model.model` to one of the IDs it accepts. If the provider needs a custom endpoint, the operator wires that on the gateway side.

---

## 16.8 FAQ

**Will changing the model erase memory or session history?** No. Both are storage-side and provider-independent.

**Can different agents on the same gateway use different models?** Yes — per agent.

**Can different sessions use different models within one agent?** No — model is an agent-level setting. To get session-level routing, run multiple agents.

**What about temperature, top-p, max-tokens?** `model.max_tokens` is settable per agent. Temperature and top-p use gateway-level defaults unless your build exposes them as additional `model.*` keys — check `hermit config --agent <id> show`.

---

## 16.9 Pointers

- Provider credentials → [Chapter 18 · Secrets](18-secrets.md).
- Cost / latency observation → [Chapter 20 · Web Admin UI](20-web-admin-ui.md), Observe tab.
