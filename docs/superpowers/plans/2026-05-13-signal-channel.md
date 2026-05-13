# Signal Channel Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth built-in channel adapter (`@openhermit/channel-signal`) that lets an OpenHermit agent send and receive Signal messages through an external `bbernhard/signal-cli-rest-api` container, mirroring the existing Telegram / Discord / Slack pattern.

**Architecture:** The adapter is a pure-Node REST/WebSocket client to a user-run `signal-cli-rest-api` container (configured with `MODE=json-rpc`). Outbound goes through `POST /v2/send`; inbound goes through a persistent WebSocket at `/v1/receive/{account}`. The adapter owns no daemon supervision — operators run the Signal daemon container themselves and supply its URL + the bot's Signal phone number. Session routing follows the Slack pattern: `signal:` prefix for DMs (keyed by Signal UUID or E.164), `signal:group:<id>` for groups, with `signal_source` / `signal_group_id` metadata for recovery.

**Tech Stack:** TypeScript (ESM, NodeNext), `ws@8.x` for the WebSocket client, `@openhermit/sdk` + `@openhermit/protocol` for gateway interop, `@openhermit/shared` for env loading, native `fetch` for REST. Tests use `node:test` (matches the existing test harness — no vitest/jest in this repo).

**Reference docs:** See `docs/channel-adapter.md` for the adapter contract, `apps/channels/slack/` for the closest analog (also a persistent-socket bridge), and `apps/agent/src/channels.ts` for the launcher wiring.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `apps/channels/signal/package.json` | Workspace package descriptor (deps: `ws`, `@openhermit/sdk`, `@openhermit/protocol`, `@openhermit/shared`) |
| `apps/channels/signal/tsconfig.json` | Build config (mirrors slack) |
| `apps/channels/signal/tsconfig.typecheck.json` | Typecheck config (mirrors slack) |
| `apps/channels/signal/README.md` | Operator docs: docker-compose snippet, registration steps, env vars |
| `apps/channels/signal/src/index.ts` | Entry point (`main()`), exports, standalone CLI shim |
| `apps/channels/signal/src/config.ts` | `SignalAdapterConfig`, `loadConfig()` |
| `apps/channels/signal/src/signal-api.ts` | REST client (`sendMessage`, `sendTyping`, `getAccount`, `fetchAttachment`) + WS receive stream factory |
| `apps/channels/signal/src/formatting.ts` | Markdown → Signal styled text, chunking, `formatAgentResponse` |
| `apps/channels/signal/src/bridge.ts` | `SignalBridge` implementing `ChannelOutbound`; session routing, SSE consumption, allow-list policy |
| `apps/channels/signal/src/bot.ts` | `SignalBot` — owns the WS reconnect loop, normalizes envelopes, dispatches to bridge |
| `apps/channels/signal/test/formatting.test.ts` | Unit tests for markdown conversion + chunking |
| `apps/channels/signal/test/config.test.ts` | Unit tests for config validation |
| `apps/channels/signal/test/bridge.test.ts` | Unit tests for session-key derivation + policy gating |

### Modified files

| Path | Change |
|---|---|
| `apps/agent/src/core/types.ts` (lines 56–93) | Add `SignalChannelConfig`, `signal?` on `ChannelsConfig`, `signal` entry in `BUILTIN_CHANNELS` |
| `apps/agent/src/channels.ts` (lines 81–115, end) | Add `signal` to `startChannels` parallel task list, add `signal` to `starters` map, add `startSignal()` |
| `apps/gateway/src/app.ts` (lines 2196–2215) | Add `signal` entry to `BUILTIN_CHANNEL_DEFS` |
| `docs/channel-adapter.md` (Implemented Adapters table, Session Routing table, Platform Notes) | Document Signal row |
| `package.json` (root) | No change — `apps/channels/*` workspace pattern picks up the new dir automatically |

---

## Architectural decisions baked into this plan

These are decisions made during the brief — when in doubt, follow them rather than re-deriving:

1. **Container-only.** No in-process `signal-cli` daemon spawning. The adapter is a thin client; operators run `bbernhard/signal-cli-rest-api` themselves. (Mirrors how Slack assumes a hosted Slack workspace and Telegram assumes the Bot API exists.)
2. **`MODE=json-rpc` is mandatory.** `MODE=normal` looks healthy on `/v1/about` but breaks the WS upgrade for `/v1/receive`. The adapter must probe this at startup and fail loudly with a remediation message.
3. **No webhook ingress.** Signal has no HTTP-push transport. The bridge owns a persistent WS like Slack Socket Mode / Discord gateway. Do NOT register a `handleWebhook` handler on the channel handle.
4. **Sender identity:** prefer Signal UUID (`uuid:<id>`) over E.164 when the envelope carries both — E.164 is rotatable, UUID is not. Store both in metadata.
5. **No streaming edits.** Signal has poor support for editing one's own messages via signal-cli-rest-api. Wait for `text_final`/`agent_end` and send the full reply in chunks. (Slack edits during streaming; Signal won't.)
6. **Loop protection:** if the bot's own `sourceUuid` appears in an inbound envelope, drop the message. This catches the "linked-as-secondary-device" case where the daemon receives its own outbound messages.
7. **Encrypted secrets:** the WS/REST `httpUrl` may contain a reverse-proxy bearer; the per-agent `account` (phone number) is non-secret but configurable per agent. Both flow through the same `${{SIGNAL_HTTP_URL}}` / `${{SIGNAL_ACCOUNT}}` secret-expansion path as Slack's two tokens.

---

## Task 1: Scaffold the package

**Files:**
- Create: `apps/channels/signal/package.json`
- Create: `apps/channels/signal/tsconfig.json`
- Create: `apps/channels/signal/tsconfig.typecheck.json`
- Create: `apps/channels/signal/src/index.ts` (stub)

- [ ] **Step 1.1: Create the package.json**

Write `apps/channels/signal/package.json`:

```json
{
  "name": "@openhermit/channel-signal",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -p tsconfig.typecheck.json --pretty false",
    "dev": "tsx src/index.ts",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "dependencies": {
    "@openhermit/protocol": "*",
    "@openhermit/sdk": "0.3.7",
    "@openhermit/shared": "0.2.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13"
  }
}
```

The `"@openhermit/protocol": "*"` matches how other channels reference the protocol package via the workspace (verify by reading `apps/channels/slack/package.json` — if they use a pinned version, match that instead).

- [ ] **Step 1.2: Create tsconfig.json**

Copy `apps/channels/slack/tsconfig.json` verbatim to `apps/channels/signal/tsconfig.json` — the config is identical across channels.

- [ ] **Step 1.3: Create tsconfig.typecheck.json**

Copy `apps/channels/slack/tsconfig.typecheck.json` verbatim to `apps/channels/signal/tsconfig.typecheck.json`.

- [ ] **Step 1.4: Create the stub index.ts**

Write `apps/channels/signal/src/index.ts`:

```ts
export const PLACEHOLDER = 'signal-channel';
```

- [ ] **Step 1.5: Install dependencies and verify the workspace picks it up**

Run: `npm install`
Expected: installs `ws` + `@types/ws` into `apps/channels/signal/node_modules`, no other errors.

Run: `npm run typecheck -w @openhermit/channel-signal`
Expected: PASS (the stub has no type errors).

- [ ] **Step 1.6: Commit**

```bash
git add apps/channels/signal/package.json apps/channels/signal/tsconfig.json apps/channels/signal/tsconfig.typecheck.json apps/channels/signal/src/index.ts package-lock.json
git commit -m "feat(channel-signal): scaffold @openhermit/channel-signal package"
```

---

## Task 2: Configuration loader

**Files:**
- Create: `apps/channels/signal/src/config.ts`
- Create: `apps/channels/signal/test/config.test.ts`

- [ ] **Step 2.1: Write the failing test**

