import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  initialResearchState,
  isResearchEvent,
  isResearchExecuting,
  pickCurrentRun,
  reduceResearch,
  type ResearchState,
} from '../ui/src/research/reducer.js';
import type { ResearchRunWire, ResearchStepWire } from '@openhermit/protocol';

const run = (overrides: Partial<ResearchRunWire> = {}): ResearchRunWire => ({
  runId: 'rr_1',
  sessionId: 'web:s1',
  status: 'researching',
  depth: 'standard',
  objective: 'ACME 2025',
  planVersion: 1,
  createdAt: 'x',
  updatedAt: 'x',
  ...overrides,
});

const step = (stepId: string, overrides: Partial<ResearchStepWire> = {}): ResearchStepWire => ({
  stepId,
  runId: 'rr_1',
  iteration: 1,
  attempt: 1,
  kind: 'search',
  status: 'completed',
  questionIds: [],
  createdAt: 'x',
  ...overrides,
});

test('reducer: durable load replaces rows and drops superseded live lines', () => {
  let state: ResearchState = initialResearchState;
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_progress', runId: 'rr_1', stepId: 'rs_1', phase: 'searching', message: 'Searching A' },
  });
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_progress', runId: 'rr_1', stepId: 'rs_2', phase: 'reading_source', message: 'Reading B' },
  });
  assert.equal(state.activity.length, 2);

  // Durable reload arrives with a row for rs_1 only → rs_1's live line is
  // superseded by the timeline, rs_2's stays.
  state = reduceResearch(state, {
    type: 'loaded',
    run: run(),
    steps: [step('rs_1')],
    sources: [],
  });
  assert.equal(state.loaded, true);
  assert.deepEqual(state.activity.map((a) => a.stepId), ['rs_2']);
  assert.equal(state.steps.length, 1);
});

test('reducer: progress events update status/counts and dedupe by stepId', () => {
  let state = reduceResearch(initialResearchState, { type: 'loaded', run: run(), steps: [], sources: [] });
  state = reduceResearch(state, {
    type: 'event',
    event: {
      type: 'research_progress', runId: 'rr_1', stepId: 'rs_9', phase: 'searching',
      status: 'researching', message: 'Searching v1',
      counts: { searches: 1, fetchedSources: 0, evidenceItems: 0, coveredQuestions: 0 },
    },
  });
  state = reduceResearch(state, {
    type: 'event',
    event: {
      type: 'research_progress', runId: 'rr_1', stepId: 'rs_9', phase: 'reviewing_sources',
      status: 'researching', message: 'Reviewing 5 candidates',
      counts: { searches: 1, fetchedSources: 0, evidenceItems: 0, coveredQuestions: 0 },
    },
  });
  // Same stepId → one line, latest message wins.
  assert.equal(state.activity.length, 1);
  assert.equal(state.activity[0]!.message, 'Reviewing 5 candidates');
  assert.equal(state.counts?.searches, 1);
  assert.ok(state.refreshNonce > 0, 'stepId progress implies new durable rows');
});

test('reducer: plan_ready flips status and refreshNonce but NOT planVersion', () => {
  let state = reduceResearch(initialResearchState, {
    type: 'loaded',
    run: run({ status: 'planning', planVersion: 0 }),
  });
  const before = state.refreshNonce;
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_plan_ready', runId: 'rr_1', planVersion: 1 },
  });
  assert.equal(state.run?.status, 'awaiting_plan_approval');
  // Version stays until the durable reload delivers version + plan body
  // together — patching it early desyncs the plan editor (it keys its
  // resync off the version and would keep showing a stale/missing plan).
  assert.equal(state.run?.planVersion, 0);
  assert.equal(state.refreshNonce, before + 1);

  // The durable reload then lands both atomically.
  state = reduceResearch(state, {
    type: 'loaded',
    run: run({ status: 'awaiting_plan_approval', planVersion: 1, plan: { objective: 'ACME 2025', questions: [] } }),
  });
  assert.equal(state.run?.planVersion, 1);
  assert.ok(state.run?.plan);
});

test('reducer: source updates upsert by sourceId', () => {
  let state = reduceResearch(initialResearchState, { type: 'loaded', run: run(), steps: [], sources: [] });
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_source_update', runId: 'rr_1', sourceId: 'rsrc_1', status: 'candidate', title: 'T', domain: 'a.example' },
  });
  assert.equal(state.sources.length, 1);
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_source_update', runId: 'rr_1', sourceId: 'rsrc_1', status: 'fetched' },
  });
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0]!.status, 'fetched');
  assert.equal(state.sources[0]!.title, 'T');
});

