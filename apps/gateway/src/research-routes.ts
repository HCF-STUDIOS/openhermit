import {
  gatewayRoutes,
  isCreateResearchRunRequest,
  isResearchRunActionRequest,
  isUpdateResearchPlanRequest,
  type ResearchEvidenceWire,
  type ResearchRunWire,
  type ResearchSourceWire,
  type ResearchStepWire,
} from '@openhermit/protocol';
import type {
  ResearchEvidenceRecord,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchStepRecord,
} from '@openhermit/store';
import { ValidationError } from '@openhermit/shared';

import type { AgentRunner } from '@openhermit/agent/agent-runner';
import type { Hono } from 'hono';

import type { AgentInstanceManager } from './agent-instance.js';
import { type AuthContext } from './auth.js';

export interface ResearchRoutesDeps {
  instances: AgentInstanceManager;
  requireAuth: (c: unknown, agentId?: string) => AuthContext;
  enforceSessionNamespace: (auth: AuthContext, sessionId: string) => void;
  resolveRunner: (
    instances: AgentInstanceManager,
    agentId: string,
  ) => Promise<AgentRunner>;
  requireSessionAccessHttp: (
    auth: AuthContext,
    runtime: AgentRunner,
    sessionId: string,
  ) => Promise<string | undefined>;
  logger?: (message: string) => void;
}

// ─── Record → wire mapping ──────────────────────────────────────────────────
// Snapshots stay server-side (§16): source responses expose metadata and
// evidence excerpts, never the full snapshot text.

export const researchRunToWire = (run: ResearchRunRecord): ResearchRunWire => ({
  runId: run.runId,
  sessionId: run.sessionId,
  status: run.status,
  depth: run.depth,
  objective: run.objective,
  planVersion: run.planVersion,
  ...(run.planJson ? { plan: run.planJson } : {}),
  sourcePolicy: run.sourcePolicyJson,
  budget: run.budgetJson as Record<string, number>,
  usage: run.usageJson,
  ...(run.reportJson ? { report: run.reportJson } : {}),
  ...(run.resumePhase ? { resumePhase: run.resumePhase } : {}),
  ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
  ...(run.lastError ? { lastError: run.lastError } : {}),
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  ...(run.startedAt ? { startedAt: run.startedAt } : {}),
  ...(run.completedAt ? { completedAt: run.completedAt } : {}),
});

export const researchStepToWire = (step: ResearchStepRecord): ResearchStepWire => ({
  stepId: step.stepId,
  runId: step.runId,
  iteration: step.iteration,
  attempt: step.attempt,
  kind: step.kind,
  status: step.status,
  questionIds: step.questionIds,
  ...(step.summary ? { summary: step.summary } : {}),
  ...(step.error ? { error: step.error } : {}),
  createdAt: step.createdAt,
  ...(step.startedAt ? { startedAt: step.startedAt } : {}),
  ...(step.completedAt ? { completedAt: step.completedAt } : {}),
});

export const researchSourceToWire = (source: ResearchSourceRecord): ResearchSourceWire => ({
  sourceId: source.sourceId,
  runId: source.runId,
  kind: source.kind,
  status: source.status,
  ...(source.url ? { url: source.url } : {}),
  ...(source.canonicalUrl ? { canonicalUrl: source.canonicalUrl } : {}),
  ...(source.title ? { title: source.title } : {}),
  ...(source.publisher ? { publisher: source.publisher } : {}),
  ...(source.domain ? { domain: source.domain } : {}),
  ...(source.author ? { author: source.author } : {}),
  ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
  ...(source.retrievedAt ? { retrievedAt: source.retrievedAt } : {}),
  ...(source.mimeType ? { mimeType: source.mimeType } : {}),
  sourceClass: source.sourceClass,
  quality: source.qualityJson,
  ...(source.contentBytes !== null ? { contentBytes: source.contentBytes } : {}),
  truncated: source.truncated,
  ...(source.duplicateOfSourceId ? { duplicateOfSourceId: source.duplicateOfSourceId } : {}),
  ...(source.lastError ? { lastError: source.lastError } : {}),
  createdAt: source.createdAt,
});

export const researchEvidenceToWire = (
  evidence: ResearchEvidenceRecord,
): ResearchEvidenceWire => ({
  evidenceId: evidence.evidenceId,
  sourceId: evidence.sourceId,
  questionIds: evidence.questionIds,
  excerpt: evidence.excerpt,
  locator: evidence.locatorJson,
  ...(evidence.claimKey ? { claimKey: evidence.claimKey } : {}),
  stance: evidence.stance,
  ...(evidence.normalizedValue ? { normalizedValue: evidence.normalizedValue } : {}),
  relevanceBasisPoints: evidence.relevanceBasisPoints,
  confidenceBasisPoints: evidence.confidenceBasisPoints,
  outOfScope: evidence.outOfScope,
});

const requireResearch = async (runtime: AgentRunner) => {
  if (typeof runtime.research !== 'function') {
    throw new ValidationError('Deep Research is not available on this runtime.');
  }
  return runtime.research();
};