Write `apps/channels/signal/test/config.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    prior[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key]!;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('loadConfig returns parsed values when all required env vars are set', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      const cfg = await loadConfig();
      assert.equal(cfg.httpUrl, 'http://signal:8080');
      assert.equal(cfg.account, '+15551234567');
      assert.equal(cfg.agentBaseUrl, 'http://gateway/api/agents/main');
      assert.equal(cfg.agentToken, 'tok');
    },
  );
});

test('loadConfig throws when SIGNAL_HTTP_URL is missing', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: undefined,
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      await assert.rejects(() => loadConfig(), /SIGNAL_HTTP_URL/);
    },
  );
});

test('loadConfig throws when SIGNAL_ACCOUNT is missing', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: undefined,
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      await assert.rejects(() => loadConfig(), /SIGNAL_ACCOUNT/);
    },
  );
});

test('loadConfig throws when agent URL/token are missing', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: undefined,
      OPENHERMIT_AGENT_TOKEN: undefined,
    },
    async () => {
      await assert.rejects(() => loadConfig(), /OPENHERMIT_AGENT_URL/);
    },
  );
});

test('loadConfig strips a trailing slash from httpUrl for predictable URL joins', async () => {
  await withEnv(
    {
      SIGNAL_HTTP_URL: 'http://signal:8080/',
      SIGNAL_ACCOUNT: '+15551234567',
      OPENHERMIT_AGENT_URL: 'http://gateway/api/agents/main',
      OPENHERMIT_AGENT_TOKEN: 'tok',
    },
    async () => {
      const cfg = await loadConfig();
      assert.equal(cfg.httpUrl, 'http://signal:8080');
    },
  );
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `npm test -w @openhermit/channel-signal`
Expected: FAIL — module `../src/config.js` not found.

- [ ] **Step 2.3: Implement config.ts**

Write `apps/channels/signal/src/config.ts`:

```ts
export interface SignalAdapterConfig {
  /** Base URL of the signal-cli-rest-api container, e.g. http://signal:8080. */
  httpUrl: string;
  /** E.164 phone number of the bot's Signal account, e.g. +15551234567. */
  account: string;
  /** Per-agent base URL provided by the gateway (OPENHERMIT_AGENT_URL). */
  agentBaseUrl: string;
  /** Per-agent bearer token provided by the gateway (OPENHERMIT_AGENT_TOKEN). */
  agentToken: string;
  /** Optional list of allowed sender identifiers (E.164 or uuid:<id>) for DMs. */
  allowedSenders?: string[];
  /** Optional list of allowed group ids. */
  allowedGroupIds?: string[];
}

export const loadConfig = async (): Promise<SignalAdapterConfig> => {
  const rawHttpUrl = process.env.SIGNAL_HTTP_URL;
  const account = process.env.SIGNAL_ACCOUNT;

  if (!rawHttpUrl) {
    throw new Error('SIGNAL_HTTP_URL environment variable is required (e.g. http://signal:8080).');
  }
  if (!account) {
    throw new Error('SIGNAL_ACCOUNT environment variable is required (E.164 phone number, e.g. +15551234567).');
  }

  const httpUrl = rawHttpUrl.replace(/\/+$/, '');

  const agentBaseUrl = process.env.OPENHERMIT_AGENT_URL ?? '';
  const agentToken = process.env.OPENHERMIT_AGENT_TOKEN ?? '';

  if (!agentBaseUrl || !agentToken) {
    throw new Error('Agent connection required. Set OPENHERMIT_AGENT_URL + OPENHERMIT_AGENT_TOKEN.');
  }

  const cfg: SignalAdapterConfig = { httpUrl, account, agentBaseUrl, agentToken };

  const allowedSenders = process.env.SIGNAL_ALLOWED_SENDERS;
  if (allowedSenders) cfg.allowedSenders = allowedSenders.split(',').map((s) => s.trim()).filter(Boolean);

  const allowedGroupIds = process.env.SIGNAL_ALLOWED_GROUP_IDS;
  if (allowedGroupIds) cfg.allowedGroupIds = allowedGroupIds.split(',').map((s) => s.trim()).filter(Boolean);

  return cfg;
};
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `npm test -w @openhermit/channel-signal`
Expected: PASS for all 5 config tests.

- [ ] **Step 2.5: Commit**

```bash
git add apps/channels/signal/src/config.ts apps/channels/signal/test/config.test.ts
git commit -m "feat(channel-signal): add config loader with env validation"
```

---

## Task 3: Markdown → Signal formatting + chunking

**Files:**
- Create: `apps/channels/signal/src/formatting.ts`
- Create: `apps/channels/signal/test/formatting.test.ts`

Signal styled text uses Markdown-ish: `**bold**`, `_italic_`, `~strikethrough~`, `||spoiler||`, `` `code` ``, ```` ```preformatted``` ````. Output limit per Signal message: ~2000 chars practically (signal-cli-rest-api docs recommend ≤2000). We chunk on paragraph then newline then word boundary.

- [ ] **Step 3.1: Write the failing test**

Write `apps/channels/signal/test/formatting.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  markdownToSignalStyled,
  splitMessage,
  formatAgentResponse,
  SIGNAL_MAX_LENGTH,
} from '../src/formatting.js';

test('markdownToSignalStyled preserves Signal-native syntax (bold/italic/strike/code/spoiler)', () => {
  assert.equal(markdownToSignalStyled('**bold**'), '**bold**');
  assert.equal(markdownToSignalStyled('_italic_'), '_italic_');
  assert.equal(markdownToSignalStyled('`code`'), '`code`');
  assert.equal(markdownToSignalStyled('~~strike~~'), '~strike~');
  assert.equal(markdownToSignalStyled('||spoiler||'), '||spoiler||');
});

test('markdownToSignalStyled converts single-* italic to underscore italic', () => {
  assert.equal(markdownToSignalStyled('an *emphasized* word'), 'an _emphasized_ word');
});

test('markdownToSignalStyled flattens headings to bold lines', () => {
  assert.equal(markdownToSignalStyled('# Title\nbody'), '**Title**\nbody');
  assert.equal(markdownToSignalStyled('### Sub'), '**Sub**');
});

test('markdownToSignalStyled converts list markers to bullet glyphs', () => {
  assert.equal(markdownToSignalStyled('- one\n- two'), '• one\n• two');
  assert.equal(markdownToSignalStyled('1. one\n2. two'), '• one\n• two');
});

test('splitMessage returns the input unchanged when under cap', () => {
  assert.deepEqual(splitMessage('short'), ['short']);
});

test('splitMessage splits on paragraph boundary when possible', () => {
  const part = 'A'.repeat(SIGNAL_MAX_LENGTH - 100);
  const text = `${part}\n\nsecond paragraph that pushes us over`;
  const chunks = splitMessage(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.endsWith('A'));
  assert.ok(chunks[1]!.startsWith('second paragraph'));
});

test('splitMessage falls back to newline boundary when no paragraph break', () => {
  const line = 'A'.repeat(SIGNAL_MAX_LENGTH - 10);
  const text = `${line}\nnext line that overflows`;
  const chunks = splitMessage(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0]!.length <= SIGNAL_MAX_LENGTH);
});

test('splitMessage hard-splits when no whitespace boundary exists', () => {
  const text = 'X'.repeat(SIGNAL_MAX_LENGTH * 2 + 50);
  const chunks = splitMessage(text);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.length <= SIGNAL_MAX_LENGTH);
  assert.equal(chunks.join(''), text);
});

test('formatAgentResponse converts markdown then chunks', () => {
  const result = formatAgentResponse('# Hello\n\n**world**');
  assert.deepEqual(result, ['**Hello**\n\n**world**']);
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `npm test -w @openhermit/channel-signal`
Expected: FAIL — `../src/formatting.js` not found.

- [ ] **Step 3.3: Implement formatting.ts**

Write `apps/channels/signal/src/formatting.ts`:

```ts
export const SIGNAL_MAX_LENGTH = 2000;

/**
 * Convert Markdown to Signal's styled-text dialect.
 * Signal natively renders **bold**, _italic_, ~strikethrough~, `code`,
 * ```preformatted```, and ||spoiler||. Headings have no native form so we
 * flatten them to bold; list bullets become • glyphs.
 */
export function markdownToSignalStyled(md: string): string {
  return md
    .replace(/~~(.*?)~~/g, '~$1~')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '• ');
}

