import { z } from 'zod';

/**
 * Deep Research engine contracts.
 *
 * Zod schemas validate everything a model emits (plan, actions, evidence
 * extraction, report) before the orchestrator acts on it — the model never
 * feeds unvalidated output into execution. Plain types describe engine state
 * that only the program produces. Wire/protocol shapes live in
 * `@openhermit/protocol`; durable row shapes live in `@openhermit/store`.
 */

// ─── Statuses and lifecycle ─────────────────────────────────────────────────

export const RESEARCH_RUN_STATUSES = [
  'created',
  'planning',
  'awaiting_plan_approval',
  'queued',
  'researching',
  'synthesizing',
  'paused',
  'completed',
  'cancelled',
  'failed',
  'budget_exhausted',
] as const;

export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

/** Terminal: no transition out. */
export const TERMINAL_RESEARCH_STATUSES: readonly ResearchRunStatus[] = [
  'completed',
  'cancelled',
];

/** Stopped but resumable through explicit user action. */
export const STOPPED_RESEARCH_STATUSES: readonly ResearchRunStatus[] = [
  'paused',
  'failed',
  'budget_exhausted',
];

/** Actively executing on the runner — chat turns conflict (409). */
export const ACTIVE_RESEARCH_STATUSES: readonly ResearchRunStatus[] = [
  'planning',
  'researching',
  'synthesizing',
];

export type ResearchResumePhase = 'planning' | 'researching' | 'synthesizing';

export type ResearchDepth = 'quick' | 'standard' | 'thorough';

// ─── Source policy (user-controlled, planner cannot loosen) ────────────────

export interface ResearchSourcePolicy {
  web: {
    mode: 'full_web' | 'only_domains' | 'prefer_domains';
    domains: string[];
    excludedDomains: string[];
  };
  /** Accepted by contract, activated in Phase 4. */
  attachmentIds: string[];
  /** Accepted by contract, activated in Phase 4. */
  mcpServerIds: string[];
  allowCodeAnalysis: boolean;
}

export const DEFAULT_SOURCE_POLICY: ResearchSourcePolicy = {
  web: { mode: 'full_web', domains: [], excludedDomains: [] },
  attachmentIds: [],
  mcpServerIds: [],
  allowCodeAnalysis: false,
};

// ─── Budgets ────────────────────────────────────────────────────────────────

