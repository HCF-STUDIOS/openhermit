import { useEffect, useState } from 'react';
import type { ResearchRunWire } from '../api';
import { estimateResearchMinutes } from '../research/estimate';
import { useTranslation } from '../i18n';

/** Structural view of the plan object (validated server-side). */
export interface UiPlanQuestion {
  id: string;
  question: string;
  priority: 'required' | 'supporting';
  rationale?: string;
}

export interface UiPlan {
  schemaVersion: number;
  objective: string;
  audience?: string;
  assumptions: string[];
  scope: {
    includedTopics: string[];
    excludedTopics: string[];
    timeframe?: { from?: string; to?: string };
  };
  questions: UiPlanQuestion[];
  deliverable: { format: string; requestedSections: string[] };
  completionCriteria: {
    requiredQuestionIds: string[];
    unresolvedContradictionsAllowed: boolean;
  };
}

export interface UiSourcePolicy {
  web: { mode: 'full_web' | 'only_domains' | 'prefer_domains'; domains: string[]; excludedDomains: string[] };
  attachmentIds: string[];
  mcpServerIds: string[];
  allowCodeAnalysis: boolean;
}

export const parseUiPlan = (raw: unknown): UiPlan | null => {
  if (!raw || typeof raw !== 'object') return null;
  const plan = raw as Partial<UiPlan>;
  if (typeof plan.objective !== 'string' || !Array.isArray(plan.questions)) return null;
  return {
    schemaVersion: typeof plan.schemaVersion === 'number' ? plan.schemaVersion : 1,
    objective: plan.objective,
    ...(typeof plan.audience === 'string' ? { audience: plan.audience } : {}),
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions : [],
    scope: {
      includedTopics: plan.scope?.includedTopics ?? [],
      excludedTopics: plan.scope?.excludedTopics ?? [],
      ...(plan.scope?.timeframe ? { timeframe: plan.scope.timeframe } : {}),
    },
    questions: plan.questions as UiPlanQuestion[],
    deliverable: {
      format: plan.deliverable?.format ?? 'report',
      requestedSections: plan.deliverable?.requestedSections ?? [],
    },
    completionCriteria: {
      requiredQuestionIds: plan.completionCriteria?.requiredQuestionIds ?? [],
      unresolvedContradictionsAllowed:
        plan.completionCriteria?.unresolvedContradictionsAllowed ?? true,
    },
  };
};

export const parseUiSourcePolicy = (raw: unknown): UiSourcePolicy => {
  const p = (raw ?? {}) as Partial<UiSourcePolicy>;
  return {
    web: {
      mode: p.web?.mode ?? 'full_web',
      domains: p.web?.domains ?? [],
      excludedDomains: p.web?.excludedDomains ?? [],
    },
    attachmentIds: p.attachmentIds ?? [],
    mcpServerIds: p.mcpServerIds ?? [],
    allowCodeAnalysis: p.allowCodeAnalysis ?? false,
  };
};

const splitList = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

interface Props {
  run: ResearchRunWire;
  busy: boolean;
  onApprove: (expectedPlanVersion: number) => void;
  onSave: (plan: UiPlan, expectedVersion: number, sourcePolicy: UiSourcePolicy) => void;
  onRefine: (instruction: string) => void;
  onCancel: () => void;
}

