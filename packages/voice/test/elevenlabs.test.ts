import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createElevenLabsStt,
  createElevenLabsTts,
  VoiceAuthError,
  VoiceTransportError,
  VoiceUnsupportedFormatError,
  VoiceValidationError,
} from '../src/index.js';

type FetchCall = { url: string; init: RequestInit | undefined };

interface StubFetchOptions {
  response: Response | (() => Response | Promise<Response>);
  throws?: Error;
}

const makeFetchStub = (opts: StubFetchOptions): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} => {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (opts.throws) throw opts.throws;
    if (typeof opts.response === 'function') {
      return await opts.response();
    }
    return opts.response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ── STT ──────────────────────────────────────────────────────────────

test('createElevenLabsStt: posts inline bytes and returns transcription', async () => {
  const { fetchImpl, calls } = makeFetchStub({
    response: jsonResponse(200, { text: 'hello world', duration: 1.5 }),
  });

  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  const result = await stt.transcribe({
    bytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'audio/ogg',
    languageHint: 'en',
  });

  assert.equal(result.text, 'hello world');
  assert.equal(result.durationMs, 1500);
  assert.equal(result.provider, 'elevenlabs');

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/speech-to-text$/);
  const init = calls[0]!.init!;
  assert.equal(init.method, 'POST');
  assert.equal(
    (init.headers as Record<string, string>)['xi-api-key'],
    'sk-test',
  );
  assert.ok(init.body instanceof FormData);
  const form = init.body as FormData;
  assert.equal(form.get('model_id'), 'scribe_v1');
  assert.equal(form.get('language_code'), 'en');
  assert.ok(form.get('file') instanceof Blob);
});

