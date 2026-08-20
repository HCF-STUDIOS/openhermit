import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, ne, notInArray } from 'drizzle-orm';

import type { ResearchStore } from '../interfaces.js';
import type {
  ResearchEvidenceCreateInput,
  ResearchEvidenceRecord,
  ResearchResumePhase,
  ResearchRunCreateInput,
  ResearchRunPatch,
  ResearchRunRecord,
  ResearchRunStatus,
  ResearchSourceCreateInput,
  ResearchSourcePatch,
  ResearchSourceRecord,
  ResearchSourceStatus,
  ResearchStepCreateInput,
  ResearchStepPatch,
  ResearchStepRecord,
  ResearchStepStatus,
  StoreScope,
} from '../types.js';
import {
  researchEvidence,
  researchRuns,
  researchSources,
  researchSteps,
} from '../schema.js';
import type { DrizzleDb } from './index.js';

// Only completed/cancelled are terminal (design §7). failed is retryable and
// budget_exhausted is resumable, so both deliberately stay "active": the run
// keeps the session's one-nonterminal-run slot until the user resumes,
// retries, or cancels it. Freeing the slot earlier would let a new run start
// and a later resume of the old one break the one-run-per-session invariant.
// Must stay in sync with the research_runs_one_active_per_session partial
// unique index predicate in schema.ts.
const TERMINAL_STATUSES: ResearchRunStatus[] = ['completed', 'cancelled'];

const now = (): string => new Date().toISOString();

export class DbResearchStore implements ResearchStore {
  constructor(private readonly db: DrizzleDb) {}

  // ─── Runs ─────────────────────────────────────────────────────────────────

