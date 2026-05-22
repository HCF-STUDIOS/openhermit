// Build the per-agent voice providers from a `voice` config block.
//
// Stays decoupled from the runner / security types: callers pass a thin
// SecretResolver shim that maps a name to its value. Phase 1 wires this
// against `AgentSecurity.resolveSecrets`, but the package itself depends
// only on the contract below.

import { ValidationError } from '@openhermit/shared';

import { createElevenLabsStt, createElevenLabsTts } from './elevenlabs.js';
import { VoiceAuthError } from './errors.js';
import type {
  SttConfig,
  SttProvider,
  TtsConfig,
  TtsProvider,
  VoiceConfig,
} from './types.js';

export interface VoiceSecretResolver {
  /**
   * Return the plaintext value of a secret, or undefined when not set.
   * Implementations may also throw on lookup failure — the factory
   * handles both shapes.
   */
  get(name: string): string | undefined;
}

export interface VoiceForAgent {
  stt?: SttProvider;
  tts?: TtsProvider;
}

const ELEVENLABS_KEY_NAME = 'ELEVENLABS_API_KEY';

const safeGet = (resolver: VoiceSecretResolver, name: string): string | undefined => {
  try {
    return resolver.get(name);
  } catch {
    return undefined;
  }
};

const requireKey = (
  resolver: VoiceSecretResolver,
  name: string,
  direction: 'stt' | 'tts',
): string => {
  const value = safeGet(resolver, name);
  if (!value) {
    throw new VoiceAuthError(
      `voice.${direction}: secret ${name} is not set on this agent`,
    );
  }
  return value;
};

const buildStt = (
  cfg: SttConfig,
  resolver: VoiceSecretResolver,
): SttProvider => {
  if (cfg.provider !== 'elevenlabs') {
    throw new ValidationError(
      `voice.stt.provider: only "elevenlabs" is supported in this build (got "${cfg.provider}")`,
    );
  }
  return createElevenLabsStt({
    apiKey: requireKey(resolver, ELEVENLABS_KEY_NAME, 'stt'),
  });
};

const buildTts = (
  cfg: TtsConfig,
  resolver: VoiceSecretResolver,
): TtsProvider => {
  if (cfg.provider !== 'elevenlabs') {
    throw new ValidationError(
      `voice.tts.provider: only "elevenlabs" is supported in this build (got "${cfg.provider}")`,
    );
  }
  return createElevenLabsTts({
    apiKey: requireKey(resolver, ELEVENLABS_KEY_NAME, 'tts'),
  });
};

/**
 * Build the {stt?, tts?} pair for an agent. Each direction is built
 * independently — an agent that opts into only one direction gets only
 * that provider.
 *
 * Returns an empty object (`{}`) when the agent has no `voice` block;
 * callers treat that as "voice disabled". Throws when the config is
 * present but invalid (unknown provider, missing API key).
 */
export const createVoiceForAgent = (
  config: VoiceConfig | undefined,
  resolver: VoiceSecretResolver,
): VoiceForAgent => {
  if (!config) return {};
  const out: VoiceForAgent = {};
  if (config.stt) out.stt = buildStt(config.stt, resolver);
  if (config.tts) out.tts = buildTts(config.tts, resolver);
  return out;
};
