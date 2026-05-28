import type { SessionSummary } from '../api';
import { useTranslation, type Translator } from '../i18n';

const relativeTime = (iso: string, t: Translator): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('sessionList.justNow');
  if (diff < hour) return t('sessionList.minutesAgo', { n: Math.round(diff / minute) });
  if (diff < day) return t('sessionList.hoursAgo', { n: Math.round(diff / hour) });
  return t('sessionList.daysAgo', { n: Math.round(diff / day) });
};

interface Props {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  emptyMessage?: string;
}

export function SessionList({ sessions, currentSessionId, onSelect, onDelete, emptyMessage }: Props) {
  const { t } = useTranslation();
  if (sessions.length === 0) {
    return (
      <div className="sidebar__list">
        <div className="empty-state">{emptyMessage ?? t('sessionList.empty')}</div>
      </div>
    );
  }

  return (
    <div className="sidebar__list">
      {sessions.map(session => {
        const isActive = session.sessionId === currentSessionId;
        const isInactive = session.status === 'inactive';
        const sourceKind = session.source?.kind || 'api';

        const canDelete = onDelete && session.status !== 'running';

        return (
          <div key={session.sessionId} className={`session-card${isActive ? ' is-active' : ''}${isInactive ? ' is-inactive' : ''}`}>
            <button
              type="button"
              className="session-card__body"
              onClick={() => onSelect(session.sessionId)}
            >
              <div className="session-card__title-row">
                <div className="session-card__title">
                  {session.description || session.lastMessagePreview || session.sessionId}
                </div>
                <div className="session-card__badges">
                  <span className={`session-badge session-badge--${sourceKind}`}>
                    {session.source?.platform || sourceKind}
                  </span>
                  {(session.status === 'running' || session.status === 'awaiting_approval') && (
                    <span className={`session-badge session-badge--${session.status}`}>
                      {session.status === 'awaiting_approval'
                        ? t('sessionList.badgeApproval')
                        : t('sessionList.badgeRunning')}
                    </span>
                  )}
                </div>
              </div>
              <div className="session-card__meta">
                {relativeTime(session.lastActivityAt, t)} · {t('sessionList.msgs', { n: session.messageCount })}
              </div>
              <p className="session-card__preview">
                {session.lastMessagePreview || t('sessionList.noPreview')}
              </p>
            </button>
            {canDelete && (
              <button
                type="button"
                className="session-card__delete"
                title={t('sessionList.deleteTitle')}
                onClick={(e) => { e.stopPropagation(); onDelete(session.sessionId); }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
