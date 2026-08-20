import { useTranslation } from '../i18n';

/**
 * Structured report view over `run.report` (the durable, server-validated
 * report_json). The chat transcript already carries the fully-rendered cited
 * Markdown; this view exposes the structure — statement kinds, confidence,
 * contradictions, gaps — with citation chips that focus the owning source in
 * the sources panel. All text renders as plain text, never markup.
 */

export interface UiStatement {
  claimId: string;
  kind: 'finding' | 'analysis' | 'caveat';
  text: string;
  evidenceIds: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface UiReport {
  title: string;
  executiveSummary: UiStatement[];
  sections: Array<{ id: string; title: string; statements: UiStatement[] }>;
  contradictions: Array<{ summary: string; evidenceIds: string[]; resolution: string | null }>;
  gaps: Array<{ questionId?: string; description: string }>;
  methodology: string[];
}

export const parseUiReport = (raw: unknown): UiReport | null => {
  if (!raw || typeof raw !== 'object') return null;
  const report = raw as Partial<UiReport>;
  if (typeof report.title !== 'string') return null;
  return {
    title: report.title,
    executiveSummary: report.executiveSummary ?? [],
    sections: report.sections ?? [],
    contradictions: report.contradictions ?? [],
    gaps: report.gaps ?? [],
    methodology: report.methodology ?? [],
  };
};

interface Props {
  report: UiReport;
  partial: boolean;
  /** evidenceId → sourceId, built by the workspace from loaded source details. */
  onCitationClick?: ((evidenceId: string) => void) | undefined;
}

function Statement({ statement, onCitationClick }: {
  statement: UiStatement;
  onCitationClick?: ((evidenceId: string) => void) | undefined;
}) {
  return (
    <p className={`research-report__statement is-${statement.kind} is-confidence-${statement.confidence}`}>
      {statement.kind === 'caveat' && <span className="research-report__badge">⚠</span>}
      {statement.text}{' '}
      {statement.evidenceIds.map((id, i) => (
        <button
          key={id}
          type="button"
          className="research-report__cite"
          title={id}
          onClick={() => onCitationClick?.(id)}
        >
          [{i + 1}]
        </button>
      ))}
    </p>
  );
}

export function ResearchReport({ report, partial, onCitationClick }: Props) {
  const { t } = useTranslation();
  return (
    <article className="research-report">
      <h3>{report.title}</h3>
      {partial && <p className="research-report__partial">{t('research.partialReport')}</p>}

      {report.executiveSummary.length > 0 && (
        <section>
          <h4>{t('research.summary')}</h4>
          {report.executiveSummary.map((s) => (
            <Statement key={s.claimId} statement={s} onCitationClick={onCitationClick} />
          ))}
        </section>
      )}

      {report.sections.map((section) => (
        <section key={section.id}>
          <h4>{section.title}</h4>
          {section.statements.map((s) => (
            <Statement key={s.claimId} statement={s} onCitationClick={onCitationClick} />
          ))}
        </section>
      ))}

      {report.contradictions.length > 0 && (
        <section>
          <h4>{t('research.contradictions')}</h4>
          {report.contradictions.map((c, i) => (
            <p key={i} className="research-report__contradiction">
              {c.summary}
              {' — '}
              {c.resolution ?? t('research.unresolved')}
            </p>
          ))}
        </section>
      )}

      {report.gaps.length > 0 && (
        <section>
          <h4>{t('research.gaps')}</h4>
          <ul>
            {report.gaps.map((g, i) => <li key={i}>{g.description}</li>)}
          </ul>
        </section>
      )}

      {report.methodology.length > 0 && (
        <section>
          <h4>{t('research.methodology')}</h4>
          <ul>
            {report.methodology.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </section>
      )}
    </article>
  );
}
