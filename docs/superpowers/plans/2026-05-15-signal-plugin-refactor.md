# Signal Channel — Plugin Refactor + Interactive Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Signal channel from a hardcoded built-in into a manifest-based external plugin (per `docs/channel-plugin-design.md`), implement the interactive QR-link setup contract, and rebuild the amiko-platform UI to use the new generic Add-channel + setup-wizard flow that William's wechat work introduced.

**Architecture:** William's PRs #87/#88/#90 landed a `ChannelManifest` + `ChannelManifestRegistry` + interactive `ChannelSetup` contract on openhermit `main`. Built-in channels (telegram/slack/discord) are now manifest-driven; non-default channels (signal, wechat, debox, …) ship as separate npm packages, get loaded via `channelPackages` in gateway config, and use the setup wizard for their auth flow. This plan rebases our previous Signal work (PR #81 / openhermit, PR #919 / amiko-platform) onto that new architecture and uses the existing `apps/web/ui/src/components/ChannelSetupWizard.tsx` (openhermit admin UI) as the canonical pattern when building amiko-web's equivalent. The wechat branch (`origin/plan/channel-wechat`) is the reference implementation — read it before touching anything.

**Tech Stack:** TypeScript ESM (NodeNext), Hono (gateway routes), node:test, Next.js (App Router) + React + next-intl on amiko-web, vitest for amiko-web tests.

**Cross-repo scope.** Two repos touched in lockstep:
- `/Users/shydev/Amiko/openhermit` — refactor signal package + drop built-in registrations. Branch: `plan/signal-channel-plugin`.
- `/Users/shydev/Amiko/amiko-platform` — replace static Signal form with generic Add-channel picker + setup wizard. Branch: `feat/signal-channel-wizard`.

The two old PRs (openhermit #81, amiko-platform #919) will be **closed and superseded** by the two new PRs this plan produces. Don't try to keep them.

---

## Scope Check

Plan covers two coordinated subsystems (openhermit package refactor + amiko-web UI rewrite). They have a hard dependency: amiko-web changes won't work until openhermit changes deploy. Splitting into two plans would be appropriate if the engineer wants finer-grained execution; a single coordinated plan is appropriate when one engineer drives both. Keeping this as one plan with two clearly-marked Parts (A and B) plus Part C for the manual E2E smoke test.

---

## File Structure

### openhermit — branch `plan/signal-channel-plugin`

| Path | Change | Responsibility |
|---|---|---|
| `apps/channels/signal/` (whole tree) | already exists from old PR #81 — keep src/bot.ts, bridge.ts, config.ts, formatting.ts, signal-api.ts, all tests intact | core signal-cli-rest-api adapter; unchanged |
| `apps/channels/signal/src/manifest.ts` | **NEW** | Default-exported `ChannelManifest` with `start` (current logic) + `setup` (new interactive QR flow) |
| `apps/channels/signal/src/setup.ts` | **NEW** | `ChannelSetup` factory implementing `begin`/`poll`/`cancel` for QR-link |
| `apps/channels/signal/src/qr-link.ts` | **NEW** | `signal-cli-rest-api` QR-link client + linked-account polling |
| `apps/channels/signal/src/index.ts` | modify | default-export the manifest in addition to the existing named exports |
| `apps/channels/signal/test/manifest.test.ts` | **NEW** | shape + parseConfig + setup-wiring tests |
| `apps/channels/signal/test/setup.test.ts` | **NEW** | state-machine tests for the QR flow |
| `apps/channels/signal/README.md` | rewrite | reflect plugin install path + setup-wizard flow (model after wechat README) |
| `apps/agent/src/core/types.ts` | modify | drop `signal` from `BUILTIN_CHANNELS` array (was added by old PR #81) and from `ChannelsConfig` (the type still needs to allow signal config — it stays optional) |
| `apps/agent/src/channels.ts` | modify | drop `startSignal()` + remove `signal` from `starters` map (both were added by old PR #81) |
| `apps/gateway/src/app.ts` | modify | drop `signal` entry from `BUILTIN_CHANNEL_DEFS` (was added by old PR #81) |
| `apps/cli/tsup.config.ts` | NO CHANGE | signal must NOT be added to `noExternal` — it's an external plugin |
| `docs/channel-adapter.md` | revise | move signal row from "Implemented Adapters" to "External Plugins" section if one exists, or add a new section; update Session Routing table |
| `docs/superpowers/plans/2026-05-15-signal-plugin-refactor.md` | this file (already saved) | the plan itself |

### amiko-platform — branch `feat/signal-channel-wizard`

| Path | Change | Responsibility |
|---|---|---|
| `amiko-web/src/lib/hermit/client.ts` | modify | add wrappers: `listChannelManifests()`, `beginChannelSetup`, `pollChannelSetup`, `submitChannelSetup`, `cancelChannelSetup`, `createBuiltinChannel({channelType, config})` |
| `amiko-web/src/app/api/agents/[id]/hermit-channel-manifests/route.ts` | **NEW** | GET proxy for `/api/channel-manifests` |
| `amiko-web/src/app/api/agents/[id]/hermit-channels/[channelType]/setup/begin/route.ts` | **NEW** | POST proxy for `setup/begin` |
| `amiko-web/src/app/api/agents/[id]/hermit-channels/[channelType]/setup/[sessionId]/route.ts` | **NEW** | GET (poll) + POST (submit) + DELETE (cancel) proxy |
| `amiko-web/src/components/channels/ChannelSetupWizard.tsx` | **NEW** | Generic wizard — drives `begin → poll/submit → done`, renders QR via `qrcode.react`, hands `done.config` back to caller |
| `amiko-web/src/components/channels/AddChannelDialog.tsx` | **NEW** | Modal: lists manifests from `/api/channel-manifests` not yet on the agent → user picks one → opens wizard if `supportsSetup`, falls back to existing form if not |
| `amiko-web/src/components/channels/HermitChannelsView.tsx` | modify | revert old PR #919 SIGNAL/`PROVIDER_BY_CHANNEL_TYPE` allow-list; instead render an "Add channel" button at the top + the existing card grid for already-added channels |
| `amiko-web/src/constants/channelProviders.tsx` | revert | remove the SIGNAL entry added by old PR #919 — provider catalog is now driven by the gateway's `/api/channel-manifests`, not a hardcoded list |
| `amiko-web/messages/{en,es,zh}.json` | modify | keep `signal_*` i18n keys from old PR #919 + add `channels.addChannel`, `channels.addChannelDescription`, `channels.linking`, `channels.linkSuccess`, `channels.linkCancelled` |
| `amiko-web/tests/components/channel-setup-wizard.test.tsx` | **NEW** | renders QR for `awaiting_external`, transitions to `done`, calls `onDone(config)` |
| `amiko-web/tests/components/add-channel-dialog.test.tsx` | **NEW** | filters out already-added channels, opens wizard for `supportsSetup: true`, falls back for `supportsSetup: false` |
| `amiko-web/package.json` | modify | add `qrcode.react@^4` for QR rendering |

### NOT touched (intentional)

- `amiko-chat/` — Signal traffic never crosses amiko-chat (the openhermit gateway's adapter talks directly to the user's daemon). No changes there.
- `prisma/schema.prisma` — channel state lives in openhermit's DB, not amiko's.
- openhermit `apps/agent/src/channels.ts` `starters` map — it's already gone on `main` (William's refactor). Old PR #81 added a `startSignal()` to a now-deleted file structure; a clean rebase drops the diff entirely.

---

## Architectural decisions baked into this plan

1. **Signal is an external plugin.** Not bundled in CLI, not in `BUILTIN_CHANNELS`, not auto-seeded into `agent_channels` rows on agent create. Operators add it via `npm install @openhermit/channel-signal` + listing it in `channelPackages`. Per `docs/channel-plugin-design.md` "CLI Bundling Policy" table.
2. **QR-link is the only setup flow shipped in v1.** The SMS+captcha registration path stays operator-driven (curl against the daemon directly) and is documented in the README. Wiring captcha into a wizard is out of scope — captchas expire in seconds, requires human-in-browser, and we don't have a meaningful UX to surface that.
3. **Setup session state lives entirely in the plugin process.** Per the design doc: gateway is stateless, plugin owns its `Map<sessionId, State>`. Lifetime: 10 minutes default; expired sessions return `{ kind: 'error', message: 'session expired' }` on poll.
4. **`http_url` lives on the agent's gateway config, not in setup state.** The wizard's `awaiting_user_input` step asks for both `phone_number` and `http_url` (default: `http://localhost:8080`). The plugin uses both during setup. On `done`, `config` returns `{ http_url, account: phoneNumber }` — same shape as before.
5. **No backwards compatibility shim.** If a user has a stale "signal" channel row from old PR #81 in their DB, this plan leaves it alone — the gateway will skip it (no `signal` manifest in `BUILTIN_CHANNELS` means the row isn't auto-managed; if the row's `channelType === 'signal'` and the manifest is registered via `channelPackages`, it works the same). No migration needed.
6. **amiko-web pattern mirrors openhermit's `apps/web/ui/src/components/ChannelSetupWizard.tsx`.** The exact code can be ported with minor adjustments: amiko-web uses Tailwind + shadcn/ui rather than openhermit's plain CSS, but the state-machine logic is identical. **Read the wechat branch's wizard before writing the amiko version** — it's already production-tested.
7. **Reuse of existing PRs:** the old PR #81 (openhermit) and PR #919 (amiko-platform) will be closed in favor of the two new PRs this plan produces. Comment "superseded by #N" on each old PR before closing.

---

# PART A — openhermit refactor

Branch: `plan/signal-channel-plugin` off `origin/main`.

## Task A0: Branch setup

**Files:** none modified — preparing the branch.

- [ ] **Step A0.1: Create the branch off latest main**

```bash
cd /Users/shydev/Amiko/openhermit
git fetch origin main
git checkout -b plan/signal-channel-plugin origin/main
```

- [ ] **Step A0.2: Cherry-pick the signal package source files from old PR #81**

The signal package itself (REST client, bot, bridge, formatter, etc.) is not in `main` — only old PR #81 has it. Cherry-pick those files individually (not the gateway/agent integration commits).

```bash
# Get the file list from old branch:
git log --name-only --oneline plan/signal-channel ^origin/main -- 'apps/channels/signal/**' \
  | sort -u | grep -E "apps/channels/signal/" | sort -u
```

Then restore those files into the new branch:

```bash
git checkout plan/signal-channel -- \
  apps/channels/signal/package.json \
  apps/channels/signal/tsconfig.json \
  apps/channels/signal/tsconfig.typecheck.json \
  apps/channels/signal/src/bot.ts \
  apps/channels/signal/src/bridge.ts \
  apps/channels/signal/src/config.ts \
  apps/channels/signal/src/formatting.ts \
  apps/channels/signal/src/index.ts \
  apps/channels/signal/src/signal-api.ts \
  apps/channels/signal/test/bridge.test.ts \
  apps/channels/signal/test/config.test.ts \
  apps/channels/signal/test/formatting.test.ts \
  apps/channels/signal/test/signal-api.test.ts \
  apps/channels/signal/test/signal-api-receive.test.ts
```

- [ ] **Step A0.3: Run install + verify the package builds**

```bash
cd /Users/shydev/Amiko/openhermit
npm install
npm run typecheck -w @openhermit/channel-signal
```

Expected: typecheck PASS. (The package still default-exports the old `main()` function and named classes — manifest comes in Task A2.)

- [ ] **Step A0.4: Commit the cherry-pick as the baseline**

```bash
git add apps/channels/signal/ package-lock.json
git -c commit.gpgsign=false commit -m "chore(channel-signal): import package source from PR #81 baseline"
```

---

## Task A1: Read the wechat reference + write `qr-link.ts`

**Files:**
- Create: `apps/channels/signal/src/qr-link.ts`
- Test: `apps/channels/signal/test/qr-link.test.ts`

The QR-link helper is a thin client to the daemon's `GET /v1/qrcodelink/:account` (returns a QR PNG) plus a poll against `GET /v1/accounts` to detect when linking completes.

- [ ] **Step A1.1: Read the wechat reference for the setup pattern**

Open `git show origin/plan/channel-wechat:apps/channels/wechat/src/ilink/login.ts` and read it. The `WeixinQrLogin` class is the pattern: a `start()` method returns `{ sessionId, qrcodeUrl }` and kicks off a background poller; `read(sessionId)` snapshots state. Mirror this shape for Signal.

- [ ] **Step A1.2: Write the failing test**

Create `apps/channels/signal/test/qr-link.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QrLinkSession } from '../src/qr-link.js';

interface RecordedCall { url: string; method: string; }

function makeFetchSpy(responses: Array<{ status?: number; body?: unknown; bytes?: Uint8Array }>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const spy: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = r?.status ?? 200;
    if (status === 204 || status === 304) return new Response(null, { status });
    if (r?.bytes) {
      return new Response(r.bytes, { status, headers: { 'content-type': 'image/png' } });
    }
    return new Response(JSON.stringify(r?.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: spy, calls };
}

test('begin() requests QR PNG and exposes it as a base64 data URL', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
  const { fetch: spy, calls } = makeFetchSpy([{ bytes: fakePng }]);
  const session = await QrLinkSession.begin({
    httpUrl: 'http://signal:8080',
    account: '+15551234567',
    fetch: spy,
  });
  assert.equal(calls[0]!.url, 'http://signal:8080/v1/qrcodelink/%2B15551234567');
  assert.equal(calls[0]!.method, 'GET');
  assert.match(session.qrPngDataUrl, /^data:image\/png;base64,iVBORw/);
  assert.equal(session.account, '+15551234567');
  assert.equal(session.httpUrl, 'http://signal:8080');
});

test('poll() returns awaiting until /v1/accounts contains the bot number', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { fetch: spy } = makeFetchSpy([
    { bytes: fakePng },
    { body: [] },                     // first poll: empty
    { body: ['+15559999999'] },       // second poll: other account, still no
    { body: ['+15551234567'] },       // third poll: linked
  ]);
  const session = await QrLinkSession.begin({
    httpUrl: 'http://signal:8080',
    account: '+15551234567',
    fetch: spy,
  });
  assert.equal(await session.poll(), 'awaiting');
  assert.equal(await session.poll(), 'awaiting');
  assert.equal(await session.poll(), 'linked');
});

test('begin() throws when daemon returns non-2xx for the QR request', async () => {
  const { fetch: spy } = makeFetchSpy([{ status: 500, body: { error: 'daemon down' } }]);
  await assert.rejects(
    () => QrLinkSession.begin({
      httpUrl: 'http://signal:8080',
      account: '+15551234567',
      fetch: spy,
    }),
    /500/,
  );
});
```

- [ ] **Step A1.3: Run test (should FAIL)**

```bash
cd /Users/shydev/Amiko/openhermit
npm test -w @openhermit/channel-signal -- --test-name-pattern qr-link
```

Expected: failure — module not found.

- [ ] **Step A1.4: Implement `qr-link.ts`**

Create `apps/channels/signal/src/qr-link.ts`:

```ts
/**
 * Thin client over signal-cli-rest-api's QR-link endpoint plus the
 * `/v1/accounts` poll used to detect when linking completes.
 */
export interface QrLinkOptions {
  httpUrl: string;
  account: string;
  fetch?: typeof fetch;
}

export class QrLinkSession {
  readonly httpUrl: string;
  readonly account: string;
  readonly qrPngDataUrl: string;
  private readonly fetchImpl: typeof fetch;

  private constructor(opts: QrLinkOptions, qrPngDataUrl: string) {
    this.httpUrl = opts.httpUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.fetchImpl = opts.fetch ?? fetch;
    this.qrPngDataUrl = qrPngDataUrl;
  }

  static async begin(opts: QrLinkOptions): Promise<QrLinkSession> {
    const fetchImpl = opts.fetch ?? fetch;
    const httpUrl = opts.httpUrl.replace(/\/+$/, '');
    const url = `${httpUrl}/v1/qrcodelink/${encodeURIComponent(opts.account)}`;
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`signal-cli-rest-api QR-link failed (${res.status}): ${body}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const b64 = Buffer.from(buf).toString('base64');
    const dataUrl = `data:image/png;base64,${b64}`;
    return new QrLinkSession(opts, dataUrl);
  }

  async poll(): Promise<'awaiting' | 'linked'> {
    const res = await this.fetchImpl(`${this.httpUrl}/v1/accounts`);
    if (!res.ok) return 'awaiting';
    const accounts = (await res.json()) as unknown;
    if (!Array.isArray(accounts)) return 'awaiting';
    return accounts.includes(this.account) ? 'linked' : 'awaiting';
  }
}
```

- [ ] **Step A1.5: Run tests**

```bash
npm test -w @openhermit/channel-signal -- --test-name-pattern qr-link
```

Expected: 3 PASS.

- [ ] **Step A1.6: Run typecheck**

```bash
npm run typecheck -w @openhermit/channel-signal
```

Expected: clean.

- [ ] **Step A1.7: Commit**

```bash
git add apps/channels/signal/src/qr-link.ts apps/channels/signal/test/qr-link.test.ts
git -c commit.gpgsign=false commit -m "feat(channel-signal): add QR-link client + linked-account polling"
```

---

## Task A2: `setup.ts` — interactive setup state machine

**Files:**
- Create: `apps/channels/signal/src/setup.ts`
- Test: `apps/channels/signal/test/setup.test.ts`

Implements `ChannelSetup` from `@openhermit/protocol`. Two-step flow:
1. `begin()` with no input → `awaiting_user_input` asking for `http_url` + `phone_number`
2. `submit({ http_url, phone_number })` → calls `QrLinkSession.begin` → `awaiting_external` with QR data URL
3. `poll()` → `awaiting_external` until linked, then `done` with config `{ http_url, account }`
4. `cancel()` → drop session

- [ ] **Step A2.1: Read the wechat reference**

Open `git show origin/plan/channel-wechat:apps/channels/wechat/src/setup.ts` and read it. Note how it uses a single helper `toState()` that snapshots underlying session progress to a `ChannelSetupState`. Mirror that shape for Signal.

- [ ] **Step A2.2: Write the failing test**

Create `apps/channels/signal/test/setup.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelSetupContext } from '@openhermit/protocol';