test('createElevenLabsStt: prefers duration_ms when both fields present', async () => {
  const { fetchImpl } = makeFetchStub({
    response: jsonResponse(200, { text: 'hi', duration: 1.0, duration_ms: 2222 }),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  const result = await stt.transcribe({
    bytes: new Uint8Array([0]),
    mimeType: 'audio/mpeg',
  });
  assert.equal(result.durationMs, 2222);
});

test('createElevenLabsStt: omits durationMs when provider reports neither field', async () => {
  const { fetchImpl } = makeFetchStub({
    response: jsonResponse(200, { text: 'hi' }),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  const result = await stt.transcribe({
    bytes: new Uint8Array([0]),
    mimeType: 'audio/mpeg',
  });
  assert.equal(result.durationMs, undefined);
  assert.ok(!('durationMs' in result && result.durationMs === undefined));
});

test('createElevenLabsStt: fetches audio bytes when input has only url', async () => {
  let urlIndex = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    urlIndex += 1;
    const u = String(url);
    if (u === 'https://example.com/clip.ogg') {
      return new Response(new Uint8Array([7, 7, 7]), { status: 200 });
    }
    return jsonResponse(200, { text: 'fetched-and-transcribed' });
  }) as unknown as typeof fetch;

  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  const result = await stt.transcribe({
    url: 'https://example.com/clip.ogg',
    mimeType: 'audio/ogg',
  });
  assert.equal(result.text, 'fetched-and-transcribed');
  assert.equal(urlIndex, 2);
});

test('createElevenLabsStt: maps 401 to VoiceAuthError', async () => {
  const { fetchImpl } = makeFetchStub({
    response: new Response('bad key', { status: 401 }),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => stt.transcribe({ bytes: new Uint8Array([0]), mimeType: 'audio/mpeg' }),
    VoiceAuthError,
  );
});

test('createElevenLabsStt: maps 400 to VoiceValidationError', async () => {
  const { fetchImpl } = makeFetchStub({
    response: new Response('bad request', { status: 400 }),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => stt.transcribe({ bytes: new Uint8Array([0]), mimeType: 'audio/mpeg' }),
    VoiceValidationError,
  );
});

test('createElevenLabsStt: maps 500 to VoiceTransportError', async () => {
  const { fetchImpl } = makeFetchStub({
    response: new Response('boom', { status: 502 }),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => stt.transcribe({ bytes: new Uint8Array([0]), mimeType: 'audio/mpeg' }),
    VoiceTransportError,
  );
});

test('createElevenLabsStt: maps network throw to VoiceTransportError', async () => {
  const { fetchImpl } = makeFetchStub({
    response: jsonResponse(200, { text: '' }),
    throws: new TypeError('fetch failed'),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => stt.transcribe({ bytes: new Uint8Array([0]), mimeType: 'audio/mpeg' }),
    VoiceTransportError,
  );
});

test('createElevenLabsStt: rejects when neither url nor bytes provided', async () => {
  const { fetchImpl } = makeFetchStub({
    response: jsonResponse(200, { text: '' }),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => stt.transcribe({ mimeType: 'audio/mpeg' }),
    VoiceValidationError,
  );
});

test('createElevenLabsStt: rejects when response body lacks text field', async () => {
  const { fetchImpl } = makeFetchStub({
    response: jsonResponse(200, { duration: 1 }),
  });
  const stt = createElevenLabsStt({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => stt.transcribe({ bytes: new Uint8Array([0]), mimeType: 'audio/mpeg' }),
    VoiceTransportError,
  );
});

test('createElevenLabsStt: requires apiKey', () => {
  assert.throws(
    () => createElevenLabsStt({ apiKey: '' }),
    VoiceAuthError,
  );
});

// ── TTS ──────────────────────────────────────────────────────────────

test('createElevenLabsTts: posts JSON body and returns synthesized bytes', async () => {
  const audio = new Uint8Array([0xff, 0xfb, 0x90]);
  const { fetchImpl, calls } = makeFetchStub({
    response: new Response(audio, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }),
  });

  const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl });
  const result = await tts.synthesize({
    text: 'Hello',
    outputMimeType: 'audio/mpeg',
    voiceId: 'voice-X',
    speed: 1.1,
  });

  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.provider, 'elevenlabs');
  assert.deepEqual(Array.from(result.bytes), Array.from(audio));

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/text-to-speech\/voice-X\?output_format=mp3_44100_128$/);
  const init = calls[0]!.init!;
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['xi-api-key'], 'sk-test');
  assert.equal(headers['Content-Type'], 'application/json');
  const body = JSON.parse(init.body as string) as {
    text: string;
    model_id: string;
    voice_settings?: { speed: number };
  };
  assert.equal(body.text, 'Hello');
  assert.equal(body.model_id, 'eleven_multilingual_v2');
  assert.deepEqual(body.voice_settings, { speed: 1.1 });
});

test('createElevenLabsTts: maps mime types to output_format query param', async () => {
  const cases = [
    { mime: 'audio/mpeg', expect: 'mp3_44100_128' },
    { mime: 'audio/ogg', expect: 'opus_48000_128' },
    { mime: 'audio/pcm', expect: 'pcm_24000' },
    { mime: 'audio/ulaw', expect: 'ulaw_8000' },
  ];

  for (const c of cases) {
    const { fetchImpl, calls } = makeFetchStub({
      response: new Response(new Uint8Array([0]), { status: 200 }),
    });
    const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl });
    await tts.synthesize({ text: 'x', outputMimeType: c.mime });
    assert.match(
      calls[0]!.url,
      new RegExp(`output_format=${c.expect}$`),
      `mime ${c.mime} should map to ${c.expect}`,
    );
  }
});

test('createElevenLabsTts: rejects unsupported output mime', async () => {
  const { fetchImpl } = makeFetchStub({
    response: new Response(new Uint8Array([0]), { status: 200 }),
  });
  const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => tts.synthesize({ text: 'x', outputMimeType: 'audio/exotic' }),
    VoiceUnsupportedFormatError,
  );
});

test('createElevenLabsTts: rejects empty text', async () => {
  const { fetchImpl } = makeFetchStub({
    response: new Response(new Uint8Array([0]), { status: 200 }),
  });
  const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => tts.synthesize({ text: '   ', outputMimeType: 'audio/mpeg' }),
    VoiceValidationError,
  );
});

test('createElevenLabsTts: maps 403 to VoiceAuthError', async () => {
  const { fetchImpl } = makeFetchStub({
    response: new Response('nope', { status: 403 }),
  });
  const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => tts.synthesize({ text: 'hi', outputMimeType: 'audio/mpeg' }),
    VoiceAuthError,
  );
});

test('createElevenLabsTts: maps network throw to VoiceTransportError', async () => {
  const { fetchImpl } = makeFetchStub({
    response: new Response(new Uint8Array([0]), { status: 200 }),
    throws: new TypeError('econnreset'),
  });
  const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => tts.synthesize({ text: 'hi', outputMimeType: 'audio/mpeg' }),
    VoiceTransportError,
  );
});

