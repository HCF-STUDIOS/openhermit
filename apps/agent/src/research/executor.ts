import type {
  WebFetchOptions,
  WebFetchResult,
  WebSearchOptions,
  WebSearchResult,
} from '../web/types.js';
import { urlMatchesDomainFilters } from '../web/domains.js';

import type {
  AcquiredResearchSource,
  ResearchAction,
  ResearchPlan,
  ResearchSourcePolicy,
} from './contracts.js';
import {
  MAX_ACTION_RETRIES,
  classifyFailure,
  isDuplicateQuery,
  retryDelayMs,
  type ResearchBudget,
} from './guards.js';

/**
 * Deterministic action validation and bounded execution. The decision model
 * proposes; everything here disposes — schema-validated actions still have to
 * clear source policy, budget reservation, duplicate checks, and concurrency
 * limits before any IO happens (§9 step 4).
 */

export const MAX_SEARCH_ACTIONS_PER_ITERATION = 2;
export const MAX_READ_ACTIONS_PER_ITERATION = 3;

export interface KnownSourceView {
  sourceId: string;
  status: string;
  url: string | null;
}

export interface ActionValidationContext {
  plan: ResearchPlan;
  sourcePolicy: ResearchSourcePolicy;
  budget: ResearchBudget;
  priorQueries: readonly string[];
  knownSources: ReadonlyMap<string, KnownSourceView>;
}

export interface RejectedAction {
  action: ResearchAction;
  reason: string;
}

export interface ValidatedActions {
  approved: ResearchAction[];
  rejected: RejectedAction[];
  finishRequested: boolean;
}

/** Domain filters implied by the web source policy (strict modes only). */
export const searchFiltersForPolicy = (
  policy: ResearchSourcePolicy,
): Pick<WebSearchOptions, 'includeDomains' | 'excludeDomains'> => ({
  ...(policy.web.mode === 'only_domains' && policy.web.domains.length > 0
    ? { includeDomains: policy.web.domains }
    : {}),
  ...(policy.web.excludedDomains.length > 0
    ? { excludeDomains: policy.web.excludedDomains }
    : {}),
});

/** prefer_domains: stable-sort preferred-domain candidates first. */
export const orderCandidatesForPolicy = <T extends { url: string }>(
  policy: ResearchSourcePolicy,
  candidates: T[],
): T[] => {
  if (policy.web.mode !== 'prefer_domains' || policy.web.domains.length === 0) {
    return candidates;
  }
  const preferred = (c: T): boolean =>
    urlMatchesDomainFilters(c.url, policy.web.domains, undefined);
  return [...candidates.filter(preferred), ...candidates.filter((c) => !preferred(c))];
};

/** True when a URL is acceptable under the run's web source policy. */
export const urlAllowedByPolicy = (
  policy: ResearchSourcePolicy,
  url: string,
): boolean =>
  urlMatchesDomainFilters(
    url,
    policy.web.mode === 'only_domains' ? policy.web.domains : undefined,
    policy.web.excludedDomains,
  );

export const validateActions = (
  actions: readonly ResearchAction[],
  ctx: ActionValidationContext,
): ValidatedActions => {
  const approved: ResearchAction[] = [];
  const rejected: RejectedAction[] = [];
  let finishRequested = false;

  const validQuestionIds = new Set(ctx.plan.questions.map((q) => q.id));
  const approvedQueries: string[] = [];
  const approvedReads = new Set<string>();
  let searchCount = 0;
  let readCount = 0;

  for (const action of actions) {
    if (action.type === 'finish') {
      finishRequested = true;
      continue;
    }

    const questionIds = action.questionIds.filter((id) => validQuestionIds.has(id));
    if (questionIds.length === 0) {
      rejected.push({ action, reason: 'references no valid plan question ids' });
      continue;
    }

    if (action.type === 'search') {
      if (searchCount >= MAX_SEARCH_ACTIONS_PER_ITERATION) {
        rejected.push({ action, reason: 'search concurrency limit reached for this iteration' });
        continue;
      }
      if (!ctx.budget.canSpendSearch(searchCount + 1)) {
        rejected.push({ action, reason: 'search budget exhausted' });
        continue;
      }
      if (isDuplicateQuery(action.query, [...ctx.priorQueries, ...approvedQueries])) {
        rejected.push({ action, reason: 'duplicate or near-duplicate of a previous query' });
        continue;
      }
      approvedQueries.push(action.query);
      searchCount += 1;
      approved.push({ ...action, questionIds });
      continue;
    }

    // read_source
    if (readCount >= MAX_READ_ACTIONS_PER_ITERATION) {
      rejected.push({ action, reason: 'read concurrency limit reached for this iteration' });
      continue;
    }
    if (!ctx.budget.canSpendFetch(readCount + 1)) {
      rejected.push({ action, reason: 'fetched-source budget exhausted' });
      continue;
    }
    const source = ctx.knownSources.get(action.sourceId);
    if (!source) {
      rejected.push({ action, reason: `unknown source id "${action.sourceId}"` });
      continue;
    }
    if (approvedReads.has(action.sourceId)) {
      rejected.push({ action, reason: 'source already scheduled this iteration' });
      continue;
    }
    if (source.status !== 'candidate') {
      rejected.push({ action, reason: `source is "${source.status}", not a readable candidate` });
      continue;
    }
    if (!source.url) {
      rejected.push({ action, reason: 'source has no URL' });
      continue;
    }
    if (!urlAllowedByPolicy(ctx.sourcePolicy, source.url)) {
      rejected.push({ action, reason: 'source URL violates the web source policy' });
      continue;
    }
    approvedReads.add(action.sourceId);
    readCount += 1;
    approved.push({ ...action, questionIds });
  }

  return { approved, rejected, finishRequested };
};