import { createSignalSetup } from '../src/setup.js';

const ctx: ChannelSetupContext = { agentId: 'agent-1', logger: () => {} };

test('begin() returns awaiting_user_input asking for http_url and phone_number', async () => {
  const setup = createSignalSetup();
  const { sessionId, state } = await setup.begin({}, ctx);
  assert.ok(sessionId);
  assert.equal(state.kind, 'awaiting_user_input');
  if (state.kind !== 'awaiting_user_input') return;
  const names = state.fields.map((f) => f.name).sort();
  assert.deepEqual(names, ['http_url', 'phone_number']);
});

test('submit() with invalid phone number returns error state', async () => {
  const setup = createSignalSetup();
  const { sessionId } = await setup.begin({}, ctx);
  const state = await setup.submit!(
    sessionId,
    { http_url: 'http://signal:8080', phone_number: 'not-a-number' },
    ctx,
  );
  assert.equal(state.kind, 'error');
});

test('submit() with valid input transitions to awaiting_external with a QR data URL', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetchSpy: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/v1/qrcodelink/')) {
      return new Response(fakePng, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const setup = createSignalSetup({ fetch: fetchSpy });
  const { sessionId } = await setup.begin({}, ctx);
  const state = await setup.submit!(
    sessionId,
    { http_url: 'http://signal:8080', phone_number: '+15551234567' },
    ctx,
  );
  assert.equal(state.kind, 'awaiting_external');
  if (state.kind !== 'awaiting_external') return;
  assert.match(state.qrText ?? '', /^data:image\/png;base64,/);
  assert.equal(state.pollIntervalMs, 1500);
});

test('poll() returns done when /v1/accounts contains the linked number', async () => {
  const fakePng = new Uint8Array([0x89]);
  let pollHits = 0;
  const fetchSpy: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/v1/qrcodelink/')) {
      return new Response(fakePng, { status: 200 });
    }
    pollHits += 1;
    const body = pollHits >= 2 ? ['+15551234567'] : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const setup = createSignalSetup({ fetch: fetchSpy });
  const { sessionId } = await setup.begin({}, ctx);
  await setup.submit!(
    sessionId,
    { http_url: 'http://signal:8080', phone_number: '+15551234567' },
    ctx,
  );
  let state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'awaiting_external');
  state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'done');
  if (state.kind !== 'done') return;
  assert.deepEqual(state.config, {
    http_url: 'http://signal:8080',
    account: '+15551234567',
  });
});