export function splitMessage(text: string): string[] {
  if (text.length <= SIGNAL_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SIGNAL_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n\n', SIGNAL_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf('\n', SIGNAL_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', SIGNAL_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = SIGNAL_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
}

export function formatAgentResponse(text: string): string[] {
  return splitMessage(markdownToSignalStyled(text));
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `npm test -w @openhermit/channel-signal`
Expected: PASS for all 9 formatting tests.

- [ ] **Step 3.5: Commit**

```bash
git add apps/channels/signal/src/formatting.ts apps/channels/signal/test/formatting.test.ts
git commit -m "feat(channel-signal): add markdown→Signal styled-text formatter"
```

---

## Task 4: REST API client — send + typing

**Files:**
- Create: `apps/channels/signal/src/signal-api.ts`
- Create: `apps/channels/signal/test/signal-api.test.ts`

The signal-cli-rest-api `POST /v2/send` body for direct messages and groups:

```json
{
  "number": "+15551234567",
  "recipients": ["+15559999999"],
  "message": "hello",
  "text_mode": "styled"
}
```

For a group, `recipients` carries the group ID (no `+`, base64). Typing indicator:
`PUT /v1/typing-indicator/{account}` with `{ "recipient": "+155..." }`.

- [ ] **Step 4.1: Write the failing test**

Write `apps/channels/signal/test/signal-api.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SignalApi } from '../src/signal-api.js';

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function makeFetchSpy(response: { status?: number; body?: unknown } = {}): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spy: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const call: RecordedCall = { url, method: (init?.method ?? 'GET').toUpperCase() };
    if (init?.body !== undefined) call.body = JSON.parse(String(init.body));
    calls.push(call);
    const status = response.status ?? 201;
    return new Response(JSON.stringify(response.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: spy, calls };
}

test('SignalApi.sendDirectMessage POSTs /v2/send with recipients = [E.164]', async () => {
  const { fetch: spy, calls } = makeFetchSpy({ body: { timestamp: 1234 } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  const result = await api.sendDirectMessage('+15559999999', 'hi');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://signal:8080/v2/send');
  assert.equal(calls[0]!.method, 'POST');
  assert.deepEqual(calls[0]!.body, {
    number: '+15551234567',
    recipients: ['+15559999999'],
    message: 'hi',
    text_mode: 'styled',
  });
  assert.equal(result.timestamp, 1234);
});

test('SignalApi.sendGroupMessage POSTs with recipients = [groupId]', async () => {
  const { fetch: spy, calls } = makeFetchSpy({ body: { timestamp: 5678 } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await api.sendGroupMessage('group.abc==', 'hi');

  assert.deepEqual(calls[0]!.body, {
    number: '+15551234567',
    recipients: ['group.abc=='],
    message: 'hi',
    text_mode: 'styled',
  });
});

test('SignalApi.sendTyping PUTs /v1/typing-indicator/{account}', async () => {
  const { fetch: spy, calls } = makeFetchSpy({ status: 204 });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await api.sendTyping('+15559999999');

  assert.equal(calls[0]!.method, 'PUT');
  assert.equal(calls[0]!.url, 'http://signal:8080/v1/typing-indicator/%2B15551234567');
  assert.deepEqual(calls[0]!.body, { recipient: '+15559999999' });
});

test('SignalApi.sendDirectMessage throws on non-2xx with the response body', async () => {
  const { fetch: spy } = makeFetchSpy({ status: 400, body: { error: 'invalid recipient' } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await assert.rejects(() => api.sendDirectMessage('+1', 'x'), /invalid recipient/);
});

test('SignalApi.probeReceiveMode rejects when probe endpoint returns non-json-rpc mode', async () => {
  const { fetch: spy } = makeFetchSpy({ body: { mode: 'normal', version: '0.x' } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await assert.rejects(
    () => api.probeReceiveMode(),
    /MODE=json-rpc/,
  );
});

test('SignalApi.probeReceiveMode resolves when /v1/about reports mode=json-rpc', async () => {
  const { fetch: spy } = makeFetchSpy({ body: { mode: 'json-rpc', version: '0.x' } });
  const api = new SignalApi({ httpUrl: 'http://signal:8080', account: '+15551234567', fetch: spy });

  await api.probeReceiveMode(); // does not throw
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `npm test -w @openhermit/channel-signal`
Expected: FAIL — `../src/signal-api.js` not found.

- [ ] **Step 4.3: Implement signal-api.ts (REST portion only — WS comes in Task 5)**

Write `apps/channels/signal/src/signal-api.ts`:

```ts
export interface SignalApiOptions {
  httpUrl: string;
  account: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface SendResult {
  timestamp: number;
}

export class SignalApi {
  readonly httpUrl: string;
  readonly account: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SignalApiOptions) {
    this.httpUrl = opts.httpUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async sendDirectMessage(recipient: string, message: string): Promise<SendResult> {
    return this.send([recipient], message);
  }

  async sendGroupMessage(groupId: string, message: string): Promise<SendResult> {
    return this.send([groupId], message);
  }

  private async send(recipients: string[], message: string): Promise<SendResult> {
    const res = await this.fetchImpl(`${this.httpUrl}/v2/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        number: this.account,
        recipients,
        message,
        text_mode: 'styled',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`signal-cli-rest-api send failed (${res.status}): ${body}`);
    }
    const json = (await res.json()) as { timestamp?: number };
    return { timestamp: json.timestamp ?? Date.now() };
  }

  async sendTyping(recipient: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.httpUrl}/v1/typing-indicator/${encodeURIComponent(this.account)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient }),
      },
    );
    if (!res.ok && res.status !== 204) {
      // typing failures are non-fatal; surface for logging but don't throw
      const body = await res.text().catch(() => '');
      throw new Error(`signal-cli-rest-api typing failed (${res.status}): ${body}`);
    }
  }

  /**
   * Verify the daemon was started with MODE=json-rpc. The /v1/receive
   * WebSocket only upgrades successfully when the daemon is in that mode,
   * but the failure mode is a silent connect-then-disconnect — much better
   * to catch this at startup with a clear message.
   */
  async probeReceiveMode(): Promise<void> {
    const res = await this.fetchImpl(`${this.httpUrl}/v1/about`);
    if (!res.ok) {
      throw new Error(`signal-cli-rest-api /v1/about returned ${res.status}; is the URL correct?`);
    }
    const json = (await res.json()) as { mode?: string };
    if (json.mode !== 'json-rpc') {
      throw new Error(
        `signal-cli-rest-api must run with MODE=json-rpc (got ${json.mode ?? 'unknown'}). ` +
          `Set MODE=json-rpc in the container env and restart.`,
      );
    }
  }
}
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `npm test -w @openhermit/channel-signal`
Expected: PASS for all 6 signal-api tests.

- [ ] **Step 4.5: Commit**

```bash
git add apps/channels/signal/src/signal-api.ts apps/channels/signal/test/signal-api.test.ts
git commit -m "feat(channel-signal): add REST client for send/typing/probe"
```

---

## Task 5: WebSocket receive stream

**Files:**
- Modify: `apps/channels/signal/src/signal-api.ts`
- Create: `apps/channels/signal/test/signal-api-receive.test.ts`

The receive stream is an async iterable of normalized envelopes. Each WS message is a JSON line with shape:

```json
{
  "envelope": {
    "source": "+15559999999",
    "sourceNumber": "+15559999999",
    "sourceUuid": "abc-...",
    "sourceName": "Alice",
    "timestamp": 1701000000000,
    "dataMessage": {
      "message": "hello",
      "groupInfo": { "groupId": "abcd==", "type": "DELIVER" },
      "attachments": []
    }
  },
  "account": "+15551234567"
}
```

We normalize to:

```ts
interface SignalIncomingMessage {
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  text: string;
  groupId?: string;
  timestamp: number;
  isSelf: boolean;
}
```

- [ ] **Step 5.1: Write the failing test**

Write `apps/channels/signal/test/signal-api-receive.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import { SignalApi } from '../src/signal-api.js';

const withMockWsServer = async (
  handler: (ws: import('ws').WebSocket) => void | Promise<void>,
  fn: (port: number) => Promise<void>,
): Promise<void> => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as { port: number }).port;
  wss.on('connection', (ws) => void handler(ws));
  try {
    await fn(port);
  } finally {
    wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
};

test('streamMessages yields normalized DM envelopes', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({
        envelope: {
          source: '+15559999999',
          sourceNumber: '+15559999999',
          sourceUuid: 'uuid-alice',
          sourceName: 'Alice',
          timestamp: 1701,
          dataMessage: { message: 'hi', attachments: [] },
        },
        account: '+15551234567',
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
      });

      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value, done } = await iter.next();
      assert.equal(done, false);
      assert.equal(value!.text, 'hi');
      assert.equal(value!.sourceUuid, 'uuid-alice');
      assert.equal(value!.sourceNumber, '+15559999999');
      assert.equal(value!.sourceName, 'Alice');
      assert.equal(value!.groupId, undefined);
      assert.equal(value!.isSelf, false);
      await iter.return?.();
    },
  );
});

test('streamMessages yields groupId when envelope is from a group', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({
        envelope: {
          sourceNumber: '+15559999999',
          sourceUuid: 'uuid-alice',
          timestamp: 1702,
          dataMessage: {
            message: 'hey',
            groupInfo: { groupId: 'gid==', type: 'DELIVER' },
          },
        },
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
      });
      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value } = await iter.next();
      assert.equal(value!.groupId, 'gid==');
      await iter.return?.();
    },
  );
});

