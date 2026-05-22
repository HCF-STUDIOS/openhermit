# Voice & Multimodal Output Design

> Status: design draft. Nothing in this doc has shipped. Captures the
> architectural shape for adding voice input/output to agents and the broader
> "agent generated a file in the sandbox — now what?" problem. Supersedes the
> "audio/video routing" deferred item in
> [`file-attachments-design.md`](file-attachments-design.md).

## Why

Two motivating use cases, one architectural gap behind them:

1. **Voice input.** A user sends a voice note on Telegram / WeChat / Signal /
   WhatsApp. Today the channel adapter either drops it or surfaces an opaque
   file URL the model cannot use. We want the agent to receive the transcript
   transparently and optionally still see the original audio.

2. **Voice output.** When the user prefers voice, the agent's final reply
   should arrive as a native voice message on platforms that support one
   (Telegram `sendVoice`, WhatsApp audio, Signal voice note), falling back to
   a file attachment elsewhere.

3. **The bigger gap behind both.** Inbound attachments are well-modelled
   today; outbound is text-only. `ChannelOutbound.send` and `session_send`
   have no attachment surface. So even when the agent runs a sandbox tool
   that produces `report.png`, `summary.mp3`, or `analysis.pdf`, the only way
   to deliver it back is a URL pasted into text. Voice output is a special
   case of this gap; solving outbound media solves both.

This doc proposes a two-phase sequence:

- **Phase 1 (voice-only):** configuration, inbound STT, outbound TTS for
  `text_final`. Synthesised audio is delivered through a channel-direct
  path (Telegram `sendVoice` etc.); no protocol change to
  `ChannelOutbound.send`. Ships voice end-to-end with the smallest blast
  radius.
- **Phase 2 (general outbound media):** generalize the outbound surface
  (`ChannelOutbound.send` gains `attachments?`, `ChannelManifest` gains
  `outboundCapabilities`, sandbox-generated files become attachment refs).
  Voice output retroactively re-routes through this surface; image / PDF
  output from sandbox tools rides the same dispatch.

Phase 1 is what the rest of this doc focuses on. Phase 2 is sketched at
the end as the eventual destination.

## Non-goals

- **Talk Mode** (always-on full-duplex streaming, VAD, barge-in). That is a
  separate architectural change — different transport, different latency
  envelope, different per-channel APIs. Deferred.
- **Real-time streaming TTS.** Synthesis happens on `text_final`, not on
  `text_delta`. Adding per-delta synthesis is possible later without
  protocol changes; the first cut is one synthesis call per turn.
- **Multimodal model routing for audio/video input.** Inbound voice is
  transcribed at the channel layer and injected as text. The model sees a
  transcript, not raw audio (the audio is still attached for tools to
  inspect, but it does not go to the LLM). Sending audio bytes directly to
  multimodal models is a follow-up tracked in
  [`file-attachments-design.md`](file-attachments-design.md).
- **Synchronous TTS in the request path.** TTS may take seconds; it must
  not block the agent loop. The send pipeline already supports
  `backgroundTasks`/`sideEffects` — outbound media synthesis runs there.
- **Multi-provider chain / local-model fallbacks.** Phase 1 supports
  exactly one provider — ElevenLabs — for both STT and TTS. The internal
  interfaces leave room for a chain later, but no chain code, no
  faster-whisper bundle, no Piper. One provider, one API key, one set of
  failure modes. Add providers only when we have a concrete reason to.

## How OpenClaw and Hermes Agent solve it

Two reference points; they converged on the same shape.

- **Provider chain, not single provider.** Hermes default STT chain is
  `local-faster-whisper > Groq > OpenAI > Mistral > xAI`; TTS chain spans
  ten providers with the local Piper engine as the zero-API-key default.
  OpenClaw 2026.4.25 ships 14 TTS providers with a similar fallback chain.
  On size / timeout / auth failure the next provider runs automatically.
- **Local-first.** Both default to bundled local models (faster-whisper,
  Piper) so voice works with zero API keys. Cloud providers are the
  upgrade path, not the baseline.
- **Per-channel native rendering.** Voice notes on Telegram / WhatsApp /
  Discord / Slack / Signal are transcribed *at the channel adapter*, not at
  the gateway. Outbound, the channel decides between native voice message
  and audio-file attachment based on what the platform supports.
- **Per-agent / per-chat overrides.** OpenClaw 2026.4.25 added chat-scoped
  auto-TTS, personas, and per-agent overrides. Layered config, not a single
  global switch.

We adopt **per-channel rendering** (transcribe inbound at the channel,
synthesize outbound at the channel) and **per-agent overrides**. We do
**not** adopt the provider-chain / local-first defaults — phase 1 ships
with one provider (ElevenLabs). The interfaces below leave room to grow
into a chain later, but the runtime wiring is direct. Talk Mode is out
of scope.