// ─── Retrying IO ────────────────────────────────────────────────────────────

export interface ExecutorDeps {
  webSearch: (query: string, options: WebSearchOptions) => Promise<WebSearchResult[]>;
  webFetch: (url: string, options: WebFetchOptions) => Promise<WebFetchResult>;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pull status/Retry-After hints off arbitrary provider/fetch errors. */
const describeError = (
  err: unknown,
): { status?: number | undefined; retryAfterSeconds?: number | undefined; message: string } => {
  const anyErr = err as { status?: unknown; retryAfterSeconds?: unknown } | undefined;
  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof anyErr?.status === 'number'
      ? anyErr.status
      : (() => {
          const m = message.match(/HTTP (\d{3})/);
          return m ? Number(m[1]) : undefined;
        })();
  const retryAfterSeconds =
    typeof anyErr?.retryAfterSeconds === 'number' ? anyErr.retryAfterSeconds : undefined;
  return { status, retryAfterSeconds, message };
};

export class ResearchActionError extends Error {
  constructor(
    message: string,
    public readonly retries: number,
    public readonly classification: 'fatal' | 'retryable' | 'rate_limited',
  ) {
    super(message);
    this.name = 'ResearchActionError';
  }
}

const withRetries = async <T>(
  deps: ExecutorDeps,
  label: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<{ result: T; retries: number }> => {
  const sleep = deps.sleep ?? defaultSleep;
  let retries = 0;
  // attempts = 1 initial + MAX_ACTION_RETRIES retries
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw new ResearchActionError(`${label} aborted`, retries, 'fatal');
    try {
      const result = await fn();
      return { result, retries };
    } catch (err) {
      const described = describeError(err);
      const decision = classifyFailure(described);
      if (decision.class === 'fatal' || attempt > MAX_ACTION_RETRIES) {
        throw new ResearchActionError(
          `${label} failed after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${described.message}`,
          retries,
          decision.class,
        );
      }
      retries += 1;
      const delay =
        decision.retryAfterMs ?? retryDelayMs(attempt, { random: deps.random ?? Math.random });
      await sleep(delay);
    }
  }
};

export interface SearchExecutionResult {
  results: WebSearchResult[];
  retries: number;
}

export const executeSearchAction = async (
  deps: ExecutorDeps,
  input: {
    query: string;
    sourcePolicy: ResearchSourcePolicy;
    limit?: number | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<SearchExecutionResult> => {
  const { result, retries } = await withRetries(deps, 'search', input.signal, () =>
    deps.webSearch(input.query, {
      limit: input.limit ?? 8,
      ...searchFiltersForPolicy(input.sourcePolicy),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    }),
  );
  return { results: orderCandidatesForPolicy(input.sourcePolicy, result), retries };
};

export interface ReadExecutionResult {
  acquired: AcquiredResearchSource;
  retries: number;
}

export const executeReadAction = async (
  deps: ExecutorDeps,
  input: {
    url: string;
    maxBytes: number;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<ReadExecutionResult> => {
  const { result, retries } = await withRetries(deps, 'fetch', input.signal, () =>
    deps.webFetch(input.url, {
      maxBytes: input.maxBytes,
      output: 'markdown',
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    }),
  );
  const acquired: AcquiredResearchSource = {
    url: input.url,
    finalUrl: result.url,
    title: result.title,
    content: result.content,
    contentBytes: result.contentBytes,
    truncated: result.truncated,
    canonicalUrl: result.acquisition?.canonicalUrl,
    mimeType: result.acquisition?.mimeType,
    status: result.acquisition?.status,
    publisher: result.acquisition?.publisher,
    author: result.acquisition?.author,
    publishedAt: result.acquisition?.publishedAt,
    retrievedAt: result.acquisition?.retrievedAt ?? new Date().toISOString(),
  };
  return { acquired, retries };
};

/**
 * Run read tasks with the design's fetch concurrency: sequential per domain,
 * parallel across domains, global cap of MAX_READ_ACTIONS_PER_ITERATION
 * (which per-iteration action limits already guarantee).
 */
export const runReadsWithDomainLimit = async <T>(
  reads: Array<{ domain: string; run: () => Promise<T> }>,
): Promise<Array<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }>> => {
  const byDomain = new Map<string, Array<{ index: number; run: () => Promise<T> }>>();
  reads.forEach((r, index) => {
    const list = byDomain.get(r.domain) ?? [];
    list.push({ index, run: r.run });
    byDomain.set(r.domain, list);
  });

  const results = new Array<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }>(
    reads.length,
  );
  await Promise.all(
    [...byDomain.values()].map(async (group) => {
      for (const item of group) {
        try {
          results[item.index] = { status: 'fulfilled', value: await item.run() };
        } catch (reason) {
          results[item.index] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return results;
};