test('cancel() drops the session so subsequent polls error', async () => {
  const setup = createSignalSetup();
  const { sessionId } = await setup.begin({}, ctx);
  await setup.cancel!(sessionId, ctx);
  const state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'error');
});
```

- [ ] **Step A2.3: Run test (should FAIL)**

```bash
npm test -w @openhermit/channel-signal -- --test-name-pattern setup.ts
```

Expected: module not found.

- [ ] **Step A2.4: Implement `setup.ts`**

Create `apps/channels/signal/src/setup.ts`:

```ts
/**
 * `ChannelSetup` adapter for Signal's QR-link flow.
 *
 * Two-step wizard: collect (http_url, phone_number) from the user, then
 * stream a daemon-rendered QR code until the device links and poll
 * succeeds. Owns its session map for the gateway lifetime.
 */
import { randomUUID } from 'node:crypto';

import type {
  ChannelSetup,
  ChannelSetupContext,
  ChannelSetupState,
} from '@openhermit/protocol';

import { QrLinkSession } from './qr-link.js';

const SESSION_TTL_MS = 10 * 60 * 1000;
const E164 = /^\+[1-9]\d{6,14}$/;

interface PendingSession {
  createdAt: number;
  http_url?: string;
  phone_number?: string;
  qr?: QrLinkSession;
}

export interface CreateSignalSetupOptions {
  fetch?: typeof fetch;
}

export const createSignalSetup = (
  opts: CreateSignalSetupOptions = {},
): ChannelSetup => {
  const sessions = new Map<string, PendingSession>();
  const customFetch = opts.fetch;

  const isExpired = (s: PendingSession): boolean =>
    Date.now() - s.createdAt > SESSION_TTL_MS;

  const userInputState = (): ChannelSetupState => ({
    kind: 'awaiting_user_input',
    instructions:
      'Enter the URL of your signal-cli-rest-api daemon and the bot phone number. The daemon must run with MODE=normal for the QR-link step (you can switch to MODE=json-rpc after linking).',
    fields: [
      {
        name: 'http_url',
        label: 'signal-cli-rest-api URL',
        type: 'text',
        placeholder: 'http://localhost:8080',
      },
      {
        name: 'phone_number',
        label: 'Bot phone number (E.164)',
        type: 'text',
        placeholder: '+15551234567',
      },
    ],
  });

  return {
    begin: async (_input, _ctx) => {
      const sessionId = randomUUID();
      sessions.set(sessionId, { createdAt: Date.now() });
      return { sessionId, state: userInputState() };
    },

    submit: async (sessionId, input, ctx) => {
      const session = sessions.get(sessionId);
      if (!session || isExpired(session)) {
        sessions.delete(sessionId);
        return { kind: 'error', message: 'Setup session not found or expired.' };
      }
      const httpUrl = String(input.http_url ?? '').trim();
      const phone = String(input.phone_number ?? '').trim();
      if (!httpUrl) {
        return { kind: 'error', message: 'http_url is required.' };
      }
      if (!E164.test(phone)) {
        return {
          kind: 'error',
          message: 'phone_number must be E.164 (e.g. +15551234567).',
        };
      }
      try {
        const qrOpts: Parameters<typeof QrLinkSession.begin>[0] = {
          httpUrl,
          account: phone,
        };
        if (customFetch) qrOpts.fetch = customFetch;
        const qr = await QrLinkSession.begin(qrOpts);
        session.http_url = httpUrl;
        session.phone_number = phone;
        session.qr = qr;
        ctx.logger(`QR generated for ${phone}`);
        return {
          kind: 'awaiting_external',
          instructions:
            'Scan this QR in Signal → Settings → Linked Devices → Link New Device.',
          qrText: qr.qrPngDataUrl,
          pollIntervalMs: 1500,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'error', message };
      }
    },

    poll: async (sessionId, _ctx) => {
      const session = sessions.get(sessionId);
      if (!session || isExpired(session)) {
        sessions.delete(sessionId);
        return { kind: 'error', message: 'Setup session not found or expired.' };
      }
      if (!session.qr) {
        return userInputState();
      }
      try {
        const status = await session.qr.poll();
        if (status === 'awaiting') {
          return {
            kind: 'awaiting_external',
            instructions: 'Waiting for the device to link…',
            qrText: session.qr.qrPngDataUrl,
            pollIntervalMs: 1500,
          };
        }
        sessions.delete(sessionId);
        return {
          kind: 'done',
          config: {
            http_url: session.http_url!,
            account: session.phone_number!,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'error', message };
      }
    },

    cancel: async (sessionId, _ctx) => {
      sessions.delete(sessionId);
    },
  };
};
```

- [ ] **Step A2.5: Run tests**

```bash
npm test -w @openhermit/channel-signal -- --test-name-pattern setup.ts
```

Expected: 5 PASS.

- [ ] **Step A2.6: Run all signal tests + typecheck**

```bash
npm test -w @openhermit/channel-signal
npm run typecheck -w @openhermit/channel-signal
```

Expected: all PASS.

- [ ] **Step A2.7: Commit**

```bash
git add apps/channels/signal/src/setup.ts apps/channels/signal/test/setup.test.ts
git -c commit.gpgsign=false commit -m "feat(channel-signal): add ChannelSetup wizard for QR-link flow"
```

---

## Task A3: `manifest.ts` — default-exported ChannelManifest

**Files:**
- Create: `apps/channels/signal/src/manifest.ts`
- Test: `apps/channels/signal/test/manifest.test.ts`

The manifest wraps the existing `start` flow + plugs in `setup`. Pattern from `git show origin/plan/channel-wechat:apps/channels/wechat/src/manifest.ts`.

- [ ] **Step A3.1: Write the failing test**

Create `apps/channels/signal/test/manifest.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import manifest from '../src/manifest.js';

test('manifest exposes the required plugin contract', () => {
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.key, 'signal');
  assert.equal(manifest.namespace, 'signal');
  assert.equal(manifest.displayName, 'Signal');
  assert.equal(typeof manifest.start, 'function');
  assert.ok(manifest.setup, 'manifest must expose ChannelSetup');
});

test('start() without required config returns undefined (channel disabled until linked)', async () => {
  const log: string[] = [];
  const handle = await manifest.start(
    { enabled: true },
    {
      agentBaseUrl: 'http://gateway/api/agents/x',
      agentTokens: { signal: 'tok' },
      logger: (_ch, msg) => log.push(msg),
    },
  );
  assert.equal(handle, undefined);
  assert.ok(
    log.some((m) => m.toLowerCase().includes('http_url')) ||
      log.some((m) => m.toLowerCase().includes('account')),
    `expected log to mention missing http_url or account, got: ${log.join(' | ')}`,
  );
});
```

- [ ] **Step A3.2: Run test (should FAIL)**

```bash
npm test -w @openhermit/channel-signal -- --test-name-pattern manifest.ts
```

Expected: module not found.

- [ ] **Step A3.3: Implement `manifest.ts`**

Create `apps/channels/signal/src/manifest.ts`:

```ts
/**
 * Channel plugin manifest for Signal (signal-cli-rest-api).
 *
 * Loaded by the gateway when `@openhermit/channel-signal` is listed under
 * `channelPackages` in gateway config. See `docs/channel-plugin-design.md`.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { SignalApi } from './signal-api.js';
import { SignalBridge } from './bridge.js';
import { SignalBot } from './bot.js';
import { createSignalSetup } from './setup.js';

interface SignalRuntimeConfig {
  enabled?: boolean;
  /** Base URL of the signal-cli-rest-api container, e.g. http://signal:8080. */
  http_url: string;
  /** E.164 phone number of the bot's Signal account. */
  account: string;
  allowed_senders?: string[];
  allowed_group_ids?: string[];
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'signal',
  namespace: 'signal',
  displayName: 'Signal',

  start: async (rawConfig, context) => {
    const config = rawConfig as SignalRuntimeConfig;
    const log = (msg: string): void => context.logger('signal', msg);

    if (!config.http_url?.trim() || !config.account?.trim()) {
      log('missing http_url or account — channel disabled until linked via setup');
      return undefined;
    }

    const api = new SignalApi({
      httpUrl: config.http_url,
      account: config.account,
    });

    const bridgeOptions: { allowedSenders?: string[]; allowedGroupIds?: string[] } = {};
    if (config.allowed_senders) bridgeOptions.allowedSenders = config.allowed_senders;
    if (config.allowed_group_ids) bridgeOptions.allowedGroupIds = config.allowed_group_ids;

    const bridge = new SignalBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['signal'] ?? '',
      },
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
  },

  setup: createSignalSetup(),
};

export default manifest;
```

- [ ] **Step A3.4: Run tests**

```bash
npm test -w @openhermit/channel-signal
```

Expected: all tests pass (manifest tests + everything from earlier tasks).

- [ ] **Step A3.5: Run typecheck**

```bash
npm run typecheck -w @openhermit/channel-signal
```

Expected: clean.

- [ ] **Step A3.6: Commit**

```bash
git add apps/channels/signal/src/manifest.ts apps/channels/signal/test/manifest.test.ts
git -c commit.gpgsign=false commit -m "feat(channel-signal): default-export ChannelManifest with QR setup"
```

---

## Task A4: Update `index.ts` to default-export the manifest

**Files:**
- Modify: `apps/channels/signal/src/index.ts`

The standalone `main()` from old PR #81 stays as a named export so users can still run the adapter standalone if they want (matches slack/telegram pattern). The default export becomes the manifest.

- [ ] **Step A4.1: Replace index.ts**

Read `apps/channels/signal/src/index.ts` first to confirm current state. Then overwrite with:

```ts
import { pathToFileURL } from 'node:url';

import { loadEnv } from '@openhermit/shared';

import manifest from './manifest.js';
import { SignalApi } from './signal-api.js';
import { SignalBridge } from './bridge.js';
import { SignalBot } from './bot.js';
import { loadConfig } from './config.js';

const log = (message: string): void => {
  console.log(`[openhermit-channel-signal] ${message}`);
};

/**
 * Standalone runner — used when the operator runs the adapter as its own
 * process (e.g. `npm run dev -w @openhermit/channel-signal`) rather than
 * having the gateway load the manifest plugin. Unchanged from before the
 * plugin refactor.
 */
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

export default manifest;
export { manifest };
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

- [ ] **Step A4.2: Build the package**

```bash
npm run build -w @openhermit/channel-signal
```

Expected: clean build, `dist/` has `index.js`, `manifest.js`, `setup.js`, `qr-link.js`.

- [ ] **Step A4.3: Verify default export resolves to a manifest**

```bash
cd /Users/shydev/Amiko/openhermit
node --import tsx -e "import('@openhermit/channel-signal').then(m => console.log({ key: m.default.key, hasSetup: !!m.default.setup, version: m.default.manifestVersion }))"
```

Expected: `{ key: 'signal', hasSetup: true, version: 1 }`.

- [ ] **Step A4.4: Commit**

