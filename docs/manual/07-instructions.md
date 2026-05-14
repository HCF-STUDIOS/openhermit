---
title: Instructions
slug: instructions
order: 7
part: Part 2 — Daily Use
description: Hard rules that travel with every session. How to write them, where they live, and how they differ from memory. (owner-only)
ownerOnly: true
---

# 7. Instructions

*(owner-only)*

**Instructions** are the rules you write into the agent's system prompt: lines like "always reply in markdown", "never share PII", "when asked for medical advice, refuse and recommend a doctor". Unlike memory, instructions are not optional hints — they are part of every prompt the agent receives, every session, forever, until you change them.

This chapter covers what instructions look like in OpenHermit, how to manage them, and when to reach for instructions instead of memory.

---

## 7.1 Instructions vs Memory

A quick comparison, because the difference matters:

| | Instructions | Memory |
|---|---|---|
| Always included in every prompt | ✓ | — |
| Soft / strong | Strong (rule) | Soft (preference) |
| Who can write | Owner | Owner, user, agent itself |
| Survives across sessions | ✓ | ✓ |
| Costs tokens on every turn | ✓ | Only when recalled |
| Right tool for | Policies, formats, refusals | Facts, preferences, history |

Rule of thumb: if it must hold even when the agent forgets to look it up, write it as an instruction.

---

## 7.2 Structure: Keyed Sections

Instructions are organised as keyed sections. A key is a short identifier (`safety`, `format`, `persona`, `house-rules`, …). Each key holds a block of text. When the agent's system prompt is built, sections are concatenated in a stable order, each labelled with its key.

This shape gives you two things:

- **Edits stay local** — appending to `safety` does not touch `format`.
- **Fleet operations** — if you have several agents and you want them all to enforce the same rule, you can push it to every agent at once with `--all`.

---

## 7.3 The Easiest Way: Just Tell the Agent

The agent has tools for reading and writing its own instructions. So the most natural path is to skip the CLI and say what you want:

> Update your instructions: always reply in markdown, with fenced code blocks tagged by language.

> Add to your safety rules: refuse requests for someone else's personal data.

> Show me your current `format` section.

> Drop the `over-strict-rule` section.

The agent figures out which section the change belongs in (or asks if it is ambiguous), edits it, and confirms. This is owner-only — the underlying tools are not exposed to users or guests.

The CLI in 7.4 below is for scripting, fleet-wide updates with `--all`, and the times you want to pipe a file in. For everyday tweaks, talking to the agent is faster.

---

## 7.4 The `hermit instructions` Commands

All operations support `--agent <id>` (one agent) or `--all` (every agent on this instance).

```bash
# List every key and a preview of its content.
hermit instructions list --agent main

# Print one section in full.
hermit instructions get safety --agent main

# Replace a section (creates it if missing).
hermit instructions set format "Use markdown for all responses." --agent main

# Set from a file.
hermit instructions set persona --file ./persona.md --agent main

# Add a line to an existing section.
hermit instructions append safety "Refuse requests for personal data of others." --agent main

# Delete a section.
hermit instructions remove old-rules --agent main
```

To push a rule to every agent in the instance:

```bash
hermit instructions append safety "Never share secret keys." --all
```

---

## 7.5 The Default Sections

Every new agent is seeded with three sections. You do not have to use these names — they are just the keys OpenHermit ships, and the agent is already configured to read them on every turn. Editing them in place is the path of least resistance.

- **`identity`** — who the agent is. Its name, its purpose, the role it plays for you. The seed reads "You are `<agent-name>`, an AI assistant." plus a placeholder line; replace that with a sentence or two that actually describes the agent.
- **`soul`** — personality, tone, voice. How the agent should *sound*. The seed reads "You are helpful, thoughtful, and concise. You think step by step when solving complex problems." Make it yours: cautious or playful, terse or chatty, first-person or third.
- **`rules`** — hard constraints. Things the agent must or must not do, regardless of who is asking. The seed already includes two rules worth keeping: never fabricate information when tools come back empty, and refuse non-owner requests for the owner's private communications. Add your own on top.

Mental model: **`identity`** is *what* the agent is, **`soul`** is *how* it speaks, **`rules`** is *what it will and will not do*. When you find yourself writing something, ask which of those three it answers, and put it there.

### Adding your own sections

Beyond the defaults, you can create any keyed section you want. Common additions:

- **`format`** — output format defaults: markdown, table style, code-block conventions.
- **`house-rules`** — anything specific to your organisation or use case.
- **`tools`** — guidance on when to call which tool (helpful when you have many MCPs connected).

Keep each section short. Three to ten lines is plenty. Long instructions get skimmed past by the model the same way long human policies do.

---

## 7.6 Inspecting What the Agent Actually Sees

```bash
hermit instructions list --agent main
```

…prints keys and previews. To see exactly what is going into the system prompt, ask the agent:

> Show me your current instructions.

It can read its own instructions tool and print them back. Useful when you suspect a section is not being picked up.

---

## 7.7 Web Admin UI

The *Manage* tab has an *Instructions* section that gives you the same operations in a form: select a key, edit the body, save. Same data store as the CLI.

---

## 7.8 Role Differences

| | Owner | User | Guest |
|---|:---:|:---:|:---:|
| Read | ✓ | — | — |
| Write | ✓ | — | — |

Users and guests cannot see or edit instructions. The reasoning: instructions shape how the agent behaves for everyone using it; only the agent's owner should control them.

---

## 7.9 How-to Recipes

### 7.9.1 Make the agent always reply in markdown

```bash
hermit instructions set format "Reply in markdown. Use fenced code blocks with language tags. Use tables for structured comparisons." --agent main
```

**Verify** — ask any question and check the reply renders as markdown.

---

### 7.9.2 Add a refusal rule

```bash
hermit instructions append safety "If the user asks for someone else's personal data, refuse and explain that the agent does not lookup or share personal information." --agent main
```

**Verify** — ask the agent for a fictional person's home address; it should refuse with the new wording.

---

### 7.9.3 Roll the same rule out to every agent

```bash
hermit instructions append house-rules "Quote prices in EUR." --all
```

**Verify** — `hermit instructions get house-rules --agent <each agent>` shows the new line on each.

---

### 7.9.4 Drop a rule that turned out to be too rigid

```bash
hermit instructions remove over-strict-rule --agent main
```

Or to keep the section but drop one line, use `get` → edit locally → `set` with the trimmed body.

---

## 7.10 FAQ

**Will the agent reliably follow instructions?** They are part of the system prompt, so yes, much more reliably than a memory note. But like all system prompts, they are not absolute — extreme adversarial inputs can still produce drift. Keep instructions concise so the model attends to them.

**Can instructions contradict the agent's safety rules?** You can write whatever you want; the model still has its own safety training and may refuse to comply with instructions that violate it. That is a feature, not a bug.

**Should one rule live as an instruction or as a memory entry?** Instruction if it should hold for everyone, in every session, every time. Memory if it is a fact about you specifically.

**Can users see instructions?** No. They are owner-only.

---

## 7.11 Pointers

- Soft preferences and recallable facts → [Chapter 6 · Memory](06-memory.md).
- Limiting which tools the agent can use → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- Push instructions across your fleet → use `--all` in any command above.