export function ResearchPlanEditor({ run, busy, onApprove, onSave, onRefine, onCancel }: Props) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<UiPlan | null>(() => parseUiPlan(run.plan));
  const [policy, setPolicy] = useState<UiSourcePolicy>(() => parseUiSourcePolicy(run.sourcePolicy));
  const [dirty, setDirty] = useState(false);
  const [refineText, setRefineText] = useState('');

  // A new plan version from the server (planner finished, refinement landed)
  // replaces local edits — the durable plan is authoritative. The plan body
  // can also arrive AFTER the status flip (live event first, durable reload
  // second), so the presence of `run.plan` is a sync trigger of its own.
  const hasPlanBody = run.plan !== undefined;
  useEffect(() => {
    setPlan(parseUiPlan(run.plan));
    setPolicy(parseUiSourcePolicy(run.sourcePolicy));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.planVersion, run.runId, hasPlanBody]);

  if (!plan) {
    // Status can flip to awaiting before the durable reload delivers the
    // plan body — that window is a loading state, not a missing plan.
    return (
      <div className="research-plan__empty">
        {hasPlanBody ? t('research.planMissing') : t('common.loading')}
      </div>
    );
  }

  const edit = (mutate: (draft: UiPlan) => void): void => {
    setPlan((prev) => {
      if (!prev) return prev;
      const draft: UiPlan = JSON.parse(JSON.stringify(prev)) as UiPlan;
      mutate(draft);
      return draft;
    });
    setDirty(true);
  };

  const editPolicy = (mutate: (draft: UiSourcePolicy) => void): void => {
    setPolicy((prev) => {
      const draft: UiSourcePolicy = JSON.parse(JSON.stringify(prev)) as UiSourcePolicy;
      mutate(draft);
      return draft;
    });
    setDirty(true);
  };

  const timeEstimate = estimateResearchMinutes(run.budget);

  return (
    <div className="research-plan">
      <h3 className="research-plan__title">
        {t('research.planTitle')}{' '}
        <span className="research-plan__version">v{run.planVersion}</span>
      </h3>

      <label className="research-plan__field">
        <span>{t('research.objective')}</span>
        <textarea
          rows={2}
          value={plan.objective}
          onChange={(e) => edit((d) => { d.objective = e.target.value; })}
        />
      </label>

      <div className="research-plan__questions">
        <span className="research-plan__label">{t('research.questions')}</span>
        {plan.questions.map((q, i) => (
          <div key={q.id} className="research-plan__question">
            <input
              type="text"
              value={q.question}
              onChange={(e) => edit((d) => { d.questions[i]!.question = e.target.value; })}
            />
            <label className="research-plan__required">
              <input
                type="checkbox"
                checked={q.priority === 'required'}
                onChange={(e) =>
                  edit((d) => {
                    d.questions[i]!.priority = e.target.checked ? 'required' : 'supporting';
                    d.completionCriteria.requiredQuestionIds = d.questions
                      .filter((x) => x.priority === 'required')
                      .map((x) => x.id);
                  })
                }
              />
              {t('research.required')}
            </label>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={plan.questions.length <= 1}
              onClick={() =>
                edit((d) => {
                  d.questions.splice(i, 1);
                  d.completionCriteria.requiredQuestionIds =
                    d.completionCriteria.requiredQuestionIds.filter((id) => id !== q.id);
                })
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            edit((d) => {
              const id = `q${d.questions.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
              d.questions.push({ id, question: '', priority: 'supporting' });
            })
          }
        >
          {t('research.addQuestion')}
        </button>
      </div>

      {plan.assumptions.length > 0 && (
        <div className="research-plan__field">
          <span>{t('research.assumptions')}</span>
          <ul className="research-plan__list">
            {plan.assumptions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}

      <div className="research-plan__policy">
        <label className="research-plan__field">
          <span>{t('research.sourceMode')}</span>
          <select
            value={policy.web.mode}
            onChange={(e) => editPolicy((d) => { d.web.mode = e.target.value as UiSourcePolicy['web']['mode']; })}
          >
            <option value="full_web">{t('research.sourceModeFull')}</option>
            <option value="only_domains">{t('research.sourceModeOnly')}</option>
            <option value="prefer_domains">{t('research.sourceModePrefer')}</option>
          </select>
        </label>
        {policy.web.mode !== 'full_web' && (
          <label className="research-plan__field">
            <span>{t('research.domains')}</span>
            <input
              type="text"
              value={policy.web.domains.join(', ')}
              placeholder="sec.gov, example.com"
              onChange={(e) => editPolicy((d) => { d.web.domains = splitList(e.target.value); })}
            />
          </label>
        )}
        <label className="research-plan__field">
          <span>{t('research.excludedDomains')}</span>
          <input
            type="text"
            value={policy.web.excludedDomains.join(', ')}
            onChange={(e) => editPolicy((d) => { d.web.excludedDomains = splitList(e.target.value); })}
          />
        </label>
        <p className="research-plan__budget">
          {t('research.budgetSummary', {
            depth: String(run.depth),
            searches: String(run.budget?.searches ?? '—'),
            sources: String(run.budget?.fetchedSources ?? '—'),
          })}
          {timeEstimate && (
            <>
              {' · '}
              {t('research.timeEstimate', {
                low: String(timeEstimate.lowMinutes),
                high: String(timeEstimate.highMinutes),
              })}
            </>
          )}
        </p>
      </div>

      <div className="research-plan__actions">
        {dirty ? (
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={() => plan && onSave(plan, run.planVersion, policy)}
          >
            {t('research.saveChanges')}
          </button>
        ) : (
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={() => onApprove(run.planVersion)}
          >
            {t('research.approve')}
          </button>
        )}
        <button className="btn btn--ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>

      <div className="research-plan__refine">
        <input
          type="text"
          value={refineText}
          placeholder={t('research.refinePlaceholder')}
          onChange={(e) => setRefineText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy || refineText.trim().length === 0}
          onClick={() => {
            onRefine(refineText.trim());
            setRefineText('');
          }}
        >
          {t('research.refine')}
        </button>
      </div>
    </div>
  );
}