test('streamMessages marks isSelf=true when sourceUuid matches the bot account', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({
        envelope: {
          sourceNumber: '+15551234567',
          sourceUuid: 'uuid-self',
          timestamp: 1703,
          dataMessage: { message: 'loopback' },
        },
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
        selfUuid: 'uuid-self',
      });
      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value } = await iter.next();
      assert.equal(value!.isSelf, true);
      await iter.return?.();
    },
  );
});

test('streamMessages skips non-dataMessage envelopes (receipts, typing, sync)', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({ envelope: { receiptMessage: {} } }));
      ws.send(JSON.stringify({ envelope: { typingMessage: {} } }));
      ws.send(JSON.stringify({
        envelope: {
          sourceNumber: '+15559999999',
          timestamp: 1704,
          dataMessage: { message: 'real msg' },
        },
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
      });
      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value } = await iter.next();
      assert.equal(value!.text, 'real msg');
      await iter.return?.();
    },
  );
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `npm test -w @openhermit/channel-signal`
Expected: FAIL — `streamMessages` not defined on `SignalApi`.

- [ ] **Step 5.3: Extend signal-api.ts with `streamMessages` and the envelope normalizer**

Add to the top of `apps/channels/signal/src/signal-api.ts` (after existing imports):

```ts
import { WebSocket } from 'ws';
```

Replace the `SignalApiOptions` interface and `SignalApi` class to add the WS bits:

```ts
export interface SignalApiOptions {
  httpUrl: string;
  account: string;
  /** UUID of the bot account itself; used to drop self-loopback messages. */
  selfUuid?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface SignalIncomingMessage {
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  text: string;
  groupId?: string;
  timestamp: number;
  isSelf: boolean;
}
```

Inside `SignalApi`, add a `selfUuid` field and these methods:

```ts
  private readonly selfUuid: string | undefined;

  // ...existing constructor body, plus:
  //   this.selfUuid = opts.selfUuid;

  /**
   * Open a persistent WebSocket to /v1/receive/{account} and yield
   * normalized incoming messages. The iterator returns when the caller
   * aborts via `opts.signal`. Reconnect is the caller's responsibility
   * (see SignalBot) so the bridge can apply its own backoff policy.
   */
  async *streamMessages(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SignalIncomingMessage> {
    const wsUrl = this.httpUrl.replace(/^http/, 'ws')
      + `/v1/receive/${encodeURIComponent(this.account)}`;
    const ws = new WebSocket(wsUrl);

    const queue: SignalIncomingMessage[] = [];
    const waiters: Array<(msg: SignalIncomingMessage | null) => void> = [];
    let closed = false;
    let openError: Error | undefined;

    const push = (msg: SignalIncomingMessage | null): void => {
      const w = waiters.shift();
      if (w) w(msg);
      else if (msg) queue.push(msg);
    };

    ws.on('message', (data) => {
      try {
        const raw = JSON.parse(data.toString());
        const normalized = this.normalizeEnvelope(raw);
        if (normalized) push(normalized);
      } catch {
        // skip malformed frames; the daemon occasionally emits non-JSON keepalives
      }
    });
    ws.on('close', () => { closed = true; push(null); });
    ws.on('error', (err) => { openError = err as Error; closed = true; push(null); });

    opts.signal?.addEventListener('abort', () => {
      try { ws.close(); } catch { /* ignore */ }
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) {
          if (openError) throw openError;
          return;
        }
        const next = await new Promise<SignalIncomingMessage | null>((resolve) => waiters.push(resolve));
        if (!next) {
          if (openError) throw openError;
          return;
        }
        yield next;
      }
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  private normalizeEnvelope(raw: unknown): SignalIncomingMessage | null {
    if (!raw || typeof raw !== 'object') return null;
    const env = (raw as { envelope?: Record<string, unknown> }).envelope;
    if (!env || typeof env !== 'object') return null;

    const data = env.dataMessage as Record<string, unknown> | undefined;
    if (!data) return null;
    const text = typeof data.message === 'string' ? data.message : '';
    if (!text) return null;

    const sourceUuid = typeof env.sourceUuid === 'string' ? env.sourceUuid : undefined;
    const sourceNumber = typeof env.sourceNumber === 'string' ? env.sourceNumber : undefined;
    const sourceName = typeof env.sourceName === 'string' ? env.sourceName : undefined;
    const timestamp = typeof env.timestamp === 'number' ? env.timestamp : Date.now();

    const groupInfo = data.groupInfo as { groupId?: string } | undefined;
    const groupId = typeof groupInfo?.groupId === 'string' ? groupInfo.groupId : undefined;

    const isSelf = sourceUuid !== undefined && sourceUuid === this.selfUuid;

    const out: SignalIncomingMessage = { text, timestamp, isSelf };
    if (sourceUuid) out.sourceUuid = sourceUuid;
    if (sourceNumber) out.sourceNumber = sourceNumber;
    if (sourceName) out.sourceName = sourceName;
    if (groupId) out.groupId = groupId;
    return out;
  }
```

- [ ] **Step 5.4: Run tests to verify they pass**

Run: `npm test -w @openhermit/channel-signal`
Expected: PASS for all signal-api + signal-api-receive tests (10 total).

- [ ] **Step 5.5: Commit**

```bash
git add apps/channels/signal/src/signal-api.ts apps/channels/signal/test/signal-api-receive.test.ts
git commit -m "feat(channel-signal): add WebSocket receive stream with envelope normalization"
```

---

## Task 6: Bridge — session routing + policy

**Files:**
- Create: `apps/channels/signal/src/bridge.ts`
- Create: `apps/channels/signal/test/bridge.test.ts`

The bridge implements `ChannelOutbound`, owns the per-conversation session map, and handles inbound messages by calling `openSession` + `postMessage` then waiting for SSE events. We split into two tasks: **Task 6** covers the pure-routing parts (session key derivation, policy gating); **Task 7** covers the SSE consumption loop.

- [ ] **Step 6.1: Write the failing test**

