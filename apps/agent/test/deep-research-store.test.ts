import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { DbInternalStateStore, type ResearchStore, type StoreScope } from '@openhermit/store';

async function openResearch(
  t: import('node:test').TestContext,
): Promise<{ research: ResearchStore; scope: StoreScope; sessionId: string }> {
  const store = await DbInternalStateStore.open();
  t.after(() => store.close());
  const scope = { agentId: `test-dr-${randomUUID().slice(0, 8)}` };
  return { research: store.research, scope, sessionId: `s-${randomUUID().slice(0, 8)}` };
}

const createRun = (research: ResearchStore, scope: StoreScope, sessionId: string, extra = {}) =>
  research.createRun({
    agentId: scope.agentId,
    sessionId,
    depth: 'standard',
    objective: 'Understand ACME 2025 revenue',
    sourcePolicyJson: { web: { mode: 'full_web', domains: [], excludedDomains: [] } },
    budgetJson: { searches: 18 },
    ...extra,
  });

// ─── Runs ────────────────────────────────────────────────────────────────────

test('research runs: create + get round-trips, defaults applied', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId, { requestedByUserId: 'usr-a' });
  assert.ok(run.runId.startsWith('rr_'));
  assert.equal(run.status, 'created');
  assert.equal(run.planVersion, 0);
  assert.equal(run.pauseRequested, false);
  const fetched = await research.getRun(scope, run.runId);
  assert.deepEqual(fetched, run);
  // agent scoping: other agents can't see it
  assert.equal(await research.getRun({ agentId: 'other' }, run.runId), undefined);
});

test('research runs: one nonterminal run per session enforced by the DB', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);
  await assert.rejects(() => createRun(research, scope, sessionId));
  // after the first run terminates, a new one is allowed
  await research.transitionRun(scope, run.runId, ['created'], { status: 'cancelled' });
  const second = await createRun(research, scope, sessionId);
  assert.notEqual(second.runId, run.runId);
});

test('research runs: client_request_id is idempotent per session', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId, { clientRequestId: 'cli-1' });
  await assert.rejects(() =>
    createRun(research, scope, sessionId, { clientRequestId: 'cli-1' }),
  );
  const found = await research.getRunByClientRequestId(scope, sessionId, 'cli-1');
  assert.equal(found?.runId, run.runId);
});

test('research runs: findActiveRun sees only nonterminal', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);
  assert.equal((await research.findActiveRun(scope, sessionId))?.runId, run.runId);
  await research.transitionRun(scope, run.runId, ['created'], { status: 'cancelled' });
  assert.equal(await research.findActiveRun(scope, sessionId), undefined);
});

test('research runs: CAS transition succeeds on expected status, conflicts otherwise', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);

  const planning = await research.transitionRun(scope, run.runId, ['created'], {
    status: 'planning',
    startedAt: new Date().toISOString(),
  });
  assert.equal(planning?.status, 'planning');

  // stale expectation → undefined, row untouched
  const conflict = await research.transitionRun(scope, run.runId, ['created'], {
    status: 'cancelled',
  });
  assert.equal(conflict, undefined);
  assert.equal((await research.getRun(scope, run.runId))?.status, 'planning');

  // multi-status expectation
  const paused = await research.transitionRun(
    scope,
    run.runId,
    ['planning', 'researching'],
    { status: 'paused', resumePhase: 'planning', terminalReason: 'runtime_restart' },
  );
  assert.equal(paused?.status, 'paused');
  assert.equal(paused?.resumePhase, 'planning');
});

test('research runs: optimistic plan update bumps version, stale writes conflict', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);

  const v1 = await research.updatePlan(scope, run.runId, 0, {
    planJson: { schemaVersion: 1, objective: 'v1' },
  });
  assert.equal(v1?.planVersion, 1);

  // stale expectedVersion → undefined
  assert.equal(
    await research.updatePlan(scope, run.runId, 0, { planJson: { objective: 'stale' } }),
    undefined,
  );

  const v2 = await research.updatePlan(scope, run.runId, 1, {
    planJson: { schemaVersion: 1, objective: 'v2' },
    sourcePolicyJson: { web: { mode: 'only_domains', domains: ['sec.gov'], excludedDomains: [] } },
  });
  assert.equal(v2?.planVersion, 2);
  assert.deepEqual((v2?.sourcePolicyJson as { web: { domains: string[] } }).web.domains, ['sec.gov']);
});

test('research runs: listRunsByStatus powers restart reconciliation', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);
  await research.transitionRun(scope, run.runId, ['created'], { status: 'planning' });
  const stale = await research.listRunsByStatus(scope, [
    'planning',
    'queued',
    'researching',
    'synthesizing',
  ]);
  assert.deepEqual(stale.map((r) => r.runId), [run.runId]);
});

