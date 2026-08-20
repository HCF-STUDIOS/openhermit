import type { LangfuseTurnContext } from '../langfuse.js';

import {
  extractionOutputSchema,
  type EvidenceStance,
  type ExtractedEvidence,
  type ResearchLocator,
} from './contracts.js';
import { sha256Hex } from './guards.js';
import {
  callPhaseWithRepair,
  type ResearchPhaseModel,
} from './model-phase.js';
import { EXTRACTOR_SYSTEM_PROMPT, buildExtractorUserPrompt } from './prompts.js';

/**
 * Deterministic evidence primitives: snapshot normalization, exact excerpt
 * verification with stable locators, evidence hashing, content dedupe, source
 * independence clustering, and contradiction grouping. The model proposes
 * evidence; everything here decides whether it is real and how it relates.
 */

// ─── Snapshot and excerpt normalization ─────────────────────────────────────

/** Collapse all whitespace runs to single spaces and trim. */
export const normalizeWhitespace = (text: string): string =>
  text.replace(/\s+/g, ' ').trim();

/**
 * Canonical snapshot form stored per source: whitespace-normalized text. All
 * locator offsets refer to this form, so verification is reproducible from
 * the stored snapshot alone.
 */
export const normalizeSnapshotText = normalizeWhitespace;

/** Content hash over the normalized snapshot — detects mirrors/syndication. */
export const contentHash = (snapshotText: string): string =>
  sha256Hex(normalizeSnapshotText(snapshotText));

export const EVIDENCE_EXCERPT_MAX_CHARS = 1_000;

export interface ExcerptVerification {
  verified: boolean;
  /** Locator when verified; undefined otherwise. */
  locator?: ResearchLocator | undefined;
  /** The whitespace-normalized excerpt actually matched/stored. */
  normalizedExcerpt: string;
}

/**
 * Verify that a model-claimed excerpt exists verbatim (modulo whitespace) in
 * the normalized snapshot, and compute stable character offsets. Unverified
 * excerpts cannot support a final claim (§10).
 */
export const verifyExcerpt = (
  snapshotText: string,
  excerpt: string,
): ExcerptVerification => {
  const normalizedExcerpt = normalizeWhitespace(excerpt).slice(
    0,
    EVIDENCE_EXCERPT_MAX_CHARS,
  );
  if (normalizedExcerpt.length === 0) {
    return { verified: false, normalizedExcerpt };
  }
  const normalizedSnapshot = normalizeSnapshotText(snapshotText);
  // Case-sensitive first; case-insensitive fallback tolerates extractor case
  // drift while offsets still index real snapshot content.
  let start = normalizedSnapshot.indexOf(normalizedExcerpt);
  if (start === -1) {
    start = normalizedSnapshot.toLowerCase().indexOf(normalizedExcerpt.toLowerCase());
  }
  if (start === -1) {
    return { verified: false, normalizedExcerpt };
  }
  return {
    verified: true,
    normalizedExcerpt: normalizedSnapshot.slice(start, start + normalizedExcerpt.length),
    locator: {
      kind: 'web_snapshot',
      snapshotSha256: sha256Hex(normalizedSnapshot),
      startChar: start,
      endChar: start + normalizedExcerpt.length,
    },
  };
};

// ─── Evidence identity ──────────────────────────────────────────────────────

/**
 * Idempotency key for evidence inserts: same source, same normalized excerpt,
 * same claim/stance → same hash, so retries and re-extractions cannot
 * duplicate the ledger.
 */
export const evidenceHash = (input: {
  sourceId: string;
  excerpt: string;
  claimKey?: string | undefined;
  stance: EvidenceStance;
}): string =>
  sha256Hex(
    [
      input.sourceId,
      normalizeWhitespace(input.excerpt).toLowerCase(),
      (input.claimKey ?? '').trim().toLowerCase(),
      input.stance,
    ].join('\n'),
  );

// ─── Source independence clustering (§10) ───────────────────────────────────

const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'org.au', 'net.au',
  'co.jp', 'or.jp', 'com.br', 'com.mx', 'co.in', 'co.nz', 'com.sg',
  'com.cn', 'com.hk', 'co.kr', 'co.za',
]);

/** Approximate registrable domain: `docs.example.co.uk` → `example.co.uk`. */
export const registrableDomain = (hostname: string): string => {
  const parts = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  const take = TWO_LEVEL_TLDS.has(lastTwo) ? 3 : 2;
  return parts.slice(-take).join('.');
};

export interface ClusterableSource {
  sourceId: string;
  domain?: string | undefined;
  publisher?: string | undefined;
  contentHash?: string | undefined;
}

/**
 * Assign independence clusters: identical content (mirrors/syndication)
 * clusters together first, then shared publisher, then registrable domain.
 * Sources in one cluster never count as independent corroboration.
 */
export const assignIndependenceClusters = (
  sources: readonly ClusterableSource[],
): Map<string, string> => {
  const clusterByContent = new Map<string, string>();
  const clusterByPublisher = new Map<string, string>();
  const clusterByDomain = new Map<string, string>();
  const out = new Map<string, string>();

  for (const s of sources) {
    let cluster: string | undefined;
    if (s.contentHash) {
      cluster = clusterByContent.get(s.contentHash);
    }
    const publisherKey = s.publisher?.trim().toLowerCase() || undefined;
    if (!cluster && publisherKey) {
      cluster = clusterByPublisher.get(publisherKey);
    }
    const domainKey = s.domain ? registrableDomain(s.domain) : undefined;
    if (!cluster && domainKey) {
      cluster = clusterByDomain.get(domainKey);
    }
    cluster ??= `cluster:${s.sourceId}`;

    if (s.contentHash && !clusterByContent.has(s.contentHash)) {
      clusterByContent.set(s.contentHash, cluster);
    }
    if (publisherKey && !clusterByPublisher.has(publisherKey)) {
      clusterByPublisher.set(publisherKey, cluster);
    }
    if (domainKey && !clusterByDomain.has(domainKey)) {
      clusterByDomain.set(domainKey, cluster);
    }
    out.set(s.sourceId, cluster);
  }
  return out;
};

