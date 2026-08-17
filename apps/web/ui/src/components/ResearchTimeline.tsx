import type { ResearchStepWire } from '../api';
import type { ResearchActivityLine } from '../research/reducer';
import { useTranslation } from '../i18n';

/**
 * Durable timeline (steps reloaded over HTTP) plus live activity lines that
 * don't have a durable row yet. Decision bookkeeping steps are hidden — the
 * user-facing timeline is searches, reads, planning, and synthesis.
 */

const VISIBLE_KINDS = new Set(['planning', 'refinement', 'search', 'read_source', 'synthesis']);

const statusIcon = (status: string): string => {
  switch (status) {
    case 'completed': return '✓';
    case 'running': return '…';
    case 'failed': return '✕';
    case 'interrupted': return '⏸';
    case 'invalidated': return '⌫';
    default: return '·';
  }
};

interface Props {
  steps: ResearchStepWire[];
  activity: ResearchActivityLine[];
}

export function ResearchTimeline({ steps, activity }: Props) {
  const { t } = useTranslation();
  const visible = steps.filter((s) => VISIBLE_KINDS.has(s.kind));
  const durableStepIds = new Set(visible.map((s) => s.stepId));
  const liveLines = activity.filter((a) => !a.stepId || !durableStepIds.has(a.stepId));

  if (visible.length === 0 && liveLines.length === 0) {
    return <p className="research-timeline__empty">{t('research.timelineEmpty')}</p>;
  }

  return (
    <ol className="research-timeline">
      {visible.map((step) => (
        <li key={step.stepId} className={`research-timeline__step is-${step.status}`}>
          <span className="research-timeline__icon" aria-hidden="true">
            {statusIcon(step.status)}
          </span>
          <span className="research-timeline__summary">
            {step.summary || step.kind}
          </span>
          {step.error && (
            <span className="research-timeline__error" title={step.error}>
              {step.error.slice(0, 120)}
            </span>
          )}
        </li>
      ))}
      {liveLines.map((line, i) => (
        <li key={`live-${line.stepId ?? i}`} className="research-timeline__step is-live">
          <span className="research-timeline__icon" aria-hidden="true">…</span>
          <span className="research-timeline__summary">{line.message}</span>
        </li>
      ))}
    </ol>
  );
}
