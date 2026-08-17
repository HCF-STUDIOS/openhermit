import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  researchPlanSchema,
  researchDecisionSchema,
  requiredQuestionIds,
  zeroResearchUsage,
} from '../src/research/contracts.js';
import {
  GainTracker,
  InvalidResearchTransitionError,
  MAX_ACTION_RETRIES,
  RESEARCH_BUDGET_PRESETS,
  ResearchBudget,
  SYNTHESIS_RESERVE_MODEL_CALLS,
  assertTransition,
  canTransition,
  canonicalUrlHash,
  classifyFailure,
  evaluateFinishGate,
  increaseBudgetLimits,
  isDuplicateQuery,
  isTerminalStatus,
  normalizeUrl,
  queryFingerprint,
  querySimilarity,
  retryDelayMs,
} from '../src/research/guards.js';

// ─── State machine ──────────────────────────────────────────────────────────

test('state machine: happy path transitions are legal', () => {
  const path = [
    'created',
    'planning',
    'awaiting_plan_approval',
    'queued',
    'researching',
    'synthesizing',
    'completed',
  ] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransition(path[i]!, path[i + 1]!), true, `${path[i]} → ${path[i + 1]}`);
  }
});

test('state machine: pause/cancel from any nonterminal state', () => {
  for (const from of [
    'created',
    'planning',
    'awaiting_plan_approval',
    'queued',
    'researching',
    'synthesizing',
  ] as const) {
    assert.equal(canTransition(from, 'paused'), true, `${from} → paused`);
    assert.equal(canTransition(from, 'cancelled'), true, `${from} → cancelled`);
  }
});

test('state machine: illegal transitions throw', () => {
  assert.equal(canTransition('created', 'researching'), false);
  assert.equal(canTransition('completed', 'queued'), false);
  assert.equal(canTransition('cancelled', 'planning'), false);
  assert.equal(canTransition('queued', 'synthesizing'), false);
  assert.throws(
    () => assertTransition('completed', 'queued'),
    InvalidResearchTransitionError,
  );
});

test('state machine: recovery paths', () => {
  // paused resumes by phase, or re-enters plan review after refinement
  assert.equal(canTransition('paused', 'queued'), true);
  assert.equal(canTransition('paused', 'synthesizing'), true);
  assert.equal(canTransition('paused', 'awaiting_plan_approval'), true);
  // failed retries only the failed phase
  assert.equal(canTransition('failed', 'planning'), true);
  assert.equal(canTransition('failed', 'queued'), true);
  assert.equal(canTransition('failed', 'synthesizing'), true);
  // budget_exhausted resumes only via queued after a budget increase
  assert.equal(canTransition('budget_exhausted', 'queued'), true);
  assert.equal(canTransition('budget_exhausted', 'synthesizing'), false);
  assert.equal(isTerminalStatus('completed'), true);
  assert.equal(isTerminalStatus('budget_exhausted'), false);
});

// ─── Budgets ────────────────────────────────────────────────────────────────

test('budget: presets match the design table', () => {
  assert.equal(RESEARCH_BUDGET_PRESETS.quick.searches, 8);
  assert.equal(RESEARCH_BUDGET_PRESETS.standard.fetchedSources, 24);
  assert.equal(RESEARCH_BUDGET_PRESETS.thorough.modelCalls, 72);
  assert.equal(RESEARCH_BUDGET_PRESETS.standard.elapsedMs, 20 * 60_000);
});

test('budget: reservation, consumption, and synthesis reserve', () => {
  const budget = new ResearchBudget({
    ...RESEARCH_BUDGET_PRESETS.quick,
    modelCalls: 4,
    searches: 2,
  });
  assert.equal(budget.canSpendSearch(), true);
  budget.spend({ searches: 2 });
  assert.equal(budget.canSpendSearch(), false);
  assert.equal(budget.exhaustedDimension(), 'searches');

  // 4 model calls with a reserve of 2 → research may use 2
  assert.equal(SYNTHESIS_RESERVE_MODEL_CALLS, 2);
  assert.equal(budget.canSpendModelCall('research'), true);
  budget.spend({ modelCalls: 2 });
  assert.equal(budget.canSpendModelCall('research'), false);
  // ...but synthesis can still spend the reserve
  assert.equal(budget.canSpendModelCall('synthesis'), true);
  budget.spend({ modelCalls: 2 });
  assert.equal(budget.canSpendModelCall('synthesis'), false);
});