// ─── Steps ───────────────────────────────────────────────────────────────────

test('research steps: dedupe key makes inserts idempotent; checkpoint lifecycle', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);

  const first = await research.insertStep({
    runId: run.runId,
    agentId: scope.agentId,
    iteration: 1,
    kind: 'search',
    dedupeKey: 'search:acme revenue 2025',
    questionIds: ['q1'],
    inputJson: { query: 'acme revenue 2025' },
    summary: 'Searching for revenue data',
  });
  assert.equal(first.created, true);
  assert.equal(first.step.status, 'pending');

  const retry = await research.insertStep({
    runId: run.runId,
    agentId: scope.agentId,
    iteration: 1,
    kind: 'search',
    dedupeKey: 'search:acme revenue 2025',
  });
  assert.equal(retry.created, false);
  assert.equal(retry.step.stepId, first.step.stepId);

  await research.updateStep(scope, first.step.stepId, {
    status: 'running',
    attempt: 2,
    startedAt: new Date().toISOString(),
  });
  const interrupted = await research.markRunningStepsInterrupted(scope, run.runId);
  assert.equal(interrupted, 1);

  const steps = await research.listSteps(scope, run.runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.status, 'interrupted');
  assert.equal(steps[0]!.attempt, 2);
});

test('research steps: invalidatePendingSteps only touches pending', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);
  const a = await research.insertStep({
    runId: run.runId, agentId: scope.agentId, iteration: 1, kind: 'search', dedupeKey: 'k1',
  });
  const b = await research.insertStep({
    runId: run.runId, agentId: scope.agentId, iteration: 1, kind: 'search', dedupeKey: 'k2',
  });
  await research.updateStep(scope, a.step.stepId, { status: 'completed' });
  assert.equal(await research.invalidatePendingSteps(scope, run.runId), 1);
  const steps = await research.listSteps(scope, run.runId);
  assert.equal(steps.find((s) => s.stepId === a.step.stepId)!.status, 'completed');
  assert.equal(steps.find((s) => s.stepId === b.step.stepId)!.status, 'invalidated');
});

// ─── Sources ─────────────────────────────────────────────────────────────────

test('research sources: completeSearchStep is transactional and hash-idempotent', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);
  const step = await research.insertStep({
    runId: run.runId, agentId: scope.agentId, iteration: 1, kind: 'search', dedupeKey: 's1',
  });

  const candidate = (url: string, hash: string, title: string) => ({
    runId: run.runId,
    agentId: scope.agentId,
    url,
    canonicalUrl: url,
    canonicalUrlHash: hash,
    title,
    domain: new URL(url).hostname,
    discoveredByStepId: step.step.stepId,
  });

  const sources = await research.completeSearchStep(
    scope,
    step.step.stepId,
    { status: 'completed', completedAt: new Date().toISOString(), outputJson: { count: 2 } },
    [
      candidate('https://acme.example/ir', 'hash-ir', 'IR page'),
      candidate('https://news.example/a', 'hash-news', 'News'),
      // duplicate within batch → collapsed
      candidate('https://acme.example/ir?utm_source=x', 'hash-ir', 'IR page dup'),
    ],
  );
  assert.equal(sources.length, 2);

  // a second search discovering the same URL returns the existing row
  const step2 = await research.insertStep({
    runId: run.runId, agentId: scope.agentId, iteration: 2, kind: 'search', dedupeKey: 's2',
  });
  const again = await research.completeSearchStep(
    scope,
    step2.step.stepId,
    { status: 'completed' },
    [
      { ...candidate('https://acme.example/ir', 'hash-ir', 'IR page again'), discoveredByStepId: step2.step.stepId },
      { ...candidate('https://other.example/b', 'hash-other', 'Other'), discoveredByStepId: step2.step.stepId },
    ],
  );
  assert.equal(again.length, 2);
  const irRows = again.filter((s) => s.canonicalUrlHash === 'hash-ir');
  assert.equal(irRows.length, 1);
  assert.equal(irRows[0]!.title, 'IR page'); // original row, not duplicated

  assert.equal((await research.listSources(scope, run.runId)).length, 3);
  assert.equal(
    (await research.listSteps(scope, run.runId)).find((s) => s.stepId === step.step.stepId)!.status,
    'completed',
  );
});

