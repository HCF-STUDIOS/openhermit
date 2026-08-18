import { createHash } from 'node:crypto';

import type {
  ResearchBudgetLimits,
  ResearchDepth,
  ResearchRunStatus,
  ResearchUsage,
} from './contracts.js';
import { TERMINAL_RESEARCH_STATUSES, zeroResearchUsage } from './contracts.js';

/**
 * Deterministic research guards: the state machine, hard budgets, query and
 * URL dedupe, the finish gate, information-gain tracking, and retry
 * classification. Everything here is pure logic — no IO, no model calls — so
 * the loop's stopping behavior is testable and cannot be argued with by a
 * model.
 */

// ─── State machine (§7) ─────────────────────────────────────────────────────

const TRANSITIONS: Record<ResearchRunStatus, readonly ResearchRunStatus[]> = {
  created: ['planning', 'paused', 'cancelled'],
  planning: ['awaiting_plan_approval', 'failed', 'paused', 'cancelled'],
  awaiting_plan_approval: ['queued', 'planning', 'paused', 'cancelled'],
  queued: ['researching', 'paused', 'cancelled'],
  researching: ['synthesizing', 'failed', 'budget_exhausted', 'paused', 'cancelled'],
  synthesizing: ['completed', 'failed', 'budget_exhausted', 'paused', 'cancelled'],
  // paused → planning covers refinement (plan revision); queued / synthesizing
  // are resume_phase targets; awaiting_plan_approval is the post-refinement
  // review stop.
  paused: ['planning', 'awaiting_plan_approval', 'queued', 'synthesizing', 'cancelled'],
  failed: ['planning', 'queued', 'synthesizing', 'cancelled'],
  budget_exhausted: ['queued', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const canTransition = (
  from: ResearchRunStatus,
  to: ResearchRunStatus,
): boolean => TRANSITIONS[from].includes(to);

export class InvalidResearchTransitionError extends Error {
  constructor(
    public readonly from: ResearchRunStatus,
    public readonly to: ResearchRunStatus,
  ) {
    super(`invalid research run transition: ${from} → ${to}`);
    this.name = 'InvalidResearchTransitionError';
  }
}

export const assertTransition = (
  from: ResearchRunStatus,
  to: ResearchRunStatus,
): void => {
  if (!canTransition(from, to)) throw new InvalidResearchTransitionError(from, to);
};

export const isTerminalStatus = (status: ResearchRunStatus): boolean =>
  TERMINAL_RESEARCH_STATUSES.includes(status);

// ─── Budget presets (§9) ────────────────────────────────────────────────────

export const RESEARCH_BUDGET_PRESETS: Record<ResearchDepth, ResearchBudgetLimits> = {
  quick: {
    iterations: 6,
    searches: 8,
    fetchedSources: 10,
    modelCalls: 22,
    elapsedMs: 10 * 60_000,
    bytesPerSource: 200_000,
    bytesPerRun: 1_500_000,
    inputTokens: 250_000,
    outputTokens: 40_000,
  },
  standard: {
    iterations: 12,
    searches: 18,
    fetchedSources: 24,
    modelCalls: 40,
    elapsedMs: 20 * 60_000,
    bytesPerSource: 200_000,
    bytesPerRun: 3_000_000,
    inputTokens: 500_000,
    outputTokens: 80_000,
  },
  thorough: {
    iterations: 20,
    searches: 32,
    fetchedSources: 45,
    modelCalls: 72,
    elapsedMs: 45 * 60_000,
    bytesPerSource: 200_000,
    bytesPerRun: 6_000_000,
    inputTokens: 900_000,
    outputTokens: 120_000,
  },
};

/** Model calls held back for synthesis (one call plus one repair attempt). */
export const SYNTHESIS_RESERVE_MODEL_CALLS = 2;

export type BudgetDimension =
  | 'iterations'
  | 'searches'
  | 'fetchedSources'
  | 'modelCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'snapshotBytes'
  | 'elapsed';

/**
 * Budget accounting over a run's durable usage. `canSpend` answers "is this
 * action affordable" before the action is persisted; `spend` records it.
 * Model-call affordability during research respects the synthesis reserve so
 * a run can always produce a (possibly partial) report.
 */
export class ResearchBudget {
  constructor(
    readonly limits: ResearchBudgetLimits,
    readonly usage: ResearchUsage = zeroResearchUsage(),
  ) {}

  canSpendSearch(n = 1): boolean {
    return this.usage.searches + n <= this.limits.searches;
  }

  canSpendFetch(n = 1): boolean {
    return this.usage.fetchedSources + n <= this.limits.fetchedSources;
  }

  canSpendIteration(): boolean {
    return this.usage.iterations + 1 <= this.limits.iterations;
  }

  /**
   * True when a research-phase model call fits under the limit minus the
   * synthesis reserve. Synthesis itself passes `phase: 'synthesis'` and may
   * consume the reserve.
   */
  canSpendModelCall(phase: 'research' | 'synthesis' = 'research'): boolean {
    const reserve = phase === 'synthesis' ? 0 : SYNTHESIS_RESERVE_MODEL_CALLS;
    return this.usage.modelCalls + 1 <= this.limits.modelCalls - reserve;
  }

  canStoreSnapshot(bytes: number): boolean {
    return (
      bytes <= this.limits.bytesPerSource &&
      this.usage.snapshotBytes + bytes <= this.limits.bytesPerRun
    );
  }

  spend(update: Partial<Pick<ResearchUsage,
    | 'iterations'
    | 'searches'
    | 'fetchedSources'
    | 'modelCalls'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheTokens'
    | 'retries'
    | 'snapshotBytes'
    | 'evidenceItems'
    | 'sources'
  >>): void {
    const usage = this.usage as unknown as Record<string, number>;
    for (const [key, value] of Object.entries(update)) {
      if (typeof value === 'number') {
        usage[key] = (usage[key] ?? 0) + value;
      }
    }
  }

  /** First hard limit already reached, or null. Elapsed is checked by caller. */
  exhaustedDimension(elapsedMs?: number): BudgetDimension | null {
    if (this.usage.iterations >= this.limits.iterations) return 'iterations';
    if (this.usage.searches >= this.limits.searches) return 'searches';
    if (this.usage.fetchedSources >= this.limits.fetchedSources) return 'fetchedSources';
    if (this.usage.modelCalls >= this.limits.modelCalls - SYNTHESIS_RESERVE_MODEL_CALLS) {
      return 'modelCalls';
    }
    if (this.usage.inputTokens >= this.limits.inputTokens) return 'inputTokens';
    if (this.usage.outputTokens >= this.limits.outputTokens) return 'outputTokens';
    if (this.usage.snapshotBytes >= this.limits.bytesPerRun) return 'snapshotBytes';
    if (elapsedMs !== undefined && elapsedMs >= this.limits.elapsedMs) return 'elapsed';
    return null;
  }
}

/** Merge a user-requested budget increase; only raises, never lowers. */
export const increaseBudgetLimits = (
  current: ResearchBudgetLimits,
  increase: Partial<ResearchBudgetLimits>,
): ResearchBudgetLimits => {
  const next = { ...current };
  for (const key of Object.keys(current) as (keyof ResearchBudgetLimits)[]) {
    const v = increase[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > next[key]) {
      next[key] = Math.floor(v);
    }
  }
  return next;
};

// ─── Query fingerprints (§9 decision 13) ────────────────────────────────────

const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'was', 'were', 'be', 'by', 'with', 'about', 'what', 'which', 'who', 'how',
  'does', 'do', 'did', 'has', 'have', 'had', 'its', 'their', 'from', 'at',
  'as', 'that', 'this', 'these', 'those', 'it', 'vs',
]);

