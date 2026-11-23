import { getBuiltinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';

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
export const listProviderCatalog = (): ProviderCatalogEntry[] => {
  const providers = getBuiltinProviders();
  return providers.map((provider) => {
    const models = getBuiltinModels(provider).map((m) => ({
      id: m.id,
      reasoning: Boolean((m as { reasoning?: boolean }).reasoning),
    }));
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
 * provider name (codepoint order — getBuiltinProviders() insertion order is not
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