```bash
git add apps/channels/signal/src/index.ts
git -c commit.gpgsign=false commit -m "feat(channel-signal): default-export manifest, keep named exports"
```

---

## Task A5: Local install + register signal in gateway config

**Files:**
- No code changes here — this is config + the README.

This task confirms the plugin loader actually picks up the package when listed in `channelPackages`. We verify by reading the gateway boot logs.

- [ ] **Step A5.1: Read the existing channelPackages handling**

```bash
git show origin/main:apps/gateway/src/channel-manifests.ts | head -120
git show origin/main:apps/gateway/src/config.ts | grep -B2 -A6 channelPackages
```

Confirm: gateway reads `channelPackages: string[]` from its config file (e.g. `~/.openhermit/gateway/config.json`) and dynamic-imports each at boot.

- [ ] **Step A5.2: Add `@openhermit/channel-signal` to local gateway config**

The dev gateway uses `~/.openhermit/dev/gateway.json` (verify by running `hermit setup` once if not present). Edit that file:

```jsonc
{
  "channelPackages": [
    "@openhermit/channel-signal"
  ]
}
```

For workspace dev, `await import('@openhermit/channel-signal')` resolves through the workspace symlinks — no global install needed.

- [ ] **Step A5.3: Boot the gateway and confirm registration log**

```bash
cd /Users/shydev/Amiko/openhermit
npm run dev:gateway
```

Look for a log line like:
```text
[gateway] registered external channel "signal" from @openhermit/channel-signal
```

If you see `channel package "@openhermit/channel-signal" failed to load` instead, run `npm install` from the repo root to refresh workspace symlinks.

- [ ] **Step A5.4: Confirm `/api/channel-manifests` includes signal**

```bash
curl -sS http://127.0.0.1:4000/api/channel-manifests \
  -H "Authorization: Bearer $OPENHERMIT_TOKEN" | jq '.[] | select(.key == "signal")'
```

Expected:
```json
{
  "key": "signal",
  "namespace": "signal",
  "displayName": "Signal",
  "origin": "external",
  "supportsSetup": true
}
```

If `origin` is `built-in` instead of `external`, the package is being double-loaded — check `BUILTIN_PACKAGES` in `apps/gateway/src/channel-manifests.ts` doesn't include signal (it shouldn't).

- [ ] **Step A5.5: Stop the gateway with Ctrl-C, no commit needed for this task**

Move on. The `~/.openhermit/dev/gateway.json` file is not committed to the repo.

---

## Task A6: Update operator README

**Files:**
- Modify: `apps/channels/signal/README.md`

The old README from PR #81 talks about the built-in channel flow + standalone adapter. The new README needs to model the wechat README pattern (plugin install + add-channel UI flow) while keeping the standalone-runner instructions for development.

- [ ] **Step A6.1: Read the wechat README for the canonical pattern**

```bash
git show origin/plan/channel-wechat:apps/channels/wechat/README.md
```

- [ ] **Step A6.2: Rewrite `apps/channels/signal/README.md`**

```markdown
# Signal Channel Adapter

`@openhermit/channel-signal` connects an OpenHermit agent to a Signal
account via [`bbernhard/signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api).
The plugin is **not bundled** in the CLI — operators install it
explicitly when they want Signal support.

## v1 scope

- Text inbound and outbound (no media)
- DMs and group messages
- QR-link wizard via `ChannelSetup`
- Optional allow-lists (`allowed_senders`, `allowed_group_ids`)
- `MODE=json-rpc` enforced at runtime; the wizard temporarily uses the
  daemon's `MODE=normal` mode for the QR-link step

## Loading the plugin

Add the package name to your gateway config:

```jsonc
// ~/.openhermit/gateway/config.json
{
  "channelPackages": ["@openhermit/channel-signal"]
}
```

For npm-installed CLI:

```bash
npm install -g @openhermit/channel-signal
```

For monorepo dev: workspace resolution handles it; nothing to install.

On gateway boot the plugin loader picks up the package via dynamic
import and registers the `signal` manifest as an `external` origin.
Unlike the bundled built-ins (telegram/slack/discord), no row is
auto-seeded on agent create — owners add Signal on demand from the
admin UI's "Add channel" picker.

## Linking a Signal account

1. In the admin UI, **Channels → Add channel → Signal**.
2. Enter the daemon URL (default: `http://localhost:8080`) and the bot's
   E.164 phone number.
3. The wizard renders a QR code. Open Signal on your phone → Settings
   → Linked Devices → Link New Device → scan.
4. Once the daemon registers the new linked device, the wizard auto-
   advances to `done` and the channel row is persisted.

For the QR-link to work, the daemon must run in `MODE=normal` (its
default). After the device is linked, restart the daemon with
`MODE=json-rpc` so the receive WebSocket comes online — that's what
the bridge uses for inbound messages.

## Daemon docker-compose snippet

```yaml
signal:
  image: bbernhard/signal-cli-rest-api:latest
  environment:
    MODE: json-rpc
  volumes:
    - signal-data:/home/.local/share/signal-cli
  ports:
    - "8080:8080"
```

## Stored config

After successful setup, the persisted `agent_channels.config` row is:

```jsonc
{
  "http_url": "http://localhost:8080",
  "account": "+15551234567",
  "allowed_senders": ["+15559999999", "uuid:abc-123"],   // optional
  "allowed_group_ids": ["base64GroupId=="]               // optional
}
```

Allow-lists are edited later via the channel card's PATCH form. Without
them the bot accepts DMs from anyone and ignores all groups.

## Standalone mode (development)

For local testing without going through the gateway:

```bash
SIGNAL_HTTP_URL=http://localhost:8080 \
SIGNAL_ACCOUNT=+15551234567 \
OPENHERMIT_AGENT_URL=http://localhost:4000/api/agents/main \
OPENHERMIT_AGENT_TOKEN=$AGENT_TOKEN \
npm run dev -w @openhermit/channel-signal
```

This runs the bridge as its own process and skips the manifest /
gateway-pool path entirely. Useful for debugging the receive loop in
isolation.

## Gotchas

- **No native group mentions.** Group routing relies on
  `allowed_group_ids`; the bot replies to every message in an allowed
  group.
- **No streaming edits.** Replies are sent as full chunks at
  `agent_end`. Signal's protocol doesn't support reliable own-message
  edits.
- **Self-loopback drop is theoretical.** Until the manifest's `start()`
  populates `selfUuid` from `/v1/accounts/{number}/identity`, sync
  messages are filtered solely by lacking a `dataMessage`. In linked-
  secondary-device deployments this is sufficient in practice.
- **QR-link captcha.** If the daemon was previously registered to a
  different number, signal-cli may demand a captcha for the new
  registration. The wizard surfaces the daemon's error verbatim;
  follow the [signal-cli captcha
  docs](https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha)
  to clear it.
```

- [ ] **Step A6.3: Commit**

```bash
git add apps/channels/signal/README.md
git -c commit.gpgsign=false commit -m "docs(channel-signal): rewrite README for plugin install + setup wizard"
```

---

## Task A7: Update channel-adapter docs

**Files:**
- Modify: `docs/channel-adapter.md`

Move signal from "Implemented Adapters" (which lists built-ins) to a new "External Plugin Adapters" subsection or update the existing table to mark signal as external.

- [ ] **Step A7.1: Read the current state**

```bash
sed -n '1,40p' docs/channel-adapter.md
```

Note the table format and what's there.

- [ ] **Step A7.2: Update the table**

If the table has a column for kind/origin, add `external` for signal. If not, edit it to include one. Append (or update) Signal row to:

```markdown
| Signal | `@openhermit/channel-signal` | external | signal-cli-rest-api WS (`MODE=json-rpc`) | yes (QR-link) |
```

(Adjust the column count to match the existing schema in the doc.)

- [ ] **Step A7.3: Update the Session Routing table** to keep Signal documented:

```markdown
| Signal | `signal:` (DMs by uuid or E.164) / `signal:group:` | `signal_source`, optional `signal_group_id` |
```

- [ ] **Step A7.4: Commit**

```bash
git add docs/channel-adapter.md
git -c commit.gpgsign=false commit -m "docs(channels): reflect signal as an external plugin adapter"
```

---

## Task A8: Push branch + open PR (openhermit)

- [ ] **Step A8.1: Run full suite + build**

```bash
npm test -w @openhermit/channel-signal
npm run typecheck -w @openhermit/channel-signal
npm run build -w @openhermit/channel-signal
```

All PASS.

- [ ] **Step A8.2: Push**

```bash
git push -u origin plan/signal-channel-plugin
```

- [ ] **Step A8.3: Open PR**

```bash
gh pr create --base main --title "feat(channel-signal): plugin manifest + QR-link setup" --body "$(cat <<'EOF'
## Summary
Reworks the Signal adapter from a hardcoded built-in into a manifest-based external plugin (per `docs/channel-plugin-design.md`) and adds the interactive QR-link setup contract.

## Replaces
Supersedes #81. The built-in registrations that #81 added to `BUILTIN_CHANNELS`, `BUILTIN_CHANNEL_DEFS`, and the `starters` map are no longer applicable after William's plugin refactor (#87/#88/#90); this PR carries only the package itself plus a manifest.

## Architecture
- New `apps/channels/signal/src/manifest.ts` — `ChannelManifest` (default export) wrapping the existing `start` flow + a `setup` for the QR-link wizard.
- New `apps/channels/signal/src/setup.ts` — implements `ChannelSetup.{begin, submit, poll, cancel}` with a 10-min session TTL.
- New `apps/channels/signal/src/qr-link.ts` — thin client over `/v1/qrcodelink/:account` and `/v1/accounts` polling.
- Standalone runner (`main()`) preserved for development.
- README rewritten to reflect plugin install path + wizard flow.

## Loading
`@openhermit/channel-signal` is not bundled in the CLI. Operators add it to `channelPackages` in gateway config; the dynamic-import path in `apps/gateway/src/channel-manifests.ts` does the rest.

## Test plan
- [x] unit: REST client (existing), WS receive (existing), formatter (existing), config (existing), bridge (existing), manifest (new), setup state machine (new), qr-link (new)
- [x] manual: gateway boot picks up the plugin and exposes it at `/api/channel-manifests`
- [ ] manual after merge: end-to-end via amiko-platform PR (linked below)