test('reducer: report_ready sets terminal status and triggers refetch', () => {
  let state = reduceResearch(initialResearchState, { type: 'loaded', run: run({ status: 'synthesizing' }) });
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_report_ready', runId: 'rr_1', terminalStatus: 'budget_exhausted' },
  });
  assert.equal(state.run?.status, 'budget_exhausted');
  assert.equal(state.refreshNonce, 1);
});

test('reducer: events for a different run only trigger a reload', () => {
  let state = reduceResearch(initialResearchState, { type: 'loaded', run: run() });
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_progress', runId: 'rr_OTHER', status: 'failed', phase: 'failed', message: 'nope' },
  });
  assert.equal(state.run?.status, 'researching'); // untouched
  assert.equal(state.refreshNonce, 1);
  assert.equal(state.activity.length, 0);
});

test('reducer: non-research events and clear', () => {
  let state = reduceResearch(initialResearchState, { type: 'loaded', run: run() });
  const before = state;
  state = reduceResearch(state, { type: 'event', event: { type: 'text_delta' } });
  assert.equal(state, before);
  state = reduceResearch(state, { type: 'clear' });
  assert.deepEqual(state, initialResearchState);
  assert.equal(isResearchEvent({ type: 'research_progress' }), true);
  assert.equal(isResearchEvent({ type: 'text_final' }), false);
});

test('pickCurrentRun prefers the nonterminal run; isResearchExecuting gates chat', () => {
  const completed = run({ runId: 'rr_a', status: 'completed' });
  const paused = run({ runId: 'rr_b', status: 'paused' });
  assert.equal(pickCurrentRun([completed, paused])?.runId, 'rr_b');
  assert.equal(pickCurrentRun([completed])?.runId, 'rr_a');
  assert.equal(pickCurrentRun([]), null);

  assert.equal(isResearchExecuting(run({ status: 'researching' })), true);
  assert.equal(isResearchExecuting(run({ status: 'planning' })), true);
  assert.equal(isResearchExecuting(run({ status: 'awaiting_plan_approval' })), false);
  assert.equal(isResearchExecuting(run({ status: 'paused' })), false);
  assert.equal(isResearchExecuting(null), false);
});

test('reducer: a new run resets run-scoped rows; the same run only updates', () => {
  let state: ResearchState = reduceResearch(initialResearchState, {
    type: 'loaded',
    run: run({ runId: 'rr_old', status: 'completed' }),
    steps: [step('rs_old', { runId: 'rr_old' })],
    sources: [],
  });
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_progress', runId: 'rr_old', message: 'done', phase: 'synthesizing', counts: { searches: 3, fetchedSources: 2, evidenceItems: 5, coveredQuestions: 2 } },
  });
  assert.ok(state.counts);
  const nonce = state.refreshNonce;

  // Starting a new run must not show it over the old run's rows.
  state = reduceResearch(state, { type: 'run', run: run({ runId: 'rr_new', status: 'planning' }) });
  assert.equal(state.run?.runId, 'rr_new');
  assert.deepEqual(state.steps, []);
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.activity, []);
  assert.equal(state.counts, null);
  assert.equal(state.refreshNonce, nonce);
  assert.equal(state.loaded, true);

  // Same-run control response keeps existing rows.
  state = reduceResearch(state, {
    type: 'event',
    event: { type: 'research_progress', runId: 'rr_new', stepId: 'rs_n1', phase: 'searching', message: 'Searching' },
  });
  const activityBefore = state.activity;
  state = reduceResearch(state, { type: 'run', run: run({ runId: 'rr_new', status: 'paused' }) });
  assert.equal(state.run?.status, 'paused');
  assert.equal(state.activity, activityBefore);
});

test('estimateResearchMinutes: budget-derived approximation, capped by elapsed budget', async () => {
  const { estimateResearchMinutes } = await import('../ui/src/research/estimate.js');

  // Default presets: quick 6 iterations → ~2–4 min; standard 12 → ~4–8 min.
  assert.deepEqual(
    estimateResearchMinutes({ iterations: 6, elapsedMs: 10 * 60_000 }),
    { lowMinutes: 2, highMinutes: 4 },
  );
  assert.deepEqual(
    estimateResearchMinutes({ iterations: 12, elapsedMs: 20 * 60_000 }),
    { lowMinutes: 4, highMinutes: 8 },
  );

  // A tight elapsed budget caps the upper bound.
  assert.deepEqual(
    estimateResearchMinutes({ iterations: 20, elapsedMs: 5 * 60_000 }),
    { lowMinutes: 5, highMinutes: 5 },
  );

  // Missing or empty budgets produce no estimate rather than a bogus one.
  assert.equal(estimateResearchMinutes(undefined), null);
  assert.equal(estimateResearchMinutes({}), null);
  assert.equal(estimateResearchMinutes({ iterations: 0 }), null);
});
