---
title: Memory
slug: memory
order: 6
part: Part 2 — Daily Use
description: How the agent remembers things across sessions, the three layers of memory, and how to teach, inspect, and forget.
---

# 6. Memory

Memory is what lets the agent feel less like a search box and more like a colleague. After a few conversations it should know your name, your preferences, the project you are working on, the people you talk about. This chapter covers what it remembers, how it decides to remember, and how you correct or clear what it has stored.

---

## 6.1 Three Layers

OpenHermit organizes memory into three layers, top to bottom in scope:

**Session history.** Every message in a single conversation. Bound to the session; if you start a new session, the agent starts with an empty scrollback. Useful for the back-and-forth within one chat.

**Working memory.** Short-lived notes the agent keeps inside one session — "the user prefers markdown tables", "we are debugging the auth flow". It is reset when the session ends. You rarely interact with working memory directly; the agent manages it.

**Long-term memory.** Persistent entries with keys, content, and tags, stored in the database and searchable across every session for that agent. This is the layer that gives the agent continuity. When people say "the agent remembered my address", this is where it lived.

---

## 6.2 How the Agent Decides What to Remember

The agent has tools for adding, recalling, listing, updating, and deleting long-term memory entries. It uses them on its own as the conversation unfolds:

- You say something it judges worth keeping ("I am vegetarian", "our staging URL is …") → it adds an entry.
- You ask a question that touches a topic it has notes on → it recalls.
- Something you said earlier turns out to be wrong → it updates the entry.
- You explicitly ask it to forget → it deletes.

You do not need to use any special syntax. Plain speech works:

- "Remember that I am based in Berlin."
- "Forget what I said about Friday's meeting."
- "What do you remember about the migration project?"

The agent tends to err on the side of remembering more rather than less, so the curation flow is mostly "remove things you don't want", not "make sure it captured everything".

---

## 6.3 Memory Is Per Agent, Not Per User

Long-term memory is attached to the **agent**, not to the person talking to it. Two people sharing one agent share the same memory store. The agent does notice who is speaking (and tags entries with that context), but anything it remembers about Alice is in the same pool as anything it remembers about Bob.

If you need user-private memory, run separate agents — one per person. The cost of that is small (sharing the same instance, just different agent IDs), the isolation is total.

---

## 6.4 Inspecting Memory

To see what the agent is keeping, ask it:

- "List what you remember about me."
- "What memories do you have tagged `project-x`?"
- "Show me your last ten memory entries."

It runs `memory_list` or `memory_recall` and prints the results.

Web admin UI: an admin view of the memory store is on the roadmap; until it ships, the agent itself is your best inspector — it is allowed to read everything.

---

## 6.5 Role Differences

| Role | Read memory | Write memory |
|---|:---:|:---:|
| Owner | ✓ | ✓ |
| User | ✓ | ✓ |
| Guest | — | — |

Guests cannot read or write long-term memory; the memory toolset is hidden from them. This is by design — public agents that auto-create guests should not let strangers write into shared memory.

---

## 6.6 How-to Recipes

### 6.6.1 Teach the agent a long-term preference

**Scenario** — you want the agent to always use metric units in answers.

**Ways to do it**

Just say it:

> Remember that I prefer metric units in all answers, including imperial-to-metric conversion when sources use imperial.

The agent confirms and stores the entry. Future sessions pick it up.

**Verify** — start a fresh session and ask a question that would naturally trigger units ("how far is Berlin from Munich?"). The agent answers in km without prompting.

**Common issues** — if the preference is something you want to enforce as a *rule* (not a soft preference the model might forget), use **instructions** instead ([Chapter 7](07-instructions.md)). Memory is a hint; instructions are mandatory.

---

### 6.6.2 Correct a wrong memory

**Scenario** — the agent has stored "user is allergic to peanuts" but you actually only have a mild sensitivity, not a serious allergy.

**Ways to do it**

Tell it:

> Update your memory: I have a mild peanut sensitivity, not a severe allergy.

It calls `memory_update` on the relevant entry. If multiple entries match, it picks the most recent or asks.

**Verify** — "what do you remember about my allergies?" — the agent should give the corrected version.

---

### 6.6.3 Make the agent forget something

**Scenario** — you tested the agent with fake data and you want the test entries gone.

**Ways to do it**

> Delete every memory entry tagged `test`.

Or:

> Forget what I said about my travel plans last week.

The agent deletes matching entries.

**Verify** — "what do you know about my travel plans?" — should come back empty.

---

### 6.6.4 Migrate memory from one agent to another

**Scenario** — you have been using agent `personal` and want to start fresh with `personal-v2` carrying over a curated set of preferences.

**Ways to do it**

There is no one-click export today. Two practical paths:

- *Have agent A summarise itself.* Ask `personal`: "Give me a markdown bullet list of every memory entry you have." Copy the list. Open a session with `personal-v2` and say "Here are my preferences, store each of these in memory." Slow but exact.
- *Database copy.* If you are also the operator of the OpenHermit instance, you can copy rows from the `memories` table from the old `agent_id` to the new one. This is operator territory, not user territory.

**Verify** — ask `personal-v2` something covered by the migrated preferences.

---

## 6.7 FAQ

**Does the agent remember everything I say?** No. It judges which messages contain durable facts versus which are conversational. If a fact you cared about did not get stored, just say "please remember that …".

**Can I see all of my memory at once?** Yes — ask the agent to list it. There is no hard cap on a single listing; long results will be paginated by the agent.

**If I delete a session, does its memory go too?** Session history goes with the session. Long-term memory entries the agent extracted from that session stay — they were promoted to the long-term store at the time, and deleting the session does not retroactively remove them.

**Can I disable memory entirely?** Yes, by disabling the memory tools through policy (see [Chapter 15](15-policy-and-approval.md)). The agent will then only have session history.

**Does memory cost tokens?** Memory entries are not auto-injected into every prompt. The agent pulls relevant ones on demand via `memory_recall`. So a large memory store does not balloon token usage.

---

## 6.8 Pointers

- Things you want enforced as rules, not soft preferences → [Chapter 7 · Instructions](07-instructions.md).
- Restricting memory for some roles or users → [Chapter 15 · Policy and Approval](15-policy-and-approval.md).
- How memory fits with the rest of the agent's state → [Chapter 3 · Core Concepts](03-concepts.md).
