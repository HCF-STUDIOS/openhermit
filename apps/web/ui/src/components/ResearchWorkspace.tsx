import { useCallback, useEffect, useState } from 'react';
import {
  getResearchSource,
  researchRunAction,
  updateResearchPlan,
  type ResearchRunActionRequest,
} from '../api';
import type { ResearchState } from '../research/reducer';
import { useTranslation } from '../i18n';
import { ResearchPlanEditor, type UiPlan, type UiSourcePolicy } from './ResearchPlanEditor';
import { ResearchReport, parseUiReport } from './ResearchReport';
import { ResearchSources } from './ResearchSources';
import { ResearchTimeline } from './ResearchTimeline';

/**
 * The research workspace for a session's current run: plan review, live
 * progress timeline, source panel, and the structured report — with the
 * §13 controls (approve, save, pause, resume, refine, cancel, retry).
 */

type Tab = 'progress' | 'sources' | 'report';

interface Props {
  sessionId: string;
  state: ResearchState;
  /** Reload run/steps/sources from the durable store. */
  onRefresh: () => void;
  onError: (message: string) => void;
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  created: 'research.status.created',
  planning: 'research.status.planning',
  awaiting_plan_approval: 'research.status.awaiting',
  queued: 'research.status.queued',
  researching: 'research.status.researching',
  synthesizing: 'research.status.synthesizing',
  paused: 'research.status.paused',
  completed: 'research.status.completed',
  cancelled: 'research.status.cancelled',
  failed: 'research.status.failed',
  budget_exhausted: 'research.status.budgetExhausted',
};

export function ResearchWorkspace({ sessionId, state, onRefresh, onError }: Props) {
  const { t } = useTranslation();
  const run = state.run;
  const [tab, setTab] = useState<Tab>('progress');
  const [busy, setBusy] = useState(false);
  const [focusSourceId, setFocusSourceId] = useState<string | null>(null);
  const [evidenceSourceMap, setEvidenceSourceMap] = useState<Record<string, string>>({});

  const act = useCallback(
    async (action: ResearchRunActionRequest): Promise<void> => {
      if (!run) return;
      setBusy(true);
      try {
        await researchRunAction(sessionId, run.runId, action);
        onRefresh();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [run, sessionId, onRefresh, onError],
  );

  const savePlan = useCallback(
    async (plan: UiPlan, expectedVersion: number, sourcePolicy: UiSourcePolicy): Promise<void> => {
      if (!run) return;
      setBusy(true);
      try {
        await updateResearchPlan(sessionId, run.runId, {
          expectedVersion,
          plan,
          sourcePolicy,
        });
        onRefresh();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
        onRefresh(); // stale version → reload the authoritative plan
      } finally {
        setBusy(false);
      }
    },
    [run, sessionId, onRefresh, onError],
  );

  // Report citation → owning source: resolve lazily by loading evidence for
  // fetched sources once the report tab first opens.
  const report = run?.report ? parseUiReport(run.report) : null;
  useEffect(() => {
    if (tab !== 'report' || !run || !report) return;
    const fetched = state.sources.filter((s) => s.status === 'fetched');
    let cancelled = false;
    void (async () => {
      const map: Record<string, string> = {};
      for (const source of fetched) {
        try {
          const detail = await getResearchSource(sessionId, run.runId, source.sourceId);
          for (const item of detail.evidence) map[item.evidenceId] = source.sourceId;
        } catch { /* best-effort */ }
      }
      if (!cancelled) setEvidenceSourceMap(map);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, run?.runId, state.sources.length]);

  if (!run) return null;

  const status = run.status;
  const executing = status === 'planning' || status === 'researching' || status === 'synthesizing';
  const terminal = status === 'completed' || status === 'cancelled';
  const statusLabel = t((STATUS_LABEL_KEYS[status] ?? 'research.status.created') as never) || status;

  return (
    <div className="research-workspace">
      <div className="research-workspace__header">
        <span className={`research-workspace__status is-${status}`}>{statusLabel}</span>
        <span className="research-workspace__objective" title={run.objective}>
          {run.objective}
        </span>
        {state.counts && (
          <span className="research-workspace__counts">
            {t('research.counts', {
              searches: String(state.counts.searches),
              sources: String(state.counts.fetchedSources),
              evidence: String(state.counts.evidenceItems),
            })}
          </span>
        )}
        <span className="research-workspace__controls">
          {executing && (
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void act({ action: 'pause' })}>
              {t('research.pause')}
            </button>
          )}
          {(status === 'paused' || status === 'budget_exhausted') && (
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void act({ action: 'resume' })}>
              {t('research.resume')}
            </button>
          )}
          {status === 'failed' && (
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void act({ action: 'retry' })}>
              {t('research.retry')}
            </button>
          )}
          {!terminal && status !== 'awaiting_plan_approval' && (
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void act({ action: 'cancel' })}>
              {t('common.cancel')}
            </button>
          )}
        </span>
      </div>

      {run.lastError && (status === 'failed' || status === 'paused') && (
        <p className="research-workspace__error">{run.lastError}</p>
      )}

      {status === 'awaiting_plan_approval' ? (
        <ResearchPlanEditor
          run={run}
          busy={busy}
          onApprove={(v) => void act({ action: 'approve_plan', expectedPlanVersion: v })}
          onSave={(plan, version, policy) => void savePlan(plan, version, policy)}
          onRefine={(instruction) => void act({ action: 'refine', instruction })}
          onCancel={() => void act({ action: 'cancel' })}
        />
      ) : (
        <>
          <div className="research-workspace__tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'progress'}
              className={tab === 'progress' ? 'is-active' : ''}
              onClick={() => setTab('progress')}
            >
              {t('research.tabProgress')}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'sources'}
              className={tab === 'sources' ? 'is-active' : ''}
              onClick={() => setTab('sources')}
            >
              {t('research.tabSources')} ({state.sources.length})
            </button>
            {report && (
              <button
                role="tab"
                aria-selected={tab === 'report'}
                className={tab === 'report' ? 'is-active' : ''}
                onClick={() => setTab('report')}
              >
                {t('research.tabReport')}
              </button>
            )}
          </div>

          {tab === 'progress' && (
            <ResearchTimeline steps={state.steps} activity={state.activity} />
          )}
          {tab === 'sources' && (
            <ResearchSources
              sessionId={sessionId}
              runId={run.runId}
              sources={state.sources}
              focusSourceId={focusSourceId}
            />
          )}
          {tab === 'report' && report && (
            <ResearchReport
              report={report}
              partial={status === 'budget_exhausted'}
              onCitationClick={(evidenceId) => {
                const sourceId = evidenceSourceMap[evidenceId];
                if (sourceId) {
                  setFocusSourceId(sourceId);
                  setTab('sources');
                }
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
