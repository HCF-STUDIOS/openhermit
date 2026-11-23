import type { Model } from '@earendil-works/pi-ai';
import { getBuiltinModel, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';

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

const OPENAI_COMPATIBLE_PROVIDERS: Record<
  string,
  { api: string; baseUrl: () => string; priceCatalog?: string }
> = {
  openrouter: { api: 'openai-completions', baseUrl: () => 'https://openrouter.ai/api/v1' },
  // Amiko router — OpenAI-compatible gateway whose default catalogue proxies
  // OpenRouter, so model ids (and list prices) are OpenRouter's. priceCatalog
  // tells resolveModel which registry to borrow pricing/capabilities from
  // when synthesizing a Model for it. AMIKO_BASE_URL must be honored here
  // exactly as in model-catalog.ts, or the picker would list models from one
  // host while completions go to another.
  amiko: {
    api: 'openai-completions',
    baseUrl: () => process.env.AMIKO_BASE_URL ?? 'https://api.heyamiko.com/api/v1',
    priceCatalog: 'openrouter',
  },
};

// DeepSeek's whole Flash tier is served by the multimodal V4.1-Flash: the
// canonical `deepseek-flash`, the `deepseek-v4.1-flash` id the amiko gateway
// hands out, and every retired alias (`deepseek-v4-flash`, `-latest`,
// `-<date>`, `-vision-exp`). pi-ai 1.6 carries `deepseek/deepseek-flash` and
// `openrouter/deepseek/deepseek-v4.1-flash` as image-capable, but other routes
// (OpenRouter's retired `deepseek-v4-flash` ids, a gateway id it doesn't
// carry) resolve text-only, or synthesize as text-only + $0. Either way
// pi-ai would strip images before the request (an agent
// on such an id reported it "couldn't see" an image the user sent). Force the
// family's true image modality, and backfill the $0-fallback pricing/window so
// usage isn't recorded as free. Provider prefixes (`deepseek/`) and the
// `~…-latest` pin marker are stripped before matching; `flash\b` excludes
// `deepseek-v4-pro`.
const DEEPSEEK_FLASH_RE = /^deepseek-(v\d+(?:\.\d+)?-)?flash\b/;

const isDeepseekFlashId = (modelId: string): boolean =>
  DEEPSEEK_FLASH_RE.test(modelId.replace(/^~/, '').replace(/^deepseek\//, '').toLowerCase());

const DEEPSEEK_FLASH_CAPS = {
  cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 384000,
};

const applyDeepseekFlashCaps = (model: Model<any>): Model<any> => {
  if (!isDeepseekFlashId(model.id)) return model;
  const input = Array.isArray(model.input) ? model.input : [];
  const c = model.cost;
  // The $0 zero-fallback signature from the synthesize path — never a real price.
  const costIsZeroFallback =
    !!c && c.input === 0 && c.output === 0 && c.cacheRead === 0 && c.cacheWrite === 0;
  return {
    ...model,
    ...(input.includes('image') ? {} : { input: ['text', 'image'] }),
    ...(costIsZeroFallback
      ? {
          cost: DEEPSEEK_FLASH_CAPS.cost,
          contextWindow:
            model.contextWindow === 128000 ? DEEPSEEK_FLASH_CAPS.contextWindow : model.contextWindow,
          maxTokens: model.maxTokens ?? DEEPSEEK_FLASH_CAPS.maxTokens,
        }
      : {}),
  } as Model<any>;
};

/** Resolve a Model from pi-ai's built-in registry, if it carries it. */
const tryRegistry = (provider: string, modelId: string): Model<any> | undefined => {
  try {
    return getBuiltinModel(provider as never, modelId as never) as Model<any> | undefined;
  } catch {
    return undefined;
  }
};

const commonPrefixLength = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

const familyWords = (id: string): string[] =>
  id.split(/[-/.:_~]+/).filter((word) => /^[a-z]+$/.test(word));

/**
 * pi-ai 1.x prunes retired ids from its registry (e.g. `claude-sonnet-4-20250514`,
 * `deepseek-v4-flash`, most of the `grok-*` / older openrouter ids). Agents
 * configured before the prune must keep working, and providers usually still
 * serve those ids for a while. So when the exact id is missing, borrow the
 * closest same-provider sibling — longest shared id prefix that reaches at
 * least one family boundary (`-` or `/`) — and keep the requested id on the
 * wire. Its api/baseUrl/compat are the provider's; capabilities and price are
 * the nearest family member's, which beats the text-only $0 synthesize default.
 * A DeepSeek Flash alias prefers the canonical flash entry over `-v4-pro`.
 */
const tryRetiredSibling = (provider: string, modelId: string): Model<any> | undefined => {
  let models: Model<any>[];
  try {
    models = getBuiltinModels(provider as never) as Model<any>[];
  } catch {
    return undefined;
  }
  const wanted = modelId.toLowerCase();
  const flash = isDeepseekFlashId(modelId);
  const candidates = flash && models.some((m) => isDeepseekFlashId(m.id))
    ? models.filter((m) => isDeepseekFlashId(m.id))
    : models;
  // Rank by shared family words first (`haiku`, `sonnet`, `flash`, …), then by
  // shared prefix, so `claude-3-5-haiku-latest` lands on a haiku, not on
  // whichever `claude-*` happens to come first.
  const wantedWords = familyWords(wanted);
  let best: Model<any> | undefined;
  let bestScore: [number, number] = [0, 0];
  for (const candidate of candidates) {
    const id = candidate.id.toLowerCase();
    const shared = familyWords(id).filter((w) => wantedWords.includes(w)).length;
    const prefix = commonPrefixLength(wanted, id);
    if (!/[-/]/.test(wanted.slice(0, prefix))) continue;
    if (shared > bestScore[0] || (shared === bestScore[0] && prefix > bestScore[1])) {
      best = candidate;
      bestScore = [shared, prefix];
    }
  }
  if (!best) return undefined;
  return { ...best, id: modelId, name: modelId };
};

const tryRegistryOrSibling = (provider: string, modelId: string): Model<any> | undefined =>
  tryRegistry(provider, modelId) ?? tryRetiredSibling(provider, modelId);

export const resolveModel = (config: AgentConfig): Model<any> => {
  const providerDefaults = OPENAI_COMPATIBLE_PROVIDERS[config.model.provider];
  const api = config.model.api ?? providerDefaults?.api;
  const baseUrl = config.model.base_url ?? providerDefaults?.baseUrl();

  // 1) Registry first. If pi-ai knows this (provider, modelId), trust its
  //    capability flags (reasoning, compat, etc.). Apply user overrides for
  //    base_url / api / max_tokens on top.
  const registry = tryRegistryOrSibling(config.model.provider, config.model.model);
  if (registry) {
    return applyDeepseekFlashCaps({
      ...registry,
      ...(config.model.base_url ? { baseUrl: config.model.base_url } : {}),
      ...(config.model.api ? { api: config.model.api } : {}),
      ...(config.model.max_tokens !== undefined ? { maxTokens: config.model.max_tokens } : {}),
    } as Model<any>);
  }

  // 2) Custom OpenAI-compatible endpoint. The registry doesn't know this
  //    model, so we synthesize a Model. Providers that proxy another
  //    catalogue (priceCatalog) reuse its model ids, so borrow that registry
  //    entry's list price, context window, and capability flags — otherwise
  //    usage cost is recorded as $0 forever and image input is dropped.
  //    List price is a safe overestimate (BYOK / cache discounts land below
  //    it). Dated ids fall back to the undated registry entry
  //    (…-preview-20251217 → …-preview). Without a priceRef we have no
  //    authoritative reasoning flag, so derive it from the user's `thinking`
  //    level (anything other than off / unset implies reasoning capability).
  if (api && baseUrl) {
    const priceCatalog = providerDefaults?.priceCatalog;
    const priceRef = priceCatalog
      ? (tryRegistry(priceCatalog, config.model.model) ??
        tryRegistryOrSibling(priceCatalog, config.model.model.replace(/-\d{8}$/, '')))
      : undefined;
    // Gateways that proxy OpenRouter (priceCatalog='openrouter') also speak
    // OpenRouter's reasoning param semantics, but their base URL isn't
    // openrouter.ai — so pi-ai's compat auto-detection classifies them as plain
    // "openai" and never emits the nested `reasoning` object. Pin the format so
    // pi-ai sends `reasoning:{effort:"none"}` when thinking is off (OpenRouter
    // then suppresses reasoning instead of letting a model's "thought summaries"
    // bleed into the reply text, e.g. gemini-3) and `reasoning:{effort}` when
    // it's on (reasoning comes back in its own field → a real thinking block).
    const compat =
      priceCatalog === 'openrouter' ? { thinkingFormat: 'openrouter' as const } : undefined;
    return applyDeepseekFlashCaps({
      id: config.model.model,
      name: config.model.model,
      api,
      provider: config.model.provider,
      baseUrl,
      reasoning: priceRef?.reasoning ?? (config.model.thinking ?? 'off') !== 'off',
      input: priceRef?.input ?? ['text'],
      cost: priceRef?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: priceRef?.contextWindow ?? 128000,
      maxTokens: config.model.max_tokens ?? priceRef?.maxTokens,
      ...(compat ? { compat } : {}),
    } as Model<any>);
  }

  throw new ValidationError(
    `Unsupported model configuration: ${config.model.provider}/${config.model.model}`,
  );
};
