import { getProviders, getModels } from '@mariozechner/pi-ai';

import { listLocalModels } from './agent-runner/model-utils.js';

export interface ProviderCatalogEntry {
  provider: string;
  models: { id: string; reasoning: boolean }[];
}

/**
 * Snapshot of the providers and models registered in pi-ai. Used by
 * the admin UI / web client to populate cascading provider+model
 * pickers without baking the registry into the frontend.
 *
 * `reasoning` is the per-model capability flag from pi-ai (true for
 * thinking-only / thinking-capable models). The UI uses it to surface
 * a warning when a user explicitly disables thinking on a model that
 * needs it server-side.
 */
/** Length of the shared leading substring of two ids. */
const commonPrefixLen = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
};

/**
 * Insert `entry` next to its closest existing sibling (the one sharing the
 * longest id prefix, e.g. `minimax/minimax-m3` beside `minimax/minimax-m2.7`)
 * so model families stay grouped in the picker, rather than appending local
 * models at the very end. Falls back to append when there is no clear sibling.
 */
const insertGrouped = (
  models: { id: string; reasoning: boolean }[],
  entry: { id: string; reasoning: boolean },
): void => {
  const MIN_SHARED = 4;
  let bestIdx = -1;
  let bestLen = MIN_SHARED - 1;
  for (let i = 0; i < models.length; i += 1) {
    const len = commonPrefixLen(models[i]!.id, entry.id);
    if (len >= MIN_SHARED && len >= bestLen) {
      bestLen = len;
      bestIdx = i; // `>=` keeps the last sibling so we insert after the family
    }
  }
  if (bestIdx === -1) models.push(entry);
  else models.splice(bestIdx + 1, 0, entry);
};

export const listProviderCatalog = (): ProviderCatalogEntry[] => {
  const providers = getProviders();
  return providers.map((provider) => {
    const models = getModels(provider).map((m) => ({
      id: m.id,
      reasoning: Boolean((m as { reasoning?: boolean }).reasoning),
    }));
    // Merge local-only models the pi-ai registry lacks, placing each next to
    // its family rather than at the end of the list.
    for (const lm of listLocalModels(provider)) {
      if (!models.some((m) => m.id === lm.id)) {
        insertGrouped(models, { id: lm.id, reasoning: Boolean(lm.reasoning) });
      }
    }
    return { provider, models };
  });
};

// --- dynamic providers ---
//
// Providers whose model list lives behind an OpenAI-compatible GET /models
// endpoint rather than in pi-ai's static registry. The fetch is attempted
// unconditionally — apiKeyEnv only adds a bearer token when present, for
// routers that serve /models publicly but meter everything else. A provider
// whose endpoint rejects the request is simply left out of the catalog.

interface DynamicProviderSource {
  provider: string;
  /** OpenAI-compatible root; `/models` is appended. */
  baseUrl: () => string;
  /** Optional bearer credential; the fetch goes out anonymously without it. */
  apiKeyEnv: string;
}

const DYNAMIC_PROVIDER_SOURCES: DynamicProviderSource[] = [
  {
    provider: 'amiko',
    baseUrl: () => process.env.AMIKO_BASE_URL ?? 'https://api.heyamiko.com/api/v1',
    apiKeyEnv: 'AMIKO_API_KEY',
  },
];

const DYNAMIC_CATALOG_TTL_MS = 15 * 60 * 1000;
const DYNAMIC_CATALOG_ERROR_TTL_MS = 60 * 1000;
const DYNAMIC_CATALOG_FETCH_TIMEOUT_MS = 5_000;

const dynamicCatalogCache = new Map<
  string,
  { at: number; entry: ProviderCatalogEntry | null }
>();

/** Test hook — dynamic entries are cached for 15 minutes otherwise. */
export const clearDynamicProviderCache = (): void => {
  dynamicCatalogCache.clear();
};

/**
 * OpenRouter-style /models entries advertise reasoning support via
 * `supported_parameters`; vendors that omit the field default to false.
 */
const modelListEntryReasoning = (m: { supported_parameters?: unknown }): boolean =>
  Array.isArray(m.supported_parameters) && m.supported_parameters.includes('reasoning');

const fetchDynamicProvider = async (
  source: DynamicProviderSource,
): Promise<ProviderCatalogEntry | null> => {
  const apiKey = process.env[source.apiKeyEnv];

  const cached = dynamicCatalogCache.get(source.provider);
  if (cached) {
    const ttl = cached.entry ? DYNAMIC_CATALOG_TTL_MS : DYNAMIC_CATALOG_ERROR_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.entry;
  }

  let entry: ProviderCatalogEntry | null = null;
  try {
    const res = await fetch(`${source.baseUrl()}/models`, {
      ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      signal: AbortSignal.timeout(DYNAMIC_CATALOG_FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        data?: { id?: unknown; supported_parameters?: unknown }[];
      };
      const models = (body.data ?? [])
        .filter((m): m is { id: string; supported_parameters?: unknown } =>
          typeof m.id === 'string' && m.id.length > 0,
        )
        .map((m) => ({ id: m.id, reasoning: modelListEntryReasoning(m) }));
      if (models.length > 0) entry = { provider: source.provider, models };
    }
  } catch {
    entry = null; // treat network / timeout like an error response: retry after the short TTL
  }
  dynamicCatalogCache.set(source.provider, { at: Date.now(), entry });
  return entry;
};

/**
 * Static pi-ai catalog plus any reachable dynamic providers, sorted by
 * provider name (codepoint order — getProviders() insertion order is not
 * guaranteed alphabetical). A dynamic provider that is unreachable or empty
 * is simply omitted — the picker never breaks because a remote catalogue is
 * down.
 */
export const listProviderCatalogWithDynamic = async (): Promise<ProviderCatalogEntry[]> => {
  const catalog = listProviderCatalog();
  const dynamic = await Promise.all(DYNAMIC_PROVIDER_SOURCES.map(fetchDynamicProvider));
  for (const entry of dynamic) {
    if (!entry || catalog.some((p) => p.provider === entry.provider)) continue;
    catalog.push(entry);
  }
  return catalog.sort((a, b) =>
    a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0,
  );
};
