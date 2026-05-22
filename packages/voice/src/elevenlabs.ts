// ElevenLabs voice provider adapter.
//
// Wraps the ElevenLabs HTTP API for both Speech-to-Text (Scribe) and
// Text-to-Speech. Maps the provider's error shapes onto the voice
// package's normalised error taxonomy so channel-side callers do not
// need to peek at HTTP status codes.

import {
  VoiceAuthError,
  VoiceTransportError,
  VoiceUnsupportedFormatError,
  VoiceValidationError,
} from './errors.js';
import type {
  SttInput,
  SttProvider,
  SttResult,
  TtsInput,
  TtsProvider,
  TtsResult,
} from './types.js';

const PROVIDER_NAME = 'elevenlabs';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_STT_MODEL = 'scribe_v1';
const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';
// ElevenLabs's long-standing sample voice ("Rachel"). Used only when an
// agent has configured TTS but supplied no voice_id and the synthesize()
// caller also did not pass one — i.e., "make it work out of the box".
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export interface ElevenLabsClientOptions {
  apiKey: string;
  /** Override for self-hosted / proxied endpoints. Trailing slash optional. */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Per-request timeout in milliseconds. A hung ElevenLabs request would
   * otherwise block whichever channel/runner awaits it indefinitely.
   */
  timeoutMs?: number;
}

