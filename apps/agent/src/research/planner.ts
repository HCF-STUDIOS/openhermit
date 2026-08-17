import type { LangfuseTurnContext } from '../langfuse.js';

import {
  researchPlanSchema,
  type ResearchBudgetLimits,
  type ResearchDepth,
  type ResearchPlan,
  type ResearchSourcePolicy,
} from './contracts.js';
import {
  callPhaseWithRepair,
  type PhaseOutcome,
  type ResearchPhaseModel,
} from './model-phase.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } from './prompts.js';

/**
 * Planner phase: objective + fixed source policy + budget in, validated
 * ResearchPlan out. No tools, no retrieved content (§8). Also used for
 * refinements, where the previous plan and the user's instruction are
 * included so question ids stay stable.
 */
export const runPlannerPhase = async (input: {
  model: ResearchPhaseModel;
  runId: string;
  sessionId: string;
  objective: string;
  depth: ResearchDepth;
  sourcePolicy: ResearchSourcePolicy;
  budget: ResearchBudgetLimits;
  refinementInstruction?: string | undefined;
  previousPlan?: ResearchPlan | undefined;
  signal?: AbortSignal | undefined;
  langfuseTurnContext?: LangfuseTurnContext | undefined;
}): Promise<PhaseOutcome<ResearchPlan>> =>
  callPhaseWithRepair(input.model, researchPlanSchema, {
    runId: input.runId,
    sessionId: input.sessionId,
    phase: 'planner',
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    userPrompt: buildPlannerUserPrompt({
      objective: input.objective,
      depth: input.depth,
      sourcePolicy: input.sourcePolicy,
      budget: input.budget,
      refinementInstruction: input.refinementInstruction,
      previousPlan: input.previousPlan,
    }),
    signal: input.signal,
    langfuseTurnContext: input.langfuseTurnContext,
  });