test('research sources: update, content-hash lookup, status filter', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);
  const step = await research.insertStep({
    runId: run.runId, agentId: scope.agentId, iteration: 1, kind: 'search', dedupeKey: 's1',
  });
  const [src] = await research.completeSearchStep(scope, step.step.stepId, { status: 'completed' }, [
    {
      runId: run.runId, agentId: scope.agentId, url: 'https://a.example/x',
      canonicalUrlHash: 'h1', discoveredByStepId: step.step.stepId,
    },
  ]);

  await research.updateSource(scope, src!.sourceId, {
    status: 'fetched',
    snapshotText: 'normalized snapshot text',
    contentHash: 'content-h',
    contentBytes: 25,
    retrievedAt: new Date().toISOString(),
    sourceClass: 'official',
    qualityJson: { authority: 'high' },
  });
  const fetched = await research.getSource(scope, run.runId, src!.sourceId);
  assert.equal(fetched?.status, 'fetched');
  assert.equal(fetched?.sourceClass, 'official');

  assert.equal(
    (await research.findSourceByContentHash(scope, run.runId, 'content-h'))?.sourceId,
    src!.sourceId,
  );
  assert.equal(
    await research.findSourceByContentHash(scope, run.runId, 'content-h', src!.sourceId),
    undefined,
  );
  assert.equal((await research.listSources(scope, run.runId, { status: 'fetched' })).length, 1);
  assert.equal((await research.listSources(scope, run.runId, { status: 'candidate' })).length, 0);
});

// ─── Evidence ────────────────────────────────────────────────────────────────

test('research evidence: hash-idempotent insert, listing, out-of-scope marking', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);

  const base = {
    runId: run.runId,
    agentId: scope.agentId,
    sourceId: 'rsrc_x',
    extractionStepId: 'rs_x',
    questionIds: ['q1'],
    excerpt: 'revenue was $4.2B',
    locatorJson: { kind: 'web_snapshot', startChar: 0, endChar: 17 },
    stance: 'supports',
    claimKey: 'acme-revenue',
  };

  const first = await research.insertEvidence([
    { ...base, evidenceHash: 'eh1' },
    { ...base, excerpt: 'margin was 18.3%', evidenceHash: 'eh2' },
    // duplicate hash within batch → collapsed
    { ...base, evidenceHash: 'eh1' },
  ]);
  assert.equal(first.length, 2);

  // retried extraction re-inserts → same rows, no duplicates
  const retry = await research.insertEvidence([
    { ...base, evidenceHash: 'eh1' },
    { ...base, excerpt: 'new excerpt', evidenceHash: 'eh3' },
  ]);
  assert.equal(retry.length, 2);
  const all = await research.listEvidence(scope, run.runId);
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((e) => e.evidenceId)).size, 3);

  // scope filter
  assert.equal((await research.listEvidence(scope, run.runId, { sourceId: 'rsrc_x' })).length, 3);
  assert.equal((await research.listEvidence(scope, run.runId, { sourceId: 'nope' })).length, 0);

  // refinement marks out-of-scope; default listing hides it, audit view keeps it
  const target = all[0]!.evidenceId;
  await research.markEvidenceOutOfScope(scope, run.runId, [target]);
  assert.equal((await research.listEvidence(scope, run.runId)).length, 2);
  const audit = await research.listEvidence(scope, run.runId, { includeOutOfScope: true });
  assert.equal(audit.length, 3);
  assert.equal(audit.find((e) => e.evidenceId === target)!.outOfScope, true);
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

test('research cleanup: deleteBySession removes evidence → sources → steps → runs', async (t) => {
  const { research, scope, sessionId } = await openResearch(t);
  const run = await createRun(research, scope, sessionId);
  const step = await research.insertStep({
    runId: run.runId, agentId: scope.agentId, iteration: 1, kind: 'search', dedupeKey: 'k',
  });
  const [src] = await research.completeSearchStep(scope, step.step.stepId, { status: 'completed' }, [
    {
      runId: run.runId, agentId: scope.agentId, url: 'https://a.example/x',
      canonicalUrlHash: 'h1', discoveredByStepId: step.step.stepId,
    },
  ]);
  await research.insertEvidence([
    {
      runId: run.runId, agentId: scope.agentId, sourceId: src!.sourceId,
      extractionStepId: step.step.stepId, questionIds: ['q1'], excerpt: 'x',
      locatorJson: {}, stance: 'context', evidenceHash: 'eh',
    },
  ]);

  // unrelated session in the same agent survives
  const otherSession = `s-${randomUUID().slice(0, 8)}`;
  const otherRun = await createRun(research, scope, otherSession);

  await research.deleteBySession(scope, sessionId);
  assert.equal(await research.getRun(scope, run.runId), undefined);
  assert.equal((await research.listSteps(scope, run.runId)).length, 0);
  assert.equal((await research.listSources(scope, run.runId)).length, 0);
  assert.equal((await research.listEvidence(scope, run.runId)).length, 0);
  assert.ok(await research.getRun(scope, otherRun.runId));
});