interface InternalOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const normalize = (opts: ElevenLabsClientOptions): InternalOptions => {
  if (!opts.apiKey) {
    throw new VoiceAuthError('elevenlabs: apiKey is required');
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    apiKey: opts.apiKey,
    baseUrl,
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
};

const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  context: string,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...(init ?? {}), signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new VoiceTransportError(
        `elevenlabs ${context}: request exceeded ${timeoutMs}ms timeout`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const mimeToOutputFormat = (mimeType: string): string => {
  // ElevenLabs's `output_format` query param uses its own naming.
  // We map the standard mime/codec string each channel will request.
  const m = mimeType.toLowerCase().split(';')[0]!.trim();
  switch (m) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3_44100_128';
    case 'audio/ogg':
    case 'audio/opus':
      return 'opus_48000_128';
    case 'audio/pcm':
    case 'audio/l16':
      return 'pcm_24000';
    case 'audio/basic':
    case 'audio/ulaw':
      return 'ulaw_8000';
    default:
      throw new VoiceUnsupportedFormatError(
        `elevenlabs: output mime type "${mimeType}" is not supported`,
      );
  }
};

const outputFormatToMime = (format: string): string => {
  if (format.startsWith('mp3_')) return 'audio/mpeg';
  if (format.startsWith('opus_')) return 'audio/ogg;codecs=opus';
  if (format.startsWith('pcm_')) return 'audio/pcm';
  if (format.startsWith('ulaw_')) return 'audio/basic';
  return 'application/octet-stream';
};

const fetchAudioBytes = async (
  url: string,
  opts: InternalOptions,
): Promise<Uint8Array> => {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      opts.fetchImpl,
      url,
      undefined,
      opts.timeoutMs,
      'audio fetch',
    );
  } catch (err) {
    if (err instanceof VoiceTransportError) throw err;
    throw new VoiceTransportError(
      `elevenlabs: failed to fetch audio from URL — ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new VoiceTransportError(
      `elevenlabs: source URL returned HTTP ${res.status}`,
    );
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
};

const throwForResponse = async (
  res: Response,
  context: string,
): Promise<never> => {
  const body = await res.text().catch(() => '');
  const detail = body ? `: ${body.slice(0, 500)}` : '';
  if (res.status === 401 || res.status === 403) {
    throw new VoiceAuthError(`elevenlabs ${context} auth failed (${res.status})${detail}`);
  }
  if (res.status >= 400 && res.status < 500) {
    throw new VoiceValidationError(
      `elevenlabs ${context} rejected request (${res.status})${detail}`,
    );
  }
  throw new VoiceTransportError(
    `elevenlabs ${context} returned HTTP ${res.status}${detail}`,
  );
};

// ── STT (Scribe) ──────────────────────────────────────────────────────

export interface ElevenLabsSttOptions extends ElevenLabsClientOptions {
  /**
   * Per-agent default model id (from `voice.stt.model_id`). Used when the
   * caller doesn't override on a specific transcribe() call.
   */
  defaultModelId?: string;
}

export const createElevenLabsStt = (
  options: ElevenLabsSttOptions,
): SttProvider => {
  const opts = normalize(options);
  const defaultModelId = options.defaultModelId ?? DEFAULT_STT_MODEL;

  const transcribe = async (input: SttInput): Promise<SttResult> => {
    if (!input.url && !input.bytes) {
      throw new VoiceValidationError('elevenlabs.stt: input requires url or bytes');
    }
    const audioBytes = input.bytes
      ? input.bytes
      : await fetchAudioBytes(input.url!, opts);

    const form = new FormData();
    form.set(
      'file',
      new Blob([audioBytes as BlobPart], { type: input.mimeType }),
      'audio',
    );
    form.set('model_id', defaultModelId);
    if (input.languageHint) {
      form.set('language_code', input.languageHint);
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(
        opts.fetchImpl,
        `${opts.baseUrl}/v1/speech-to-text`,
        {
          method: 'POST',
          headers: { 'xi-api-key': opts.apiKey },
          body: form,
        },
        opts.timeoutMs,
        'stt',
      );
    } catch (err) {
      if (err instanceof VoiceTransportError) throw err;
      throw new VoiceTransportError(
        `elevenlabs.stt: transport failure — ${(err as Error).message}`,
      );
    }

    if (!res.ok) await throwForResponse(res, 'stt');

    const body = (await res.json()) as {
      text?: unknown;
      duration?: unknown;
      duration_ms?: unknown;
    };
    if (typeof body.text !== 'string') {
      throw new VoiceTransportError(
        'elevenlabs.stt: response missing `text` field',
      );
    }

    let durationMs: number | undefined;
    if (typeof body.duration_ms === 'number') {
      durationMs = body.duration_ms;
    } else if (typeof body.duration === 'number') {
      durationMs = Math.round(body.duration * 1000);
    }

    const result: SttResult = { text: body.text, provider: PROVIDER_NAME };
    if (durationMs !== undefined) result.durationMs = durationMs;
    return result;
  };

  return { name: PROVIDER_NAME, transcribe };
};

// ── TTS ───────────────────────────────────────────────────────────────

export interface ElevenLabsTtsOptions extends ElevenLabsClientOptions {
  /** Per-agent default voice id (from `voice.tts.voice_id`). */
  defaultVoiceId?: string;
  /** Per-agent default model id (from `voice.tts.model_id`). */
  defaultModelId?: string;
  /** Per-agent default playback speed (from `voice.tts.speed`). */
  defaultSpeed?: number;
}

export const createElevenLabsTts = (
  options: ElevenLabsTtsOptions,
): TtsProvider => {
  const opts = normalize(options);
  const defaultVoiceId = options.defaultVoiceId ?? DEFAULT_VOICE_ID;
  const defaultModelId = options.defaultModelId ?? DEFAULT_TTS_MODEL;
  const defaultSpeed = options.defaultSpeed;

  const synthesize = async (input: TtsInput): Promise<TtsResult> => {
    if (!input.text.trim()) {
      throw new VoiceValidationError('elevenlabs.tts: text must not be empty');
    }
    const outputFormat = mimeToOutputFormat(input.outputMimeType);
    const voiceId = input.voiceId ?? defaultVoiceId;
    const modelId = input.modelId ?? defaultModelId;
    const speed = input.speed ?? defaultSpeed;

    const body: Record<string, unknown> = { text: input.text, model_id: modelId };
    if (typeof speed === 'number') {
      body.voice_settings = { speed };
    }

    const url =
      `${opts.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
      `?output_format=${encodeURIComponent(outputFormat)}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        opts.fetchImpl,
        url,
        {
          method: 'POST',
          headers: {
            'xi-api-key': opts.apiKey,
            'Content-Type': 'application/json',
            Accept: outputFormatToMime(outputFormat),
          },
          body: JSON.stringify(body),
        },
        opts.timeoutMs,
        'tts',
      );
    } catch (err) {
      if (err instanceof VoiceTransportError) throw err;
      throw new VoiceTransportError(
        `elevenlabs.tts: transport failure — ${(err as Error).message}`,
      );
    }

    if (!res.ok) await throwForResponse(res, 'tts');

    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mimeType: outputFormatToMime(outputFormat),
      provider: PROVIDER_NAME,
    };
  };

  return { name: PROVIDER_NAME, synthesize };
};
