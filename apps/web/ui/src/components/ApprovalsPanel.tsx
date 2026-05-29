import { useCallback, useEffect, useState } from 'react';
import { fetchApprovalRequests, reviewApprovalRequest, type ApprovalRequestInfo } from '../api';
import { useTranslation } from '../i18n';

const STATUS_BADGE: Record<string, string> = {
  pending: 'approvals-row__status--pending',
  approved: 'approvals-row__status--approved',
  rejected: 'approvals-row__status--rejected',
  expired: 'approvals-row__status--expired',
};

export function ApprovalsPanel() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<ApprovalRequestInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setRequests(await fetchApprovalRequests(filter || undefined));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const handleReview = async (id: string, decision: 'approved' | 'rejected', resolution?: 'once' | 'persistent') => {
    try {
      await reviewApprovalRequest(id, { decision, resolution });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) return <p className="manage__empty">{t('common.loading')}</p>;

  const statusLabel = (status: string): string => {
    switch (status) {
      case 'pending': return t('approvals.statusPending');
      case 'approved': return t('approvals.statusApproved');
      case 'rejected': return t('approvals.statusRejected');
      case 'expired': return t('approvals.statusExpired');
      default: return status;
    }
  };

  return (
    <div className="approvals-panel">
      <div className="approvals-panel__intro">
        <p className="eyebrow">{t('approvals.eyebrow')}</p>
        <p className="approvals-panel__hint">{t('approvals.hint')}</p>
      </div>

      <div className="manage__toolbar">
        <select
          className="btn btn--sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">{t('approvals.filterAll')}</option>
          <option value="pending">{t('approvals.statusPending')}</option>
          <option value="approved">{t('approvals.statusApproved')}</option>
          <option value="rejected">{t('approvals.statusRejected')}</option>
          <option value="expired">{t('approvals.statusExpired')}</option>
        </select>
      </div>

      {requests.length === 0 ? (
        <p className="manage__empty">
          {filter
            ? t('approvals.emptyFiltered', { status: statusLabel(filter) })
            : t('approvals.emptyAll')}
        </p>
      ) : (
        <div className="approvals-panel__list">
          {requests.map((r) => (
            <div className="approvals-row" key={r.id}>
              <div className="approvals-row__info">
                <span className="approvals-row__resource">
                  {r.resourceType}/{r.resourceKey}
                </span>
                <span className={`approvals-row__status ${STATUS_BADGE[r.status] ?? ''}`}>
                  {statusLabel(r.status)}
                </span>
                <span className="approvals-row__requester">
                  {t('approvals.by', { requester: r.requesterId })}
                </span>
              </div>
              <div className="approvals-row__meta">
                <span className="approvals-row__time">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
                {r.resolvedBy && (
                  <span className="approvals-row__resolver">
                    {t('approvals.resolvedBy', { resolver: r.resolvedBy })}
                    {r.resolution ? ` (${r.resolution})` : ''}
                  </span>
                )}
                {r.reason && (
                  <span className="approvals-row__reason">— {r.reason}</span>
                )}
              </div>
              {r.status === 'pending' && (
                <div className="approvals-row__actions">
                  <button
                    className="btn btn--sm btn--primary"
                    onClick={() => void handleReview(r.id, 'approved', 'once')}
                  >
                    {t('approvals.approveOnce')}
                  </button>
                  <button
                    className="btn btn--sm btn--primary"
                    onClick={() => void handleReview(r.id, 'approved', 'persistent')}
                    title={t('approvals.approvePersistentTitle')}
                  >
                    {t('approvals.approvePersistent')}
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void handleReview(r.id, 'rejected')}
                  >
                    {t('approvals.reject')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="basic-panel__error">{error}</p>}
    </div>
  );
}
