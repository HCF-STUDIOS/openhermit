import { getModel, type Model } from '@mariozechner/pi-ai';

import { ValidationError } from '@openhermit/shared';

import type { AgentConfig } from '../core/index.js';

const SECRET_NAME_CANDIDATES: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  zai: ['ZAI_API_KEY'],
  exa: ['EXA_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
};

export const createProviderSecretCandidates = (provider: string): string[] => {
  const configured = SECRET_NAME_CANDIDATES[provider];

  if (configured) {
    return configured;
  }

  return [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`];
};

export const formatMissingApiKeyMessage = (
  provider: string,
  secretsFilePath: string,
): string => {
  const candidateNames = createProviderSecretCandidates(provider);

  return [
    `Missing API key for provider "${provider}".`,
    `Add one of [${candidateNames.join(', ')}] to ${secretsFilePath}, or export it in the environment before starting the agent.`,
  ].join(' ');
};

const OPENAI_COMPATIBLE_PROVIDERS: Record<string, { api: string; baseUrl: string }> = {
  openrouter: { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' },
};

const minimaxM3 = (provider: string, baseUrl: string): Model<any> => ({
  id: 'MiniMax-M3',
  name: 'MiniMax-M3',
  api: 'anthropic-messages',
  provider,
  baseUrl,
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0.375 },
  contextWindow: 512000,
  maxTokens: 128000,
} as Model<any>);

const LOCAL_MODELS: Record<string, Model<any>> = {
  'minimax/MiniMax-M3': minimaxM3('minimax', 'https://api.minimax.io/anthropic'),
  'minimax-cn/MiniMax-M3': minimaxM3('minimax-cn', 'https://api.minimaxi.com/anthropic'),
};

// Local Model entries for a provider for surfacing in the
// picker catalog.
export const listLocalModels = (provider: string): Model<any>[] =>
  Object.values(LOCAL_MODELS).filter((m) => m.provider === provider);

/**
 * Try to fetch a Model entry from pi-ai's built-in registry (or our local
 * overrides). Returns undefined when the (provider, model id) pair is not
 * registered.
 *
 * pi-ai's registry carries authoritative `reasoning`, `compat`, and
 * other capability flags. We always prefer registry values over guesses
 * so that thinking-only models (deepseek-v4-pro, o1, etc.) are flagged
 * correctly even when the agent config provides an explicit base_url.
 */
const tryRegistry = (provider: string, modelId: string): Model<any> | undefined => {
  const local = LOCAL_MODELS[`${provider}/${modelId}`];
  if (local) return local;
  try {
    return getModel(provider as never, modelId as never) as Model<any>;
  } catch {
    return undefined;
  }
};

export const resolveModel = (config: AgentConfig): Model<any> => {
  const providerDefaults = OPENAI_COMPATIBLE_PROVIDERS[config.model.provider];
  const api = config.model.api ?? providerDefaults?.api;
  const baseUrl = config.model.base_url ?? providerDefaults?.baseUrl;

  // 1) Registry first. If pi-ai knows this (provider, modelId), trust its
  //    capability flags (reasoning, compat, etc.). Apply user overrides for
  //    base_url / api / max_tokens on top.
  const registry = tryRegistry(config.model.provider, config.model.model);
  if (registry) {
    return {
      ...registry,
      ...(config.model.base_url ? { baseUrl: config.model.base_url } : {}),
      ...(config.model.api ? { api: config.model.api } : {}),
      ...(config.model.max_tokens !== undefined ? { maxTokens: config.model.max_tokens } : {}),
    } as Model<any>;
  }

  // 2) Custom OpenAI-compatible endpoint. The registry doesn't know this
  //    model, so we synthesize a Model. We have no authoritative reasoning
  //    flag here, so derive it from the user's `thinking` level (anything
  //    other than off / unset implies reasoning capability).
  if (api && baseUrl) {
    return {
      id: config.model.model,
      name: config.model.model,
      api,
      provider: config.model.provider,
      baseUrl,
      reasoning: (config.model.thinking ?? 'off') !== 'off',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: config.model.max_tokens,
    } as Model<any>;
  }

  throw new ValidationError(
    `Unsupported model configuration: ${config.model.provider}/${config.model.model}`,
  );
};