Write `apps/channels/signal/test/bridge.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conversationKey,
  generateSessionId,
  shouldAcceptSender,
} from '../src/bridge.js';

test('conversationKey uses signal: prefix for DMs keyed by uuid when available', () => {
  assert.equal(
    conversationKey({ sourceUuid: 'uuid-alice', sourceNumber: '+15559999999' }),
    'signal:uuid:uuid-alice',
  );
});

test('conversationKey falls back to E.164 when uuid is missing', () => {
  assert.equal(
    conversationKey({ sourceNumber: '+15559999999' }),
    'signal:+15559999999',
  );
});

test('conversationKey uses group prefix for group messages', () => {
  assert.equal(
    conversationKey({ sourceUuid: 'uuid-alice', groupId: 'gid==' }),
    'signal:group:gid==',
  );
});

test('generateSessionId produces a date-stamped signal: prefix', () => {
  const id = generateSessionId();
  assert.match(id, /^signal:\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
});

test('shouldAcceptSender accepts everyone when no allow-list is configured', () => {
  assert.equal(shouldAcceptSender({ sourceUuid: 'x' }, undefined, undefined), true);
});

test('shouldAcceptSender accepts when sender uuid matches allowedSenders', () => {
  assert.equal(
    shouldAcceptSender({ sourceUuid: 'uuid-alice' }, ['uuid:uuid-alice'], undefined),
    true,
  );
});

test('shouldAcceptSender accepts when sender E.164 matches allowedSenders', () => {
  assert.equal(
    shouldAcceptSender({ sourceNumber: '+15559999999' }, ['+15559999999'], undefined),
    true,
  );
});

test('shouldAcceptSender rejects DMs not in allowedSenders', () => {
  assert.equal(
    shouldAcceptSender({ sourceUuid: 'uuid-stranger' }, ['uuid:uuid-friend'], undefined),
    false,
  );
});

test('shouldAcceptSender consults allowedGroupIds only for group messages', () => {
  assert.equal(
    shouldAcceptSender({ groupId: 'gid==', sourceUuid: 'x' }, undefined, ['gid==']),
    true,
  );
  assert.equal(
    shouldAcceptSender({ groupId: 'other==', sourceUuid: 'x' }, undefined, ['gid==']),
    false,
  );
});
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `npm test -w @openhermit/channel-signal`
Expected: FAIL — `../src/bridge.js` not found.

- [ ] **Step 6.3: Implement bridge.ts (helpers only — class comes in Task 7)**

Write `apps/channels/signal/src/bridge.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { SignalIncomingMessage } from './signal-api.js';

export interface ConversationKeyInput {
  sourceUuid?: string | undefined;
  sourceNumber?: string | undefined;
  groupId?: string | undefined;
}

export function conversationKey(input: ConversationKeyInput): string {
  if (input.groupId) return `signal:group:${input.groupId}`;
  if (input.sourceUuid) return `signal:uuid:${input.sourceUuid}`;
  if (input.sourceNumber) return `signal:${input.sourceNumber}`;
  throw new Error('conversationKey requires at least one of groupId, sourceUuid, sourceNumber');
}