export const registerResearchRoutes = (app: Hono, deps: ResearchRoutesDeps): void => {
  const {
    instances,
    requireAuth,
    enforceSessionNamespace,
    resolveRunner,
    requireSessionAccessHttp,
  } = deps;

  interface RouteContext {
    runtime: AgentRunner;
    orchestrator: Awaited<ReturnType<AgentRunner['research']>>;
    callerUserId: string | undefined;
    sessionId: string;
    runId: string;
    sourceId: string;
  }

  // Canonical preamble: requireAuth → enforceSessionNamespace → resolveRunner
  // → requireSessionAccessHttp (user mode only), mirroring attachment routes.
  const prepare = async (c: {
    req: { param: (name: string) => string | undefined };
  }): Promise<RouteContext> => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
    const runtime = await resolveRunner(instances, agentId);
    const callerUserId =
      auth.mode === 'user'
        ? await requireSessionAccessHttp(auth, runtime, sessionId)
        : undefined;
    const orchestrator = await requireResearch(runtime);
    return {
      runtime,
      orchestrator,
      callerUserId,
      sessionId,
      runId: c.req.param('runId') ?? '',
      sourceId: c.req.param('sourceId') ?? '',
    };
  };

  /** Runs are session-scoped; a runId from another session is a 404-shaped miss. */
  const requireRunInSession = async (
    ctx: RouteContext,
  ): Promise<ReturnType<RouteContext['orchestrator']['getRun']>> => {
    const run = await ctx.orchestrator.getRun(ctx.runId);
    if (run.sessionId !== ctx.sessionId) {
      throw new ValidationError(`Research run ${ctx.runId} does not belong to this session.`);
    }
    return run;
  };

  // ─── Create (202: durable run in planning) ───────────────────────────────
  app.post(gatewayRoutes.agentSessionResearchRunsPattern, async (c) => {
    const ctx = await prepare(c);
    const body: unknown = await c.req.json().catch(() => {
      throw new ValidationError('Request body must be JSON.');
    });
    if (!isCreateResearchRunRequest(body)) {
      throw new ValidationError(
        'Invalid research run request: objective (non-empty string) is required; depth must be quick|standard|thorough.',
      );
    }
    const run = await ctx.orchestrator.createRun({
      sessionId: ctx.sessionId,
      objective: body.objective,
      depth: body.depth,
      sourcePolicy: body.sourcePolicy as never,
      clientRequestId: body.clientRequestId,
      requestedByUserId: ctx.callerUserId,
    });
    return c.json({ run: researchRunToWire(run) }, 202);
  });

  // ─── List / get ──────────────────────────────────────────────────────────
  app.get(gatewayRoutes.agentSessionResearchRunsPattern, async (c) => {
    const ctx = await prepare(c);
    const runs = await ctx.orchestrator.listRuns(ctx.sessionId);
    return c.json({ runs: runs.map(researchRunToWire) });
  });

  app.get(gatewayRoutes.agentSessionResearchRunByIdPattern, async (c) => {
    const ctx = await prepare(c);
    const run = await requireRunInSession(ctx);
    return c.json({ run: researchRunToWire(run) });
  });

  // ─── Plan editing ────────────────────────────────────────────────────────
  app.patch(gatewayRoutes.agentSessionResearchRunPlanPattern, async (c) => {
    const ctx = await prepare(c);
    await requireRunInSession(ctx);
    const body: unknown = await c.req.json().catch(() => {
      throw new ValidationError('Request body must be JSON.');
    });
    if (!isUpdateResearchPlanRequest(body)) {
      throw new ValidationError(
        'Invalid plan update: expectedVersion (integer) and plan (object) are required.',
      );
    }
    const run = await ctx.orchestrator.updatePlan(
      ctx.runId,
      body.expectedVersion,
      body.plan,
      body.sourcePolicy as never,
    );
    return c.json({ run: researchRunToWire(run) });
  });

  // ─── Control actions ─────────────────────────────────────────────────────
  app.post(gatewayRoutes.agentSessionResearchRunActionsPattern, async (c) => {
    const ctx = await prepare(c);
    await requireRunInSession(ctx);
    const body: unknown = await c.req.json().catch(() => {
      throw new ValidationError('Request body must be JSON.');
    });
    if (!isResearchRunActionRequest(body)) {
      throw new ValidationError(
        'Invalid action: one of approve_plan/pause/resume/cancel/refine/retry/increase_budget.',
      );
    }
    const run = await (() => {
      switch (body.action) {
        case 'approve_plan':
          return ctx.orchestrator.approvePlan(ctx.runId, body.expectedPlanVersion);
        case 'pause':
          return ctx.orchestrator.pause(ctx.runId);
        case 'resume':
          return ctx.orchestrator.resume(ctx.runId);
        case 'cancel':
          return ctx.orchestrator.cancel(ctx.runId);
        case 'refine':
          return ctx.orchestrator.refine(ctx.runId, body.instruction);
        case 'retry':
          return ctx.orchestrator.retry(ctx.runId);
        case 'increase_budget':
          return ctx.orchestrator.increaseBudget(ctx.runId, body.limits);
      }
    })();
    return c.json({ run: researchRunToWire(run) });
  });

  // ─── Steps / sources / source detail ─────────────────────────────────────
  app.get(gatewayRoutes.agentSessionResearchRunStepsPattern, async (c) => {
    const ctx = await prepare(c);
    await requireRunInSession(ctx);
    const steps = await ctx.orchestrator.listSteps(ctx.runId);
    return c.json({ steps: steps.map(researchStepToWire) });
  });

  app.get(gatewayRoutes.agentSessionResearchRunSourcesPattern, async (c) => {
    const ctx = await prepare(c);
    await requireRunInSession(ctx);
    const sources = await ctx.orchestrator.listSources(ctx.runId);
    return c.json({ sources: sources.map(researchSourceToWire) });
  });

  app.get(gatewayRoutes.agentSessionResearchRunSourceByIdPattern, async (c) => {
    const ctx = await prepare(c);
    await requireRunInSession(ctx);
    const detail = await ctx.orchestrator.getSourceDetail(ctx.runId, ctx.sourceId);
    return c.json({
      source: researchSourceToWire(detail.source),
      evidence: detail.evidence.map(researchEvidenceToWire),
    });
  });
};