const queryTokens = (query: string): string[] => {
  const tokens = query
    .toLowerCase()
    .replace(/["'’‘“”()[\]{}<>,;:!?]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 0 && !QUERY_STOPWORDS.has(t));
  return [...new Set(tokens)].sort();
};

/** Canonical fingerprint: casing-, punctuation-, ordering-, stopword-invariant. */
export const queryFingerprint = (query: string): string =>
  queryTokens(query).join(' ');

/** Token-set Jaccard similarity in [0, 1]. */
export const querySimilarity = (a: string, b: string): number => {
  const ta = new Set(queryTokens(a));
  const tb = new Set(queryTokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

export const NEAR_DUPLICATE_QUERY_THRESHOLD = 0.8;

/** True when `query` is an exact or near reformulation of any prior query. */
export const isDuplicateQuery = (
  query: string,
  priorQueries: readonly string[],
  threshold = NEAR_DUPLICATE_QUERY_THRESHOLD,
): boolean => {
  const fp = queryFingerprint(query);
  return priorQueries.some(
    (p) => queryFingerprint(p) === fp || querySimilarity(query, p) >= threshold,
  );
};

// ─── URL normalization and hashing (§10) ────────────────────────────────────

const TRACKING_PARAMS = new Set([
  'gclid', 'fbclid', 'igshid', 'msclkid', 'dclid', 'twclid', 'yclid',
  'mc_cid', 'mc_eid', 'ref', 'ref_src', 'ref_url', 'referrer',
  'source', 'spm', '_hsenc', '_hsmi', 'wt_mc', 's_kwcid', 'sc_channel',
]);

const isTrackingParam = (name: string): boolean =>
  TRACKING_PARAMS.has(name.toLowerCase()) || name.toLowerCase().startsWith('utm_');

/**
 * Canonical URL form: lowercase scheme/host, default port and fragment
 * removed, tracking params stripped, remaining query params sorted,
 * dot-segments resolved (by URL parsing), trailing slash trimmed off
 * non-root paths.
 */
export const normalizeUrl = (raw: string): string => {
  const url = new URL(raw); // throws on garbage — callers fail closed
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }
  const kept = [...url.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
};

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** Hash of the normalized URL — repeat-acquisition dedupe key within a run. */
export const canonicalUrlHash = (raw: string): string => sha256Hex(normalizeUrl(raw));

// ─── Finish gate and information gain (§9) ──────────────────────────────────

export interface ContradictionStatus {
  claimKey: string;
  resolved: boolean;
  followUpAttempted: boolean;
}

export interface FinishGateInput {
  requiredQuestionIds: readonly string[];
  coveredQuestionIds: readonly string[];
  contradictions: readonly ContradictionStatus[];
  unresolvedContradictionsAllowed: boolean;
}

export interface FinishGateResult {
  pass: boolean;
  reasons: string[];
}

export const evaluateFinishGate = (input: FinishGateInput): FinishGateResult => {
  const reasons: string[] = [];
  const covered = new Set(input.coveredQuestionIds);
  const missing = input.requiredQuestionIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    reasons.push(`required questions not covered: ${missing.join(', ')}`);
  }
  for (const c of input.contradictions) {
    if (!c.resolved && !c.followUpAttempted) {
      reasons.push(`contradiction "${c.claimKey}" has no follow-up attempt`);
    }
    if (!c.resolved && !input.unresolvedContradictionsAllowed) {
      reasons.push(`contradiction "${c.claimKey}" unresolved and not allowed`);
    }
  }
  return { pass: reasons.length === 0, reasons };
};

export interface IterationGain {
  newEvidence: number;
  newSourceClasses: number;
  newCoveredQuestions: number;
  resolvedContradictions: number;
}

export const isZeroGain = (gain: IterationGain): boolean =>
  gain.newEvidence === 0 &&
  gain.newSourceClasses === 0 &&
  gain.newCoveredQuestions === 0 &&
  gain.resolvedContradictions === 0;

export const ZERO_GAIN_STREAK_LIMIT = 3;

/** Consecutive-zero-gain counter with a hard stop at the streak limit. */
export class GainTracker {
  private streak = 0;

  constructor(initialStreak = 0) {
    this.streak = initialStreak;
  }

  record(gain: IterationGain): void {
    this.streak = isZeroGain(gain) ? this.streak + 1 : 0;
  }

  get zeroGainStreak(): number {
    return this.streak;
  }

  get diminished(): boolean {
    return this.streak >= ZERO_GAIN_STREAK_LIMIT;
  }
}

// ─── Retry classification and backoff (§9 / §15) ────────────────────────────

export type RetryClass = 'retryable' | 'rate_limited' | 'fatal';

export interface RetryDecision {
  class: RetryClass;
  /** Explicit server-requested delay (from Retry-After), when present. */
  retryAfterMs?: number | undefined;
}

const RETRYABLE_MESSAGE = /timeout|timed out|econnreset|econnrefused|enotfound|eai_again|socket|network|fetch failed|aborted.*due to timeout/i;

export const classifyFailure = (input: {
  status?: number | undefined;
  retryAfterSeconds?: number | undefined;
  message?: string | undefined;
}): RetryDecision => {
  if (input.status === 429) {
    return {
      class: 'rate_limited',
      retryAfterMs:
        input.retryAfterSeconds !== undefined && Number.isFinite(input.retryAfterSeconds)
          ? Math.max(0, input.retryAfterSeconds) * 1_000
          : undefined,
    };
  }
  if (input.status !== undefined) {
    if (input.status === 408 || input.status >= 500) return { class: 'retryable' };
    return { class: 'fatal' }; // 4xx other than 408/429: retrying won't help
  }
  if (input.message && RETRYABLE_MESSAGE.test(input.message)) {
    return { class: 'retryable' };
  }
  return { class: 'fatal' };
};

export const MAX_ACTION_RETRIES = 3;

/** Ceiling for any retry wait, including server-requested Retry-After. */
export const MAX_RETRY_DELAY_MS = 15_000;

/** Exponential backoff with injectable jitter for deterministic tests. */
export const retryDelayMs = (
  attempt: number,
  options?: { baseMs?: number; capMs?: number; random?: () => number },
): number => {
  const base = options?.baseMs ?? 500;
  const cap = options?.capMs ?? MAX_RETRY_DELAY_MS;
  const random = options?.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
};
