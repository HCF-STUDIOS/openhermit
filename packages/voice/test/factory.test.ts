import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidationError } from '@openhermit/shared';

import {
  createVoiceForAgent,
  VoiceAuthError,
  type VoiceSecretResolver,
} from '../src/index.js';

const makeResolver = (secrets: Record<string, string>): VoiceSecretResolver => ({
  get: (name: string) => secrets[name],
});

test('createVoiceForAgent returns empty object when config is undefined', () => {
  const v = createVoiceForAgent(undefined, makeResolver({}));
  assert.deepEqual(v, {});
});

test('createVoiceForAgent returns empty object when config has no stt/tts', () => {
  const v = createVoiceForAgent({}, makeResolver({}));
  assert.deepEqual(v, {});
});

test('createVoiceForAgent builds only stt when only stt is configured', () => {
  const v = createVoiceForAgent(
    { stt: { provider: 'elevenlabs' } },
    makeResolver({ ELEVENLABS_API_KEY: 'sk-1' }),
  );
  assert.ok(v.stt);
  assert.equal(v.tts, undefined);
  assert.equal(v.stt!.name, 'elevenlabs');
});

test('createVoiceForAgent builds only tts when only tts is configured', () => {
  const v = createVoiceForAgent(
    { tts: { provider: 'elevenlabs', voice_id: 'rachel' } },
    makeResolver({ ELEVENLABS_API_KEY: 'sk-1' }),
  );
  assert.ok(v.tts);
  assert.equal(v.stt, undefined);
  assert.equal(v.tts!.name, 'elevenlabs');
});

test('createVoiceForAgent builds both directions independently', () => {
  const v = createVoiceForAgent(
    { stt: { provider: 'elevenlabs' }, tts: { provider: 'elevenlabs' } },
    makeResolver({ ELEVENLABS_API_KEY: 'sk-1' }),
  );
  assert.ok(v.stt);
  assert.ok(v.tts);
});

test('createVoiceForAgent throws VoiceAuthError when API key is missing', () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.throws(
      () =>
        createVoiceForAgent(
          { stt: { provider: 'elevenlabs' } },
          makeResolver({}),
        ),
      VoiceAuthError,
    );
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
  }
});

test('createVoiceForAgent throws ValidationError for unknown provider', () => {
  assert.throws(
    () =>
      createVoiceForAgent(
        // @ts-expect-error: provider intentionally invalid to test runtime guard
        { stt: { provider: 'whisper' } },
        makeResolver({ ELEVENLABS_API_KEY: 'sk-1' }),
      ),
    ValidationError,
  );
});

test('createVoiceForAgent treats resolver throw as missing secret (no env fallback)', () => {
  const resolver: VoiceSecretResolver = {
    get: () => {
      throw new Error('vault down');
    },
  };
  const prev = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.throws(
      () =>
        createVoiceForAgent(
          { tts: { provider: 'elevenlabs' } },
          resolver,
        ),
      VoiceAuthError,
    );
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
  }
});

test('createVoiceForAgent falls back to process.env.ELEVENLABS_API_KEY when per-agent secret is missing', () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'env-key-xyz';
  try {
    const v = createVoiceForAgent(
      { tts: { provider: 'elevenlabs' } },
      makeResolver({}),
    );
    assert.ok(v.tts, 'tts provider should be built using the env-var key');
    assert.equal(v.tts!.name, 'elevenlabs');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  }
});

test('createVoiceForAgent prefers per-agent secret over process.env', () => {
  // Smoke check — we can't directly observe which key reached the
  // adapter from outside, but if the per-agent value is set, the build
  // must still succeed. The env fallback is gated on `?? process.env[...]`,
  // so this just exercises the happy path of the first branch.
  const prev = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'env-key';
  try {
    const v = createVoiceForAgent(
      { stt: { provider: 'elevenlabs' } },
      makeResolver({ ELEVENLABS_API_KEY: 'agent-key' }),
    );
    assert.ok(v.stt);
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  }
});