  async createRun(input: ResearchRunCreateInput): Promise<ResearchRunRecord> {
    const ts = now();
    const [inserted] = await this.db
      .insert(researchRuns)
      .values({
        runId: input.runId ?? `rr_${randomUUID()}`,
        agentId: input.agentId,
        sessionId: input.sessionId,
        requestedByUserId: input.requestedByUserId ?? null,
        clientRequestId: input.clientRequestId ?? null,
        status: 'created',
        depth: input.depth,
        objective: input.objective,
        sourcePolicyJson: input.sourcePolicyJson,
        budgetJson: input.budgetJson,
        usageJson: {},
        workingStateJson: {},
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    if (!inserted) throw new Error('research run insert returned no row');
    return toRunRecord(inserted);
  }

  async getRun(scope: StoreScope, runId: string): Promise<ResearchRunRecord | undefined> {
    const rows = await this.db
      .select()
      .from(researchRuns)
      .where(and(eq(researchRuns.agentId, scope.agentId), eq(researchRuns.runId, runId)))
      .limit(1);
    return rows[0] ? toRunRecord(rows[0]) : undefined;
  }

  async getRunByClientRequestId(
    scope: StoreScope,
    sessionId: string,
    clientRequestId: string,
  ): Promise<ResearchRunRecord | undefined> {
    const rows = await this.db
      .select()
      .from(researchRuns)
      .where(
        and(
          eq(researchRuns.agentId, scope.agentId),
          eq(researchRuns.sessionId, sessionId),
          eq(researchRuns.clientRequestId, clientRequestId),
        ),
      )
      .limit(1);
    return rows[0] ? toRunRecord(rows[0]) : undefined;
  }

  async listRuns(
    scope: StoreScope,
    sessionId: string,
    options?: { limit?: number },
  ): Promise<ResearchRunRecord[]> {
    const rows = await this.db
      .select()
      .from(researchRuns)
      .where(
        and(eq(researchRuns.agentId, scope.agentId), eq(researchRuns.sessionId, sessionId)),
      )
      .orderBy(desc(researchRuns.createdAt))
      .limit(options?.limit ?? 50);
    return rows.map(toRunRecord);
  }

  async findActiveRun(
    scope: StoreScope,
    sessionId: string,
  ): Promise<ResearchRunRecord | undefined> {
    const rows = await this.db
      .select()
      .from(researchRuns)
      .where(
        and(
          eq(researchRuns.agentId, scope.agentId),
          eq(researchRuns.sessionId, sessionId),
          notInArray(researchRuns.status, TERMINAL_STATUSES),
        ),
      )
      .limit(1);
    return rows[0] ? toRunRecord(rows[0]) : undefined;
  }

  async listRunsByStatus(
    scope: StoreScope,
    statuses: ResearchRunStatus[],
  ): Promise<ResearchRunRecord[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select()
      .from(researchRuns)
      .where(
        and(eq(researchRuns.agentId, scope.agentId), inArray(researchRuns.status, statuses)),
      )
      .orderBy(desc(researchRuns.updatedAt));
    return rows.map(toRunRecord);
  }

  async transitionRun(
    scope: StoreScope,
    runId: string,
    expectStatus: ResearchRunStatus[],
    patch: ResearchRunPatch,
  ): Promise<ResearchRunRecord | undefined> {
    const [updated] = await this.db
      .update(researchRuns)
      .set({ ...runPatchToSet(patch), updatedAt: now() })
      .where(
        and(
          eq(researchRuns.agentId, scope.agentId),
          eq(researchRuns.runId, runId),
          inArray(researchRuns.status, expectStatus),
        ),
      )
      .returning();
    return updated ? toRunRecord(updated) : undefined;
  }

  async updatePlan(
    scope: StoreScope,
    runId: string,
    expectedVersion: number,
    patch: { planJson: Record<string, unknown>; sourcePolicyJson?: Record<string, unknown> },
  ): Promise<ResearchRunRecord | undefined> {
    const [updated] = await this.db
      .update(researchRuns)
      .set({
        planJson: patch.planJson,
        planVersion: expectedVersion + 1,
        ...(patch.sourcePolicyJson ? { sourcePolicyJson: patch.sourcePolicyJson } : {}),
        updatedAt: now(),
      })
      .where(
        and(
          eq(researchRuns.agentId, scope.agentId),
          eq(researchRuns.runId, runId),
          eq(researchRuns.planVersion, expectedVersion),
        ),
      )
      .returning();
    return updated ? toRunRecord(updated) : undefined;
  }

  async patchRun(scope: StoreScope, runId: string, patch: ResearchRunPatch): Promise<void> {
    await this.db
      .update(researchRuns)
      .set({ ...runPatchToSet(patch), updatedAt: now() })
      .where(and(eq(researchRuns.agentId, scope.agentId), eq(researchRuns.runId, runId)));
  }

  // ─── Steps ────────────────────────────────────────────────────────────────

  async insertStep(
    input: ResearchStepCreateInput,
  ): Promise<{ step: ResearchStepRecord; created: boolean }> {
    const [inserted] = await this.db
      .insert(researchSteps)
      .values({
        stepId: input.stepId ?? `rs_${randomUUID()}`,
        runId: input.runId,
        agentId: input.agentId,
        iteration: input.iteration,
        kind: input.kind,
        status: 'pending',
        dedupeKey: input.dedupeKey,
        questionIds: input.questionIds ?? [],
        inputJson: input.inputJson ?? {},
        summary: input.summary ?? null,
        createdAt: now(),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { step: toStepRecord(inserted), created: true };
    const rows = await this.db
      .select()
      .from(researchSteps)
      .where(
        and(eq(researchSteps.runId, input.runId), eq(researchSteps.dedupeKey, input.dedupeKey)),
      )
      .limit(1);
    if (!rows[0]) throw new Error('research step conflict but no existing row found');
    return { step: toStepRecord(rows[0]), created: false };
  }

  async updateStep(scope: StoreScope, stepId: string, patch: ResearchStepPatch): Promise<void> {
    await this.db
      .update(researchSteps)
      .set(stepPatchToSet(patch))
      .where(and(eq(researchSteps.agentId, scope.agentId), eq(researchSteps.stepId, stepId)));
  }

  async listSteps(
    scope: StoreScope,
    runId: string,
    options?: { limit?: number },
  ): Promise<ResearchStepRecord[]> {
    const rows = await this.db
      .select()
      .from(researchSteps)
      .where(and(eq(researchSteps.agentId, scope.agentId), eq(researchSteps.runId, runId)))
      .orderBy(researchSteps.createdAt, researchSteps.stepId)
      .limit(options?.limit ?? 500);
    return rows.map(toStepRecord);
  }

  async markRunningStepsInterrupted(scope: StoreScope, runId: string): Promise<number> {
    const rows = await this.db
      .update(researchSteps)
      .set({ status: 'interrupted', completedAt: now() })
      .where(
        and(
          eq(researchSteps.agentId, scope.agentId),
          eq(researchSteps.runId, runId),
          eq(researchSteps.status, 'running'),
        ),
      )
      .returning({ stepId: researchSteps.stepId });
    return rows.length;
  }

  async invalidatePendingSteps(scope: StoreScope, runId: string): Promise<number> {
    const rows = await this.db
      .update(researchSteps)
      .set({ status: 'invalidated', completedAt: now() })
      .where(
        and(
          eq(researchSteps.agentId, scope.agentId),
          eq(researchSteps.runId, runId),
          eq(researchSteps.status, 'pending'),
        ),
      )
      .returning({ stepId: researchSteps.stepId });
    return rows.length;
  }

  // ─── Sources ──────────────────────────────────────────────────────────────

  async completeSearchStep(
    scope: StoreScope,
    stepId: string,
    stepPatch: ResearchStepPatch,
    candidates: ResearchSourceCreateInput[],
  ): Promise<Array<{ source: ResearchSourceRecord; created: boolean }>> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(researchSteps)
        .set(stepPatchToSet(stepPatch))
        .where(and(eq(researchSteps.agentId, scope.agentId), eq(researchSteps.stepId, stepId)));

      if (candidates.length === 0) return [];
      const ts = now();

      // Dedupe within the batch by canonical hash so ON CONFLICT never sees
      // two rows racing for the same arbiter within one INSERT.
      const seen = new Set<string>();
      const values = [];
      for (const c of candidates) {
        if (c.canonicalUrlHash) {
          if (seen.has(c.canonicalUrlHash)) continue;
          seen.add(c.canonicalUrlHash);
        }
        values.push({
          sourceId: c.sourceId ?? `rsrc_${randomUUID()}`,
          runId: c.runId,
          agentId: c.agentId,
          kind: c.kind ?? 'web',
          status: 'candidate' as const,
          url: c.url ?? null,
          canonicalUrl: c.canonicalUrl ?? null,
          canonicalUrlHash: c.canonicalUrlHash ?? null,
          title: c.title ?? null,
          publisher: c.publisher ?? null,
          domain: c.domain ?? null,
          publishedAt: c.publishedAt ?? null,
          metadataJson: c.metadataJson ?? {},
          discoveredByStepId: c.discoveredByStepId,
          createdAt: ts,
          updatedAt: ts,
        });
      }

      const inserted = await tx
        .insert(researchSources)
        .values(values)
        .onConflictDoNothing()
        .returning();
      const byHash = new Map(
        inserted
          .filter((r) => r.canonicalUrlHash)
          .map((r) => [r.canonicalUrlHash as string, r]),
      );

      // Re-select rows whose insert was skipped by the canonical-hash dedupe.
      const missingHashes = values
        .map((v) => v.canonicalUrlHash)
        .filter((h): h is string => h !== null && !byHash.has(h));
      const existing = missingHashes.length
        ? await tx
            .select()
            .from(researchSources)
            .where(
              and(
                eq(researchSources.runId, values[0]!.runId),
                inArray(researchSources.canonicalUrlHash, missingHashes),
              ),
            )
        : [];

      const insertedNoHash = inserted.filter((r) => !r.canonicalUrlHash);
      return [
        ...[...inserted.filter((r) => r.canonicalUrlHash), ...insertedNoHash].map((r) => ({
          source: toSourceRecord(r),
          created: true,
        })),
        ...existing.map((r) => ({ source: toSourceRecord(r), created: false })),
      ];
    });
  }

  async getSource(
    scope: StoreScope,
    runId: string,
    sourceId: string,
  ): Promise<ResearchSourceRecord | undefined> {
    const rows = await this.db
      .select()
      .from(researchSources)
      .where(
        and(
          eq(researchSources.agentId, scope.agentId),
          eq(researchSources.runId, runId),
          eq(researchSources.sourceId, sourceId),
        ),
      )
      .limit(1);
    return rows[0] ? toSourceRecord(rows[0]) : undefined;
  }

  async listSources(
    scope: StoreScope,
    runId: string,
    options?: { status?: string; limit?: number },
  ): Promise<ResearchSourceRecord[]> {
    const conditions = [
      eq(researchSources.agentId, scope.agentId),
      eq(researchSources.runId, runId),
    ];
    if (options?.status) conditions.push(eq(researchSources.status, options.status));
    const rows = await this.db
      .select()
      .from(researchSources)
      .where(and(...conditions))
      .orderBy(researchSources.createdAt, researchSources.sourceId)
      .limit(options?.limit ?? 500);
    return rows.map(toSourceRecord);
  }

  async updateSource(
    scope: StoreScope,
    sourceId: string,
    patch: ResearchSourcePatch,
  ): Promise<void> {
    await this.db
      .update(researchSources)
      .set({ ...sourcePatchToSet(patch), updatedAt: now() })
      .where(
        and(eq(researchSources.agentId, scope.agentId), eq(researchSources.sourceId, sourceId)),
      );
  }

  async findSourceByContentHash(
    scope: StoreScope,
    runId: string,
    contentHash: string,
    excludeSourceId?: string,
  ): Promise<ResearchSourceRecord | undefined> {
    const conditions = [
      eq(researchSources.agentId, scope.agentId),
      eq(researchSources.runId, runId),
      eq(researchSources.contentHash, contentHash),
    ];
    if (excludeSourceId) conditions.push(ne(researchSources.sourceId, excludeSourceId));
    const rows = await this.db
      .select()
      .from(researchSources)
      .where(and(...conditions))
      .orderBy(researchSources.createdAt)
      .limit(1);
    return rows[0] ? toSourceRecord(rows[0]) : undefined;
  }

  // ─── Evidence ─────────────────────────────────────────────────────────────

  async insertEvidence(
    inputs: ResearchEvidenceCreateInput[],
  ): Promise<ResearchEvidenceRecord[]> {
    if (inputs.length === 0) return [];
    const ts = now();

    // One run per batch — the hash-recovery query below and the source check
    // both key off the first input's run.
    const { runId, agentId } = inputs[0]!;
    for (const e of inputs) {
      if (e.runId !== runId || e.agentId !== agentId) {
        throw new Error('insertEvidence batch must belong to a single run');
      }
    }

    // Citations resolve evidenceId → sourceId → source metadata (design §11:
    // "server validates IDs and source ownership") and there is no FK to
    // catch a dangling or cross-run sourceId, so reject it here. Verbatim
    // excerpt verification intentionally stays in the extraction pipeline
    // (evidence-ledger.ts), which owns the snapshot-normalization rules that
    // check depends on.
    const sourceIds = [...new Set(inputs.map((e) => e.sourceId))];
    const knownRows = await this.db
      .select({ sourceId: researchSources.sourceId })
      .from(researchSources)
      .where(
        and(
          eq(researchSources.agentId, agentId),
          eq(researchSources.runId, runId),
          inArray(researchSources.sourceId, sourceIds),
        ),
      );
    const knownIds = new Set(knownRows.map((r) => r.sourceId));
    const unknownIds = sourceIds.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(
        `evidence rejected: source(s) not in run ${runId}: ${unknownIds.join(', ')}`,
      );
    }

    const seen = new Set<string>();
    const values = [];
    for (const e of inputs) {
      if (seen.has(e.evidenceHash)) continue;
      seen.add(e.evidenceHash);
      values.push({
        evidenceId: e.evidenceId ?? `rev_${randomUUID()}`,
        runId: e.runId,
        agentId: e.agentId,
        sourceId: e.sourceId,
        extractionStepId: e.extractionStepId,
        questionIds: e.questionIds,
        excerpt: e.excerpt,
        locatorJson: e.locatorJson,
        claimKey: e.claimKey ?? null,
        stance: e.stance,
        normalizedValue: e.normalizedValue ?? null,
        scopeJson: e.scopeJson ?? {},
        relevanceBasisPoints: e.relevanceBasisPoints ?? 5000,
        confidenceBasisPoints: e.confidenceBasisPoints ?? 5000,
        evidenceHash: e.evidenceHash,
        createdAt: ts,
      });
    }

    const inserted = await this.db
      .insert(researchEvidence)
      .values(values)
      .onConflictDoNothing()
      .returning();
    if (inserted.length === values.length) return inserted.map(toEvidenceRecord);

    const insertedHashes = new Set(inserted.map((r) => r.evidenceHash));
    const missing = values
      .map((v) => v.evidenceHash)
      .filter((h) => !insertedHashes.has(h));
    const existing = await this.db
      .select()
      .from(researchEvidence)
      .where(
        and(
          eq(researchEvidence.runId, values[0]!.runId),
          inArray(researchEvidence.evidenceHash, missing),
        ),
      );
    return [...inserted, ...existing].map(toEvidenceRecord);
  }