/** Count independent clusters represented by the given source ids. */
export const independentClusterCount = (
  sourceIds: readonly string[],
  clusters: Map<string, string>,
): number => {
  const seen = new Set<string>();
  for (const id of sourceIds) {
    seen.add(clusters.get(id) ?? `cluster:${id}`);
  }
  return seen.size;
};

// ─── Contradiction grouping (§10) ───────────────────────────────────────────

export interface LedgerEvidence {
  evidenceId: string;
  sourceId: string;
  claimKey?: string | undefined;
  stance: EvidenceStance;
  normalizedValue?: string | undefined;
}

export interface ContradictionCandidate {
  claimKey: string;
  evidenceIds: string[];
  kind: 'stance' | 'value';
}

const normalizeValue = (v: string): string => normalizeWhitespace(v).toLowerCase();

/**
 * Group evidence by claim key and surface incompatibilities: opposing
 * stances, or differing normalized values among supporting evidence. Values
 * are never averaged — a candidate is surfaced for a targeted follow-up.
 */
export const detectContradictions = (
  evidence: readonly LedgerEvidence[],
): ContradictionCandidate[] => {
  const byClaim = new Map<string, LedgerEvidence[]>();
  for (const e of evidence) {
    const key = e.claimKey?.trim().toLowerCase();
    if (!key) continue;
    const list = byClaim.get(key);
    if (list) list.push(e);
    else byClaim.set(key, [e]);
  }

  const candidates: ContradictionCandidate[] = [];
  for (const [claimKey, items] of byClaim) {
    const supports = items.filter((e) => e.stance === 'supports');
    const contradicts = items.filter((e) => e.stance === 'contradicts');
    if (supports.length > 0 && contradicts.length > 0) {
      candidates.push({
        claimKey,
        evidenceIds: [...supports, ...contradicts].map((e) => e.evidenceId),
        kind: 'stance',
      });
      continue;
    }
    const values = new Map<string, string[]>();
    for (const e of supports) {
      if (!e.normalizedValue) continue;
      const v = normalizeValue(e.normalizedValue);
      const list = values.get(v);
      if (list) list.push(e.evidenceId);
      else values.set(v, [e.evidenceId]);
    }
    if (values.size > 1) {
      candidates.push({
        claimKey,
        evidenceIds: [...values.values()].flat(),
        kind: 'value',
      });
    }
  }
  return candidates;
};

// ─── Extraction phase (model call + server-side verification) ───────────────

export interface VerifiedExtraction {
  evidence: ExtractedEvidence;
  locator: ResearchLocator;
  normalizedExcerpt: string;
  evidenceHash: string;
}

export interface ExtractionPhaseResult {
  verified: VerifiedExtraction[];
  /** Model-proposed excerpts that did not exist in the snapshot. */
  rejectedExcerpts: number;
  quality: (typeof extractionOutputSchema)['_output']['quality'];
  note?: string | undefined;
  modelCalls: number;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Run the no-tools extractor over one bounded snapshot, then verify every
 * proposed excerpt against the stored snapshot (§10). Unverifiable excerpts
 * are dropped and counted — they can never support a final claim. Question
 * ids outside the plan are stripped; items left with none are dropped too.
 */
export const runExtractionPhase = async (input: {
  model: ResearchPhaseModel;
  runId: string;
  sessionId: string;
  sourceId: string;
  title?: string | undefined;
  url?: string | undefined;
  snapshotText: string;
  questions: Array<{ id: string; question: string }>;
  signal?: AbortSignal | undefined;
  langfuseTurnContext?: LangfuseTurnContext | undefined;
}): Promise<ExtractionPhaseResult> => {
  const outcome = await callPhaseWithRepair(input.model, extractionOutputSchema, {
    runId: input.runId,
    sessionId: input.sessionId,
    phase: 'extract_evidence',
    systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
    userPrompt: buildExtractorUserPrompt({
      sourceId: input.sourceId,
      title: input.title,
      url: input.url,
      questions: input.questions,
      snapshotText: input.snapshotText,
    }),
    signal: input.signal,
    langfuseTurnContext: input.langfuseTurnContext,
  });

  const validQuestionIds = new Set(input.questions.map((q) => q.id));
  const verified: VerifiedExtraction[] = [];
  let rejectedExcerpts = 0;

  for (const item of outcome.value.evidence) {
    const questionIds = item.questionIds.filter((id) => validQuestionIds.has(id));
    if (questionIds.length === 0) continue;
    const verification = verifyExcerpt(input.snapshotText, item.excerpt);
    if (!verification.verified || !verification.locator) {
      rejectedExcerpts += 1;
      continue;
    }
    const evidence: ExtractedEvidence = { ...item, questionIds };
    verified.push({
      evidence,
      locator: verification.locator,
      normalizedExcerpt: verification.normalizedExcerpt,
      evidenceHash: evidenceHash({
        sourceId: input.sourceId,
        excerpt: verification.normalizedExcerpt,
        claimKey: item.claimKey,
        stance: item.stance,
      }),
    });
  }

  return {
    verified,
    rejectedExcerpts,
    quality: outcome.value.quality,
    note: outcome.value.note,
    modelCalls: outcome.modelCalls,
    usage: outcome.usage,
  };
};