## Current state

Relevant scaffolding already exists:

- **`SessionAttachment`** (`packages/protocol/src/index.ts:65`) — id-shape
  and url-passthrough, mime type, SHA, sandbox path. Already used inbound;
  the type itself is direction-agnostic.
- **Attachment materialization** —
  `AgentRunner.materializeAttachmentToSandbox`
  (`apps/agent/src/agent-runner.ts:386`) writes bytes under
  `<agentHome>/.openhermit/attachments/<sessionId>/<id>/<name>`. The reverse
  flow — register an existing sandbox file as an attachment — does not yet
  exist but the storage shape is the same.
- **Event taxonomy** — `OutboundEvent` already separates `text_final`,
  `thinking_*`, `tool_*`, `agent_start/end`
  (`packages/protocol/src/index.ts:217`). "Only TTS the final text" is
  already a subscription decision, not a parsing problem.
- **`ChannelManifest`** (`packages/protocol/src/index.ts:464`) — no
  `outboundCapabilities` field today. Channels cannot declare which
  modalities they can render.
- **`ChannelOutbound.send`** (`packages/protocol/src/index.ts:294`) —
  text-only:
  `send({ sessionId, to, text, actions })`. No `attachments` parameter.
- **`session_send`** (`apps/agent/src/tools/session.ts:257`) — text-only
  for the same reason.
- **Per-agent secret store** — already used by channel plugins for API
  keys; the natural home for `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, etc.

## Phase 1 — Design

Three subsystems, one package, no protocol change to `ChannelOutbound`:

```text
┌─────────────────────────────────────────────────────────────┐
│ packages/voice                                              │
│   • STT provider (single, per-agent)                        │
│   • TTS provider (single, per-agent)                        │
│   • per-mime codec selection (audio/ogg vs audio/mp4 …)     │
└─────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ used by                          │ used by
        │                                  │
┌───────┴────────────────┐      ┌──────────┴───────────────────┐
│ Channel adapter        │      │ Channel adapter              │
│ (inbound path)         │      │ (outbound path)              │
│  voice msg → STT → text│      │  text_final → gate → TTS →   │
│  → postMessage         │      │  channel-native voice send   │
└────────────────────────┘      └──────────────────────────────┘
```

### 1. Configuration

Per-agent. STT and TTS configured independently — one model per
direction, no arrays. Persisted via the existing `agents.config_json`
column — no new table.

```jsonc
{
  "voice": {
    "stt": {
      "provider": "elevenlabs",
      "model_id": "scribe_v1"             // optional; provider default if omitted
    },
    "tts": {
      "provider": "elevenlabs",
      "voice_id": "JBFqnCBsd6RMkjVDRZzb", // optional; ElevenLabs default voice if omitted
      "model_id": "eleven_multilingual_v2", // optional
      "speed": 1.0                         // optional
    }
  }
}
```

- **`provider`** — only `"elevenlabs"` is accepted in phase 1, for both
  STT and TTS. Validation rejects anything else with a clear error so the
  field stays a useful extension point. Configuring them separately
  reflects the eventual reality (you may want ElevenLabs for TTS quality
  but Whisper / Groq for cheap STT) — phase 1 just happens to point both
  at the same vendor.
- **`tts.voice_id`** — ElevenLabs voice catalog id. Owner-selectable so
  different agents (or the same agent across personas) can sound distinct.
- **API key** — `ELEVENLABS_API_KEY` in the agent's secret store (already
  supported by the secret resolver). One key serves both directions today.
- **CLI** mirrors the existing pattern, e.g.
  `hermit config --agent <id> set voice.tts.voice_id = JBFqnCBsd6RMkjVDRZzb`.

Each direction is independently opt-in. An agent may configure only
`voice.stt` (accept voice notes, reply in text) or only `voice.tts`
(reply by voice when triggered, ignore inbound voice). Omitting both
disables voice entirely.

**Per-session toggle.** Independent of agent config, the owner / user can
flip voice-out on or off for a specific session via a channel command
(`/voice on`, `/voice off`). Persisted on `session.metadata.voice_out`.
The TTS gate (below) reads this. Without an explicit toggle, the gate
falls back to modality mirroring (inbound voice ⇒ reply voice, inbound
text ⇒ reply text).

### 2. `packages/voice` — shared provider package

A small package exposing two interfaces and exactly one implementation of
each (ElevenLabs). The interfaces are the extension point; the runtime
just constructs the ElevenLabs adapter from agent config.

```ts
// packages/voice/src/index.ts (sketch)
export interface SttProvider {
  readonly name: string;
  transcribe(input: {
    url?: string;
    bytes?: Uint8Array;
    mimeType: string;
    languageHint?: string;
  }): Promise<{ text: string; durationMs?: number; provider: string }>;
}