test('budget: per-source and per-run snapshot byte caps', () => {
  const budget = new ResearchBudget({
    ...RESEARCH_BUDGET_PRESETS.quick,
    bytesPerSource: 100,
    bytesPerRun: 250,
  });
  assert.equal(budget.canStoreSnapshot(100), true);
  assert.equal(budget.canStoreSnapshot(101), false);
  budget.spend({ snapshotBytes: 200 });
  assert.equal(budget.canStoreSnapshot(100), false); // run cap
  assert.equal(budget.canStoreSnapshot(50), true);
});

test('budget: elapsed-time check', () => {
  const budget = new ResearchBudget({ ...RESEARCH_BUDGET_PRESETS.quick, elapsedMs: 1000 });
  assert.equal(budget.exhaustedDimension(999), null);
  assert.equal(budget.exhaustedDimension(1000), 'elapsed');
});

test('budget: increase raises but never lowers limits', () => {
  const next = increaseBudgetLimits(RESEARCH_BUDGET_PRESETS.quick, {
    searches: 50,
    modelCalls: 1, // attempt to lower — ignored
  });
  assert.equal(next.searches, 50);
  assert.equal(next.modelCalls, RESEARCH_BUDGET_PRESETS.quick.modelCalls);
});

test('budget: usage starts at zero', () => {
  const usage = zeroResearchUsage();
  assert.equal(usage.searches, 0);
  assert.equal(usage.costUsd, null);
});

// ─── Query fingerprints ─────────────────────────────────────────────────────

test('query fingerprint: order, case, stopwords, punctuation invariant', () => {
  const a = queryFingerprint('What is the revenue of ACME Corp in 2025?');
  const b = queryFingerprint('ACME corp 2025 revenue');
  assert.equal(a, b);
  assert.notEqual(queryFingerprint('acme revenue 2025'), queryFingerprint('acme profit 2025'));
});

test('query similarity: near-duplicates detected without embeddings', () => {
  assert.ok(
    querySimilarity(
      'ACME 2025 annual revenue report',
      'annual revenue report ACME 2025 filings',
    ) >= 0.8,
  );
  assert.ok(querySimilarity('acme revenue', 'weather in paris') < 0.2);
});

test('isDuplicateQuery: exact reformulations and near-duplicates rejected', () => {
  const prior = ['ACME Corp revenue 2025', 'ACME market share Europe'];
  assert.equal(isDuplicateQuery('what is acme corp 2025 revenue?', prior), true);
  assert.equal(isDuplicateQuery('ACME CEO compensation history', prior), false);
});

// ─── URL normalization ──────────────────────────────────────────────────────

test('normalizeUrl: strips tracking params, fragment, default port; sorts params', () => {
  assert.equal(
    normalizeUrl(
      'HTTPS://Example.COM:443/Path/?utm_source=x&b=2&a=1&fbclid=abc#frag',
    ),
    'https://example.com/Path?a=1&b=2',
  );
});

test('normalizeUrl: keeps meaningful params and non-default ports', () => {
  assert.equal(
    normalizeUrl('https://example.com:8443/search?q=acme'),
    'https://example.com:8443/search?q=acme',
  );
});

test('normalizeUrl: trailing slash trimmed off non-root paths only', () => {
  assert.equal(normalizeUrl('https://example.com/docs/'), 'https://example.com/docs');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
});

test('canonicalUrlHash: equal for equivalent URLs, distinct otherwise', () => {
  assert.equal(
    canonicalUrlHash('https://example.com/a?utm_campaign=x'),
    canonicalUrlHash('https://EXAMPLE.com/a#top'),
  );
  assert.notEqual(
    canonicalUrlHash('https://example.com/a'),
    canonicalUrlHash('https://example.com/b'),
  );
});

