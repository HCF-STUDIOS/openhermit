// Bridge between AgentRunner's per-agent security/config and the
// generic VoiceProvider contracts from @openhermit/voice.
//
// Voice providers are built on-demand rather than at boot: the agent's
// config and secrets can change at runtime, and most agents won't
// exercise voice at all, so caching saved instances would just leak
// state across config edits.

import {
  createVoiceForAgent,
  type VoiceForAgent,
  type VoiceSecretResolver,
} from '@openhermit/voice';

import type { AgentSecurity } from './core/index.js';

/**
 * Build the {stt?, tts?} pair for an agent from its persisted config and
 * secret store. Returns `{}` when the agent has no `voice` block.
 *
 * The resolver wraps `security.resolveSecrets`, which throws when a
 * secret is missing — the factory catches that and falls back to
 * `process.env[name]` so a host-wide ELEVENLABS_API_KEY works even when
 * the per-agent secret is not set.
 */
export const buildVoiceForAgent = async (
  security: AgentSecurity,
): Promise<VoiceForAgent> => {
  const config = await security.readConfig();
  const resolver: VoiceSecretResolver = {
    get(name: string): string | undefined {
      try {
        return security.resolveSecrets([name])[name];
      } catch {
        return undefined;
      }
    },
  };
  return createVoiceForAgent(config.voice, resolver);
};
