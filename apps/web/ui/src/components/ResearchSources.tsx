import { useState } from 'react';
import {
  getResearchSource,
  type ResearchEvidenceWire,
  type ResearchSourceWire,
} from '../api';
import { useTranslation } from '../i18n';

/**
 * Source panel: fetched/blocked/duplicate states, metadata, quality label,
 * and on-demand evidence excerpts per source. URLs render as plain http(s)
 * links only; titles are shown as text (never markup).
 */

const safeHref = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch { /* not a URL */ }
  return undefined;
};

interface Props {
  sessionId: string;
  runId: string;
  sources: ResearchSourceWire[];
  /** Source id to highlight (citation click-through). */
  focusSourceId?: string | null;
}

export function ResearchSources({ sessionId, runId, sources, focusSourceId }: Props) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Record<string, ResearchEvidenceWire[]>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const toggle = async (sourceId: string): Promise<void> => {
    if (openId === sourceId) {
      setOpenId(null);
      return;
    }
    setOpenId(sourceId);
    if (!evidence[sourceId]) {
      setLoadingId(sourceId);
      try {
        const detail = await getResearchSource(sessionId, runId, sourceId);
        setEvidence((prev) => ({ ...prev, [sourceId]: detail.evidence }));
      } catch {
        setEvidence((prev) => ({ ...prev, [sourceId]: [] }));
      } finally {
        setLoadingId(null);
      }
    }
  };

  if (sources.length === 0) {
    return <p className="research-sources__empty">{t('research.sourcesEmpty')}</p>;
  }

  return (
    <ul className="research-sources">
      {sources.map((source) => {
        const href = safeHref(source.canonicalUrl ?? source.url);
        const isOpen = openId === source.sourceId;
        return (
          <li
            key={source.sourceId}
            className={
              `research-sources__item is-${source.status}`
              + (focusSourceId === source.sourceId ? ' is-focused' : '')
            }
          >
            <button
              type="button"
              className="research-sources__row"
              onClick={() => void toggle(source.sourceId)}
            >
              <span className={`research-sources__status research-sources__status--${source.status}`}>
                {t(`research.sourceStatus.${source.status}` as never) || source.status}
              </span>
              <span className="research-sources__title">
                {source.title || source.domain || source.sourceId}
              </span>
              {source.domain && <span className="research-sources__domain">{source.domain}</span>}
              {source.sourceClass !== 'unknown' && (
                <span className="research-sources__class">{source.sourceClass}</span>
              )}
            </button>
            {isOpen && (
              <div className="research-sources__detail">
                {href && (
                  <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                    {href}
                  </a>
                )}
                {source.publisher && <p>{t('research.publisher')}: {source.publisher}</p>}
                {source.publishedAt && <p>{t('research.published')}: {source.publishedAt}</p>}
                {source.duplicateOfSourceId && (
                  <p>{t('research.duplicateOf')}: {source.duplicateOfSourceId}</p>
                )}
                {source.lastError && <p className="research-sources__error">{source.lastError}</p>}
                {loadingId === source.sourceId ? (
                  <p>{t('common.loading')}</p>
                ) : (
                  (evidence[source.sourceId] ?? []).map((item) => (
                    <blockquote
                      key={item.evidenceId}
                      className={`research-sources__evidence${item.outOfScope ? ' is-out-of-scope' : ''}`}
                    >
                      “{item.excerpt}”
                      <span className="research-sources__evidence-meta">
                        {item.stance}
                        {item.claimKey ? ` · ${item.claimKey}` : ''}
                        {item.outOfScope ? ` · ${t('research.outOfScope')}` : ''}
                      </span>
                    </blockquote>
                  ))
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