// ─── Finish gate and information gain ───────────────────────────────────────

test('finish gate: passes when required questions covered and contradictions handled', () => {
  const result = evaluateFinishGate({
    requiredQuestionIds: ['q1', 'q2'],
    coveredQuestionIds: ['q1', 'q2', 'q3'],
    contradictions: [{ claimKey: 'k', resolved: false, followUpAttempted: true }],
    unresolvedContradictionsAllowed: true,
  });
  assert.equal(result.pass, true);
});

test('finish gate: fails on uncovered required question', () => {
  const result = evaluateFinishGate({
    requiredQuestionIds: ['q1', 'q2'],
    coveredQuestionIds: ['q1'],
    contradictions: [],
    unresolvedContradictionsAllowed: true,
  });
  assert.equal(result.pass, false);
  assert.match(result.reasons[0]!, /q2/);
});

test('finish gate: contradiction without follow-up blocks; strict mode requires resolution', () => {
  const noFollowUp = evaluateFinishGate({
    requiredQuestionIds: [],
    coveredQuestionIds: [],
    contradictions: [{ claimKey: 'rev', resolved: false, followUpAttempted: false }],
    unresolvedContradictionsAllowed: true,
  });
  assert.equal(noFollowUp.pass, false);

  const strict = evaluateFinishGate({
    requiredQuestionIds: [],
    coveredQuestionIds: [],
    contradictions: [{ claimKey: 'rev', resolved: false, followUpAttempted: true }],
    unresolvedContradictionsAllowed: false,
  });
  assert.equal(strict.pass, false);
});

test('gain tracker: three consecutive zero-gain iterations trip the stop', () => {
  const tracker = new GainTracker();
  const zero = { newEvidence: 0, newSourceClasses: 0, newCoveredQuestions: 0, resolvedContradictions: 0 };
  tracker.record(zero);
  tracker.record(zero);
  assert.equal(tracker.diminished, false);
  tracker.record(zero);
  assert.equal(tracker.diminished, true);
  // any gain resets the streak
  tracker.record({ ...zero, newEvidence: 1 });
  assert.equal(tracker.zeroGainStreak, 0);
});

// ─── Retry classification and backoff ───────────────────────────────────────

test('classifyFailure: 429 with Retry-After, 5xx retryable, 4xx fatal', () => {
  const limited = classifyFailure({ status: 429, retryAfterSeconds: 7 });
  assert.equal(limited.class, 'rate_limited');
  assert.equal(limited.retryAfterMs, 7000);
  assert.equal(classifyFailure({ status: 503 }).class, 'retryable');
  assert.equal(classifyFailure({ status: 408 }).class, 'retryable');
  assert.equal(classifyFailure({ status: 404 }).class, 'fatal');
  assert.equal(classifyFailure({ status: 401 }).class, 'fatal');
});

test('classifyFailure: network/timeout messages retryable, others fatal', () => {
  assert.equal(classifyFailure({ message: 'request timed out (url=x)' }).class, 'retryable');
  assert.equal(classifyFailure({ message: 'fetch failed: ECONNRESET' }).class, 'retryable');
  assert.equal(classifyFailure({ message: 'invalid API key' }).class, 'fatal');
});

test('retryDelayMs: deterministic with injected randomness, capped', () => {
  const noJitter = () => 0;
  const fullJitter = () => 1;
  assert.equal(retryDelayMs(1, { baseMs: 500, random: noJitter }), 250);
  assert.equal(retryDelayMs(1, { baseMs: 500, random: fullJitter }), 500);
  assert.equal(retryDelayMs(2, { baseMs: 500, random: fullJitter }), 1000);
  assert.equal(retryDelayMs(10, { baseMs: 500, capMs: 4000, random: fullJitter }), 4000);
  assert.ok(MAX_ACTION_RETRIES >= 1);
});