export interface TtsProvider {
  readonly name: string;
  /**
   * Synthesise `text` into the requested output container. Callers
   * (channel adapters) pass the codec their platform needs for native
   * voice messages.
   */
  synthesize(input: {
    text: string;
    voiceId?: string;
    modelId?: string;
    speed?: number;
    outputMimeType: string;     // e.g. 'audio/mp3', 'audio/ogg;codecs=opus'
  }): Promise<{ bytes: Uint8Array; mimeType: string; provider: string }>;
}

export const createElevenLabsStt = (cfg: { apiKey: string }): SttProvider => /* … */;
export const createElevenLabsTts = (cfg: { apiKey: string }): TtsProvider => /* … */;

/**
 * Build the voice providers for an agent. Each direction is built
 * independently from its own `voice.stt` / `voice.tts` block; either may
 * be undefined if the agent only opted into one direction. Throws if
 * `provider` is anything other than `'elevenlabs'`, or if the required
 * API key is missing.
 */
export const createVoiceForAgent = (
  agentConfig: AgentConfig,
  secrets: SecretResolver,
): { stt?: SttProvider; tts?: TtsProvider } => /* … */;
```

The chain helper / fallback logic is **deliberately not implemented**.
When (if) we add a second provider, we add it as another constructor and
a chain combinator — the channel-adapter call sites don't change because
they only see `SttProvider` / `TtsProvider`.

ElevenLabs covers both STT (Scribe v1) and TTS, so phase 1 ships with a
single API key and a single billing surface.

### 3. Inbound STT (channel-side transcription)

Channel adapters that receive voice notes transcribe before calling
`postMessage`. The agent sees text; the original audio is still attached
so tools can re-listen if needed.

```ts
// apps/channels/telegram/src/bridge.ts (sketch)
async onVoiceMessage(msg) {
  if (!this.voice) return /* fall through to text-only behaviour */;
  const audioUrl = await this.bot.getFileLink(msg.voice.file_id);
  const result = await this.voice.stt.transcribe({
    url: audioUrl,
    mimeType: 'audio/ogg',
  });
  await agent.postMessage(sessionId, {
    text: result.text,
    attachments: [{ type: 'file', url: audioUrl, mimeType: 'audio/ogg' }],
    metadata: {
      source: 'voice_note',
      transcript_provider: result.provider,
      voice_duration_ms: result.durationMs,
    },
  });
}
```

If the agent has no `voice` config, `this.voice` is undefined and the
adapter falls through to whatever it does today (drop the message, or
surface it as an opaque attachment). Voice input is strictly opt-in.

The `source: 'voice_note'` metadata is the signal the TTS gate uses
(below) to default to voice-out reply.

### 4. Outbound TTS — when to do it

This is the design decision the user flagged. The interceptor must not
TTS every assistant turn — that would be expensive, often annoying
(spoken code blocks, multi-paragraph summaries), and miss the point of
"voice when it makes sense".

The gate runs once per `text_final`, in order. Any predicate firing
**skips** TTS for that turn:

| # | Predicate | Default |
|---|-----------|---------|
| 1 | Session has `voice_out` disabled in `session.metadata` | skip if `false` |
| 2 | The channel doesn't declare voice support in its adapter | skip |
| 3 | The triggering user message was *not* a voice note **and** the user hasn't explicitly turned voice on | skip |
| 4 | `text_final.text` is empty / whitespace only | skip |
| 5 | `text_final.text` exceeds `voice.tts.maxChars` (default 600) | skip + fall back to text |
| 6 | `text_final.text` contains a fenced code block or table | skip + fall back to text |
| 7 | `text_final.text` is a tool-affordance message (approval prompt with inline actions) | skip — the buttons are the point |

Default behaviour ("modality mirroring"): if the inbound was a voice
note, reply with voice; if the inbound was text, reply with text. The
user opts out of this by setting voice-out off, or opts in to "always
voice" via `/voice on` (which flips the predicate 3 to "always allow"
for the session).

When the gate passes:

```ts
// channel adapter, in the event subscription
on('text_final', async (evt) => {
  if (!this.voice || !gate.shouldSpeak(evt, session)) {
    return await this.sendText(evt.text);     // existing path
  }
  const cfg = this.agent.config.voice!;
  const audio = await this.voice.tts.synthesize({
    text: evt.text,
    voiceId: cfg.voice_id,
    modelId: cfg.model_id,
    speed: cfg.speed,
    outputMimeType: this.platform.preferredVoiceMime,   // 'audio/ogg;codecs=opus' on TG
  });
  await this.platform.sendVoice(to, audio.bytes);
  // Optional: also send the text for accessibility / search.
  if (session.metadata.voice_keep_text) await this.sendText(evt.text);
});
```

`text_delta` / `thinking_*` / `tool_*` are simply not subscribed to —
the event taxonomy already does the filtering for us.

### Timing — when in the event stream

TTS runs on `text_final`, not on `text_delta`:

- `text_delta` arrives token-by-token; per-delta synthesis multiplies cost
  and breaks prosody (no sentence-level context).
- `text_final` is one synthesis per turn. Latency penalty of waiting for
  the full response is acceptable for the first cut — voice replies are
  inherently slower than text and users expect a brief delay.
- Streaming TTS (sentence-level chunking on `text_delta`) is a follow-up
  optimisation tracked in open questions, not phase 1.

Synthesis runs on `session.backgroundTasks` (the same hook the central
scheduler awaits before tearing down `ephemeral` sessions, per the recent
schedule-session fix). This keeps it off the agent's blocking loop while
still letting the scheduler wait for it to complete.

### Phase-1 outbound path

No change to `ChannelOutbound.send`. The TTS interceptor lives entirely
inside the channel adapter — it has the synthesised bytes in hand and
calls the platform API directly (`bot.sendVoice` on Telegram,
`messages.send` with `audio/ogg` body on WhatsApp Business, etc.). The
adapter wires its own event subscription against the runner's outbound
event stream.

The protocol-level `attachments` field on `ChannelOutbound.send` is
deferred to phase 2.

## Phase 2 — Generalize outbound media (sketch)

Once voice ships, the same pattern wants to handle sandbox-generated
images, PDFs, and arbitrary audio. Phase 2 generalizes the outbound
surface so the channel-direct path used in phase 1 becomes the general
case:

- Extend `ChannelOutbound.send` to accept `attachments?: SessionAttachment[]`.
- Add `outboundCapabilities?: { mimeTypes: string[]; voiceMimeTypes?: string[] }`
  to `ChannelManifest` so the dispatcher knows what each channel can
  render natively.
- Add sandbox-side attachment registration (a sandbox tool, or implicit
  resolution of `{ sandboxPath }` refs inside `session_send`) so an agent
  that writes `/sandbox/report.png` can ship it through `session_send`
  with no special-casing.
- Re-route phase-1 TTS through this surface: the synthesised audio
  becomes an attachment ref, `ChannelOutbound.send` dispatches it. The
  channel-direct path remains for adapters that haven't migrated yet.

Phase 2 is not blocked by phase 1, but it's a much larger change
(protocol contract, every channel adapter, agent outbound tool surface)
and the user-visible win — voice — lands sooner if phase 1 ships first.

## Migration plan

Phase 1 is one PR per concern, ordered for early integration:

1. **`packages/voice` + config plumbing.** Provider interfaces, the
   ElevenLabs STT and TTS implementations, the agent-config schema entry
   (`voice.stt.*`, `voice.tts.*`), `createVoiceForAgent` wiring against
   the secret resolver. No channel integration yet — verified by unit
   tests against a stubbed ElevenLabs HTTP fixture.
2. **Telegram inbound STT.** Wire `voice.stt` into the Telegram adapter's
   voice-message handler. Verifies the package end-to-end on the first
   channel.
3. **Telegram outbound TTS.** Adds `voice.tts` + the gate-predicate
   evaluation + channel-direct `sendVoice`. Modality-mirroring default
   on; `/voice on/off` per-session override.
4. **Rollout to remaining channels** (WeChat, WhatsApp, Signal, Discord
   where applicable), one PR each — all reuse `packages/voice` and the
   same gate logic.

Talk Mode (full-duplex streaming) is a separate, larger initiative tracked
in [`pending-decisions.md`](pending-decisions.md) and is *not* unlocked by
this work — Talk Mode needs a different transport, different latency
profile, and per-channel duplex APIs (Telegram voice chats, WeChat
voip-style channels) we don't carry today.

## Open questions

- **Audio attachments and the LLM.** Today inbound attachments are
  materialized into the sandbox but only images are inlined to multimodal
  models. Should audio be inlined for models that accept it (Claude, GPT-4o
  audio), or always go through transcript-first? Defer; current proposal is
  transcript-first regardless, since the channel already has a transcript
  in hand from STT and inlining audio would double the prompt cost.
- **Voice cloning / personas.** OpenClaw ships persona-keyed voices. We
  could mirror via `agent.config.voice.persona`, but voice cloning has
  legal / consent surface that needs operator review before defaulting on.
  Deferred.
- **Cost accounting.** TTS bills per character; STT bills per second. The
  existing usage telemetry doesn't track audio. Adding it is a small
  schema change but worth surfacing before users discover the bill.
- **Where does `attachment_register` live?** Sandbox tool vs. a runner
  method invoked by `session_send`? Slight preference for runner method
  (`session_send({ text, attachments: [{ sandboxPath }] })` would internally
  register), to avoid adding a new tool surface the model must learn.