  async listEvidence(
    scope: StoreScope,
    runId: string,
    options?: { sourceId?: string; includeOutOfScope?: boolean },
  ): Promise<ResearchEvidenceRecord[]> {
    const conditions = [
      eq(researchEvidence.agentId, scope.agentId),
      eq(researchEvidence.runId, runId),
    ];
    if (options?.sourceId) conditions.push(eq(researchEvidence.sourceId, options.sourceId));
    if (!options?.includeOutOfScope) conditions.push(eq(researchEvidence.outOfScope, false));
    const rows = await this.db
      .select()
      .from(researchEvidence)
      .where(and(...conditions))
      .orderBy(researchEvidence.createdAt, researchEvidence.evidenceId);
    return rows.map(toEvidenceRecord);
  }

  async markEvidenceOutOfScope(
    scope: StoreScope,
    runId: string,
    evidenceIds: string[],
  ): Promise<void> {
    if (evidenceIds.length === 0) return;
    await this.db
      .update(researchEvidence)
      .set({ outOfScope: true })
      .where(
        and(
          eq(researchEvidence.agentId, scope.agentId),
          eq(researchEvidence.runId, runId),
          inArray(researchEvidence.evidenceId, evidenceIds),
        ),
      );
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  async deleteBySession(scope: StoreScope, sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const runs = await tx
        .select({ runId: researchRuns.runId })
        .from(researchRuns)
        .where(
          and(eq(researchRuns.agentId, scope.agentId), eq(researchRuns.sessionId, sessionId)),
        );
      const runIds = runs.map((r) => r.runId);
      if (runIds.length === 0) return;
      await tx.delete(researchEvidence).where(inArray(researchEvidence.runId, runIds));
      await tx.delete(researchSources).where(inArray(researchSources.runId, runIds));
      await tx.delete(researchSteps).where(inArray(researchSteps.runId, runIds));
      await tx.delete(researchRuns).where(inArray(researchRuns.runId, runIds));
    });
  }
}