## Companion PR
amiko-platform PR for the UI side (replaces #919): <fill in after Part B opens it>
EOF
)"
```

Take note of the openhermit PR number for the amiko-platform PR description later.

- [ ] **Step A8.4: Comment + close old PR #81**

```bash
gh pr comment 81 --body "Superseded by #<new-PR-number> after William's plugin refactor (#87/#88/#90). The built-in registrations are no longer applicable; the new PR carries the package as an external plugin with a manifest."
gh pr close 81
```

---

# PART B — amiko-platform refactor

Branch: `feat/signal-channel-wizard` off `feat/hermit-provisioning`.

## Task B0: Branch setup + revert old PR #919 changes

**Files:** `amiko-web/src/components/channels/HermitChannelsView.tsx`, `amiko-web/src/constants/channelProviders.tsx`

Old PR #919 added Signal as a built-in into the hardcoded UI maps. The new plan drives the UI from the gateway's `/api/channel-manifests` instead, so those static entries must come out. The i18n keys stay (we'll need them).

- [ ] **Step B0.1: Branch off the working base**

```bash
cd /Users/shydev/Amiko/amiko-platform
git fetch origin feat/hermit-provisioning
git checkout -b feat/signal-channel-wizard origin/feat/hermit-provisioning
```

- [ ] **Step B0.2: Cherry-pick i18n + plan from old branch**

The translation entries from old PR #919 are still useful. Cherry-pick the i18n commit only (commit hash from `git log feat/signal-channel-ui --oneline | grep i18n`):

```bash
git log --oneline feat/signal-channel-ui | grep i18n
# → e.g. 19571e960 i18n(amiko-web): add Signal channel translations (en/es/zh)
git cherry-pick 19571e960
```

If the cherry-pick has conflicts (likely none since i18n keys were appended), resolve and continue.

- [ ] **Step B0.3: No reverts needed yet**

The old PR #919's HermitChannelsView modifications are not on this branch (we just created it off `feat/hermit-provisioning`). The cherry-pick brought in only the i18n changes. We'll modify `HermitChannelsView.tsx` and `channelProviders.tsx` from scratch in later tasks.

- [ ] **Step B0.4: Confirm clean state**

```bash
git status
git log --oneline origin/feat/hermit-provisioning..HEAD
```

Expected: one commit on the branch (the i18n cherry-pick), nothing staged or modified.

---

## Task B1: Add `qrcode.react` dependency + lib client wrappers

**Files:**
- Modify: `amiko-web/package.json`
- Modify: `amiko-web/src/lib/hermit/client.ts`

We need a QR rendering component on the React side and SDK wrappers for the new gateway routes.

- [ ] **Step B1.1: Install qrcode.react**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm add qrcode.react
```

This updates `package.json` and `pnpm-lock.yaml`.

- [ ] **Step B1.2: Read the existing hermit/client.ts**

```bash
cat /Users/shydev/Amiko/amiko-platform/amiko-web/src/lib/hermit/client.ts
```

Note the GatewayClient setup, the auth header pattern, and how existing methods like `listAgentChannels` are exposed. Mirror that pattern.

- [ ] **Step B1.3: Add the new wrappers to client.ts**

