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