export function generateSessionId(): string {
  return `signal:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

export function shouldAcceptSender(
  msg: ConversationKeyInput,
  allowedSenders: string[] | undefined,
  allowedGroupIds: string[] | undefined,
): boolean {
  if (msg.groupId) {
    if (!allowedGroupIds || allowedGroupIds.length === 0) return true;
    return allowedGroupIds.includes(msg.groupId);
  }
  if (!allowedSenders || allowedSenders.length === 0) return true;
  if (msg.sourceUuid && allowedSenders.includes(`uuid:${msg.sourceUuid}`)) return true;
  if (msg.sourceNumber && allowedSenders.includes(msg.sourceNumber)) return true;
  return false;
}

// SignalBridge class is implemented in Task 7 — it lives in this same file.
```

- [ ] **Step 6.4: Run tests to verify they pass**

Run: `npm test -w @openhermit/channel-signal`
Expected: PASS for all 9 bridge-helper tests.

- [ ] **Step 6.5: Commit**

```bash
git add apps/channels/signal/src/bridge.ts apps/channels/signal/test/bridge.test.ts
git commit -m "feat(channel-signal): add bridge helpers for routing + policy"
```

---

## Task 7: Bridge — `SignalBridge` class with SSE consumption

**Files:**
- Modify: `apps/channels/signal/src/bridge.ts`

The class mirrors `SlackBridge` (apps/channels/slack/src/bridge.ts) but without intra-stream message editing. Reply flow: receive `text_delta` events into a buffer, send full chunks only on `text_final` / `agent_end`. This avoids Signal's edit limitations.

- [ ] **Step 7.1: Add the SignalBridge class to bridge.ts**

Append to `apps/channels/signal/src/bridge.ts` (after the helpers):

```ts
import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

import type { SignalApi } from './signal-api.js';
import { formatAgentResponse } from './formatting.js';

const NO_REPLY_TAG = '<NO_REPLY>';

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

export interface SignalBridgeOptions {
  allowedSenders?: string[];
  allowedGroupIds?: string[];
}

export class SignalBridge implements ChannelOutbound {
  readonly channel = 'signal';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  private readonly conversationSessions = new Map<string, string>();
  private readonly allowedSenders: string[] | undefined;
  private readonly allowedGroupIds: string[] | undefined;

  constructor(
    private readonly signal: SignalApi,
    clientOptions: { baseUrl: string; token: string },
    options: SignalBridgeOptions = {},
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg) => console.log(`[signal-bridge] ${msg}`));
    this.allowedSenders = options.allowedSenders;
    this.allowedGroupIds = options.allowedGroupIds;
  }

  /**
   * ChannelOutbound entry-point — `to` is a conversationKey
   * (signal:uuid:..., signal:+E.164, or signal:group:...).
   */
  async send(params: { sessionId: string; to: string; text: string }): Promise<ChannelOutboundResult> {
    try {
      const chunks = formatAgentResponse(params.text);
      let lastTimestamp: number | undefined;
      for (const chunk of chunks) {
        const result = await this.sendChunkToTarget(params.to, chunk);
        lastTimestamp = result.timestamp;
      }
      const out: ChannelOutboundResult = { success: true };
      if (lastTimestamp !== undefined) out.messageId = String(lastTimestamp);
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send to ${params.to}: ${message}`);
      return { success: false, error: message };
    }
  }

  private async sendChunkToTarget(target: string, text: string): Promise<{ timestamp: number }> {
    if (target.startsWith('signal:group:')) {
      return this.signal.sendGroupMessage(target.slice('signal:group:'.length), text);
    }
    if (target.startsWith('signal:uuid:')) {
      return this.signal.sendDirectMessage(target.slice('signal:uuid:'.length), text);
    }
    if (target.startsWith('signal:')) {
      return this.signal.sendDirectMessage(target.slice('signal:'.length), text);
    }
    return this.signal.sendDirectMessage(target, text);
  }

  /**
   * Inbound entry-point — called by SignalBot for each accepted envelope.
   * Resolves or creates the session, posts the user message, then waits
   * for the agent's final reply over SSE.
   */
  async handleIncoming(msg: import('./signal-api.js').SignalIncomingMessage): Promise<void> {
    if (!shouldAcceptSender(msg, this.allowedSenders, this.allowedGroupIds)) {
      this.log(`dropped message from disallowed sender (${msg.sourceUuid ?? msg.sourceNumber})`);
      return;
    }
    if (msg.isSelf) return; // loopback guard

    const key = conversationKey(msg);
    const sessionId = await this.getSessionId(key, msg);
    await this.ensureSession(sessionId, msg);

    const senderChannelUserId = msg.sourceUuid ?? msg.sourceNumber ?? 'unknown';
    const senderName = msg.sourceName;
    const postResult = await this.client.postMessage(sessionId, {
      text: msg.text,
      mentioned: true, // every DM is "mentioned"; group routing is enforced upstream by allowedGroupIds
      sender: {
        channel: 'signal',
        channelUserId: senderChannelUserId,
        ...(senderName ? { displayName: senderName } : {}),
      },
    });

    if (!(postResult as { triggered?: boolean }).triggered) return;

    const result = await this.waitForAgentResponse(sessionId);
    if (result.error && !result.text) {
      await this.send({ sessionId, to: key, text: `Error: ${result.error}` });
    } else if (result.text && result.text.trim() !== NO_REPLY_TAG) {
      await this.send({ sessionId, to: key, text: result.text });
    }
  }

  private async getSessionId(
    key: string,
    msg: import('./signal-api.js').SignalIncomingMessage,
  ): Promise<string> {
    const cached = this.conversationSessions.get(key);
    if (cached) return cached;

    try {
      const metadata: Record<string, string> = {};
      if (msg.groupId) metadata.signal_group_id = msg.groupId;
      else if (msg.sourceUuid) metadata.signal_source = `uuid:${msg.sourceUuid}`;
      else if (msg.sourceNumber) metadata.signal_source = msg.sourceNumber;

      const sessions = await this.client.listSessions({
        channel: 'signal',
        metadata,
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.conversationSessions.set(key, sessionId);
        return sessionId;
      }
    } catch {
      // fall through
    }

    const id = generateSessionId();
    this.conversationSessions.set(key, id);
    return id;
  }

  private async ensureSession(
    sessionId: string,
    msg: import('./signal-api.js').SignalIncomingMessage,
  ): Promise<void> {
    const metadata: Record<string, string> = {};
    if (msg.groupId) metadata.signal_group_id = msg.groupId;
    if (msg.sourceUuid) metadata.signal_source = `uuid:${msg.sourceUuid}`;
    else if (msg.sourceNumber) metadata.signal_source = msg.sourceNumber;
    if (msg.sourceNumber) metadata.signal_source_number = msg.sourceNumber;

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'signal',
        type: msg.groupId ? 'group' : 'direct',
      },
      metadata,
    });
  }

  private async waitForAgentResponse(sessionId: string): Promise<TurnResult> {
    const eventsUrl = this.client.buildEventsUrl(sessionId);
    const lastEventId = this.lastEventIds.get(sessionId) ?? 0;
    const response = await fetch(eventsUrl, {
      headers: { authorization: `Bearer ${this.clientToken}` },
    });
    if (!response.ok || !response.body) {
      return { text: undefined, error: `Failed to open event stream (${response.status})` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let nextLastEventId = lastEventId;
    let sequenceResetChecked = false;
    let accumulatedText = '';
    let finalText: string | undefined;
    let error: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.remainder;
        let sawAgentEnd = false;

        for (const frame of parsed.frames) {
          if (frame.id !== undefined && frame.id <= nextLastEventId) continue;
          if (frame.id !== undefined) nextLastEventId = frame.id;

          if (frame.event === 'ready') {
            if (!sequenceResetChecked) {
              sequenceResetChecked = true;
              try {
                const data = frame.data.length > 0
                  ? (JSON.parse(frame.data) as { nextEventId?: number })
                  : {};
                if (typeof data.nextEventId === 'number' && data.nextEventId <= nextLastEventId) {
                  nextLastEventId = 0;
                }
              } catch { /* ignore */ }
            }
            continue;
          }
          if (frame.event === 'ping') continue;

          const payload = frame.data.length > 0
            ? (JSON.parse(frame.data) as Record<string, unknown>)
            : {};

          if (frame.event === 'text_delta') {
            accumulatedText += String(payload.text ?? '');
            continue;
          }
          if (frame.event === 'text_final') {
            finalText = String(payload.text ?? '').trim();
            continue;
          }
          if (frame.event === 'error') {
            error = String(payload.message ?? 'Unknown error');
            continue;
          }
          if (frame.event === 'agent_end') {
            sawAgentEnd = true;
            continue;
          }
        }
        if (sawAgentEnd) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    this.lastEventIds.set(sessionId, nextLastEventId);
    const responseText = finalText ?? (accumulatedText.trim() || undefined);
    return { text: responseText, error };
  }
}
```

- [ ] **Step 7.2: Run typecheck to verify class compiles**

Run: `npm run typecheck -w @openhermit/channel-signal`
Expected: PASS.

- [ ] **Step 7.3: Run all tests to verify no regressions**

Run: `npm test -w @openhermit/channel-signal`
Expected: PASS for all tests so far (config + formatting + signal-api + bridge).

- [ ] **Step 7.4: Commit**

```bash
git add apps/channels/signal/src/bridge.ts
git commit -m "feat(channel-signal): add SignalBridge with SSE consumption and reply routing"
```

---

## Task 8: Bot — WS receive loop with reconnect

**Files:**
- Create: `apps/channels/signal/src/bot.ts`

The bot owns the WS receive loop and reconnect backoff. It probes `MODE=json-rpc` once on startup, then runs the receive iterator; on disconnect it sleeps with exponential backoff (capped at 30s) and reconnects.

- [ ] **Step 8.1: Implement bot.ts**

Write `apps/channels/signal/src/bot.ts`:

```ts
import type { SignalApi } from './signal-api.js';
import type { SignalBridge } from './bridge.js';

export interface SignalBotOptions {
  signal: SignalApi;
  bridge: SignalBridge;
  logger?: (message: string) => void;
}

export class SignalBot {
  private readonly signal: SignalApi;
  private readonly bridge: SignalBridge;
  private readonly log: (message: string) => void;
  private readonly abortController = new AbortController();
  private running = false;
  private loopPromise: Promise<void> | undefined;

  constructor(opts: SignalBotOptions) {
    this.signal = opts.signal;
    this.bridge = opts.bridge;
    this.log = opts.logger ?? ((msg) => console.log(`[signal-bot] ${msg}`));
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.signal.probeReceiveMode();
    this.log(`probe ok: signal-cli-rest-api MODE=json-rpc`);
    this.running = true;
    this.loopPromise = this.receiveLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController.abort();
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
    this.log('bot stopped');
  }

  private async receiveLoop(): Promise<void> {
    let backoffMs = 1000;
    const MAX_BACKOFF_MS = 30_000;

    while (this.running) {
      try {
        this.log('connecting to receive WS...');
        const stream = this.signal.streamMessages({ signal: this.abortController.signal });
        for await (const msg of stream) {
          backoffMs = 1000; // reset on any successful message
          try {
            await this.bridge.handleIncoming(msg);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            this.log(`bridge.handleIncoming error: ${m}`);
          }
        }
        if (!this.running) break;
        this.log('WS stream ended; will reconnect');
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.log(`WS receive error: ${m}; reconnect in ${backoffMs}ms`);
      }

      if (!this.running) break;
      await this.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abortController.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
```

- [ ] **Step 8.2: Run typecheck**

Run: `npm run typecheck -w @openhermit/channel-signal`
Expected: PASS.

- [ ] **Step 8.3: Commit**

```bash
git add apps/channels/signal/src/bot.ts
git commit -m "feat(channel-signal): add SignalBot with WS reconnect loop"
```

---

## Task 9: Entry point + exports

**Files:**
- Modify: `apps/channels/signal/src/index.ts`

- [ ] **Step 9.1: Replace the stub index.ts**

Overwrite `apps/channels/signal/src/index.ts`:

```ts
import { pathToFileURL } from 'node:url';

import { loadEnv } from '@openhermit/shared';

import { SignalApi } from './signal-api.js';
import { SignalBridge } from './bridge.js';
import { SignalBot } from './bot.js';
import { loadConfig } from './config.js';

const log = (message: string): void => {
  console.log(`[openhermit-channel-signal] ${message}`);
};

export const main = async (): Promise<void> => {
  await loadEnv();
  const config = await loadConfig();
  log(`agent: ${config.agentBaseUrl}`);
  log(`signal-cli-rest-api: ${config.httpUrl}`);
  log(`account: ${config.account}`);

  const api = new SignalApi({ httpUrl: config.httpUrl, account: config.account });

  const bridgeOptions: { allowedSenders?: string[]; allowedGroupIds?: string[] } = {};
  if (config.allowedSenders) bridgeOptions.allowedSenders = config.allowedSenders;
  if (config.allowedGroupIds) bridgeOptions.allowedGroupIds = config.allowedGroupIds;

  const bridge = new SignalBridge(
    api,
    { baseUrl: config.agentBaseUrl, token: config.agentToken },
    bridgeOptions,
    log,
  );

  const bot = new SignalBot({ signal: api, bridge, logger: log });

  const shutdown = async (): Promise<void> => {
    log('shutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await bot.start();
};

export { SignalApi } from './signal-api.js';
export { SignalBridge } from './bridge.js';
export { SignalBot } from './bot.js';
export type { SignalAdapterConfig } from './config.js';
export type { SignalIncomingMessage } from './signal-api.js';
export type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 9.2: Build the workspace**

Run: `npm run build -w @openhermit/channel-signal`
Expected: PASS, produces `apps/channels/signal/dist/` with `index.js`, `bridge.js`, etc.

- [ ] **Step 9.3: Commit**

```bash
git add apps/channels/signal/src/index.ts
git commit -m "feat(channel-signal): wire entry point and exports"
```

---

## Task 10: Register Signal as a built-in channel (agent types)

**Files:**
- Modify: `apps/agent/src/core/types.ts`

- [ ] **Step 10.1: Add `SignalChannelConfig` and wire it into `ChannelsConfig` + `BUILTIN_CHANNELS`**

In `apps/agent/src/core/types.ts`, after the `DiscordChannelConfig` interface (currently around line 72–76), add:

```ts
export interface SignalChannelConfig {
  enabled: boolean;
  /** Base URL of the signal-cli-rest-api container (e.g. http://signal:8080). */
  http_url: string;
  /** E.164 phone number of the bot's Signal account. */
  account: string;
  /** Optional DM allow-list: each entry is either "+E164" or "uuid:<uuid>". */
  allowed_senders?: string[];
  /** Optional group allow-list: base64 group ids as reported by signal-cli. */
  allowed_group_ids?: string[];
}
```

Update the `ChannelsConfig` interface (currently lines 78–82) to:

```ts
export interface ChannelsConfig {
  telegram?: TelegramChannelConfig;
  slack?: SlackChannelConfig;
  discord?: DiscordChannelConfig;
  signal?: SignalChannelConfig;
}
```

Update the `BUILTIN_CHANNELS` array (currently lines 89–93) to:

```ts
export const BUILTIN_CHANNELS: readonly BuiltinChannelDef[] = [
  { key: 'telegram', namespace: 'telegram' },
  { key: 'slack', namespace: 'slack' },
  { key: 'discord', namespace: 'discord' },
  { key: 'signal', namespace: 'signal' },
] satisfies readonly { key: keyof ChannelsConfig; namespace: string }[];
```

- [ ] **Step 10.2: Typecheck the agent**

Run: `npm run typecheck -w @openhermit/agent`
Expected: PASS.

- [ ] **Step 10.3: Commit**

```bash
git add apps/agent/src/core/types.ts
git commit -m "feat(agent): register signal as a built-in channel type"
```

---

## Task 11: Wire Signal into the channel launcher

**Files:**
- Modify: `apps/agent/src/channels.ts`

- [ ] **Step 11.1: Add `startSignal` and register it in `starters`**

In `apps/agent/src/channels.ts`, in the `startChannels` parallel-task block (currently lines 81–91), add a `signal` task after `discord`:

```ts
  if (channels.signal?.enabled) {
    tasks.push(tryStart('signal', () => startSignal(channels.signal!, context)));
  }
```

In the `starters` record (currently lines 112–116), add a `signal` entry:

```ts
const starters: Record<string, (config: ChannelsConfig, context: ChannelContext) => Promise<ChannelHandle | undefined>> = {
  telegram: (cfg, ctx) => startTelegram(cfg.telegram!, ctx),
  slack: (cfg, ctx) => startSlack(cfg.slack!, ctx),
  discord: (cfg, ctx) => startDiscord(cfg.discord!, ctx),
  signal: (cfg, ctx) => startSignal(cfg.signal!, ctx),
};
```

Append `startSignal` to the end of the file (after `startTelegram`):

```ts
async function startSignal(
  config: NonNullable<ChannelsConfig['signal']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const log = (msg: string) => context.logger('signal', msg);

  try {
    const { SignalApi, SignalBridge, SignalBot } = await import(
      '@openhermit/channel-signal'
    );

    const api = new SignalApi({ httpUrl: config.http_url, account: config.account });

    const bridgeOptions: { allowedSenders?: string[]; allowedGroupIds?: string[] } = {};
    if (config.allowed_senders) bridgeOptions.allowedSenders = config.allowed_senders;
    if (config.allowed_group_ids) bridgeOptions.allowedGroupIds = config.allowed_group_ids;

    const bridge = new SignalBridge(
      api,
      { baseUrl: context.agentBaseUrl, token: context.agentTokens['signal'] ?? '' },
      bridgeOptions,
      log,
    );

    const bot = new SignalBot({ signal: api, bridge, logger: log });
    await bot.start();

    return {
      name: 'signal',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start signal channel: ${message}`);
    return undefined;
  }
}
```

- [ ] **Step 11.2: Add `@openhermit/channel-signal` as an optional dependency of `@openhermit/agent`**

The other channel packages are dynamic-imported and not listed in agent's deps (verify via `grep '"@openhermit/channel-' apps/agent/package.json`). If they ARE listed, add Signal there too. If not, do nothing — the dynamic import resolves through the workspace.

- [ ] **Step 11.3: Typecheck**

Run: `npm run typecheck -w @openhermit/agent`
Expected: PASS.

- [ ] **Step 11.4: Build the whole monorepo**

Run: `npm run build`
Expected: PASS — no type errors anywhere.

- [ ] **Step 11.5: Commit**

```bash
git add apps/agent/src/channels.ts
git commit -m "feat(agent): launch signal channel adapter from channels.ts"
```

---

## Task 12: Add Signal to the admin UI channel registry

**Files:**
- Modify: `apps/gateway/src/app.ts`

- [ ] **Step 12.1: Add the `signal` entry to `BUILTIN_CHANNEL_DEFS`**

In `apps/gateway/src/app.ts`, in the `BUILTIN_CHANNEL_DEFS` map (currently lines 2196–2215), add after the `slack` entry:

```ts
    signal: {
      label: 'Signal',
      secretKeys: [
        { key: 'SIGNAL_HTTP_URL', label: 'signal-cli-rest-api URL', placeholder: 'http://signal:8080' },
        { key: 'SIGNAL_ACCOUNT', label: 'Bot phone number (E.164)', placeholder: '+15551234567' },
      ],
      defaultConfig: {
        http_url: '${{SIGNAL_HTTP_URL}}',
        account: '${{SIGNAL_ACCOUNT}}',
      },
    },
```

- [ ] **Step 12.2: Typecheck the gateway**

Run: `npm run typecheck -w @openhermit/gateway`
Expected: PASS.

- [ ] **Step 12.3: Commit**

```bash
git add apps/gateway/src/app.ts
git commit -m "feat(gateway): expose Signal as a built-in channel in the admin UI"
```

---

## Task 13: Operator README for the signal-cli-rest-api container

**Files:**
- Create: `apps/channels/signal/README.md`

- [ ] **Step 13.1: Write the README**

Write `apps/channels/signal/README.md`:

````markdown
# @openhermit/channel-signal

Signal channel adapter for OpenHermit. Connects an agent to a Signal phone
number via an external [`bbernhard/signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api)
container running in `MODE=json-rpc`.

## Operator setup

### 1. Run the daemon

```yaml
# docker-compose.yml fragment
signal:
  image: bbernhard/signal-cli-rest-api:latest
  environment:
    MODE: json-rpc        # REQUIRED — anything else breaks the receive WS
  volumes:
    - signal-data:/home/.local/share/signal-cli
  ports:
    - "8080:8080"
```

`MODE=json-rpc` is non-negotiable. The adapter probes `/v1/about` at
startup and refuses to start otherwise.

### 2. Register or link a Signal account

Pick one path, both done against the running container before configuring
OpenHermit:

**Link as a secondary device (recommended):**

```bash
curl http://localhost:8080/v1/qrcodelink?device_name=OpenHermit -o qr.png
# Open qr.png on your laptop, scan from Signal → Settings → Linked Devices.
```

**Register a dedicated bot number with SMS:**

```bash
# 1. Generate a captcha token at https://signalcaptchas.org/registration/generate.html
#    (the token expires within seconds — register from a machine with a browser nearby)
curl -X POST -H "Content-Type: application/json" \
  -d '{"captcha": "signalcaptcha://..."}' \
  http://localhost:8080/v1/register/+15551234567

# 2. After the SMS arrives:
curl -X POST -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:8080/v1/register/+15551234567/verify/123-456
```

Don't reuse a phone number that's already active on a Signal app — registering
will deauthenticate that phone.

### 3. Configure the channel in OpenHermit

In the admin UI: Agents → your agent → Channels → enable **Signal**, paste:

- **signal-cli-rest-api URL** → `http://signal:8080` (or wherever the
  daemon is reachable from the gateway)
- **Bot phone number** → the E.164 number registered/linked above

Or via the REST API:

```bash
curl -X PUT $GATEWAY/api/agents/main/channels/signal \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "config": { "http_url": "http://signal:8080", "account": "+15551234567" } }'
```

## Standalone mode

For local testing without the gateway, run the adapter as a sidecar:

```bash
SIGNAL_HTTP_URL=http://localhost:8080 \
SIGNAL_ACCOUNT=+15551234567 \
OPENHERMIT_AGENT_URL=http://localhost:4000/api/agents/main \
OPENHERMIT_AGENT_TOKEN=$AGENT_TOKEN \
npm run dev -w @openhermit/channel-signal
```

## Allow-list (optional)

To restrict who can DM the bot, or which groups it listens in:

```bash
SIGNAL_ALLOWED_SENDERS="+15551111111,uuid:abc-def-...,+15552222222"
SIGNAL_ALLOWED_GROUP_IDS="base64GroupId1==,base64GroupId2=="
```

Without these the bot accepts all incoming traffic — fine for personal-use
deployments, not fine for public bot numbers.

## Gotchas

- **No native group mentions.** Group routing relies on `allowed_group_ids`
  rather than `@bot` mentions because Signal lacks first-class mentions.
- **No message editing.** Replies are sent as complete chunks once the
  agent reaches `agent_end`. No streaming-edit UX like Slack.
- **Self-loopback drop.** If the bot is linked as a secondary device, the
  daemon will echo its own outbound messages back through `/v1/receive`.
  The adapter drops these via `sourceUuid === selfUuid`.
- **Backup `~/.local/share/signal-cli`.** If you lose the daemon's data
  volume you'll need to re-register or re-link.
````

- [ ] **Step 13.2: Commit**

```bash
git add apps/channels/signal/README.md
git commit -m "docs(channel-signal): add operator README with daemon setup"
```

---

## Task 14: Update channel-adapter docs

**Files:**
- Modify: `docs/channel-adapter.md`

- [ ] **Step 14.1: Add Signal to the Implemented Adapters table**

In `docs/channel-adapter.md`, in the table starting at line 7, add a row after Slack:

```markdown
| Signal | `@openhermit/channel-signal` | signal-cli-rest-api WebSocket (`MODE=json-rpc`) |
```

- [ ] **Step 14.2: Add Signal to the Session Routing table**

In the same file, in the Session Routing table (currently lines 17–22), add a row after Slack:

```markdown
| Signal | `signal:` (DMs by uuid or E.164) / `signal:group:` | `signal_source`, optional `signal_group_id` |
```

- [ ] **Step 14.3: Add Platform Notes for Signal**

At the end of the **Platform Notes** section (currently ends around line 124 with the Slack block), append:

```markdown

Signal:

- external `bbernhard/signal-cli-rest-api` daemon (`MODE=json-rpc` required)
- persistent WebSocket to `/v1/receive/{account}` for inbound
- REST `POST /v2/send` with `text_mode=styled` for outbound
- group routing controlled via optional `allowed_group_ids`
- DM allow-list controlled via optional `allowed_senders` (mix of `+E164` and `uuid:<id>`)
- no native streaming edits — replies are sent in full chunks
- self-loopback messages (linked secondary device) are dropped via `sourceUuid` match
```

- [ ] **Step 14.4: Commit**

```bash
git add docs/channel-adapter.md
git commit -m "docs(channels): document Signal adapter"
```

---

## Task 15: End-to-end smoke test

This is a manual checklist — code is complete after Task 14; this task verifies it works against a real daemon.

- [ ] **Step 15.1: Start the daemon locally**

```bash
docker run -d --rm \
  --name signal-test \
  -p 8080:8080 \
  -e MODE=json-rpc \
  -v $PWD/.signal-data:/home/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api:latest
```

Wait for `/v1/about` to return 200:

```bash
curl -s http://localhost:8080/v1/about | jq .mode
```

Expected output: `"json-rpc"`.

- [ ] **Step 15.2: Link a Signal account to the daemon**

```bash
curl 'http://localhost:8080/v1/qrcodelink?device_name=openhermit-test' -o qr.png
open qr.png   # macOS — scan from Signal app → Linked Devices
```

- [ ] **Step 15.3: Configure the channel against a running gateway**

With the gateway running locally (`hermit gateway start`) and an agent named `main` created:

```bash
hermit config secrets set SIGNAL_HTTP_URL http://localhost:8080 --agent main
hermit config secrets set SIGNAL_ACCOUNT +YOUR_NUMBER --agent main

curl -X PUT http://127.0.0.1:4000/api/agents/main/channels/signal \
  -H "Authorization: Bearer $OPENHERMIT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "config": {"http_url": "${{SIGNAL_HTTP_URL}}", "account": "${{SIGNAL_ACCOUNT}}"}}'
```

- [ ] **Step 15.4: Enable the channel**

```bash
curl -X POST http://127.0.0.1:4000/api/agents/main/channels/signal/enable \
  -H "Authorization: Bearer $OPENHERMIT_TOKEN"
```

Watch the gateway logs — expected lines:

```
[main] [signal] probe ok: signal-cli-rest-api MODE=json-rpc
[main] [signal] connecting to receive WS...
[main] pool started channel: signal
```

- [ ] **Step 15.5: Send a DM to the bot number from another Signal client**

Expected: within a few seconds, the agent replies in the same DM thread.

Verify in the admin UI: a new session with prefix `signal:` exists with metadata `signal_source` set to either `uuid:<your-uuid>` or your E.164.

- [ ] **Step 15.6: Send a follow-up DM**

Expected: the reply lands in the **same** session (session recovery by metadata).

- [ ] **Step 15.7: Disable the channel and verify shutdown**

```bash
curl -X POST http://127.0.0.1:4000/api/agents/main/channels/signal/disable \
  -H "Authorization: Bearer $OPENHERMIT_TOKEN"
```

Expected logs:

```
[main] pool stopped channel: signal
[main] [signal] bot stopped
```

A subsequent DM should NOT be answered (bridge is down).

- [ ] **Step 15.8: Open a PR**

```bash
git push -u origin plan/signal-channel
gh pr create --title "feat(channels): add Signal adapter" --body "$(cat <<'EOF'
## Summary
- new `@openhermit/channel-signal` package, REST + WS client to `bbernhard/signal-cli-rest-api`
- registered as a fourth built-in channel (config type, launcher, admin-UI registry)
- pure-Node, no in-process daemon supervision — operator runs the container

## Test plan
- [x] unit tests for config / formatting / signal-api REST / signal-api WS / bridge helpers
- [x] manual smoke test against a real `signal-cli-rest-api` container (see plan Task 15)
EOF
)"
```

---

## Self-Review (run before handing off)

After writing this plan I scanned it against the brief:

1. **Spec coverage** — every item from the brief maps to a task:
   - container-only design → Task 4 (`probeReceiveMode`) + Task 13 (README)
   - `MODE=json-rpc` enforcement → Task 4
   - inbound flow (WS, normalize) → Task 5
   - outbound flow (send, chunking) → Tasks 3, 4, 7
   - registration/linking → Task 13 README
   - session routing (`signal:` prefix, group, metadata recovery) → Tasks 6, 7
   - per-agent toggle via hermit / admin UI → Task 12
   - encrypted secrets via `${{SECRET}}` → Task 12 default config
   - self-loopback drop → Task 5 + Task 7
   - mirror of Slack `apps/channels/slack/` structure → Tasks 1–9 file layout
2. **Placeholder scan** — no TBDs, no "implement later", no "add validation" without code. The only "do nothing" step is 11.2 which has a concrete grep check.
3. **Type consistency** — `SignalIncomingMessage` and `SignalAdapterConfig` field names match across tests (Tasks 2, 5, 6, 7) and `SignalChannelConfig` snake_case in the agent type (Task 10) matches the runtime expansion in `startSignal` (Task 11). `conversationKey` / `generateSessionId` / `shouldAcceptSender` exports defined in Task 6 are imported in Task 7's class.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-13-signal-channel.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
