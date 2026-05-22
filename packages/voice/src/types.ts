// Voice provider contracts.
//
// These interfaces are the extension point. Phase 1 ships exactly one
// implementation of each (ElevenLabs). Adding a second provider should
// only require a new constructor in this package — channel adapters and
// the runner see only these interfaces.

/** Input to a single STT call. Exactly one of `url` or `bytes` must be set. */
export interface SttInput {
  /** Fetch the audio bytes from this URL. Provider may stream directly. */
  url?: string;
  /** Inline audio bytes. */
  bytes?: Uint8Array;
  /** Mime type of the audio. e.g. `audio/ogg`, `audio/mp3`, `audio/mp4`. */
  mimeType: string;
  /**
   * Optional BCP-47 language hint (e.g. `en`, `zh`). Providers that
   * support language detection should treat this as advisory.
   */
  languageHint?: string;
}

export interface SttResult {
  text: string;
  /** Duration of the input audio in milliseconds, if the provider reports it. */
  durationMs?: number;
  /** Name of the provider that produced this result, for telemetry. */
  provider: string;
}

export interface SttProvider {
  readonly name: string;
  transcribe(input: SttInput): Promise<SttResult>;
}

export interface TtsInput {
  text: string;
  /** Provider-specific voice id. Optional — provider falls back to a default. */
  voiceId?: string;
  /** Provider-specific model id (e.g. ElevenLabs `eleven_multilingual_v2`). */
  modelId?: string;
  /** Playback rate multiplier; 1.0 is natural. */
  speed?: number;
  /**
   * Container/codec the caller wants. Providers that cannot produce the
   * requested container throw `VoiceUnsupportedFormatError`. Channel
   * adapters know what their platform needs (audio/ogg;codecs=opus for
   * Telegram voice messages, audio/mp4 for iMessage, etc.).
   */
  outputMimeType: string;
}

export interface TtsResult {
  bytes: Uint8Array;
  /** Echoed back so callers know which mime they actually got. */
  mimeType: string;
  provider: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(input: TtsInput): Promise<TtsResult>;
}

// ── Agent-level config shape ──────────────────────────────────────────
//
// These are the JSON-serialisable types that live under `agents.config_json`
// at `voice.stt` / `voice.tts`. Lifted here (rather than in apps/agent) so
// that callers in packages/* can reference them without depending on agent
// internals.

export type VoiceProviderName = 'elevenlabs';

export interface SttConfig {
  /** Phase 1: must be `'elevenlabs'`. */
  provider: VoiceProviderName;
  /** Provider-specific model identifier (e.g. ElevenLabs `scribe_v1`). */
  model_id?: string;
}

export interface TtsConfig {
  /** Phase 1: must be `'elevenlabs'`. */
  provider: VoiceProviderName;
  /** Voice catalog id from the provider (ElevenLabs returns these from /v1/voices). */
  voice_id?: string;
  /** Provider-specific model identifier (e.g. ElevenLabs `eleven_multilingual_v2`). */
  model_id?: string;
  /** Playback rate multiplier; defaults to 1.0 on the provider side. */
  speed?: number;
}

export interface VoiceConfig {
  stt?: SttConfig;
  tts?: TtsConfig;
}
