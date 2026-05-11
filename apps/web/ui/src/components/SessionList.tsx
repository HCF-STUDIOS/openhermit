import type { SessionSummary } from '../api';

const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  return `${Math.round(diff / day)}d ago`;
};

interface Props {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  emptyMessage?: string;
}

export function SessionList({ sessions, currentSessionId, onSelect, onDelete, emptyMessage }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="sidebar__list">
        <div className="empty-state">{emptyMessage ?? 'No sessions yet. Start one to begin chatting.'}</div>
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
                      {session.status === 'awaiting_approval' ? 'approval' : session.status}
                    </span>
                  )}
                </div>
              </div>
              <div className="session-card__meta">
                {relativeTime(session.lastActivityAt)} · {session.messageCount} msgs
              </div>
              <p className="session-card__preview">
                {session.lastMessagePreview || 'No preview yet'}
              </p>
            </button>
            {canDelete && (
              <button
                type="button"
                className="session-card__delete"
                title="Delete session"
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
