import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';
import { ConflictError, NotFoundError, OpenHermitError, UnauthorizedError, jsonError } from '@openhermit/shared';

import { registerResearchRoutes } from '../src/research-routes.js';
import type { AuthContext } from '../src/auth.js';

/**
 * DB-free route unit tests: a stub runtime with a recording fake orchestrator
 * exercises auth preamble ordering, request validation, wire mapping, action
 * dispatch, and error status codes.
 */

const RUN = {
  runId: 'rr_1',
  agentId: 'agent-a',
  sessionId: 'web:s1',
  requestedByUserId: 'usr-1',
  clientRequestId: null,
  status: 'awaiting_plan_approval',
  resumePhase: null,
  terminalReason: null,
  depth: 'standard',
  objective: 'ACME 2025',
  planJson: { schemaVersion: 1, objective: 'ACME 2025' },
  planVersion: 1,
  sourcePolicyJson: { web: { mode: 'full_web', domains: [], excludedDomains: [] } },
  budgetJson: { searches: 18 },
  usageJson: { searches: 0 },
  workingStateJson: {},
  reportJson: null,
  pauseRequested: false,
  cancelRequested: false,
  lastError: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
};

const makeHarness = () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const orchestrator = {
    createRun: async (input: unknown) => {
      record('createRun', input);
      return { ...RUN, status: 'created', planVersion: 0, planJson: null };
    },
    listRuns: async (sessionId: string) => {
      record('listRuns', sessionId);
      return [RUN];
    },
    getRun: async (runId: string) => {
      record('getRun', runId);
      if (runId !== RUN.runId) throw new NotFoundError(`Research run not found: ${runId}`);
      return RUN;
    },
    updatePlan: async (...args: unknown[]) => {
      record('updatePlan', ...args);
      if (args[1] !== RUN.planVersion) throw new ConflictError('plan version conflict');
      return { ...RUN, planVersion: RUN.planVersion + 1 };
    },
    approvePlan: async (...args: unknown[]) => {
      record('approvePlan', ...args);
      return { ...RUN, status: 'queued' };
    },
    pause: async (...args: unknown[]) => (record('pause', ...args), { ...RUN, status: 'paused' }),
    resume: async (...args: unknown[]) => (record('resume', ...args), { ...RUN, status: 'queued' }),
    cancel: async (...args: unknown[]) => (record('cancel', ...args), { ...RUN, status: 'cancelled' }),
    refine: async (...args: unknown[]) => (record('refine', ...args), { ...RUN, status: 'planning' }),
    retry: async (...args: unknown[]) => (record('retry', ...args), { ...RUN, status: 'queued' }),
    increaseBudget: async (...args: unknown[]) => (record('increaseBudget', ...args), RUN),
    listSteps: async (runId: string) => {
      record('listSteps', runId);
      return [
        {
          stepId: 'rs_1', runId, agentId: 'agent-a', iteration: 1, attempt: 1,
          kind: 'search', status: 'completed', dedupeKey: 'k', questionIds: ['q1'],
          inputJson: {}, outputJson: {}, usageJson: {}, summary: 'Searching', error: null,
          createdAt: 'x', startedAt: 'x', completedAt: 'x',
        },
      ];
    },
    listSources: async (runId: string) => {
      record('listSources', runId);
      return [
        {
          sourceId: 'rsrc_1', runId, agentId: 'agent-a', kind: 'web', status: 'fetched',
          url: 'https://a.example/x', canonicalUrl: 'https://a.example/x', canonicalUrlHash: 'h',
          title: 'T', publisher: null, domain: 'a.example', author: null, publishedAt: null,
          retrievedAt: 'x', mimeType: 'text/html', sourceClass: 'official',
          qualityJson: {}, metadataJson: {}, discoveredByStepId: 'rs_1',
          snapshotText: 'SECRET SNAPSHOT CONTENT', contentHash: 'ch', contentBytes: 10,
          truncated: false, duplicateOfSourceId: null, lastError: null,
          createdAt: 'x', updatedAt: 'x',
        },
      ];
    },
    getSourceDetail: async (runId: string, sourceId: string) => {
      record('getSourceDetail', runId, sourceId);
      return {
        source: (await orchestrator.listSources(runId))[0]!,
        evidence: [
          {
            evidenceId: 'rev_1', runId, agentId: 'agent-a', sourceId,
            extractionStepId: 'rs_2', questionIds: ['q1'], excerpt: 'excerpt',
            locatorJson: { kind: 'web_snapshot' }, claimKey: 'k', stance: 'supports',
            normalizedValue: null, scopeJson: {}, relevanceBasisPoints: 9000,
            confidenceBasisPoints: 8000, outOfScope: false, evidenceHash: 'eh', createdAt: 'x',
          },
        ],
      };
    },
  };

  const runtime = {
    research: async () => orchestrator,
  };

  const authCalls: string[] = [];
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof OpenHermitError) {
      return c.json(jsonError(error), error.statusCode);
    }
    return c.json(jsonError(error), 500);
  });

  registerResearchRoutes(app, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instances: {} as any,
    requireAuth: (_c, agentId) => {
      authCalls.push(`requireAuth:${agentId}`);
      return { mode: 'user', channel: 'web', channelUserId: 'w1' } as AuthContext;
    },
    enforceSessionNamespace: (_auth, sessionId) => {
      authCalls.push(`namespace:${sessionId}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveRunner: async () => runtime as any,
    requireSessionAccessHttp: async (_auth, _runtime, sessionId) => {
      authCalls.push(`sessionAccess:${sessionId}`);
      if (sessionId === 'web:forbidden') throw new UnauthorizedError('Session not found');
      return 'usr-1';
    },
  });

  return { app, calls, authCalls };
};

const BASE = '/api/agents/agent-a/sessions/web:s1/research-runs';

test('research routes: create validates body, runs auth preamble, returns 202', async () => {
  const h = makeHarness();
  const res = await h.app.request(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objective: 'ACME 2025', depth: 'standard', clientRequestId: 'c1' }),
  });
  assert.equal(res.status, 202);
  const body = (await res.json()) as { run: { runId: string; status: string } };
  assert.equal(body.run.runId, 'rr_1');
  assert.equal(body.run.status, 'created');
  assert.deepEqual(h.authCalls, [
    'requireAuth:agent-a',
    'namespace:web:s1',
    'sessionAccess:web:s1',
  ]);
  const created = h.calls.find((c) => c.method === 'createRun')!.args[0] as Record<string, unknown>;
  assert.equal(created.sessionId, 'web:s1');
  assert.equal(created.requestedByUserId, 'usr-1');
  assert.equal(created.clientRequestId, 'c1');
});

test('research routes: create rejects invalid bodies with 400', async () => {
  const h = makeHarness();
  for (const bad of [
    {},
    { objective: '' },
    { objective: 'x', depth: 'extreme' },
    { objective: 'x', sourcePolicy: { web: { mode: 'bogus' } } },
  ]) {
    const res = await h.app.request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(h.calls.filter((c) => c.method === 'createRun').length, 0);
});

test('research routes: list and get map records to wire shape', async () => {
  const h = makeHarness();
  const list = await h.app.request(BASE);
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { runs: Array<Record<string, unknown>> };
  assert.equal(listBody.runs.length, 1);
  assert.equal(listBody.runs[0]!.planVersion, 1);

  const get = await h.app.request(`${BASE}/rr_1`);
  assert.equal(get.status, 200);
  const getBody = (await get.json()) as { run: Record<string, unknown> };
  assert.equal(getBody.run.objective, 'ACME 2025');
  // Internal columns never leak.
  assert.equal('workingStateJson' in getBody.run, false);
  assert.equal('pauseRequested' in getBody.run, false);

  const missing = await h.app.request(`${BASE}/rr_nope`);
  assert.equal(missing.status, 404);
});

test('research routes: plan PATCH validates and surfaces version conflicts as 409', async () => {
  const h = makeHarness();
  const ok = await h.app.request(`${BASE}/rr_1/plan`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, plan: { objective: 'edited' } }),
  });
  assert.equal(ok.status, 200);

  const stale = await h.app.request(`${BASE}/rr_1/plan`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 99, plan: { objective: 'edited' } }),
  });
  assert.equal(stale.status, 409);

  const invalid = await h.app.request(`${BASE}/rr_1/plan`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: { objective: 'edited' } }),
  });
  assert.equal(invalid.status, 400);
});

test('research routes: actions dispatch to the orchestrator', async () => {
  const h = makeHarness();
  const actions: Array<[Record<string, unknown>, string]> = [
    [{ action: 'approve_plan', expectedPlanVersion: 1 }, 'approvePlan'],
    [{ action: 'pause' }, 'pause'],
    [{ action: 'resume' }, 'resume'],
    [{ action: 'refine', instruction: 'focus on filings' }, 'refine'],
    [{ action: 'retry' }, 'retry'],
    [{ action: 'increase_budget', limits: { searches: 30 } }, 'increaseBudget'],
    [{ action: 'cancel' }, 'cancel'],
  ];
  for (const [body, expected] of actions) {
    const res = await h.app.request(`${BASE}/rr_1/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200, `${expected} → ${res.status}`);
    assert.ok(h.calls.some((c) => c.method === expected), `${expected} dispatched`);
  }

  const invalid = await h.app.request(`${BASE}/rr_1/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'self_destruct' }),
  });
  assert.equal(invalid.status, 400);
});

test('research routes: steps and sources listings; snapshot text never leaves the server', async () => {
  const h = makeHarness();
  const steps = await h.app.request(`${BASE}/rr_1/steps`);
  assert.equal(steps.status, 200);
  const stepsBody = (await steps.json()) as { steps: Array<Record<string, unknown>> };
  assert.equal(stepsBody.steps[0]!.kind, 'search');
  assert.equal('inputJson' in stepsBody.steps[0]!, false);

  const sources = await h.app.request(`${BASE}/rr_1/sources`);
  assert.equal(sources.status, 200);
  const sourcesText = await sources.text();
  assert.doesNotMatch(sourcesText, /SECRET SNAPSHOT CONTENT/);

  const detail = await h.app.request(`${BASE}/rr_1/sources/rsrc_1`);
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as {
    source: Record<string, unknown>;
    evidence: Array<Record<string, unknown>>;
  };
  assert.equal(detailBody.evidence[0]!.excerpt, 'excerpt');
  assert.doesNotMatch(JSON.stringify(detailBody), /SECRET SNAPSHOT CONTENT/);
});

test('research routes: session access failures stop the request before the orchestrator', async () => {
  const h = makeHarness();
  const res = await h.app.request(
    '/api/agents/agent-a/sessions/web:forbidden/research-runs',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'x' }),
    },
  );
  assert.equal(res.status, 401);
  assert.equal(h.calls.length, 0);
});