// ─── Row ↔ record mapping ────────────────────────────────────────────────────

const toRunRecord = (row: typeof researchRuns.$inferSelect): ResearchRunRecord => ({
  runId: row.runId,
  agentId: row.agentId,
  sessionId: row.sessionId,
  requestedByUserId: row.requestedByUserId,
  clientRequestId: row.clientRequestId,
  status: row.status as ResearchRunStatus,
  resumePhase: row.resumePhase as ResearchResumePhase | null,
  terminalReason: row.terminalReason,
  depth: row.depth,
  objective: row.objective,
  planJson: row.planJson ?? null,
  planVersion: row.planVersion,
  sourcePolicyJson: row.sourcePolicyJson,
  budgetJson: row.budgetJson,
  usageJson: row.usageJson,
  workingStateJson: row.workingStateJson,
  reportJson: row.reportJson ?? null,
  pauseRequested: row.pauseRequested,
  cancelRequested: row.cancelRequested,
  lastError: row.lastError,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

const runPatchToSet = (
  patch: ResearchRunPatch,
): Partial<typeof researchRuns.$inferInsert> => {
  const set: Partial<typeof researchRuns.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.resumePhase !== undefined) set.resumePhase = patch.resumePhase;
  if (patch.terminalReason !== undefined) set.terminalReason = patch.terminalReason;
  if (patch.planJson !== undefined) set.planJson = patch.planJson;
  if (patch.planVersion !== undefined) set.planVersion = patch.planVersion;
  if (patch.sourcePolicyJson !== undefined) set.sourcePolicyJson = patch.sourcePolicyJson;
  if (patch.budgetJson !== undefined) set.budgetJson = patch.budgetJson;
  if (patch.usageJson !== undefined) set.usageJson = patch.usageJson;
  if (patch.workingStateJson !== undefined) set.workingStateJson = patch.workingStateJson;
  if (patch.reportJson !== undefined) set.reportJson = patch.reportJson;
  if (patch.pauseRequested !== undefined) set.pauseRequested = patch.pauseRequested;
  if (patch.cancelRequested !== undefined) set.cancelRequested = patch.cancelRequested;
  if (patch.lastError !== undefined) set.lastError = patch.lastError;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  return set;
};

const toStepRecord = (row: typeof researchSteps.$inferSelect): ResearchStepRecord => ({
  stepId: row.stepId,
  runId: row.runId,
  agentId: row.agentId,
  iteration: row.iteration,
  attempt: row.attempt,
  kind: row.kind,
  status: row.status as ResearchStepStatus,
  dedupeKey: row.dedupeKey,
  questionIds: row.questionIds,
  inputJson: row.inputJson,
  outputJson: row.outputJson,
  usageJson: row.usageJson,
  summary: row.summary,
  error: row.error,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

const stepPatchToSet = (
  patch: ResearchStepPatch,
): Partial<typeof researchSteps.$inferInsert> => {
  const set: Partial<typeof researchSteps.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.attempt !== undefined) set.attempt = patch.attempt;
  if (patch.outputJson !== undefined) set.outputJson = patch.outputJson;
  if (patch.usageJson !== undefined) set.usageJson = patch.usageJson;
  if (patch.summary !== undefined) set.summary = patch.summary;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  return set;
};

const toSourceRecord = (row: typeof researchSources.$inferSelect): ResearchSourceRecord => ({
  sourceId: row.sourceId,
  runId: row.runId,
  agentId: row.agentId,
  kind: row.kind,
  status: row.status as ResearchSourceStatus,
  url: row.url,
  canonicalUrl: row.canonicalUrl,
  canonicalUrlHash: row.canonicalUrlHash,
  title: row.title,
  publisher: row.publisher,
  domain: row.domain,
  author: row.author,
  publishedAt: row.publishedAt,
  retrievedAt: row.retrievedAt,
  mimeType: row.mimeType,
  sourceClass: row.sourceClass,
  qualityJson: row.qualityJson,
  metadataJson: row.metadataJson,
  discoveredByStepId: row.discoveredByStepId,
  snapshotText: row.snapshotText,
  contentHash: row.contentHash,
  contentBytes: row.contentBytes,
  truncated: row.truncated,
  duplicateOfSourceId: row.duplicateOfSourceId,
  lastError: row.lastError,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const sourcePatchToSet = (
  patch: ResearchSourcePatch,
): Partial<typeof researchSources.$inferInsert> => {
  const set: Partial<typeof researchSources.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.canonicalUrl !== undefined) set.canonicalUrl = patch.canonicalUrl;
  if (patch.canonicalUrlHash !== undefined) set.canonicalUrlHash = patch.canonicalUrlHash;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.publisher !== undefined) set.publisher = patch.publisher;
  if (patch.domain !== undefined) set.domain = patch.domain;
  if (patch.author !== undefined) set.author = patch.author;
  if (patch.publishedAt !== undefined) set.publishedAt = patch.publishedAt;
  if (patch.retrievedAt !== undefined) set.retrievedAt = patch.retrievedAt;
  if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
  if (patch.sourceClass !== undefined) set.sourceClass = patch.sourceClass;
  if (patch.qualityJson !== undefined) set.qualityJson = patch.qualityJson;
  if (patch.metadataJson !== undefined) set.metadataJson = patch.metadataJson;
  if (patch.snapshotText !== undefined) set.snapshotText = patch.snapshotText;
  if (patch.contentHash !== undefined) set.contentHash = patch.contentHash;
  if (patch.contentBytes !== undefined) set.contentBytes = patch.contentBytes;
  if (patch.truncated !== undefined) set.truncated = patch.truncated;
  if (patch.duplicateOfSourceId !== undefined) set.duplicateOfSourceId = patch.duplicateOfSourceId;
  if (patch.lastError !== undefined) set.lastError = patch.lastError;
  return set;
};

const toEvidenceRecord = (
  row: typeof researchEvidence.$inferSelect,
): ResearchEvidenceRecord => ({
  evidenceId: row.evidenceId,
  runId: row.runId,
  agentId: row.agentId,
  sourceId: row.sourceId,
  extractionStepId: row.extractionStepId,
  questionIds: row.questionIds,
  excerpt: row.excerpt,
  locatorJson: row.locatorJson,
  claimKey: row.claimKey,
  stance: row.stance,
  normalizedValue: row.normalizedValue,
  scopeJson: row.scopeJson,
  relevanceBasisPoints: row.relevanceBasisPoints,
  confidenceBasisPoints: row.confidenceBasisPoints,
  outOfScope: row.outOfScope,
  evidenceHash: row.evidenceHash,
  createdAt: row.createdAt,
});