test('createElevenLabsTts: falls back to default voice and model when not specified', async () => {
  const { fetchImpl, calls } = makeFetchStub({
    response: new Response(new Uint8Array([0]), { status: 200 }),
  });
  const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl });
  await tts.synthesize({ text: 'hi', outputMimeType: 'audio/mpeg' });
  // The default Rachel voice id from the adapter is embedded in the URL.
  assert.match(calls[0]!.url, /\/v1\/text-to-speech\/21m00Tcm4TlvDq8ikWAM\?/);
  const body = JSON.parse(calls[0]!.init!.body as string) as { model_id: string };
  assert.equal(body.model_id, 'eleven_multilingual_v2');
});

test('createElevenLabsTts: respects baseUrl override and trims trailing slashes', async () => {
  const { fetchImpl, calls } = makeFetchStub({
    response: new Response(new Uint8Array([0]), { status: 200 }),
  });
  const tts = createElevenLabsTts({
    apiKey: 'sk-test',
    baseUrl: 'https://proxy.internal//',
    fetchImpl,
  });
  await tts.synthesize({ text: 'hi', outputMimeType: 'audio/mpeg' });
  assert.match(calls[0]!.url, /^https:\/\/proxy\.internal\/v1\/text-to-speech\//);
});

// ── per-agent defaults forwarding ─────────────────────────────────────

test('createElevenLabsTts: uses defaultVoiceId / defaultModelId / defaultSpeed when caller omits them', async () => {
  const { fetchImpl, calls } = makeFetchStub({
    response: new Response(new Uint8Array([0]), { status: 200 }),
  });
  const tts = createElevenLabsTts({
    apiKey: 'sk-test',
    fetchImpl,
    defaultVoiceId: 'agent-voice',
    defaultModelId: 'agent-model',
    defaultSpeed: 0.9,
  });
  await tts.synthesize({ text: 'hi', outputMimeType: 'audio/mpeg' });
  assert.match(calls[0]!.url, /\/v1\/text-to-speech\/agent-voice\?/);
  const body = JSON.parse(calls[0]!.init!.body as string) as {
    model_id: string;
    voice_settings?: { speed: number };
  };
  assert.equal(body.model_id, 'agent-model');
  assert.deepEqual(body.voice_settings, { speed: 0.9 });
});

test('createElevenLabsTts: per-call input still overrides per-agent defaults', async () => {
  const { fetchImpl, calls } = makeFetchStub({
    response: new Response(new Uint8Array([0]), { status: 200 }),
  });
  const tts = createElevenLabsTts({
    apiKey: 'sk-test',
    fetchImpl,
    defaultVoiceId: 'agent-voice',
    defaultSpeed: 0.9,
  });
  await tts.synthesize({
    text: 'hi',
    outputMimeType: 'audio/mpeg',
    voiceId: 'call-voice',
    speed: 1.5,
  });
  assert.match(calls[0]!.url, /\/v1\/text-to-speech\/call-voice\?/);
  const body = JSON.parse(calls[0]!.init!.body as string) as {
    voice_settings?: { speed: number };
  };
  assert.deepEqual(body.voice_settings, { speed: 1.5 });
});

test('createElevenLabsStt: uses defaultModelId from per-agent config', async () => {
  const { fetchImpl, calls } = makeFetchStub({
    response: jsonResponse(200, { text: 'ok' }),
  });
  const stt = createElevenLabsStt({
    apiKey: 'sk-test',
    fetchImpl,
    defaultModelId: 'scribe_custom',
  });
  await stt.transcribe({ bytes: new Uint8Array([0]), mimeType: 'audio/mpeg' });
  const form = calls[0]!.init!.body as FormData;
  assert.equal(form.get('model_id'), 'scribe_custom');
});

// ── timeout ───────────────────────────────────────────────────────────

test('fetchWithTimeout aborts hung requests and surfaces VoiceTransportError', async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    // Simulate a server that never responds — resolve only when the caller
    // aborts the request via the AbortSignal the adapter passes in.
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  }) as unknown as typeof fetch;

  const tts = createElevenLabsTts({ apiKey: 'sk-test', fetchImpl, timeoutMs: 25 });
  await assert.rejects(
    () => tts.synthesize({ text: 'hi', outputMimeType: 'audio/mpeg' }),
    (err: Error) =>
      err instanceof VoiceTransportError && /timeout/i.test(err.message),
  );
});