Append (don't replace) the following methods to whatever exports already exist:

```ts
// Append to amiko-web/src/lib/hermit/client.ts

export interface ChannelManifestSummary {
  key: string;
  namespace: string;
  displayName: string;
  origin: 'built-in' | 'external';
  supportsSetup: boolean;
}

export type ChannelSetupState =
  | { kind: 'awaiting_user_input'; instructions?: string; fields: ChannelSetupField[] }
  | { kind: 'awaiting_external'; instructions?: string; qrText?: string; redirectUrl?: string; pollIntervalMs?: number }
  | { kind: 'done'; config: Record<string, unknown> }
  | { kind: 'error'; message: string };

export interface ChannelSetupField {
  name: string;
  label: string;
  type?: 'text' | 'password';
  placeholder?: string;
}

export interface ChannelSetupResponse {
  sessionId: string;
  state: ChannelSetupState;
}

// Add as methods on the existing gateway client class. Adapt the call
// shape (this.fetchJson / this.request / etc.) to whatever the existing
// listAgentChannels() / setAgentSecret() use:

  async listChannelManifests(): Promise<ChannelManifestSummary[]> {
    return this.fetchJson<ChannelManifestSummary[]>(`/api/channel-manifests`);
  }

  async beginChannelSetup(
    agentId: string,
    channelType: string,
    body: Record<string, unknown> = {},
  ): Promise<ChannelSetupResponse> {
    return this.fetchJson<ChannelSetupResponse>(
      `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/begin`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  async pollChannelSetup(
    agentId: string,
    channelType: string,
    sessionId: string,
  ): Promise<ChannelSetupResponse> {
    return this.fetchJson<ChannelSetupResponse>(
      `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
    );
  }

  async submitChannelSetup(
    agentId: string,
    channelType: string,
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<ChannelSetupResponse> {
    return this.fetchJson<ChannelSetupResponse>(
      `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  async cancelChannelSetup(
    agentId: string,
    channelType: string,
    sessionId: string,
  ): Promise<{ ok: boolean }> {
    return this.fetchJson<{ ok: boolean }>(
      `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
  }

  async createBuiltinChannel(
    agentId: string,
    channelType: string,
    config: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return this.fetchJson<{ id: string }>(
      `/api/agents/${encodeURIComponent(agentId)}/channels`,
      {
        method: 'POST',
        body: JSON.stringify({ channelType, config, enabled: true }),
      },
    );
  }
```

If the existing client class doesn't have `fetchJson`, look at how `listAgentChannels` is called (it's already in the file from the hermit-provisioning branch) and reuse the same helper name.

- [ ] **Step B1.4: Typecheck**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm tsc --noEmit 2>&1 | grep -v "tests/\|.next/" | head -10
```

Expected: no errors in `client.ts`.

- [ ] **Step B1.5: Commit**

```bash
cd /Users/shydev/Amiko/amiko-platform
git add amiko-web/package.json amiko-web/pnpm-lock.yaml amiko-web/src/lib/hermit/client.ts
git -c commit.gpgsign=false commit -m "feat(amiko-web): SDK wrappers for channel manifests + setup wizard"
```

---

## Task B2: Proxy routes for the gateway setup endpoints

**Files (all NEW):**
- `amiko-web/src/app/api/agents/[id]/hermit-channel-manifests/route.ts`
- `amiko-web/src/app/api/agents/[id]/hermit-channels/[channelType]/setup/begin/route.ts`
- `amiko-web/src/app/api/agents/[id]/hermit-channels/[channelType]/setup/[sessionId]/route.ts`

These mirror the existing `amiko-web/src/app/api/agents/[id]/hermit-channels/route.ts` proxy pattern (verify auth → look up `hermit_agent_id` from Twin → call gateway client).

- [ ] **Step B2.1: Read the existing proxy as a template**

```bash
cat /Users/shydev/Amiko/amiko-platform/amiko-web/src/app/api/agents/[id]/hermit-channels/route.ts
```

Note: it uses `getLoginUserWithTwinScope`, `verifyTwinAccess`, `prisma`, `tagSentryRequest` from `@/app/api/utils`, and `getHermitGatewayClient` from `@/lib/hermit`. Same imports go into the new routes.

- [ ] **Step B2.2: Create the manifests proxy**

`amiko-web/src/app/api/agents/[id]/hermit-channel-manifests/route.ts`:

```ts
import { NextResponse } from "next/server";
import {
  getLoginUserWithTwinScope,
  verifyTwinAccess,
  prisma,
  tagSentryRequest,
} from "@/app/api/utils";
import { getHermitGatewayClient } from "@/lib/hermit";
import { logError } from "@/lib/sentry";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: twinId } = await context.params;
    const loginResult = await getLoginUserWithTwinScope(twinId);
    if (!loginResult) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    tagSentryRequest(loginResult.user.id, "/api/agents/[id]/hermit-channel-manifests");

    const twin = await prisma.twin.findFirst({
      where: { id: twinId, deleted_at: null },
      select: { id: true, user_id: true, hermit_agent_id: true },
    });
    if (!twin) return NextResponse.json({ error: "Twin not found" }, { status: 404 });

    const access = verifyTwinAccess(loginResult, twinId, twin);
    if (!access.authorized) {
      return NextResponse.json({ error: access.error }, { status: access.status || 403 });
    }
    if (!twin.hermit_agent_id) {
      return NextResponse.json({ error: "Twin has no hermit agent provisioned" }, { status: 409 });
    }

    const gateway = getHermitGatewayClient();
    const manifests = await gateway.listChannelManifests();
    return NextResponse.json({ manifests });
  } catch (error) {
    logError(error, {
      op: "hermit_channel_manifests.list",
      route: "/api/agents/[id]/hermit-channel-manifests",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list manifests" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step B2.3: Create the setup-begin proxy**

`amiko-web/src/app/api/agents/[id]/hermit-channels/[channelType]/setup/begin/route.ts`:

```ts
import { NextResponse } from "next/server";
import {
  getLoginUserWithTwinScope,
  verifyTwinAccess,
  prisma,
  tagSentryRequest,
} from "@/app/api/utils";
import { getHermitGatewayClient } from "@/lib/hermit";
import { logError } from "@/lib/sentry";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; channelType: string }> },
) {
  try {
    const { id: twinId, channelType } = await context.params;
    const loginResult = await getLoginUserWithTwinScope(twinId);
    if (!loginResult) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    tagSentryRequest(loginResult.user.id, "/api/agents/[id]/hermit-channels/[channelType]/setup/begin");

    const twin = await prisma.twin.findFirst({
      where: { id: twinId, deleted_at: null },
      select: { id: true, user_id: true, hermit_agent_id: true },
    });
    if (!twin) return NextResponse.json({ error: "Twin not found" }, { status: 404 });
    const access = verifyTwinAccess(loginResult, twinId, twin);
    if (!access.authorized) return NextResponse.json({ error: access.error }, { status: access.status || 403 });
    if (!twin.hermit_agent_id) {
      return NextResponse.json({ error: "Twin has no hermit agent provisioned" }, { status: 409 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const gateway = getHermitGatewayClient();
    const resp = await gateway.beginChannelSetup(twin.hermit_agent_id, channelType, body);
    return NextResponse.json(resp);
  } catch (error) {
    logError(error, {
      op: "hermit_channel_setup.begin",
      route: "/api/agents/[id]/hermit-channels/[channelType]/setup/begin",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to begin setup" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step B2.4: Create the poll/submit/cancel proxy**

`amiko-web/src/app/api/agents/[id]/hermit-channels/[channelType]/setup/[sessionId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import {
  getLoginUserWithTwinScope,
  verifyTwinAccess,
  prisma,
  tagSentryRequest,
} from "@/app/api/utils";
import { getHermitGatewayClient } from "@/lib/hermit";
import { logError } from "@/lib/sentry";

type Params = { id: string; channelType: string; sessionId: string };

async function authorize(twinId: string, route: string) {
  const loginResult = await getLoginUserWithTwinScope(twinId);
  if (!loginResult) return { error: "Unauthorized", status: 401 as const };
  tagSentryRequest(loginResult.user.id, route);

  const twin = await prisma.twin.findFirst({
    where: { id: twinId, deleted_at: null },
    select: { id: true, user_id: true, hermit_agent_id: true },
  });
  if (!twin) return { error: "Twin not found", status: 404 as const };

  const access = verifyTwinAccess(loginResult, twinId, twin);
  if (!access.authorized) return { error: access.error, status: access.status || 403 } as const;
  if (!twin.hermit_agent_id) {
    return { error: "Twin has no hermit agent provisioned", status: 409 as const };
  }
  return { hermitAgentId: twin.hermit_agent_id };
}

export async function GET(_request: Request, context: { params: Promise<Params> }) {
  try {
    const { id: twinId, channelType, sessionId } = await context.params;
    const auth = await authorize(twinId, "/api/agents/[id]/hermit-channels/[channelType]/setup/[sessionId]");
    if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const gateway = getHermitGatewayClient();
    const resp = await gateway.pollChannelSetup(auth.hermitAgentId, channelType, sessionId);
    return NextResponse.json(resp);
  } catch (error) {
    logError(error, { op: "hermit_channel_setup.poll" });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to poll setup" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const { id: twinId, channelType, sessionId } = await context.params;
    const auth = await authorize(twinId, "/api/agents/[id]/hermit-channels/[channelType]/setup/[sessionId]");
    if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const gateway = getHermitGatewayClient();
    const resp = await gateway.submitChannelSetup(auth.hermitAgentId, channelType, sessionId, body);
    return NextResponse.json(resp);
  } catch (error) {
    logError(error, { op: "hermit_channel_setup.submit" });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to submit setup" },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, context: { params: Promise<Params> }) {
  try {
    const { id: twinId, channelType, sessionId } = await context.params;
    const auth = await authorize(twinId, "/api/agents/[id]/hermit-channels/[channelType]/setup/[sessionId]");
    if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const gateway = getHermitGatewayClient();
    await gateway.cancelChannelSetup(auth.hermitAgentId, channelType, sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logError(error, { op: "hermit_channel_setup.cancel" });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to cancel setup" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step B2.5: Typecheck**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm tsc --noEmit 2>&1 | grep -v "tests/\|.next/" | head -10
```

Expected: no errors in any of the three new route files.

- [ ] **Step B2.6: Commit**

```bash
cd /Users/shydev/Amiko/amiko-platform
git add amiko-web/src/app/api/agents/\[id\]/hermit-channel-manifests \
        amiko-web/src/app/api/agents/\[id\]/hermit-channels/\[channelType\]
git -c commit.gpgsign=false commit -m "feat(amiko-web): proxy routes for channel manifests + setup wizard"
```

---

## Task B3: `ChannelSetupWizard` component

**Files:**
- Create: `amiko-web/src/components/channels/ChannelSetupWizard.tsx`

Port openhermit's `apps/web/ui/src/components/ChannelSetupWizard.tsx` to amiko-web's stack (Tailwind + shadcn/ui + next-intl). Uses `qrcode.react` for QR rendering and the wrappers added in Task B1, but called via fetch to the Next.js proxy routes from Task B2.

- [ ] **Step B3.1: Read the openhermit reference verbatim**

```bash
git -C /Users/shydev/Amiko/openhermit show origin/plan/channel-wechat:apps/web/ui/src/components/ChannelSetupWizard.tsx
```

The state machine is identical; only the rendering primitives differ.

- [ ] **Step B3.2: Create the component**

`amiko-web/src/components/channels/ChannelSetupWizard.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ChannelSetupField = {
  name: string;
  label: string;
  type?: "text" | "password";
  placeholder?: string;
};

type ChannelSetupState =
  | { kind: "awaiting_user_input"; instructions?: string; fields: ChannelSetupField[] }
  | { kind: "awaiting_external"; instructions?: string; qrText?: string; redirectUrl?: string; pollIntervalMs?: number }
  | { kind: "done"; config: Record<string, unknown> }
  | { kind: "error"; message: string };

type ChannelSetupResponse = { sessionId: string; state: ChannelSetupState };

interface Props {
  twinId: string;
  channelType: string;
  displayName: string;
  onDone: (config: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
}

export function ChannelSetupWizard({ twinId, channelType, displayName, onDone, onCancel }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<ChannelSetupState | null>(null);
  const [error, setError] = useState("");
  const [formInput, setFormInput] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const apply = useCallback((resp: ChannelSetupResponse) => {
    setSessionId(resp.sessionId);
    setState(resp.state);
    setError("");
    if (resp.state.kind === "awaiting_user_input") {
      const initial: Record<string, string> = {};
      for (const f of resp.state.fields) initial[f.name] = "";
      setFormInput(initial);
    }
  }, []);

  // Kick off setup on mount.
  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(twinId)}/hermit-channels/${encodeURIComponent(channelType)}/setup/begin`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        );
        if (!res.ok) throw new Error((await res.text()) || `Begin failed (${res.status})`);
        if (cancelledRef.current) return;
        apply((await res.json()) as ChannelSetupResponse);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    return () => {
      cancelledRef.current = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [twinId, channelType, apply]);

  // Poll while awaiting an external event (QR scan, OAuth callback).
  useEffect(() => {
    if (!sessionId || !state || state.kind !== "awaiting_external") return;
    const interval = state.pollIntervalMs ?? 2000;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(twinId)}/hermit-channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) throw new Error((await res.text()) || `Poll failed (${res.status})`);
        if (cancelledRef.current) return;
        apply((await res.json()) as ChannelSetupResponse);
      } catch (err) {
        if (cancelledRef.current) return;
        setError((err as Error).message);
      }
    };
    pollTimerRef.current = setTimeout(() => { void tick(); }, interval);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [sessionId, state, twinId, channelType, apply]);

  // Hand off to the parent on `done`.
  useEffect(() => {
    if (state?.kind === "done") {
      void onDone(state.config);
    }
  }, [state, onDone]);

  const handleCancel = useCallback(async () => {
    if (sessionId) {
      try {
        await fetch(
          `/api/agents/${encodeURIComponent(twinId)}/hermit-channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        );
      } catch { /* ignore */ }
    }
    onCancel();
  }, [sessionId, twinId, channelType, onCancel]);

  const handleSubmit = async (): Promise<void> => {
    if (!sessionId) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(twinId)}/hermit-channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(formInput) },
      );
      if (!res.ok) throw new Error((await res.text()) || `Submit failed (${res.status})`);
      apply((await res.json()) as ChannelSetupResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        Linking <strong>{displayName}</strong>. The wizard closes automatically when linking completes.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!state && !error && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Starting…
        </div>
      )}
      {state?.kind === "awaiting_external" && <ExternalStep state={state} />}
      {state?.kind === "awaiting_user_input" && (
        <div className="space-y-3">
          {state.instructions && <p className="text-sm text-slate-600">{state.instructions}</p>}
          {state.fields.map((f) => (
            <div key={f.name} className="space-y-1.5">
              <Label htmlFor={`setup-${channelType}-${f.name}`}>{f.label}</Label>
              <Input
                id={`setup-${channelType}-${f.name}`}
                type={f.type === "password" ? "password" : "text"}
                placeholder={f.placeholder ?? ""}
                value={formInput[f.name] ?? ""}
                onChange={(e) => setFormInput({ ...formInput, [f.name]: e.target.value })}
                autoComplete="off"
              />
            </div>
          ))}
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "Submitting…" : "Continue"}
          </Button>
        </div>
      )}
      {state?.kind === "error" && <p className="text-sm text-red-600">{state.message}</p>}
      {state?.kind === "done" && <p className="text-sm text-emerald-700">Linked. Saving…</p>}
      <div className="pt-2">
        <Button variant="ghost" size="sm" onClick={() => void handleCancel()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ExternalStep({ state }: { state: Extract<ChannelSetupState, { kind: "awaiting_external" }> }) {
  const isDataUrl = !!state.qrText && state.qrText.startsWith("data:image/");
  return (
    <div className="space-y-3">
      {state.instructions && <p className="text-sm text-slate-600">{state.instructions}</p>}
      {state.qrText && (
        <div className="flex flex-col items-center gap-2 rounded-md border border-slate-200 bg-white p-4">
          {isDataUrl ? (
            <img src={state.qrText} alt="Setup QR" className="h-56 w-56" />
          ) : (
            <QRCodeSVG value={state.qrText} size={224} marginSize={1} />
          )}
        </div>
      )}
      {state.redirectUrl && (
        <p className="text-sm">
          <a href={state.redirectUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">
            Open login page ↗
          </a>
        </p>
      )}
      <p className="text-sm text-slate-500">Waiting for confirmation…</p>
    </div>
  );
}
```

Note: Signal's `qrText` is a `data:image/png;base64,…` string (per Task A2 implementation). The wizard handles both data-URL PNGs and arbitrary `sgnl://` strings — the latter via `QRCodeSVG`. Both code paths are present so the component works for any future plugin.

- [ ] **Step B3.3: Typecheck**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm tsc --noEmit 2>&1 | grep -v "tests/\|.next/" | head -10
```

Expected: no errors in `ChannelSetupWizard.tsx`.

- [ ] **Step B3.4: Commit**

```bash
cd /Users/shydev/Amiko/amiko-platform
git add amiko-web/src/components/channels/ChannelSetupWizard.tsx
git -c commit.gpgsign=false commit -m "feat(amiko-web): generic ChannelSetupWizard for plugin auth flows"
```

---

## Task B4: `AddChannelDialog` component

**Files:**
- Create: `amiko-web/src/components/channels/AddChannelDialog.tsx`

Modal that lists `/api/channel-manifests`, filters out manifests already on the agent, and opens the wizard for `supportsSetup: true` (or proxies to a stub form for `supportsSetup: false` — the latter only happens for token-only externals which Signal isn't).

- [ ] **Step B4.1: Create the component**

`amiko-web/src/components/channels/AddChannelDialog.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChannelSetupWizard } from "./ChannelSetupWizard";

interface ChannelManifestSummary {
  key: string;
  namespace: string;
  displayName: string;
  origin: "built-in" | "external";
  supportsSetup: boolean;
}

interface Props {
  twinId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** channelTypes already present on the agent — filtered out of the picker. */
  alreadyAddedTypes: string[];
  onAdded: () => void | Promise<void>;
}

type Stage =
  | { kind: "picker" }
  | { kind: "wizard"; channelType: string; displayName: string };

export function AddChannelDialog({
  twinId,
  open,
  onOpenChange,
  alreadyAddedTypes,
  onAdded,
}: Props) {
  const [manifests, setManifests] = useState<ChannelManifestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "picker" });

  useEffect(() => {
    if (!open) return;
    setStage({ kind: "picker" });
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(twinId)}/hermit-channel-manifests`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Failed to load (${res.status})`);
        }
        const data = (await res.json()) as { manifests: ChannelManifestSummary[] };
        setManifests(data.manifests);
        setLoadError(null);
      } catch (err) {
        setLoadError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, twinId]);

  const available = manifests.filter((m) => !alreadyAddedTypes.includes(m.key));

  const handleDone = async (config: Record<string, unknown>) => {
    if (stage.kind !== "wizard") return;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(twinId)}/hermit-channels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelType: stage.channelType, config, enabled: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Save failed (${res.status})`);
      }
      toast.success(`${stage.displayName} connected`);
      onOpenChange(false);
      await onAdded();
    } catch (err) {
      toast.error((err as Error).message);
      setStage({ kind: "picker" });
    }
  };

  const handleCancel = () => setStage({ kind: "picker" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {stage.kind === "wizard" ? `Connect ${stage.displayName}` : "Add channel"}
          </DialogTitle>
        </DialogHeader>
        {stage.kind === "picker" && (
          <>
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {loadError && (
              <p className="text-sm text-red-600">{loadError}</p>
            )}
            {!loading && !loadError && available.length === 0 && (
              <p className="text-sm text-slate-500">
                No additional channels available. Built-in channels are already
                added; install more via your gateway's <code>channelPackages</code>{" "}
                config.
              </p>
            )}
            {!loading &&
              available.map((m) => (
                <Button
                  key={m.key}
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => {
                    if (m.supportsSetup) {
                      setStage({ kind: "wizard", channelType: m.key, displayName: m.displayName });
                    } else {
                      toast.error(
                        `${m.displayName} requires manual config — open the channel card after creating it to enter credentials.`,
                      );
                    }
                  }}
                >
                  <span className="font-medium">{m.displayName}</span>
                  <span className="ml-2 text-xs text-slate-500">{m.key}</span>
                </Button>
              ))}
          </>
        )}
        {stage.kind === "wizard" && (
          <ChannelSetupWizard
            twinId={twinId}
            channelType={stage.channelType}
            displayName={stage.displayName}
            onDone={handleDone}
            onCancel={handleCancel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step B4.2: Typecheck**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm tsc --noEmit 2>&1 | grep -v "tests/\|.next/" | head -10
```

Expected: clean (or whatever pre-existing errors exist outside of the new file).

- [ ] **Step B4.3: Commit**

```bash
cd /Users/shydev/Amiko/amiko-platform
git add amiko-web/src/components/channels/AddChannelDialog.tsx
git -c commit.gpgsign=false commit -m "feat(amiko-web): AddChannelDialog driven by /api/channel-manifests"
```

---

## Task B5: Wire the Add-channel button into HermitChannelsView

**Files:**
- Modify: `amiko-web/src/components/channels/HermitChannelsView.tsx`

Add an "Add channel" button at the top of the list. Existing card rendering is unchanged.

- [ ] **Step B5.1: Read the current HermitChannelsView**

```bash
cat /Users/shydev/Amiko/amiko-platform/amiko-web/src/components/channels/HermitChannelsView.tsx | head -160
```

This is the version on `feat/hermit-provisioning` — without the old PR #919 modifications. Expected: it lists builtin channels using a hardcoded `PROVIDER_BY_CHANNEL_TYPE` map.

- [ ] **Step B5.2: Add the AddChannelDialog state + button**

Find the top-level component `HermitChannelsView`. After the existing `useState` declarations, add:

```tsx
  const [addOpen, setAddOpen] = useState(false);
```

Add the import at the top of the file:

```tsx
import { AddChannelDialog } from "./AddChannelDialog";
```

In the JSX return (around the existing `<div className="space-y-6">`), add the trigger button + the dialog. Replace the outer wrapper:

```tsx
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          + {t("addChannel")}
        </Button>
      </div>
      <div className="grid gap-4">
        {channels.map((ch) => {
          const provider = PROVIDER_BY_CHANNEL_TYPE[ch.channelType];
          if (!provider) return null;
          return (
            <HermitChannelCard
              key={ch.id}
              channel={ch}
              provider={provider}
              isExpanded={expanded === ch.id}
              onToggleExpand={() =>
                setExpanded((prev) => (prev === ch.id ? null : ch.id))
              }
              onChanged={reload}
              twinId={twinId}
              t={t}
            />
          );
        })}
      </div>
      <AddChannelDialog
        twinId={twinId}
        open={addOpen}
        onOpenChange={setAddOpen}
        alreadyAddedTypes={channels.map((c) => c.channelType)}
        onAdded={reload}
      />
    </div>
  );
```

If `t("title")` doesn't exist, swap to a literal string or whatever the existing component uses for headings. The point is the layout: title + button on top row, cards below, dialog at end.

- [ ] **Step B5.3: Typecheck**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm tsc --noEmit 2>&1 | grep -v "tests/\|.next/" | head -10
```

Expected: clean.

- [ ] **Step B5.4: Commit**

```bash
cd /Users/shydev/Amiko/amiko-platform
git add amiko-web/src/components/channels/HermitChannelsView.tsx
git -c commit.gpgsign=false commit -m "feat(amiko-web): add 'Add channel' button to HermitChannelsView"
```

---

## Task B6: i18n keys for the new strings

**Files:**
- Modify: `amiko-web/messages/en.json`
- Modify: `amiko-web/messages/es.json`
- Modify: `amiko-web/messages/zh.json`

Translation parity test forces all three locales to update together.

- [ ] **Step B6.1: Add to en.json**

Find the `channels` object root (where `providers.signal_*` already lives from the cherry-pick). Add the new keys at the same top level (not inside `providers`):

```json
    "addChannel": "Add channel",
    "addChannelDescription": "Connect a new messaging channel to this agent.",
    "linking": "Linking…",
    "linkSuccess": "Channel connected",
    "linkCancelled": "Channel setup cancelled"
```

- [ ] **Step B6.2: Add to es.json**

```json
    "addChannel": "Agregar canal",
    "addChannelDescription": "Conecta un nuevo canal de mensajería a este agente.",
    "linking": "Vinculando…",
    "linkSuccess": "Canal conectado",
    "linkCancelled": "Configuración del canal cancelada"
```

- [ ] **Step B6.3: Add to zh.json**

```json
    "addChannel": "添加频道",
    "addChannelDescription": "将新的消息频道连接到此代理。",
    "linking": "正在关联…",
    "linkSuccess": "频道已连接",
    "linkCancelled": "频道设置已取消"
```

- [ ] **Step B6.4: Run translation test**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm vitest run tests/translations.test.ts
```

Expected: PASS.

- [ ] **Step B6.5: Commit**

```bash
cd /Users/shydev/Amiko/amiko-platform
git add amiko-web/messages/en.json amiko-web/messages/es.json amiko-web/messages/zh.json
git -c commit.gpgsign=false commit -m "i18n(amiko-web): add channel-wizard strings (en/es/zh)"
```

---

## Task B7: Tests for the wizard + dialog

**Files:**
- Create: `amiko-web/tests/components/channel-setup-wizard.test.tsx`
- Create: `amiko-web/tests/components/add-channel-dialog.test.tsx`

- [ ] **Step B7.1: Wizard test**

`amiko-web/tests/components/channel-setup-wizard.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelSetupWizard } from "@/components/channels/ChannelSetupWizard";

describe("ChannelSetupWizard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("hits begin() on mount and renders the awaiting_user_input form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/setup/begin")) {
          return new Response(
            JSON.stringify({
              sessionId: "sess-1",
              state: {
                kind: "awaiting_user_input",
                fields: [
                  { name: "http_url", label: "Daemon URL", type: "text" },
                  { name: "phone_number", label: "Phone", type: "text" },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    render(
      <ChannelSetupWizard
        twinId="agent_1"
        channelType="signal"
        displayName="Signal"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Daemon URL")).toBeInTheDocument());
    expect(screen.getByLabelText("Phone")).toBeInTheDocument();
  });

  it("calls onDone with config when state transitions to done after a poll", async () => {
    let pollHits = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/setup/begin")) {
          return new Response(
            JSON.stringify({
              sessionId: "sess-1",
              state: {
                kind: "awaiting_external",
                qrText: "data:image/png;base64,iVBORw==",
                pollIntervalMs: 50,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // poll
        pollHits += 1;
        const done = pollHits >= 2;
        return new Response(
          JSON.stringify({
            sessionId: "sess-1",
            state: done
              ? { kind: "done", config: { http_url: "http://x", account: "+1" } }
              : { kind: "awaiting_external", qrText: "data:image/png;base64,iVBORw==", pollIntervalMs: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const onDone = vi.fn();
    render(
      <ChannelSetupWizard
        twinId="agent_1"
        channelType="signal"
        displayName="Signal"
        onDone={onDone}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(
      () => expect(onDone).toHaveBeenCalledWith({ http_url: "http://x", account: "+1" }),
      { timeout: 2000 },
    );
  });

  it("calls onCancel when the user clicks Cancel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionId: "sess-1",
            state: { kind: "awaiting_user_input", fields: [] },
          }),
          { status: 200 },
        ),
      ),
    );
    const onCancel = vi.fn();
    render(
      <ChannelSetupWizard
        twinId="agent_1"
        channelType="signal"
        displayName="Signal"
        onDone={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("Cancel")).toBeInTheDocument());
    await user.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step B7.2: Add-dialog test**

`amiko-web/tests/components/add-channel-dialog.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddChannelDialog } from "@/components/channels/AddChannelDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const manifests = [
  { key: "telegram", namespace: "telegram", displayName: "Telegram", origin: "built-in", supportsSetup: false },
  { key: "signal", namespace: "signal", displayName: "Signal", origin: "external", supportsSetup: true },
];

describe("AddChannelDialog", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("filters out already-added channels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ manifests }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    render(
      <AddChannelDialog
        twinId="agent_1"
        open={true}
        onOpenChange={vi.fn()}
        alreadyAddedTypes={["telegram"]}
        onAdded={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Signal")).toBeInTheDocument());
    expect(screen.queryByText("Telegram")).not.toBeInTheDocument();
  });

  it("shows an empty-state message when nothing is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ manifests }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    render(
      <AddChannelDialog
        twinId="agent_1"
        open={true}
        onOpenChange={vi.fn()}
        alreadyAddedTypes={["telegram", "signal"]}
        onAdded={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/No additional channels available/i)).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step B7.3: Run tests**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm vitest run tests/components/channel-setup-wizard.test.tsx tests/components/add-channel-dialog.test.tsx
```

Expected: 5 PASS (3 wizard + 2 dialog). If a test fails because of mock/setup pattern mismatch, look at `tests/components/hermit-channels-signal.test.tsx` from old PR #919 (already exists on `feat/hermit-provisioning` if it merged, or in `feat/signal-channel-ui` you can copy the imports from) for the canonical setup.

- [ ] **Step B7.4: Commit**

```bash
cd /Users/shydev/Amiko/amiko-platform
git add amiko-web/tests/components/channel-setup-wizard.test.tsx \
        amiko-web/tests/components/add-channel-dialog.test.tsx
git -c commit.gpgsign=false commit -m "test(amiko-web): cover ChannelSetupWizard + AddChannelDialog"
```

---

## Task B8: Push branch + open PR (amiko-platform)

- [ ] **Step B8.1: Final lints + tests**

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
pnpm vitest run tests/translations.test.ts \
  tests/components/channel-setup-wizard.test.tsx \
  tests/components/add-channel-dialog.test.tsx
pnpm tsc --noEmit 2>&1 | grep -v "tests/\|.next/" | head -10
```

All clean (ignore pre-existing errors in unrelated files).

- [ ] **Step B8.2: Push**

```bash
cd /Users/shydev/Amiko/amiko-platform
git push -u origin feat/signal-channel-wizard
```

- [ ] **Step B8.3: Open PR**

```bash
gh pr create --base main --title "feat(amiko-web): generic channel setup wizard + Signal" --body "$(cat <<'EOF'
## Summary
Replaces the hardcoded "Signal as built-in" approach (#919) with a generic Add-channel + setup-wizard UI that's driven by the openhermit gateway's `/api/channel-manifests` endpoint. Works with Signal today and any future plugin (wechat, debox, …) automatically.

## Replaces
Supersedes #919. The new approach matches what William's wechat work (`origin/plan/channel-wechat`) introduced for the openhermit admin UI; this PR brings the same pattern to amiko-web.

## What changed
- New gateway client wrappers: `listChannelManifests`, `beginChannelSetup`, `pollChannelSetup`, `submitChannelSetup`, `cancelChannelSetup`, `createBuiltinChannel`.
- New Next.js route proxies for the four `/setup/*` endpoints + `/api/channel-manifests`.
- New `<ChannelSetupWizard>` — generic state-machine UI driving `begin → poll/submit → done`. Renders QR codes from data URLs (Signal) or text (WeChat-style).
- New `<AddChannelDialog>` — modal with manifest picker, filters out channels already on the agent.
- `<HermitChannelsView>` gets an "Add channel" button at the top.
- i18n: 5 new strings × 3 locales.
- 5 new vitest cases.

## Pre-merge dependency
openhermit PR #<num> must be merged + deployed first (so `/api/channel-manifests` returns Signal). Until then the picker won't show Signal but the rest of the flow works for the bundled built-ins.

## Test plan
- [x] vitest unit (translations, wizard, dialog)
- [x] typecheck
- [ ] manual after openhermit deploy: Add channel → Signal → enter daemon URL + phone → scan QR → DM bot → reply
EOF
)"
```

- [ ] **Step B8.4: Comment + close old PR #919**

```bash
gh pr comment 919 --body "Superseded by #<new-PR-number>. The hardcoded 'Signal as built-in' approach is replaced by a generic channel-manifest-driven UI that works for Signal + any future plugin."
gh pr close 919
```

---

# PART C — Local end-to-end test

After both PRs are open and all unit tests pass, exercise the full flow before merging.

## Task C1: Boot the local stack

- [ ] **Step C1.1: Start signal-cli-rest-api in linking mode**

```bash
docker stop signal-test 2>/dev/null
docker rm signal-test 2>/dev/null
docker run -d --restart unless-stopped --name signal-test \
  -p 8080:8080 \
  -v ~/.signal-cli-local:/home/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api:0.99
```

The daemon starts in `MODE=normal`. We'll switch to json-rpc later for the receive loop.

- [ ] **Step C1.2: Start the local openhermit gateway**

In a separate terminal:

```bash
cd /Users/shydev/Amiko/openhermit
git checkout plan/signal-channel-plugin
npm install
npm run dev:gateway
```

Verify in the boot logs:
```text
registered external channel "signal" from @openhermit/channel-signal
```

- [ ] **Step C1.3: Start amiko-web**

In another terminal:

```bash
cd /Users/shydev/Amiko/amiko-platform/amiko-web
git checkout feat/signal-channel-wizard
pnpm install
# Make sure the env points at the local gateway:
# HERMIT_GATEWAY_URL=http://127.0.0.1:4000
# HERMIT_ADMIN_TOKEN=<dev token from `hermit setup`>
pnpm dev
```

Open `http://localhost:3000`, log in, navigate to your twin's channels page.

## Task C2: Walk through the wizard

- [ ] **Step C2.1: Click "Add channel"**

Expected: modal appears, listing whatever manifests aren't already on the twin. Signal should appear.

- [ ] **Step C2.2: Click Signal**

Expected: wizard opens, asks for `http_url` (default `http://localhost:8080`) and `phone_number`.

- [ ] **Step C2.3: Submit + scan QR**

Enter your phone number (E.164), click Continue. A QR appears. Scan it with Signal → Settings → Linked Devices → Link New Device.

Expected: within ~3 seconds the wizard advances to "Linked. Saving…", the modal closes, and a Signal card appears in the channel list with an "active" badge.

If the wizard hangs on `awaiting_external` for more than 30s, check the daemon logs:
```bash
docker logs signal-test --tail 30
```

A common failure: the QR was scanned but the daemon hasn't yet propagated the link to `/v1/accounts`. Wait another 10s.

- [ ] **Step C2.4: Switch the daemon to json-rpc**

Once the channel is created, the bridge needs the WebSocket receive endpoint. Restart the daemon in json-rpc mode:

```bash
docker stop signal-test
docker rm signal-test
docker run -d --restart unless-stopped --name signal-test \
  -p 8080:8080 -e MODE=json-rpc \
  -v ~/.signal-cli-local:/home/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api:0.99
```

Restart the gateway too so the bridge reconnects:
```bash
# In the gateway terminal: Ctrl-C, then
npm run dev:gateway
```

- [ ] **Step C2.5: Send a test DM**

From a separate Signal account, DM the linked number "hello".

Expected: within a few seconds, the agent replies. Check the gateway logs for `[main] [signal] connecting to receive WS...` followed by the bridge's incoming-message log.

- [ ] **Step C2.6: Toggle disable + re-enable**

In the channel card, click Disable. The bridge should stop. Send another DM — no reply.

Click Enable. Bridge restarts. DM gets a reply.

## Task C3: Smoke results

- [ ] **Step C3.1: Document what worked / what broke**

Report back in this thread before merging:
- Wizard reached `done` cleanly?
- Channel row was created?
- Receive bridge connected after the json-rpc switch?
- DM round-trip worked?
- Disable/enable toggle worked?

Any "no" → file the issue against the relevant PR before merging.

---

# PART D — Merge

Order matters: openhermit first.

- [ ] **Step D.1: Merge openhermit PR**

After CI green + CodeRabbit comments addressed:

```bash
cd /Users/shydev/Amiko/openhermit
gh pr merge <openhermit-PR-number> --squash
```

Wait for the `amiko-openhermit` Railway service to redeploy.

- [ ] **Step D.2: Verify deploy**

```bash
curl -sS https://hermit.heyamiko.com/api/channel-manifests \
  -H "Authorization: Bearer $OPENHERMIT_TOKEN" | jq '.[] | select(.key == "signal")'
```

Expected: signal manifest with `origin: "external"`, `supportsSetup: true`.

If `signal` is missing, the gateway's `channelPackages` config in production needs `@openhermit/channel-signal`. Either:
1. Set the env var / edit `~/.openhermit/gateway/config.json` on the Railway service, or
2. (preferred) hardcode `@openhermit/channel-signal` into `BUILTIN_PACKAGES` in `apps/gateway/src/channel-manifests.ts` for Amiko's deployment — that's a follow-up commit on openhermit's main branch.

- [ ] **Step D.3: Merge amiko-platform PR**

```bash
cd /Users/shydev/Amiko/amiko-platform
gh pr merge <amiko-PR-number> --squash
```

- [ ] **Step D.4: Verify production**

Once amiko-web deploys, navigate to `/amiko/<twin-id>/channels` on prod. Click Add channel. Signal should appear. Walk through the wizard against your prod daemon.

- [ ] **Step D.5: Done**

Mark the openhermit `Task 15` (manual smoke test from the original openhermit plan) and the amiko-platform `Task 6` (manual smoke test from the original UI plan) as completed.

---

## Self-Review

**1. Spec coverage:** Each item from William's brief maps to a task:
- "channels package not in core, except built-ins (telegram/slack/discord)" → Task A0 starts off `origin/main` which already drops them; we never add signal back to BUILTIN_CHANNELS.
- "external channels in own npm package" → already true; package was scaffolded in PR #81.
- "manifest so gateway can recognize and run when installed" → Tasks A2 (setup) + A3 (manifest) + A5 (verify boot picks it up).
- "test it locally end-to-end" → Part C.
- "then merge" → Part D.

The **amiko-platform side** ensures end users get full connectivity: Add-channel button + wizard + persisted row → bridge online (Tasks B1–B7).

**2. Placeholder scan:** No "TBD", "fill in details", or "similar to". Every step has either complete code or a complete shell command. The two places that say "if pre-existing test patterns differ, copy that" (B7.3) are debugging hints, not placeholders — the tests are fully written.

**3. Type consistency:**
- `ChannelManifest` / `ChannelSetup` / `ChannelSetupContext` / `ChannelSetupState` / `ChannelSetupResponse` — names match `@openhermit/protocol` exactly across Tasks A2, A3, B1, B2, B3, B4, B7.
- `http_url`, `account`, `allowed_senders`, `allowed_group_ids` — snake_case for the persisted runtime config (matches what the existing signal package consumes).
- `channelType` parameter naming in routes (B2) and components (B3, B4) — consistent.
- `manifest.key === 'signal'`, `namespace === 'signal'` — consistent across A3, A5 verification, B4 dialog filter.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-signal-plugin-refactor.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
