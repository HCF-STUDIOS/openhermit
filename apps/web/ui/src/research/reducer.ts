import type {
  ResearchRunWire,
  ResearchSourceWire,
  ResearchStepWire,
} from '@openhermit/protocol';

/**
 * Pure, DOM-free research UI state. The protocol is
 * durable-reload-then-live-events (design §13): the caller reloads
 * run/steps/sources over HTTP, then live session events patch the state and —
 * for events that imply new durable rows — bump `refreshNonce` so the
 * component refetches. Live progress lines are deduplicated against durable
 * timeline rows by stepId.
 */

export interface ResearchCounts {
  searches: number;
  fetchedSources: number;
  evidenceItems: number;
  coveredQuestions: number;
}

export interface ResearchActivityLine {
  stepId?: string | undefined;
  phase: string;
  message: string;
}

export interface ResearchState {
  run: ResearchRunWire | null;
  steps: ResearchStepWire[];
  sources: ResearchSourceWire[];
  /** Most recent live progress lines, newest last, deduped by stepId. */
  activity: ResearchActivityLine[];
  counts: ResearchCounts | null;
  /** Bumped when a live event implies new durable rows to refetch. */
  refreshNonce: number;
  loaded: boolean;
}

export const initialResearchState: ResearchState = {
  run: null,
  steps: [],
  sources: [],
  activity: [],
  counts: null,
  refreshNonce: 0,
  loaded: false,
};

const ACTIVITY_CAP = 12;

/** Loosely-typed live session event (the web UI keeps events structural). */
export interface ResearchUiEvent {
  type: string;
  runId?: string;
  stepId?: string;
  phase?: string;
  status?: string;
  message?: string;
  counts?: ResearchCounts;
  planVersion?: number;
  sourceId?: string;
  title?: string;
  domain?: string;
  terminalStatus?: string;
}

export type ResearchStateAction =
  | { type: 'clear' }
  | {
      type: 'loaded';
      run: ResearchRunWire | null;
      steps?: ResearchStepWire[];
      sources?: ResearchSourceWire[];
    }
  | { type: 'run'; run: ResearchRunWire }
  | { type: 'event'; event: ResearchUiEvent };

const isResearchEventType = (type: string): boolean =>
  type === 'research_progress' ||
  type === 'research_plan_ready' ||
  type === 'research_source_update' ||
  type === 'research_report_ready';

export const isResearchEvent = (event: { type: string }): boolean =>
  isResearchEventType(event.type);

const pushActivity = (
  activity: ResearchActivityLine[],
  line: ResearchActivityLine,
): ResearchActivityLine[] => {
  const next = line.stepId
    ? activity.filter((a) => a.stepId !== line.stepId)
    : [...activity];
  next.push(line);
  return next.slice(-ACTIVITY_CAP);
};

export const reduceResearch = (
  state: ResearchState,
  action: ResearchStateAction,
): ResearchState => {
  switch (action.type) {
    case 'clear':
      return initialResearchState;

    case 'loaded': {
      // A durable reload is authoritative: replace rows, drop live lines
      // whose stepId now has a durable row (the timeline shows those).
      const stepIds = new Set((action.steps ?? []).map((s) => s.stepId));
      return {
        run: action.run,
        steps: action.steps ?? [],
        sources: action.sources ?? [],
        activity: state.activity.filter((a) => !a.stepId || !stepIds.has(a.stepId)),
        counts: state.counts,
        refreshNonce: state.refreshNonce,
        loaded: true,
      };
    }

    case 'run': {
      // Control responses return the latest run representation.
      return { ...state, run: action.run, loaded: true };
    }

    case 'event': {
      const event = action.event;
      if (!isResearchEventType(event.type)) return state;
      // Events for a different (e.g. older) run than the loaded one only
      // trigger a reload — never patch the wrong run.
      if (state.run && event.runId && event.runId !== state.run.runId) {
        return { ...state, refreshNonce: state.refreshNonce + 1 };
      }

      if (event.type === 'research_progress') {
        const run = state.run
          ? { ...state.run, ...(event.status ? { status: event.status as ResearchRunWire['status'] } : {}) }
          : state.run;
        const terminalish =
          event.status === 'completed' ||
          event.status === 'failed' ||
          event.status === 'cancelled' ||
          event.status === 'budget_exhausted' ||
          event.status === 'paused';
        return {
          ...state,
          run,
          counts: event.counts ?? state.counts,
          activity: event.message
            ? pushActivity(state.activity, {
                stepId: event.stepId,
                phase: event.phase ?? '',
                message: event.message,
              })
            : state.activity,
          // Progress implies new durable steps; also refetch on settle.
          refreshNonce: event.stepId || terminalish ? state.refreshNonce + 1 : state.refreshNonce,
        };
      }

      if (event.type === 'research_plan_ready') {
        return {
          ...state,
          run: state.run
            ? {
                ...state.run,
                status: 'awaiting_plan_approval',
                planVersion: event.planVersion ?? state.run.planVersion,
              }
            : state.run,
          refreshNonce: state.refreshNonce + 1,
        };
      }

      if (event.type === 'research_source_update') {
        if (!event.sourceId) return state;
        const existing = state.sources.find((s) => s.sourceId === event.sourceId);
        const sources = existing
          ? state.sources.map((s) =>
              s.sourceId === event.sourceId
                ? {
                    ...s,
                    status: (event.status ?? s.status) as ResearchSourceWire['status'],
                    ...(event.title ? { title: event.title } : {}),
                    ...(event.domain ? { domain: event.domain } : {}),
                  }
                : s,
            )
          : [
              ...state.sources,
              {
                sourceId: event.sourceId,
                runId: event.runId ?? state.run?.runId ?? '',
                kind: 'web',
                status: (event.status ?? 'candidate') as ResearchSourceWire['status'],
                sourceClass: 'unknown',
                truncated: false,
                createdAt: '',
                ...(event.title ? { title: event.title } : {}),
                ...(event.domain ? { domain: event.domain } : {}),
              },
            ];
        return { ...state, sources };
      }

      // research_report_ready
      return {
        ...state,
        run: state.run
          ? {
              ...state.run,
              status: (event.terminalStatus ?? 'completed') as ResearchRunWire['status'],
            }
          : state.run,
        refreshNonce: state.refreshNonce + 1,
      };
    }
  }
};

/** The run the workspace should surface for a session: newest nonterminal, else newest. */
export const pickCurrentRun = (runs: ResearchRunWire[]): ResearchRunWire | null => {
  if (runs.length === 0) return null;
  const nonterminal = runs.find((r) => r.status !== 'completed' && r.status !== 'cancelled');
  return nonterminal ?? runs[0] ?? null;
};

/** True when the run is actively executing and chat turns would 409. */
export const isResearchExecuting = (run: ResearchRunWire | null): boolean =>
  run !== null &&
  (run.status === 'planning' || run.status === 'researching' || run.status === 'synthesizing');
