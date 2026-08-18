import { ConflictError, NotFoundError, ValidationError } from '@openhermit/shared';
import type { OutboundEventBody, ResearchProgressPhase } from '@openhermit/protocol';
import type {
  ResearchEvidenceRecord,
  ResearchResumePhase,
  ResearchRunRecord,
  ResearchRunStatus,
  ResearchSourceRecord,
  ResearchStepRecord,
  ResearchStore,
  StoreScope,
} from '@openhermit/store';

import type { LangfuseClientLike, LangfuseTurnContext } from '../langfuse.js';
import {
  researchActionsTotal,
  researchActiveRuns,
  researchBudgetExhaustionsTotal,
  researchRetriesTotal,
  researchRunDuration,
  researchRunsTotal,
  researchSourcesTotal,
  researchTokensTotal,
} from '../metrics.js';
import type { WebFetchOptions, WebFetchResult, WebSearchOptions, WebSearchResult } from '../web/types.js';

import {
  DEFAULT_SOURCE_POLICY,
  requiredQuestionIds,
  zeroResearchUsage,
  type ResearchAction,
  type ResearchBudgetLimits,
  type ResearchDepth,
  type ResearchPlan,
  type ResearchSourcePolicy,
  type ResearchUsage,
  researchPlanSchema,
  researchDecisionSchema,
} from './contracts.js';
import {
  GainTracker,
  RESEARCH_BUDGET_PRESETS,
  ResearchBudget,
  assertTransition,
  canonicalUrlHash,
  evaluateFinishGate,
  increaseBudgetLimits,
  isTerminalStatus,
  normalizeUrl,
  queryFingerprint,
  type BudgetDimension,
  type ContradictionStatus,
} from './guards.js';
import {
  contentHash,
  detectContradictions,
  normalizeSnapshotText,
  runExtractionPhase,
} from './evidence-ledger.js';
import {
  ResearchActionError,
  executeReadAction,
  executeSearchAction,
  runReadsWithDomainLimit,
  validateActions,
  type ExecutorDeps,
  type KnownSourceView,
} from './executor.js';
import { callPhaseWithRepair, type ResearchPhaseModel } from './model-phase.js';
import { runPlannerPhase } from './planner.js';
import { DECISION_SYSTEM_PROMPT, buildDecisionUserPrompt } from './prompts.js';
import { runSynthesisPhase, sanitizeInline, type SynthesisEvidenceCard } from './synthesis.js';

/**
 * ResearchOrchestrator — the program-controlled Deep Research workflow (§6).
 *
 * Owns the lifecycle state machine, durable checkpoints, budgets, and the
 * bounded plan → approve → search/read/extract → synthesize loop. Models emit
 * validated JSON; this class decides whether actions are allowed and
 * affordable, executes them through policy-scoped web capabilities, and
 * persists every step/source/evidence row before and after execution.
 */

const RESEARCH_SEARCH_TIMEOUT_MS = 30_000;
const RESEARCH_FETCH_TIMEOUT_MS = 45_000;
const SEARCH_RESULT_LIMIT = 8;
const SYSTEMIC_FAILURE_STREAK_LIMIT = 3;
const WORKING_STATE_NOTE_CAP = 30;

interface ResearchWorkingState {
  schemaVersion: 1;
  coveredQuestionIds: string[];
  queryHistory: string[];
  contradictions: Array<{
    claimKey: string;
    resolved: boolean;
    followUpAttempted: boolean;
    evidenceIds: string[];
  }>;
  zeroGainStreak: number;
  iteration: number;
  /** Execution elapsed accumulated across pause/resume boundaries. */
  elapsedMsBefore: number;
  systemicFailureStreak: number;
  seenSourceClasses: string[];
  notes: string[];
}

const initialWorkingState = (): ResearchWorkingState => ({
  schemaVersion: 1,
  coveredQuestionIds: [],
  queryHistory: [],
  contradictions: [],
  zeroGainStreak: 0,
  iteration: 0,
  elapsedMsBefore: 0,
  systemicFailureStreak: 0,
  seenSourceClasses: [],
  notes: [],
});

const parseWorkingState = (raw: Record<string, unknown>): ResearchWorkingState => {
  const base = initialWorkingState();
  if (raw.schemaVersion !== 1) return base;
  return { ...base, ...(raw as unknown as ResearchWorkingState) };
};

class PauseRequested extends Error {
  constructor() {
    super('pause requested');
    this.name = 'PauseRequested';
  }
}

class CancelRequested extends Error {
  constructor() {
    super('cancel requested');
    this.name = 'CancelRequested';
  }
}

interface ActiveExecution {
  runId: string;
  sessionId: string;
  controller: AbortController;
  promise: Promise<void>;
  langfuseTurnContext?: LangfuseTurnContext | undefined;
  releaseBusy?: (() => void) | undefined;
  startedAtMs: number;
}

export interface ResearchOrchestratorDeps {
  agentId: string;
  scope: StoreScope;
  research: ResearchStore;
  /** One bounded, no-tools internal model turn (planner/decision/extract/synthesis). */
  model: ResearchPhaseModel;
  /** Policy-scoped web capabilities; absent when policy denies or no provider. */
  webSearch?: ((query: string, options: WebSearchOptions) => Promise<WebSearchResult[]>) | undefined;
  webFetch?: ((url: string, options: WebFetchOptions) => Promise<WebFetchResult>) | undefined;
  publishEvent: (event: OutboundEventBody) => void;
  /** Deliver the final rendered report as a normal assistant entry. */
  deliverReport: (sessionId: string, markdown: string, runId: string) => Promise<void>;
  log: (message: string) => void;
  langfuse?: LangfuseClientLike | undefined;
  /** Eviction fence: acquire while executing detached phases; returns release. */
  acquireBusy?: (() => () => void) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  /** Executing runs per agent (default 1); additional approved runs stay queued. */
  maxConcurrentRuns?: number | undefined;
  budgetPresets?: Partial<Record<ResearchDepth, ResearchBudgetLimits>> | undefined;
}

export interface CreateResearchRunInput {
  sessionId: string;
  objective: string;
  depth?: ResearchDepth | undefined;
  sourcePolicy?: Partial<ResearchSourcePolicy> | undefined;
  clientRequestId?: string | undefined;
  requestedByUserId?: string | undefined;
}

const sanitizeError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

const mergeSourcePolicy = (
  partial: Partial<ResearchSourcePolicy> | undefined,
): ResearchSourcePolicy => ({
  web: {
    mode: partial?.web?.mode ?? DEFAULT_SOURCE_POLICY.web.mode,
    domains: partial?.web?.domains ?? [],
    excludedDomains: partial?.web?.excludedDomains ?? [],
  },
  attachmentIds: partial?.attachmentIds ?? [],
  mcpServerIds: partial?.mcpServerIds ?? [],
  allowCodeAnalysis: partial?.allowCodeAnalysis ?? false,
});

export class ResearchOrchestrator {
  private readonly executions = new Map<string, ActiveExecution>();

  private readonly executionsBySession = new Map<string, string>();

  /** Per-run serialization of the content-hash dedupe critical section. */
  private readonly dedupeChains = new Map<string, Promise<void>>();