// ─── Contract schemas ───────────────────────────────────────────────────────

const validPlan = {
  objective: 'Understand ACME 2025 revenue',
  questions: [
    { id: 'q1', question: 'What was 2025 revenue?', priority: 'required', rationale: 'core' },
    { id: 'q2', question: 'How does it compare to 2024?', priority: 'supporting', rationale: 'context' },
  ],
  deliverable: { format: 'report', requestedSections: ['Summary'] },
  completionCriteria: { requiredQuestionIds: ['q1'], unresolvedContradictionsAllowed: true },
};

test('plan schema: accepts a valid plan and derives required questions', () => {
  const plan = researchPlanSchema.parse(validPlan);
  assert.equal(plan.schemaVersion, 1);
  assert.deepEqual(requiredQuestionIds(plan), ['q1']);
});

test('plan schema: defaults required questions from priority when criteria empty', () => {
  const plan = researchPlanSchema.parse({
    ...validPlan,
    completionCriteria: { requiredQuestionIds: [], unresolvedContradictionsAllowed: true },
  });
  assert.deepEqual(requiredQuestionIds(plan), ['q1']);
});

test('plan schema: rejects duplicate and dangling question ids', () => {
  assert.equal(
    researchPlanSchema.safeParse({
      ...validPlan,
      questions: [validPlan.questions[0], validPlan.questions[0]],
    }).success,
    false,
  );
  assert.equal(
    researchPlanSchema.safeParse({
      ...validPlan,
      completionCriteria: { requiredQuestionIds: ['nope'], unresolvedContradictionsAllowed: true },
    }).success,
    false,
  );
});

test('decision schema: validates 1–3 typed actions and rejects unknown types', () => {
  const ok = researchDecisionSchema.parse({
    actions: [
      { type: 'search', questionIds: ['q1'], query: 'acme revenue 2025', rationale: 'gap' },
      { type: 'finish', rationale: 'covered' },
    ],
  });
  assert.equal(ok.actions.length, 2);
  assert.equal(
    researchDecisionSchema.safeParse({ actions: [] }).success,
    false,
  );
  assert.equal(
    researchDecisionSchema.safeParse({
      actions: [{ type: 'run_shell', command: 'rm -rf /' }],
    }).success,
    false,
  );
  assert.equal(
    researchDecisionSchema.safeParse({
      actions: [
        { type: 'search', questionIds: ['q1'], query: 'a' },
        { type: 'search', questionIds: ['q1'], query: 'b' },
        { type: 'search', questionIds: ['q1'], query: 'c' },
        { type: 'search', questionIds: ['q1'], query: 'd' },
      ],
    }).success,
    false,
  );
});

// ─── Phase-call failure reporting ───────────────────────────────────────────

test('callPhaseWithRepair: truncation (stopReason=length) is named, not "unparseable"', async () => {
  const { callPhaseWithRepair } = await import('../src/research/model-phase.js');
  const truncated = '{"actions": [{"type": "search", "questionIds": ["q1"], "query": "acme';
  const model = async () => ({ text: truncated, stopReason: 'length' as const });
  await assert.rejects(
    () =>
      callPhaseWithRepair(model, researchDecisionSchema, {
        runId: 'rr_t', sessionId: 's', phase: 'decision',
        systemPrompt: 'sys', userPrompt: 'user',
      }),
    (err: unknown) =>
      err instanceof Error && /truncated at the model output-token limit/.test(err.message),
  );
});

test('callPhaseWithRepair: unparseable prose error includes the answer head', async () => {
  const { callPhaseWithRepair } = await import('../src/research/model-phase.js');
  const model = async () => ({ text: 'Sure! Here is my plan in prose form.' });
  await assert.rejects(
    () =>
      callPhaseWithRepair(model, researchDecisionSchema, {
        runId: 'rr_t', sessionId: 's', phase: 'decision',
        systemPrompt: 'sys', userPrompt: 'user',
      }),
    (err: unknown) =>
      err instanceof Error && /began: "Sure! Here is my plan/.test(err.message),
  );
});
