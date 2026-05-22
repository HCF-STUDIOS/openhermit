export * from './types.js';
export * from './errors.js';
export {
  createElevenLabsStt,
  createElevenLabsTts,
  type ElevenLabsClientOptions,
  type ElevenLabsSttOptions,
  type ElevenLabsTtsOptions,
} from './elevenlabs.js';
export {
  createVoiceForAgent,
  type VoiceForAgent,
  type VoiceSecretResolver,
} from './factory.js';