  /** Serialization of queued-run scheduling passes (see maybeStartQueued). */
  private schedulerChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ResearchOrchestratorDeps) {}

  /**
   * Serialize the mirror-detection check-then-write per run: two concurrent
   * cross-domain reads of identical content would otherwise both pass the
   * "no mirror yet" check before either writes its hash, and mirrors would
   * count as independent sources (§10).
   */
  private withDedupeLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.dedupeChains.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.dedupeChains.set(runId, next.then(() => undefined, () => undefined));
    return next;
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get maxConcurrent(): number {
    return this.deps.maxConcurrentRuns ?? 1;
  }

  private presets(depth: ResearchDepth): ResearchBudgetLimits {
    return this.deps.budgetPresets?.[depth] ?? RESEARCH_BUDGET_PRESETS[depth];
  }

  // ─── Public API (runtime contract) ─────────────────────────────────────────

  /** RunId currently executing (planning/researching/synthesizing) for a session. */
  getActiveExecution(sessionId: string): string | undefined {
    return this.executionsBySession.get(sessionId);
  }

  async createRun(input: CreateResearchRunInput): Promise<ResearchRunRecord> {
    if (input.clientRequestId) {
      const existing = await this.deps.research.getRunByClientRequestId(
        this.deps.scope,
        input.sessionId,
        input.clientRequestId,
      );
      if (existing) return existing;
    }
    const active = await this.deps.research.findActiveRun(this.deps.scope, input.sessionId);
    if (active) {
      throw new ConflictError(
        `research_run_active: run ${active.runId} is ${active.status} in this session`,
      );
    }

    const objective = input.objective.trim();
    if (objective.length === 0) throw new ValidationError('objective is required');
    const depth: ResearchDepth = input.depth ?? 'standard';
    const sourcePolicy = mergeSourcePolicy(input.sourcePolicy);
    const budget = this.presets(depth);

    let run: ResearchRunRecord;
    try {
      run = await this.deps.research.createRun({
        agentId: this.deps.agentId,
        sessionId: input.sessionId,
        requestedByUserId: input.requestedByUserId ?? null,
        clientRequestId: input.clientRequestId ?? null,
        depth,
        objective,
        sourcePolicyJson: sourcePolicy as unknown as Record<string, unknown>,
        budgetJson: budget as unknown as Record<string, unknown>,
      });
    } catch (err) {
      // Lost a race against another create — the partial unique index is the
      // arbiter. Surface as the same 409 the pre-check produces.
      const message = err instanceof Error ? err.message : String(err);
      if (/research_runs_one_active_per_session|research_runs_client_request_unique/.test(message)) {
        throw new ConflictError('research_run_active: another run was just created');
      }
      throw err;
    }

    this.startPlanning(run.runId, input.sessionId);
    return run;
  }

  async getRun(runId: string): Promise<ResearchRunRecord> {
    const run = await this.deps.research.getRun(this.deps.scope, runId);
    if (!run) throw new NotFoundError(`Research run not found: ${runId}`);
    return run;
  }

  async listRuns(sessionId: string): Promise<ResearchRunRecord[]> {
    return this.deps.research.listRuns(this.deps.scope, sessionId);
  }

  async listSteps(runId: string): Promise<ResearchStepRecord[]> {
    await this.getRun(runId);
    return this.deps.research.listSteps(this.deps.scope, runId);
  }

  async listSources(runId: string): Promise<ResearchSourceRecord[]> {
    await this.getRun(runId);
    return this.deps.research.listSources(this.deps.scope, runId);
  }

  async getSourceDetail(
    runId: string,
    sourceId: string,
  ): Promise<{ source: ResearchSourceRecord; evidence: ResearchEvidenceRecord[] }> {
    const source = await this.deps.research.getSource(this.deps.scope, runId, sourceId);
    if (!source) throw new NotFoundError(`Research source not found: ${sourceId}`);
    const evidence = await this.deps.research.listEvidence(this.deps.scope, runId, {
      sourceId,
      includeOutOfScope: true,
    });
    return { source, evidence };
  }

  async updatePlan(
    runId: string,
    expectedVersion: number,
    plan: unknown,
    sourcePolicy?: Partial<ResearchSourcePolicy> | undefined,
  ): Promise<ResearchRunRecord> {
    const run = await this.getRun(runId);
    if (run.status !== 'awaiting_plan_approval') {
      throw new ConflictError(`plan can only be edited while awaiting approval (run is ${run.status})`);
    }
    const parsed = researchPlanSchema.safeParse(plan);
    if (!parsed.success) {
      throw new ValidationError(
        `invalid plan: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const updated = await this.deps.research.updatePlan(this.deps.scope, runId, expectedVersion, {
      planJson: parsed.data as unknown as Record<string, unknown>,
      ...(sourcePolicy
        ? { sourcePolicyJson: mergeSourcePolicy(sourcePolicy) as unknown as Record<string, unknown> }
        : {}),
    });
    if (!updated) {
      throw new ConflictError(
        `plan version conflict: expected ${expectedVersion}, run has ${run.planVersion}`,
      );
    }
    return updated;
  }

  async approvePlan(runId: string, expectedPlanVersion: number): Promise<ResearchRunRecord> {
    const run = await this.getRun(runId);
    if (run.status !== 'awaiting_plan_approval') {
      throw new ConflictError(`run is ${run.status}, not awaiting plan approval`);
    }
    if (run.planVersion !== expectedPlanVersion) {
      throw new ConflictError(
        `plan version conflict: expected ${expectedPlanVersion}, run has ${run.planVersion}`,
      );
    }
    const updated = await this.deps.research.transitionRun(
      this.deps.scope,
      runId,
      ['awaiting_plan_approval'],
      { status: 'queued', resumePhase: 'researching' },
    );
    if (!updated) throw new ConflictError('run state changed during approval');
    this.publishProgress(updated, 'queued', 'Plan approved — research queued');
    this.maybeStartQueued();
    return updated;
  }

  async pause(runId: string): Promise<ResearchRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalStatus(run.status)) {
      throw new ConflictError(`run is already ${run.status}`);
    }
    const execution = this.executions.get(runId);
    if (execution) {
      await this.deps.research.patchRun(this.deps.scope, runId, { pauseRequested: true });
      execution.controller.abort(new PauseRequested());
      await execution.promise;
      return this.getRun(runId);
    }
    const resumePhase = this.resumePhaseFor(run);
    const updated = await this.deps.research.transitionRun(
      this.deps.scope,
      runId,
      ['created', 'awaiting_plan_approval', 'queued'],
      { status: 'paused', resumePhase, pauseRequested: false },
    );
    if (!updated) throw new ConflictError(`cannot pause run in status ${run.status}`);
    this.publishProgress(updated, 'paused', 'Research paused');
    return updated;
  }

  async resume(runId: string): Promise<ResearchRunRecord> {
    const run = await this.getRun(runId);
    if (!['paused', 'failed', 'budget_exhausted'].includes(run.status)) {
      throw new ConflictError(`run is ${run.status}; only paused/failed/budget_exhausted resume`);
    }
    const budget = new ResearchBudget(
      run.budgetJson as unknown as ResearchBudgetLimits,
      run.usageJson && Object.keys(run.usageJson).length > 0
        ? (run.usageJson as unknown as ResearchUsage)
        : zeroResearchUsage(),
    );
    if (run.status === 'budget_exhausted') {
      const exhausted = budget.exhaustedDimension();
      if (exhausted) {
        throw new ConflictError(
          `budget dimension "${exhausted}" is still exhausted — increase the budget first`,
        );
      }
    }

    const phase = this.resumePhaseFor(run);
    if (phase === 'planning') {
      const updated = await this.transitionOrConflict(run, 'planning', {
        pauseRequested: false,
        cancelRequested: false,
        lastError: null,
      });
      this.startPlanning(runId, run.sessionId);
      return updated;
    }
    if (phase === 'synthesizing') {
      const updated = await this.transitionOrConflict(run, 'synthesizing', {
        pauseRequested: false,
        cancelRequested: false,
        lastError: null,
      });
      // `partial` is recomputed from the finish gate inside runSynthesis.
      this.startDetached(updated, (signal, lf) => this.runSynthesis(updated, signal, lf, undefined));
      return updated;
    }
    if (phase === null) {
      // Paused before approval — return to plan review.
      return this.transitionOrConflict(run, 'awaiting_plan_approval', {
        pauseRequested: false,
        cancelRequested: false,
      });
    }
    const updated = await this.transitionOrConflict(run, 'queued', {
      pauseRequested: false,
      cancelRequested: false,
      lastError: null,
    });
    this.publishProgress(updated, 'queued', 'Research resuming');
    this.maybeStartQueued();
    return updated;
  }

  async retry(runId: string): Promise<ResearchRunRecord> {
    const run = await this.getRun(runId);
    if (run.status !== 'failed') {
      throw new ConflictError(`retry applies to failed runs; run is ${run.status}`);
    }
    return this.resume(runId);
  }

  async cancel(runId: string): Promise<ResearchRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalStatus(run.status)) {
      throw new ConflictError(`run is already ${run.status}`);
    }
    const execution = this.executions.get(runId);
    if (execution) {
      await this.deps.research.patchRun(this.deps.scope, runId, { cancelRequested: true });
      execution.controller.abort(new CancelRequested());
      await execution.promise;
      return this.getRun(runId);
    }
    await this.deps.research.markRunningStepsInterrupted(this.deps.scope, runId);
    await this.deps.research.invalidatePendingSteps(this.deps.scope, runId);
    const updated = await this.deps.research.transitionRun(
      this.deps.scope,
      runId,
      ['created', 'planning', 'awaiting_plan_approval', 'queued', 'paused', 'failed', 'budget_exhausted'],
      {
        status: 'cancelled',
        cancelRequested: false,
        terminalReason: 'user_cancelled',
        completedAt: new Date(this.now).toISOString(),
      },
    );
    if (!updated) throw new ConflictError('run state changed during cancel');
    researchRunsTotal.inc({ agent_id: this.deps.agentId, status: 'cancelled' });
    this.publishProgress(updated, 'failed', 'Research cancelled');
    return updated;
  }

  async refine(runId: string, instruction: string): Promise<ResearchRunRecord> {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) throw new ValidationError('refinement instruction is required');
    let run = await this.getRun(runId);
    if (isTerminalStatus(run.status)) {
      throw new ConflictError(
        `run is ${run.status}; start a new run to refine a completed report`,
      );
    }
    const execution = this.executions.get(runId);
    if (execution) {
      await this.deps.research.patchRun(this.deps.scope, runId, { pauseRequested: true });
      execution.controller.abort(new PauseRequested());
      await execution.promise;
      run = await this.getRun(runId);
    }
    await this.deps.research.invalidatePendingSteps(this.deps.scope, runId);
    const updated = await this.deps.research.transitionRun(
      this.deps.scope,
      runId,
      ['paused', 'awaiting_plan_approval', 'queued', 'failed', 'budget_exhausted', 'created'],
      { status: 'planning', pauseRequested: false, lastError: null },
    );
    if (!updated) throw new ConflictError('run state changed during refinement');
    this.startPlanning(runId, run.sessionId, trimmed);
    return updated;
  }

  async increaseBudget(
    runId: string,
    limits: Partial<ResearchBudgetLimits>,
  ): Promise<ResearchRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalStatus(run.status)) {
      throw new ConflictError(`run is already ${run.status}`);
    }
    const next = increaseBudgetLimits(
      run.budgetJson as unknown as ResearchBudgetLimits,
      limits,
    );
    await this.deps.research.patchRun(this.deps.scope, runId, {
      budgetJson: next as unknown as Record<string, unknown>,
    });
    return this.getRun(runId);
  }

  /** Graceful shutdown: pause everything actively executing. */
  async shutdown(): Promise<void> {
    const active = [...this.executions.values()];
    for (const execution of active) {
      await this.deps.research.patchRun(this.deps.scope, execution.runId, {
        pauseRequested: true,
      });
      execution.controller.abort(new PauseRequested());
    }
    await Promise.allSettled(active.map((e) => e.promise));
  }

  /**
   * Hydration reconciliation: stale active rows from an unclean restart
   * become paused with reason runtime_restart (§15).
   */
  async reconcileStaleRuns(): Promise<number> {
    const stale = await this.deps.research.listRunsByStatus(this.deps.scope, [
      'planning',
      'queued',
      'researching',
      'synthesizing',
    ]);
    let reconciled = 0;
    for (const run of stale) {
      if (this.executions.has(run.runId)) continue;
      await this.deps.research.markRunningStepsInterrupted(this.deps.scope, run.runId);
      const updated = await this.deps.research.transitionRun(
        this.deps.scope,
        run.runId,
        ['planning', 'queued', 'researching', 'synthesizing'],
        {
          status: 'paused',
          resumePhase: this.resumePhaseFor(run),
          terminalReason: 'runtime_restart',
          pauseRequested: false,
        },
      );
      if (updated) reconciled += 1;
    }
    if (reconciled > 0) {
      this.deps.log(`[research] reconciled ${reconciled} stale run(s) to paused after restart`);
    }
    return reconciled;
  }

  // ─── Lifecycle internals ───────────────────────────────────────────────────

  private resumePhaseFor(run: ResearchRunRecord): ResearchResumePhase | null {
    if (run.resumePhase) return run.resumePhase;
    switch (run.status) {
      case 'created':
      case 'planning':
        return 'planning';
      case 'queued':
      case 'researching':
        return 'researching';
      case 'synthesizing':
        return 'synthesizing';
      default:
        return null; // awaiting_plan_approval → back to review
    }
  }

  private async transitionOrConflict(
    run: ResearchRunRecord,
    to: ResearchRunStatus,
    patch: Parameters<ResearchStore['transitionRun']>[3] = {},
  ): Promise<ResearchRunRecord> {
    assertTransition(run.status, to);
    const updated = await this.deps.research.transitionRun(
      this.deps.scope,
      run.runId,
      [run.status],
      { ...patch, status: to },
    );
    if (!updated) {
      throw new ConflictError(`run ${run.runId} changed state during ${run.status} → ${to}`);
    }
    return updated;
  }

  private publishProgress(
    run: ResearchRunRecord,
    phase: ResearchProgressPhase,
    message: string,
    extra?: { stepId?: string | undefined; counts?: { searches: number; fetchedSources: number; evidenceItems: number; coveredQuestions: number } | undefined },
  ): void {
    this.deps.publishEvent({
      type: 'research_progress',
      sessionId: run.sessionId,
      runId: run.runId,
      ...(extra?.stepId ? { stepId: extra.stepId } : {}),
      phase,
      status: run.status,
      message: sanitizeInline(message).slice(0, 300),
      ...(extra?.counts ? { counts: extra.counts } : {}),
    });
  }

  private startPlanning(runId: string, sessionId: string, refinement?: string): void {
    void this.startDetachedById(runId, sessionId, async (signal, lf) => {
      const run = await this.getRun(runId);
      const running =
        run.status === 'planning'
          ? run
          : await this.transitionOrConflict(run, 'planning', {
              startedAt: run.startedAt ?? new Date(this.now).toISOString(),
            });
      await this.runPlanning(running, signal, lf, refinement);
    });
  }

  private async runPlanning(
    run: ResearchRunRecord,
    signal: AbortSignal,
    langfuseTurnContext: LangfuseTurnContext | undefined,
    refinement?: string,
  ): Promise<void> {
    this.publishProgress(run, 'planning', 'Planning research');
    const step = await this.deps.research.insertStep({
      runId: run.runId,
      agentId: this.deps.agentId,
      iteration: 0,
      kind: refinement ? 'refinement' : 'planning',
      dedupeKey: `plan:v${run.planVersion + 1}`,
      inputJson: refinement ? { instruction: refinement } : {},
      summary: refinement ? 'Revising research plan' : 'Planning research',
    });
    await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
      status: 'running',
      startedAt: new Date(this.now).toISOString(),
    });

    try {
      const budget = run.budgetJson as unknown as ResearchBudgetLimits;
      const outcome = await runPlannerPhase({
        model: this.deps.model,
        runId: run.runId,
        sessionId: run.sessionId,
        objective: run.objective,
        depth: (run.depth as ResearchDepth) ?? 'standard',
        sourcePolicy: run.sourcePolicyJson as unknown as ResearchSourcePolicy,
        budget,
        refinementInstruction: refinement,
        previousPlan: run.planJson
          ? (run.planJson as unknown as ResearchPlan)
          : undefined,
        signal,
        langfuseTurnContext,
      });
      this.recordPhaseUsage('planner', outcome.usage);
      await this.spendUsage(run.runId, {
        modelCalls: outcome.modelCalls,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
      });

      this.throwIfControlRequested(signal);

      const updated = await this.deps.research.updatePlan(
        this.deps.scope,
        run.runId,
        run.planVersion,
        { planJson: outcome.value as unknown as Record<string, unknown> },
      );
      if (!updated) throw new ConflictError('plan version changed while planning');

      await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
        status: 'completed',
        completedAt: new Date(this.now).toISOString(),
        outputJson: { planVersion: updated.planVersion },
        usageJson: outcome.usage as unknown as Record<string, unknown>,
      });

      const awaiting = await this.transitionOrConflict(updated, 'awaiting_plan_approval', {
        resumePhase: null,
      });
      this.deps.publishEvent({
        type: 'research_plan_ready',
        sessionId: run.sessionId,
        runId: run.runId,
        planVersion: awaiting.planVersion,
      });
      this.publishProgress(awaiting, 'plan_ready', 'Research plan ready for review');
    } catch (err) {
      await this.handlePhaseFailure(run.runId, 'planning', step.step.stepId, err);
    }
  }

  /**
   * queued → researching for as many runs as concurrency allows. Passes are
   * chained: overlapping triggers (approve/resume/run-completion) would
   * otherwise each pass the capacity check while suspended on the store, and
   * with several queued runs the CAS loser on one run could claim another
   * before the winner's startDetached registers — exceeding maxConcurrent.
   */
  private maybeStartQueued(): void {
    this.schedulerChain = this.schedulerChain
      .then(async () => {
        if (this.executions.size >= this.maxConcurrent) return;
        const queued = await this.deps.research.listRunsByStatus(this.deps.scope, ['queued']);
        for (const run of queued) {
          if (this.executions.size >= this.maxConcurrent) break;
          if (this.executions.has(run.runId)) continue;
          const claimed = await this.deps.research.transitionRun(
            this.deps.scope,
            run.runId,
            ['queued'],
            { status: 'researching', startedAt: run.startedAt ?? new Date(this.now).toISOString() },
          );
          if (!claimed) continue;
          this.startDetached(claimed, (signal, lf) => this.runResearchLoop(claimed, signal, lf));
        }
      })
      .catch((err) => {
        this.deps.log(`[research] failed to start queued run: ${sanitizeError(err)}`);
      });
  }

  private startDetached(
    run: ResearchRunRecord,
    fn: (signal: AbortSignal, langfuseTurnContext: LangfuseTurnContext | undefined) => Promise<void>,
  ): void {
    void this.startDetachedById(run.runId, run.sessionId, fn);
  }

  private startDetachedById(
    runId: string,
    sessionId: string,
    fn: (signal: AbortSignal, langfuseTurnContext: LangfuseTurnContext | undefined) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const releaseBusy = this.deps.acquireBusy?.();
    const langfuseTurnContext: LangfuseTurnContext | undefined = this.deps.langfuse
      ? {
          currentTrace: this.deps.langfuse.trace({
            name: 'openhermit.deep_research',
            sessionId,
            metadata: { runId },
          }),
        }
      : undefined;

    researchActiveRuns.inc({ agent_id: this.deps.agentId });
    const execution: ActiveExecution = {
      runId,
      sessionId,
      controller,
      langfuseTurnContext,
      releaseBusy,
      startedAtMs: this.now,
      promise: Promise.resolve(),
    };
    execution.promise = (async () => {
      try {
        await fn(controller.signal, langfuseTurnContext);
      } catch (err) {
        // Last-resort catch: phase handlers persist their own failures; this
        // guards the orchestration scaffolding itself.
        this.deps.log(`[research] run ${runId} execution error: ${sanitizeError(err)}`);
        await this.handlePhaseFailure(runId, 'researching', undefined, err).catch(() => {});
      } finally {
        this.executions.delete(runId);
        if (this.executionsBySession.get(sessionId) === runId) {
          this.executionsBySession.delete(sessionId);
        }
        researchActiveRuns.dec({ agent_id: this.deps.agentId });
        releaseBusy?.();
        this.maybeStartQueued();
      }
    })();
    this.executions.set(runId, execution);
    this.executionsBySession.set(sessionId, runId);
    return execution.promise;
  }

  private throwIfControlRequested(signal: AbortSignal): void {
    if (!signal.aborted) return;
    if (signal.reason instanceof CancelRequested) throw signal.reason;
    throw signal.reason instanceof PauseRequested ? signal.reason : new PauseRequested();
  }

  private async spendUsage(
    runId: string,
    update: Parameters<ResearchBudget['spend']>[0],
  ): Promise<void> {
    const run = await this.deps.research.getRun(this.deps.scope, runId);
    if (!run) return;
    const usage =
      run.usageJson && Object.keys(run.usageJson).length > 0
        ? (run.usageJson as unknown as ResearchUsage)
        : zeroResearchUsage();
    const budget = new ResearchBudget(
      run.budgetJson as unknown as ResearchBudgetLimits,
      usage,
    );
    budget.spend(update);
    await this.deps.research.patchRun(this.deps.scope, runId, {
      usageJson: usage as unknown as Record<string, unknown>,
    });
  }

  private recordPhaseUsage(
    phase: string,
    usage: { inputTokens: number; outputTokens: number },
  ): void {
    if (usage.inputTokens > 0) {
      researchTokensTotal.inc(
        { agent_id: this.deps.agentId, phase, direction: 'input' },
        usage.inputTokens,
      );
    }
    if (usage.outputTokens > 0) {
      researchTokensTotal.inc(
        { agent_id: this.deps.agentId, phase, direction: 'output' },
        usage.outputTokens,
      );
    }
  }

  private async handlePhaseFailure(
    runId: string,
    phase: ResearchResumePhase,
    stepId: string | undefined,
    err: unknown,
  ): Promise<void> {
    const message = sanitizeError(err);
    if (stepId) {
      const status = err instanceof PauseRequested || err instanceof CancelRequested
        ? 'interrupted'
        : 'failed';
      await this.deps.research
        .updateStep(this.deps.scope, stepId, {
          status,
          error: message,
          completedAt: new Date(this.now).toISOString(),
        })
        .catch(() => {});
    }
    await this.deps.research.markRunningStepsInterrupted(this.deps.scope, runId).catch(() => {});

    if (err instanceof CancelRequested) {
      await this.deps.research.invalidatePendingSteps(this.deps.scope, runId).catch(() => {});
      const cancelled = await this.deps.research.transitionRun(
        this.deps.scope,
        runId,
        ['planning', 'queued', 'researching', 'synthesizing', 'awaiting_plan_approval', 'created'],
        {
          status: 'cancelled',
          cancelRequested: false,
          pauseRequested: false,
          terminalReason: 'user_cancelled',
          completedAt: new Date(this.now).toISOString(),
        },
      );
      if (cancelled) {
        researchRunsTotal.inc({ agent_id: this.deps.agentId, status: 'cancelled' });
        this.publishProgress(cancelled, 'failed', 'Research cancelled');
      }
      return;
    }

    if (err instanceof PauseRequested) {
      const paused = await this.deps.research.transitionRun(
        this.deps.scope,
        runId,
        ['planning', 'queued', 'researching', 'synthesizing'],
        { status: 'paused', resumePhase: phase, pauseRequested: false },
      );
      if (paused) this.publishProgress(paused, 'paused', 'Research paused');
      return;
    }

    const failed = await this.deps.research.transitionRun(
      this.deps.scope,
      runId,
      ['planning', 'researching', 'synthesizing'],
      { status: 'failed', resumePhase: phase, lastError: message },
    );
    if (failed) {
      researchRunsTotal.inc({ agent_id: this.deps.agentId, status: 'failed' });
      this.publishProgress(failed, 'failed', 'Research failed — retry to continue');
    }
  }

  // ─── Research loop (§9) ────────────────────────────────────────────────────

  private async runResearchLoop(
    initialRun: ResearchRunRecord,
    signal: AbortSignal,
    langfuseTurnContext: LangfuseTurnContext | undefined,
  ): Promise<void> {
    const runId = initialRun.runId;
    let run = await this.getRun(runId);
    if (!run.planJson) {
      throw new ValidationError('research loop started without a plan');
    }
    const plan = researchPlanSchema.parse(run.planJson);
    const sourcePolicy = run.sourcePolicyJson as unknown as ResearchSourcePolicy;
    const limits = run.budgetJson as unknown as ResearchBudgetLimits;
    const usage =
      run.usageJson && Object.keys(run.usageJson).length > 0
        ? (run.usageJson as unknown as ResearchUsage)
        : zeroResearchUsage();
    const budget = new ResearchBudget(limits, usage);
    const state = parseWorkingState(run.workingStateJson);
    const gainTracker = new GainTracker(state.zeroGainStreak);
    const executionStartMs = this.now;
    const executorDeps: ExecutorDeps = {
      webSearch: this.requireWebSearch(),
      webFetch: this.requireWebFetch(),
      sleep: this.deps.sleep,
      random: this.deps.random,
    };

    const elapsed = (): number => state.elapsedMsBefore + (this.now - executionStartMs);
    const persist = async (): Promise<void> => {
      await this.deps.research.patchRun(this.deps.scope, runId, {
        usageJson: usage as unknown as Record<string, unknown>,
        workingStateJson: { ...state, elapsedMsBefore: elapsed() } as unknown as Record<string, unknown>,
      });
    };

    let stopReason: { kind: 'finish_gate' | 'budget' | 'diminishing' | 'systemic_failure'; detail: string } | null = null;

    try {
      while (stopReason === null) {
        this.throwIfControlRequested(signal);

        const exhausted = budget.exhaustedDimension(elapsed());
        if (exhausted) {
          stopReason = { kind: 'budget', detail: exhausted };
          break;
        }
        if (state.systemicFailureStreak >= SYSTEMIC_FAILURE_STREAK_LIMIT) {
          stopReason = { kind: 'systemic_failure', detail: 'provider_failures' };
          break;
        }
        if (gainTracker.diminished) {
          stopReason = { kind: 'diminishing', detail: 'no_information_gain' };
          break;
        }
        if (!budget.canSpendModelCall('research')) {
          stopReason = { kind: 'budget', detail: 'modelCalls' };
          break;
        }

        state.iteration += 1;
        budget.spend({ iterations: 1 });

        // Decision phase (idempotent per iteration).
        const sources = await this.deps.research.listSources(this.deps.scope, runId);
        const evidence = await this.deps.research.listEvidence(this.deps.scope, runId);
        const decisionStep = await this.deps.research.insertStep({
          runId,
          agentId: this.deps.agentId,
          iteration: state.iteration,
          kind: 'decision',
          dedupeKey: `decision:i${state.iteration}`,
          summary: 'Choosing next research actions',
        });

        let actions: ResearchAction[];
        if (decisionStep.step.status === 'completed' && !decisionStep.created) {
          const stored = researchDecisionSchema.safeParse(decisionStep.step.outputJson);
          actions = stored.success ? stored.data.actions : [];
        } else {
          await this.deps.research.updateStep(this.deps.scope, decisionStep.step.stepId, {
            status: 'running',
            startedAt: new Date(this.now).toISOString(),
            attempt: decisionStep.step.attempt + (decisionStep.created ? 0 : 1),
          });
          const brief = this.buildBrief(plan, sourcePolicy, budget, state, sources, evidence, elapsed());
          const outcome = await callPhaseWithRepair(this.deps.model, researchDecisionSchema, {
            runId,
            sessionId: run.sessionId,
            phase: 'decision',
            systemPrompt: DECISION_SYSTEM_PROMPT,
            userPrompt: buildDecisionUserPrompt(brief),
            signal,
            langfuseTurnContext,
          });
          this.recordPhaseUsage('decision', outcome.usage);
          budget.spend({
            modelCalls: outcome.modelCalls,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
          });
          actions = outcome.value.actions;
          await this.deps.research.updateStep(this.deps.scope, decisionStep.step.stepId, {
            status: 'completed',
            completedAt: new Date(this.now).toISOString(),
            outputJson: { actions } as unknown as Record<string, unknown>,
            usageJson: outcome.usage as unknown as Record<string, unknown>,
            summary: this.describeActions(actions),
          });
        }

        this.throwIfControlRequested(signal);

        // Validate.
        const knownSources = new Map<string, KnownSourceView>(
          sources.map((s) => [s.sourceId, { sourceId: s.sourceId, status: s.status, url: s.url }]),
        );
        const validated = validateActions(actions, {
          plan,
          sourcePolicy,
          budget,
          priorQueries: state.queryHistory,
          knownSources,
        });
        for (const rejectedAction of validated.rejected) {
          researchActionsTotal.inc({
            agent_id: this.deps.agentId,
            kind: rejectedAction.action.type,
            outcome: 'rejected',
          });
        }

        if (validated.finishRequested) {
          const gate = evaluateFinishGate(this.gateInput(plan, state));
          if (gate.pass) {
            stopReason = { kind: 'finish_gate', detail: 'finish' };
            break;
          }
          state.notes.push(`Finish rejected: ${gate.reasons.join('; ')}`.slice(0, 300));
        }

        if (validated.approved.length === 0) {
          gainTracker.record({
            newEvidence: 0,
            newSourceClasses: 0,
            newCoveredQuestions: 0,
            resolvedContradictions: 0,
          });
          state.zeroGainStreak = gainTracker.zeroGainStreak;
          state.notes = state.notes.slice(-WORKING_STATE_NOTE_CAP);
          if (validated.rejected.length > 0) {
            state.notes.push(
              `All actions rejected: ${validated.rejected.map((r) => r.reason).join('; ')}`.slice(0, 300),
            );
          }
          await persist();
          continue;
        }

        // Execute approved actions.
        const openContradictionsBefore = state.contradictions.filter((c) => !c.resolved && !c.followUpAttempted);
        const gain = await this.executeIterationActions({
          run,
          plan,
          sourcePolicy,
          budget,
          state,
          executorDeps,
          approved: validated.approved,
          signal,
          langfuseTurnContext,
          iteration: state.iteration,
        });

        if (gain.executedAny && openContradictionsBefore.length > 0) {
          // A post-contradiction action counts as the targeted follow-up.
          for (const c of openContradictionsBefore) c.followUpAttempted = true;
        }
        state.systemicFailureStreak = gain.allFailed ? state.systemicFailureStreak + 1 : 0;

        gainTracker.record({
          newEvidence: gain.newEvidence,
          newSourceClasses: gain.newSourceClasses,
          newCoveredQuestions: gain.newCoveredQuestions,
          resolvedContradictions: 0,
        });
        state.zeroGainStreak = gainTracker.zeroGainStreak;
        state.notes = state.notes.slice(-WORKING_STATE_NOTE_CAP);
        await persist();

        run = await this.getRun(runId);
        this.publishProgress(run, 'comparing_evidence', 'Reviewing collected evidence', {
          counts: this.counts(budget, state),
        });
      }

      await persist();

      const gate = evaluateFinishGate(this.gateInput(plan, state));
      const partial = !(stopReason?.kind === 'finish_gate' || gate.pass);
      if (stopReason && stopReason.kind === 'budget') {
        researchBudgetExhaustionsTotal.inc({
          agent_id: this.deps.agentId,
          reason: stopReason.detail as BudgetDimension,
        });
      }

      const synthesizing = await this.deps.research.transitionRun(
        this.deps.scope,
        runId,
        ['researching'],
        {
          status: 'synthesizing',
          resumePhase: 'synthesizing',
          terminalReason: stopReason?.detail ?? null,
        },
      );
      if (!synthesizing) throw new ConflictError('run changed state before synthesis');
      await this.runSynthesis(synthesizing, signal, langfuseTurnContext, partial);
    } catch (err) {
      await persist().catch(() => {});
      await this.handlePhaseFailure(runId, 'researching', undefined, err);
    }
  }

  private requireWebSearch(): ExecutorDeps['webSearch'] {
    const webSearch = this.deps.webSearch;
    if (!webSearch) {
      return async () => {
        throw new ValidationError('web search is not available (no provider or denied by policy)');
      };
    }
    return webSearch;
  }

  private requireWebFetch(): ExecutorDeps['webFetch'] {
    const webFetch = this.deps.webFetch;
    if (!webFetch) {
      return async () => {
        throw new ValidationError('web fetch is not available (no provider or denied by policy)');
      };
    }
    return webFetch;
  }

  private counts(
    budget: ResearchBudget,
    state: ResearchWorkingState,
  ): { searches: number; fetchedSources: number; evidenceItems: number; coveredQuestions: number } {
    return {
      searches: budget.usage.searches,
      fetchedSources: budget.usage.fetchedSources,
      evidenceItems: budget.usage.evidenceItems,
      coveredQuestions: state.coveredQuestionIds.length,
    };
  }

  private gateInput(plan: ResearchPlan, state: ResearchWorkingState): {
    requiredQuestionIds: string[];
    coveredQuestionIds: string[];
    contradictions: ContradictionStatus[];
    unresolvedContradictionsAllowed: boolean;
  } {
    return {
      requiredQuestionIds: requiredQuestionIds(plan),
      coveredQuestionIds: state.coveredQuestionIds,
      contradictions: state.contradictions.map((c) => ({
        claimKey: c.claimKey,
        resolved: c.resolved,
        followUpAttempted: c.followUpAttempted,
      })),
      unresolvedContradictionsAllowed: plan.completionCriteria.unresolvedContradictionsAllowed,
    };
  }

  private describeActions(actions: readonly ResearchAction[]): string {
    const searches = actions.filter((a) => a.type === 'search').length;
    const reads = actions.filter((a) => a.type === 'read_source').length;
    const finish = actions.some((a) => a.type === 'finish');
    const parts: string[] = [];
    if (searches > 0) parts.push(`${searches} search${searches > 1 ? 'es' : ''}`);
    if (reads > 0) parts.push(`${reads} source read${reads > 1 ? 's' : ''}`);
    if (finish) parts.push('finish');
    return `Next actions: ${parts.join(', ') || 'none'}`;
  }

  // ─── Iteration action execution ────────────────────────────────────────────

  private async executeIterationActions(input: {
    run: ResearchRunRecord;
    plan: ResearchPlan;
    sourcePolicy: ResearchSourcePolicy;
    budget: ResearchBudget;
    state: ResearchWorkingState;
    executorDeps: ExecutorDeps;
    approved: ResearchAction[];
    signal: AbortSignal;
    langfuseTurnContext: LangfuseTurnContext | undefined;
    iteration: number;
  }): Promise<{
    newEvidence: number;
    newSourceClasses: number;
    newCoveredQuestions: number;
    executedAny: boolean;
    allFailed: boolean;
  }> {
    const { run, plan, budget, state } = input;
    let newEvidence = 0;
    let newSourceClasses = 0;
    let newCoveredQuestions = 0;
    let executed = 0;
    let failed = 0;

    const searches = input.approved.filter(
      (a): a is Extract<ResearchAction, { type: 'search' }> => a.type === 'search',
    );
    const reads = input.approved.filter(
      (a): a is Extract<ResearchAction, { type: 'read_source' }> => a.type === 'read_source',
    );

    // Searches run concurrently (max 2 already enforced by validation).
    await Promise.all(
      searches.map(async (action) => {
        const outcome = await this.executeSearch(input, action);
        executed += 1;
        if (outcome === 'failed') failed += 1;
      }),
    );

    // Reads: parallel across domains, sequential per domain.
    const readTasks: Array<{ domain: string; run: () => Promise<'ok' | 'failed' | 'skipped'> }> = [];
    for (const action of reads) {
      const source = await this.deps.research.getSource(this.deps.scope, run.runId, action.sourceId);
      if (!source?.url) continue;
      const domain = source.domain ?? 'unknown';
      readTasks.push({
        domain,
        run: async () => {
          const result = await this.executeRead(input, action, source);
          if (result.newEvidence > 0) {
            newEvidence += result.newEvidence;
            newCoveredQuestions += result.newCoveredQuestions;
            newSourceClasses += result.newSourceClass ? 1 : 0;
          }
          return result.outcome;
        },
      });
    }
    const readResults = await runReadsWithDomainLimit(readTasks);
    for (const r of readResults) {
      if (r.status === 'fulfilled' && r.value !== 'skipped') {
        executed += 1;
        if (r.value === 'failed') failed += 1;
      }
      if (r.status === 'rejected') {
        const reason = r.reason;
        if (reason instanceof PauseRequested || reason instanceof CancelRequested) throw reason;
        executed += 1;
        failed += 1;
      }
    }

    // Coverage recount from durable evidence (authoritative).
    const evidence = await this.deps.research.listEvidence(this.deps.scope, run.runId);
    const covered = new Set<string>();
    for (const e of evidence) for (const q of e.questionIds) covered.add(q);
    const planIds = new Set(plan.questions.map((q) => q.id));
    const coveredNow = [...covered].filter((q) => planIds.has(q));
    newCoveredQuestions = Math.max(0, coveredNow.length - state.coveredQuestionIds.length);
    state.coveredQuestionIds = coveredNow;

    // Contradiction recompute.
    const candidates = detectContradictions(
      evidence.map((e) => ({
        evidenceId: e.evidenceId,
        sourceId: e.sourceId,
        claimKey: e.claimKey ?? undefined,
        stance: e.stance as 'supports' | 'contradicts' | 'context',
        normalizedValue: e.normalizedValue ?? undefined,
      })),
    );
    for (const candidate of candidates) {
      const existing = state.contradictions.find((c) => c.claimKey === candidate.claimKey);
      if (existing) {
        existing.evidenceIds = candidate.evidenceIds;
      } else {
        state.contradictions.push({
          claimKey: candidate.claimKey,
          resolved: false,
          followUpAttempted: false,
          evidenceIds: candidate.evidenceIds,
        });
      }
    }

    budget.spend({ evidenceItems: newEvidence });
    return {
      newEvidence,
      newSourceClasses,
      newCoveredQuestions,
      executedAny: executed > 0,
      allFailed: executed > 0 && failed === executed,
    };
  }

  private async executeSearch(
    ctx: {
      run: ResearchRunRecord;
      sourcePolicy: ResearchSourcePolicy;
      budget: ResearchBudget;
      state: ResearchWorkingState;
      executorDeps: ExecutorDeps;
      signal: AbortSignal;
      iteration: number;
    },
    action: Extract<ResearchAction, { type: 'search' }>,
  ): Promise<'ok' | 'failed' | 'skipped'> {
    const { run, state, budget } = ctx;
    const fingerprint = queryFingerprint(action.query);
    const step = await this.deps.research.insertStep({
      runId: run.runId,
      agentId: this.deps.agentId,
      iteration: ctx.iteration,
      kind: 'search',
      dedupeKey: `search:${fingerprint}`,
      questionIds: action.questionIds,
      inputJson: { query: action.query, rationale: action.rationale },
      summary: `Searching: ${action.query}`.slice(0, 200),
    });
    if (!step.created && step.step.status === 'completed') return 'skipped';

    await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
      status: 'running',
      startedAt: new Date(this.now).toISOString(),
      attempt: step.step.attempt + (step.created ? 0 : 1),
    });
    this.publishProgress(run, 'searching', action.rationale || `Searching: ${action.query}`, {
      stepId: step.step.stepId,
      counts: this.counts(budget, state),
    });

    try {
      const { results, retries } = await executeSearchAction(ctx.executorDeps, {
        query: action.query,
        sourcePolicy: ctx.sourcePolicy,
        limit: SEARCH_RESULT_LIMIT,
        timeoutMs: RESEARCH_SEARCH_TIMEOUT_MS,
        signal: ctx.signal,
      });
      if (retries > 0) {
        researchRetriesTotal.inc({ agent_id: this.deps.agentId, operation: 'search' }, retries);
        budget.spend({ retries });
      }

      const candidates = results
        .map((r) => {
          try {
            const canonical = normalizeUrl(r.url);
            return {
              runId: run.runId,
              agentId: this.deps.agentId,
              url: r.url,
              canonicalUrl: canonical,
              canonicalUrlHash: canonicalUrlHash(r.url),
              title: r.title ?? null,
              domain: new URL(canonical).hostname,
              publishedAt: r.publishedDate ?? null,
              metadataJson: {
                snippet: r.snippet,
                ...(r.score !== undefined ? { providerScore: r.score } : {}),
              },
              discoveredByStepId: step.step.stepId,
            };
          } catch {
            return null; // unparseable URL → fail closed
          }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);

      const sourceRows = await this.deps.research.completeSearchStep(
        this.deps.scope,
        step.step.stepId,
        {
          status: 'completed',
          completedAt: new Date(this.now).toISOString(),
          outputJson: { resultCount: candidates.length },
        },
        candidates,
      );
      // Only newly discovered sources count against the budget/metric; a
      // re-discovery by a later search resolves to the existing row.
      const createdCount = sourceRows.filter((r) => r.created).length;
      budget.spend({ searches: 1, sources: createdCount });
      state.queryHistory.push(action.query);
      researchActionsTotal.inc({ agent_id: this.deps.agentId, kind: 'search', outcome: 'ok' });
      researchSourcesTotal.inc(
        { agent_id: this.deps.agentId, kind: 'web', status: 'candidate' },
        createdCount,
      );
      this.publishProgress(run, 'reviewing_sources', `Reviewing ${sourceRows.length} candidate sources`, {
        stepId: step.step.stepId,
        counts: this.counts(budget, state),
      });
      return 'ok';
    } catch (err) {
      if (err instanceof PauseRequested || err instanceof CancelRequested) throw err;
      if (ctx.signal.aborted) this.throwIfControlRequested(ctx.signal);
      const retries = err instanceof ResearchActionError ? err.retries : 0;
      if (retries > 0) {
        researchRetriesTotal.inc({ agent_id: this.deps.agentId, operation: 'search' }, retries);
        budget.spend({ retries });
      }
      budget.spend({ searches: 1 });
      state.queryHistory.push(action.query);
      researchActionsTotal.inc({ agent_id: this.deps.agentId, kind: 'search', outcome: 'failed' });
      await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
        status: 'failed',
        error: sanitizeError(err),
        completedAt: new Date(this.now).toISOString(),
      });
      ctx.state.notes.push(`Search failed: ${sanitizeError(err)}`.slice(0, 300));
      return 'failed';
    }
  }

  private async executeRead(
    ctx: {
      run: ResearchRunRecord;
      plan: ResearchPlan;
      sourcePolicy: ResearchSourcePolicy;
      budget: ResearchBudget;
      state: ResearchWorkingState;
      executorDeps: ExecutorDeps;
      signal: AbortSignal;
      langfuseTurnContext: LangfuseTurnContext | undefined;
      iteration: number;
    },
    action: Extract<ResearchAction, { type: 'read_source' }>,
    source: ResearchSourceRecord,
  ): Promise<{
    outcome: 'ok' | 'failed' | 'skipped';
    newEvidence: number;
    newCoveredQuestions: number;
    newSourceClass: boolean;
  }> {
    const { run, plan, budget, state } = ctx;
    const none = { newEvidence: 0, newCoveredQuestions: 0, newSourceClass: false };
    const step = await this.deps.research.insertStep({
      runId: run.runId,
      agentId: this.deps.agentId,
      iteration: ctx.iteration,
      kind: 'read_source',
      dedupeKey: `read:${source.sourceId}`,
      questionIds: action.questionIds,
      inputJson: { sourceId: source.sourceId, url: source.url, rationale: action.rationale },
      summary: `Reading: ${source.title ?? source.domain ?? source.url}`.slice(0, 200),
    });
    if (!step.created && step.step.status === 'completed') return { outcome: 'skipped', ...none };

    await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
      status: 'running',
      startedAt: new Date(this.now).toISOString(),
      attempt: step.step.attempt + (step.created ? 0 : 1),
    });
    this.publishProgress(
      run,
      'reading_source',
      action.rationale || `Reading ${source.title ?? source.domain ?? 'source'}`,
      { stepId: step.step.stepId, counts: this.counts(budget, state) },
    );

    try {
      const maxBytes = Math.min(
        (run.budgetJson as unknown as ResearchBudgetLimits).bytesPerSource,
        200_000,
      );
      const { acquired, retries } = await executeReadAction(ctx.executorDeps, {
        url: source.url!,
        maxBytes,
        timeoutMs: RESEARCH_FETCH_TIMEOUT_MS,
        signal: ctx.signal,
      });
      if (retries > 0) {
        researchRetriesTotal.inc({ agent_id: this.deps.agentId, operation: 'fetch' }, retries);
        budget.spend({ retries });
      }

      // Blocked/unsupported classification.
      if (acquired.status !== undefined && (acquired.status === 401 || acquired.status === 403 || acquired.status === 402)) {
        await this.markSourceState(run, source, step.step.stepId, 'blocked', `HTTP ${acquired.status}`);
        budget.spend({ fetchedSources: 1 });
        return { outcome: 'ok', ...none };
      }
      if (acquired.mimeType && !/^(text\/|application\/(xhtml|xml))/.test(acquired.mimeType)) {
        await this.markSourceState(
          run,
          source,
          step.step.stepId,
          'unsupported',
          `unsupported MIME type ${acquired.mimeType} (HTML/text only in this version)`,
        );
        budget.spend({ fetchedSources: 1 });
        return { outcome: 'ok', ...none };
      }

      const snapshot = normalizeSnapshotText(acquired.content);
      if (snapshot.length === 0) {
        await this.markSourceState(run, source, step.step.stepId, 'failed', 'empty content');
        budget.spend({ fetchedSources: 1 });
        return { outcome: 'failed', ...none };
      }
      const snapshotBytes = Buffer.byteLength(snapshot, 'utf8');
      if (!budget.canStoreSnapshot(snapshotBytes)) {
        await this.markSourceState(run, source, step.step.stepId, 'failed', 'snapshot byte budget exhausted');
        budget.spend({ fetchedSources: 1 });
        return { outcome: 'failed', ...none };
      }

      const hash = contentHash(snapshot);
      const mirror = await this.withDedupeLock(run.runId, async () => {
        const existing = await this.deps.research.findSourceByContentHash(
          this.deps.scope,
          run.runId,
          hash,
          source.sourceId,
        );
        if (existing) return existing;
        await this.deps.research.updateSource(this.deps.scope, source.sourceId, {
          status: 'fetched',
          snapshotText: snapshot,
          contentHash: hash,
          contentBytes: snapshotBytes,
          truncated: acquired.truncated,
          title: acquired.title ?? source.title,
          canonicalUrl: acquired.canonicalUrl ?? source.canonicalUrl,
          author: acquired.author ?? null,
          publisher: acquired.publisher ?? null,
          publishedAt: acquired.publishedAt ?? source.publishedAt,
          retrievedAt: acquired.retrievedAt,
          mimeType: acquired.mimeType ?? null,
        });
        return undefined;
      });
      if (mirror) {
        await this.deps.research.updateSource(this.deps.scope, source.sourceId, {
          status: 'duplicate',
          duplicateOfSourceId: mirror.sourceId,
          contentHash: hash,
          retrievedAt: acquired.retrievedAt,
        });
        await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
          status: 'completed',
          completedAt: new Date(this.now).toISOString(),
          outputJson: { duplicateOf: mirror.sourceId },
          summary: `Duplicate of ${mirror.title ?? mirror.sourceId}`.slice(0, 200),
        });
        budget.spend({ fetchedSources: 1 });
        researchSourcesTotal.inc({ agent_id: this.deps.agentId, kind: 'web', status: 'duplicate' });
        this.publishSourceUpdate(run, source.sourceId, 'duplicate', source);
        return { outcome: 'ok', ...none };
      }
      budget.spend({ fetchedSources: 1, snapshotBytes });
      researchActionsTotal.inc({ agent_id: this.deps.agentId, kind: 'read_source', outcome: 'ok' });
      researchSourcesTotal.inc({ agent_id: this.deps.agentId, kind: 'web', status: 'fetched' });
      this.publishSourceUpdate(run, source.sourceId, 'fetched', {
        ...source,
        title: acquired.title ?? source.title,
      });

      // Extraction (no tools; untrusted envelope).
      this.throwIfControlRequested(ctx.signal);
      if (!budget.canSpendModelCall('research')) {
        await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
          status: 'completed',
          completedAt: new Date(this.now).toISOString(),
          outputJson: { fetched: true, extraction: 'skipped_budget' },
        });
        return { outcome: 'ok', ...none };
      }
      this.publishProgress(run, 'extracting_evidence', `Extracting evidence from ${acquired.title ?? source.domain ?? 'source'}`, {
        stepId: step.step.stepId,
        counts: this.counts(budget, state),
      });
      const questions = plan.questions.map((q) => ({ id: q.id, question: q.question }));
      const extraction = await runExtractionPhase({
        model: this.deps.model,
        runId: run.runId,
        sessionId: run.sessionId,
        sourceId: source.sourceId,
        title: acquired.title,
        url: source.url ?? undefined,
        snapshotText: snapshot,
        questions,
        signal: ctx.signal,
        langfuseTurnContext: ctx.langfuseTurnContext,
      });
      this.recordPhaseUsage('extract_evidence', extraction.usage);
      budget.spend({
        modelCalls: extraction.modelCalls,
        inputTokens: extraction.usage.inputTokens,
        outputTokens: extraction.usage.outputTokens,
      });

      const inserted = await this.deps.research.insertEvidence(
        extraction.verified.map((v) => ({
          runId: run.runId,
          agentId: this.deps.agentId,
          sourceId: source.sourceId,
          extractionStepId: step.step.stepId,
          questionIds: v.evidence.questionIds,
          excerpt: v.normalizedExcerpt,
          locatorJson: v.locator as unknown as Record<string, unknown>,
          claimKey: v.evidence.claimKey ?? null,
          stance: v.evidence.stance,
          normalizedValue: v.evidence.normalizedValue ?? null,
          scopeJson: (v.evidence.scope ?? {}) as Record<string, unknown>,
          relevanceBasisPoints: v.evidence.relevanceBasisPoints,
          confidenceBasisPoints: v.evidence.confidenceBasisPoints,
          evidenceHash: v.evidenceHash,
        })),
      );

      const newClass = !state.seenSourceClasses.includes(extraction.quality.sourceClass);
      if (newClass && extraction.quality.sourceClass !== 'unknown') {
        state.seenSourceClasses.push(extraction.quality.sourceClass);
      }
      await this.deps.research.updateSource(this.deps.scope, source.sourceId, {
        sourceClass: extraction.quality.sourceClass,
        qualityJson: extraction.quality as unknown as Record<string, unknown>,
      });
      if (extraction.note) {
        state.notes.push(`${source.sourceId}: ${extraction.note}`.slice(0, 300));
      }

      await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
        status: 'completed',
        completedAt: new Date(this.now).toISOString(),
        outputJson: {
          fetched: true,
          evidence: inserted.length,
          rejectedExcerpts: extraction.rejectedExcerpts,
        },
        usageJson: extraction.usage as unknown as Record<string, unknown>,
      });

      return {
        outcome: 'ok',
        newEvidence: inserted.length,
        newCoveredQuestions: 0, // recomputed authoritatively by the caller
        newSourceClass: newClass && extraction.quality.sourceClass !== 'unknown',
      };
    } catch (err) {
      if (err instanceof PauseRequested || err instanceof CancelRequested) throw err;
      if (ctx.signal.aborted) this.throwIfControlRequested(ctx.signal);
      const retries = err instanceof ResearchActionError ? err.retries : 0;
      if (retries > 0) {
        researchRetriesTotal.inc({ agent_id: this.deps.agentId, operation: 'fetch' }, retries);
        budget.spend({ retries });
      }
      budget.spend({ fetchedSources: 1 });
      researchActionsTotal.inc({ agent_id: this.deps.agentId, kind: 'read_source', outcome: 'failed' });
      await this.markSourceState(run, source, step.step.stepId, 'failed', sanitizeError(err));
      state.notes.push(`Read failed (${source.domain ?? source.url}): ${sanitizeError(err)}`.slice(0, 300));
      return { outcome: 'failed', ...none };
    }
  }

  private async markSourceState(
    run: ResearchRunRecord,
    source: ResearchSourceRecord,
    stepId: string,
    status: 'blocked' | 'failed' | 'unsupported',
    reason: string,
  ): Promise<void> {
    await this.deps.research.updateSource(this.deps.scope, source.sourceId, {
      status,
      lastError: reason.slice(0, 500),
    });
    await this.deps.research.updateStep(this.deps.scope, stepId, {
      status: status === 'failed' ? 'failed' : 'completed',
      completedAt: new Date(this.now).toISOString(),
      error: reason.slice(0, 500),
    });
    researchSourcesTotal.inc({ agent_id: this.deps.agentId, kind: 'web', status });
    this.publishSourceUpdate(run, source.sourceId, status, source);
  }

  private publishSourceUpdate(
    run: ResearchRunRecord,
    sourceId: string,
    status: 'candidate' | 'fetched' | 'blocked' | 'failed' | 'unsupported' | 'duplicate',
    source: { title?: string | null; domain?: string | null },
  ): void {
    this.deps.publishEvent({
      type: 'research_source_update',
      sessionId: run.sessionId,
      runId: run.runId,
      sourceId,
      status,
      ...(source.title ? { title: sanitizeInline(source.title).slice(0, 200) } : {}),
      ...(source.domain ? { domain: source.domain } : {}),
    });
  }

  // ─── Research brief (§9 step 2) ────────────────────────────────────────────

  private buildBrief(
    plan: ResearchPlan,
    sourcePolicy: ResearchSourcePolicy,
    budget: ResearchBudget,
    state: ResearchWorkingState,
    sources: ResearchSourceRecord[],
    evidence: ResearchEvidenceRecord[],
    elapsedMs: number,
  ): string {
    const covered = new Set(state.coveredQuestionIds);
    const evidenceByQuestion = new Map<string, number>();
    for (const e of evidence) {
      for (const q of e.questionIds) {
        evidenceByQuestion.set(q, (evidenceByQuestion.get(q) ?? 0) + 1);
      }
    }

    const lines: string[] = [];
    lines.push(`Objective: ${plan.objective}`);
    lines.push('', 'Question coverage:');
    for (const q of plan.questions) {
      const count = evidenceByQuestion.get(q.id) ?? 0;
      lines.push(
        `- ${q.id} (${q.priority}${covered.has(q.id) ? ', covered' : ', NOT covered'}, evidence=${count}): ${q.question}`,
      );
    }

    const candidates = sources.filter((s) => s.status === 'candidate').slice(0, 15);
    if (candidates.length > 0) {
      lines.push('', 'Unread candidate sources (read by sourceId):');
      for (const c of candidates) {
        const snippet = typeof c.metadataJson.snippet === 'string' ? c.metadataJson.snippet.slice(0, 150) : '';
        lines.push(`- ${c.sourceId} [${c.domain ?? '?'}] ${sanitizeInline(c.title ?? '(untitled)')} — ${sanitizeInline(snippet)}`);
      }
    } else {
      lines.push('', 'No unread candidate sources — search to discover more.');
    }

    const byStatus = new Map<string, number>();
    for (const s of sources) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
    lines.push(
      '',
      `Sources: ${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'none yet'}.`,
    );

    if (evidence.length > 0) {
      lines.push('', `Evidence collected (${evidence.length} items):`);
      const byClaim = new Map<string, number>();
      for (const e of evidence) {
        if (e.claimKey) byClaim.set(e.claimKey, (byClaim.get(e.claimKey) ?? 0) + 1);
      }
      for (const [claim, count] of [...byClaim.entries()].slice(0, 20)) {
        lines.push(`- claimKey=${claim}: ${count} item(s)`);
      }
    }

    if (state.contradictions.length > 0) {
      lines.push('', 'Contradiction candidates (follow up on central ones):');
      for (const c of state.contradictions.slice(0, 10)) {
        lines.push(
          `- ${c.claimKey}: ${c.evidenceIds.length} conflicting items${c.followUpAttempted ? ' (follow-up attempted)' : ' (NO follow-up yet)'}`,
        );
      }
    }

    if (state.queryHistory.length > 0) {
      lines.push('', 'Previous queries (do not repeat or trivially rephrase):');
      for (const q of state.queryHistory.slice(-15)) lines.push(`- ${q}`);
    }

    if (state.notes.length > 0) {
      lines.push('', 'Recent notes / failures:');
      for (const n of state.notes.slice(-8)) lines.push(`- ${sanitizeInline(n)}`);
    }

    const gate = evaluateFinishGate(this.gateInput(plan, state));
    lines.push(
      '',
      gate.pass
        ? 'Finish gate: PASSES — finish when additional searches would not materially improve the report.'
        : `Finish gate: NOT met — ${gate.reasons.join('; ')}`,
    );

    const limits = budget.limits;
    const usage = budget.usage;
    lines.push(
      '',
      `Remaining budget: searches ${limits.searches - usage.searches}/${limits.searches}, ` +
        `source reads ${limits.fetchedSources - usage.fetchedSources}/${limits.fetchedSources}, ` +
        `iterations ${limits.iterations - usage.iterations}/${limits.iterations}, ` +
        `time ${Math.max(0, Math.round((limits.elapsedMs - elapsedMs) / 60000))} min.`,
    );
    if (sourcePolicy.web.mode !== 'full_web') {
      lines.push(`Source policy: ${sourcePolicy.web.mode} ${sourcePolicy.web.domains.join(', ')}`);
    }
    if (sourcePolicy.web.excludedDomains.length > 0) {
      lines.push(`Excluded domains: ${sourcePolicy.web.excludedDomains.join(', ')}`);
    }

    return lines.join('\n').slice(0, 12_000);
  }

  // ─── Synthesis (§11) ───────────────────────────────────────────────────────

  private async runSynthesis(
    run: ResearchRunRecord,
    signal: AbortSignal,
    langfuseTurnContext: LangfuseTurnContext | undefined,
    partialHint: boolean | undefined,
  ): Promise<void> {
    const runId = run.runId;
    const step = await this.deps.research.insertStep({
      runId,
      agentId: this.deps.agentId,
      iteration: -1,
      kind: 'synthesis',
      dedupeKey: `synthesis:v${run.planVersion}`,
      summary: 'Preparing the final report',
    });
    await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
      status: 'running',
      startedAt: new Date(this.now).toISOString(),
      attempt: step.step.attempt + (step.created ? 0 : 1),
    });
    this.publishProgress(run, 'synthesizing', 'Preparing the final report');

    try {
      const plan = researchPlanSchema.parse(run.planJson);
      const state = parseWorkingState(run.workingStateJson);
      const evidence = await this.deps.research.listEvidence(this.deps.scope, runId);
      const sources = await this.deps.research.listSources(this.deps.scope, runId);
      const sourceById = new Map(
        sources.map((s) => [
          s.sourceId,
          {
            sourceId: s.sourceId,
            title: s.title ?? undefined,
            url: s.url ?? undefined,
            canonicalUrl: s.canonicalUrl ?? undefined,
            domain: s.domain ?? undefined,
            publisher: s.publisher ?? undefined,
            publishedAt: s.publishedAt ?? undefined,
            sourceClass: s.sourceClass as never,
          },
        ]),
      );
      const cards: SynthesisEvidenceCard[] = evidence.map((e) => ({
        evidenceId: e.evidenceId,
        runId: e.runId,
        sourceId: e.sourceId,
        excerpt: e.excerpt,
        locator: e.locatorJson as never,
        questionIds: e.questionIds,
        claimKey: e.claimKey ?? undefined,
        stance: e.stance,
        normalizedValue: e.normalizedValue ?? undefined,
        scope: e.scopeJson,
      }));

      const gate = evaluateFinishGate(this.gateInput(plan, state));
      const partial = partialHint ?? !gate.pass;
      const gapsSummary = gate.pass ? '' : gate.reasons.map((r) => `- ${r}`).join('\n');
      const contradictionsSummary = state.contradictions
        .map((c) => `- ${c.claimKey}: evidence ${c.evidenceIds.join(', ')}`)
        .join('\n');

      const result = await runSynthesisPhase({
        model: this.deps.model,
        runId,
        sessionId: run.sessionId,
        plan,
        evidence: cards,
        sourceById,
        contradictionsSummary,
        gapsSummary,
        partial,
        signal,
        langfuseTurnContext,
      });
      this.recordPhaseUsage('synthesis', result.usage);
      await this.spendUsage(runId, {
        modelCalls: result.modelCalls,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });

      this.throwIfControlRequested(signal);

      await this.deps.research.updateStep(this.deps.scope, step.step.stepId, {
        status: 'completed',
        completedAt: new Date(this.now).toISOString(),
        outputJson: {
          statements: result.report.executiveSummary.length +
            result.report.sections.reduce((n, s) => n + s.statements.length, 0),
          downgradedFindings: result.downgradedFindings,
        },
        usageJson: result.usage as unknown as Record<string, unknown>,
      });

      const terminalStatus: ResearchRunStatus = partial ? 'budget_exhausted' : 'completed';
      const finished = await this.deps.research.transitionRun(
        this.deps.scope,
        runId,
        ['synthesizing'],
        {
          status: terminalStatus,
          reportJson: result.report as unknown as Record<string, unknown>,
          resumePhase: partial ? 'researching' : null,
          completedAt: new Date(this.now).toISOString(),
          pauseRequested: false,
        },
      );
      if (!finished) throw new ConflictError('run changed state during synthesis');

      researchRunsTotal.inc({ agent_id: this.deps.agentId, status: terminalStatus });
      const execution = this.executions.get(runId);
      if (execution) {
        researchRunDuration.observe(
          { agent_id: this.deps.agentId, terminal_status: terminalStatus },
          (this.now - execution.startedAtMs) / 1000,
        );
      }

      await this.deps.deliverReport(run.sessionId, result.markdown, runId);
      this.deps.publishEvent({
        type: 'research_report_ready',
        sessionId: run.sessionId,
        runId,
        terminalStatus: terminalStatus as 'completed' | 'budget_exhausted',
      });
      this.publishProgress(
        finished,
        'completed',
        partial ? 'Partial report ready (budget exhausted)' : 'Research report ready',
      );
    } catch (err) {
      await this.handlePhaseFailure(runId, 'synthesizing', step.step.stepId, err);
    }
  }
}