export interface ResearchBudgetLimits {
  iterations: number;
  searches: number;
  fetchedSources: number;
  modelCalls: number;
  elapsedMs: number;
  bytesPerSource: number;
  bytesPerRun: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ResearchUsage {
  iterations: number;
  searches: number;
  fetchedSources: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  retries: number;
  snapshotBytes: number;
  costUsd: number | null;
  evidenceItems: number;
  sources: number;
}

export const zeroResearchUsage = (): ResearchUsage => ({
  iterations: 0,
  searches: 0,
  fetchedSources: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheTokens: 0,
  retries: 0,
  snapshotBytes: 0,
  costUsd: null,
  evidenceItems: 0,
  sources: 0,
});

// ─── Source and evidence (engine view) ─────────────────────────────────────

export const RESEARCH_SOURCE_CLASSES = [
  'primary',
  'official',
  'academic',
  'reputable_secondary',
  'aggregator',
  'user_generated',
  'unknown',
] as const;

export type ResearchSourceClass = (typeof RESEARCH_SOURCE_CLASSES)[number];

export type ResearchSourceKind = 'web' | 'attachment' | 'mcp' | 'api' | 'analysis';

export type ResearchSourceStatus =
  | 'candidate'
  | 'fetched'
  | 'blocked'
  | 'failed'
  | 'unsupported'
  | 'duplicate';

export interface SourceQualityAssessment {
  sourceClass: ResearchSourceClass;
  authority: 'high' | 'medium' | 'low' | 'unknown';
  proximityToClaim: 'direct' | 'reported' | 'derived' | 'unknown';
  recency: 'current' | 'dated' | 'unknown';
  methodologyTransparency: 'clear' | 'partial' | 'absent' | 'unknown';
  independenceCluster: string;
  notes: string[];
}

export const unknownQuality = (independenceCluster = ''): SourceQualityAssessment => ({
  sourceClass: 'unknown',
  authority: 'unknown',
  proximityToClaim: 'unknown',
  recency: 'unknown',
  methodologyTransparency: 'unknown',
  independenceCluster,
  notes: [],
});

/** Locator into a normalized web snapshot (MVP web-only locator kind). */
export interface ResearchLocator {
  kind: 'web_snapshot';
  snapshotSha256: string;
  /** Character offsets into the whitespace-normalized snapshot text. */
  startChar: number;
  endChar: number;
}

export type EvidenceStance = 'supports' | 'contradicts' | 'context';

// ─── Plan schema (§8 — planner model output) ────────────────────────────────

const nonEmpty = z.string().trim().min(1);

export const researchPlanQuestionSchema = z.object({
  id: nonEmpty.max(64),
  question: nonEmpty.max(1_000),
  priority: z.enum(['required', 'supporting']),
  rationale: z.string().max(2_000).default(''),
  preferredSourceKinds: z.array(z.enum(RESEARCH_SOURCE_CLASSES)).optional(),
  requiresPrimarySource: z.boolean().optional(),
});

export const researchPlanSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    objective: nonEmpty.max(4_000),
    audience: z.string().max(500).optional(),
    assumptions: z.array(z.string().max(1_000)).default([]),
    scope: z
      .object({
        includedTopics: z.array(z.string().max(500)).default([]),
        excludedTopics: z.array(z.string().max(500)).default([]),
        timeframe: z
          .object({
            from: z.string().max(64).optional(),
            to: z.string().max(64).optional(),
          })
          .optional(),
        geographies: z.array(z.string().max(200)).optional(),
      })
      .default({ includedTopics: [], excludedTopics: [] }),
    questions: z.array(researchPlanQuestionSchema).min(1).max(12),
    deliverable: z.object({
      format: z.literal('report').default('report'),
      requestedSections: z.array(z.string().max(300)).default([]),
      decisionOrOutcome: z.string().max(1_000).optional(),
    }),
    completionCriteria: z.object({
      requiredQuestionIds: z.array(nonEmpty).default([]),
      unresolvedContradictionsAllowed: z.boolean().default(true),
    }),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const q of plan.questions) {
      if (ids.has(q.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate question id "${q.id}"`,
          path: ['questions'],
        });
      }
      ids.add(q.id);
    }
    for (const rid of plan.completionCriteria.requiredQuestionIds) {
      if (!ids.has(rid)) {
        ctx.addIssue({
          code: 'custom',
          message: `completionCriteria references unknown question id "${rid}"`,
          path: ['completionCriteria', 'requiredQuestionIds'],
        });
      }
    }
  });

export type ResearchPlan = z.infer<typeof researchPlanSchema>;

/** Required question ids, defaulting to all `priority: 'required'` questions. */
export const requiredQuestionIds = (plan: ResearchPlan): string[] => {
  if (plan.completionCriteria.requiredQuestionIds.length > 0) {
    return plan.completionCriteria.requiredQuestionIds;
  }
  return plan.questions.filter((q) => q.priority === 'required').map((q) => q.id);
};

// ─── Action schema (§9 — decision model output) ─────────────────────────────

export const researchActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('search'),
    questionIds: z.array(nonEmpty).min(1),
    query: nonEmpty.max(500),
    rationale: z.string().max(500).default(''),
  }),
  z.object({
    type: z.literal('read_source'),
    sourceId: nonEmpty.max(64),
    questionIds: z.array(nonEmpty).min(1),
    rationale: z.string().max(500).default(''),
  }),
  z.object({
    type: z.literal('finish'),
    rationale: z.string().max(500).default(''),
  }),
]);

export type ResearchAction = z.infer<typeof researchActionSchema>;

export const researchDecisionSchema = z.object({
  actions: z.array(researchActionSchema).min(1).max(3),
});

export type ResearchDecision = z.infer<typeof researchDecisionSchema>;

// ─── Evidence extraction schema (§10 — extractor model output) ──────────────

export const extractedEvidenceSchema = z.object({
  questionIds: z.array(nonEmpty).min(1),
  excerpt: nonEmpty.max(1_000),
  claimKey: z.string().max(200).optional(),
  stance: z.enum(['supports', 'contradicts', 'context']).default('context'),
  normalizedValue: z.string().max(500).optional(),
  scope: z
    .object({
      asOf: z.string().max(64).optional(),
      geography: z.string().max(200).optional(),
      population: z.string().max(200).optional(),
      definition: z.string().max(500).optional(),
      methodology: z.string().max(500).optional(),
    })
    .optional(),
  relevanceBasisPoints: z.number().int().min(0).max(10_000).default(5_000),
  confidenceBasisPoints: z.number().int().min(0).max(10_000).default(5_000),
});

export type ExtractedEvidence = z.infer<typeof extractedEvidenceSchema>;

export const sourceQualityAssessmentSchema = z.object({
  sourceClass: z.enum(RESEARCH_SOURCE_CLASSES).default('unknown'),
  authority: z.enum(['high', 'medium', 'low', 'unknown']).default('unknown'),
  proximityToClaim: z.enum(['direct', 'reported', 'derived', 'unknown']).default('unknown'),
  recency: z.enum(['current', 'dated', 'unknown']).default('unknown'),
  methodologyTransparency: z.enum(['clear', 'partial', 'absent', 'unknown']).default('unknown'),
  notes: z.array(z.string().max(500)).max(10).default([]),
});

export const extractionOutputSchema = z.object({
  evidence: z.array(extractedEvidenceSchema).max(20).default([]),
  quality: sourceQualityAssessmentSchema.default({
    sourceClass: 'unknown',
    authority: 'unknown',
    proximityToClaim: 'unknown',
    recency: 'unknown',
    methodologyTransparency: 'unknown',
    notes: [],
  }),
  /** Extractor's short operational note (e.g. "page is a paywall stub"). */
  note: z.string().max(500).optional(),
});

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

// ─── Report schema (§11 — synthesis model output) ───────────────────────────

export const researchStatementSchema = z.object({
  claimId: nonEmpty.max(64),
  kind: z.enum(['finding', 'analysis', 'caveat']),
  text: nonEmpty.max(4_000),
  evidenceIds: z.array(nonEmpty).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});

export type ResearchStatement = z.infer<typeof researchStatementSchema>;

export const researchReportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  title: nonEmpty.max(300),
  executiveSummary: z.array(researchStatementSchema).default([]),
  sections: z
    .array(
      z.object({
        id: nonEmpty.max(64),
        title: nonEmpty.max(300),
        statements: z.array(researchStatementSchema).default([]),
      }),
    )
    .default([]),
  contradictions: z
    .array(
      z.object({
        summary: nonEmpty.max(2_000),
        evidenceIds: z.array(nonEmpty).default([]),
        resolution: z.string().max(2_000).nullable().default(null),
      }),
    )
    .default([]),
  gaps: z
    .array(
      z.object({
        questionId: z.string().max(64).optional(),
        description: nonEmpty.max(2_000),
      }),
    )
    .default([]),
  methodology: z.array(z.string().max(1_000)).default([]),
});

export type ResearchReport = z.infer<typeof researchReportSchema>;

// ─── Adapter contracts (§6) ─────────────────────────────────────────────────

export interface ResearchSourceCandidate {
  url: string;
  title?: string | undefined;
  snippet?: string | undefined;
  publishedDate?: string | undefined;
  providerRank?: number | undefined;
  providerScore?: number | undefined;
}

export interface AcquiredResearchSource {
  url: string;
  finalUrl?: string | undefined;
  title?: string | undefined;
  content: string;
  contentBytes: number;
  truncated: boolean;
  canonicalUrl?: string | undefined;
  mimeType?: string | undefined;
  status?: number | undefined;
  publisher?: string | undefined;
  author?: string | undefined;
  publishedAt?: string | undefined;
  retrievedAt: string;
}
