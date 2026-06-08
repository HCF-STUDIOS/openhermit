import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Pagination, usePagination } from './Pagination';

type RuntimeStatus = 'running' | 'exited' | 'created' | 'removed' | 'unknown';

interface SandboxInfo {
  id: string;
  agentId: string;
  agentName?: string;
  alias: string;
  type: 'host' | 'docker' | 'e2b' | 'daytona';
  status: 'pending' | 'provisioned' | 'deleted';
  externalId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  runtime: {
    status: RuntimeStatus;
    statusText: string;
    image: string;
  } | null;
}

const REFRESH_MS = 10_000;

const lifecycleBadge = (status: SandboxInfo['status']): string => {
  switch (status) {
    case 'provisioned': return 'badge--running';
    case 'pending': return 'badge--paused';
    case 'deleted':
    default: return 'badge--stopped';
  }
};

const runtimeBadge = (status: RuntimeStatus): string => {
  switch (status) {
    case 'running': return 'badge--running';
    case 'created': return 'badge--paused';
    case 'exited':
    case 'removed':
    case 'unknown':
    default: return 'badge--stopped';
  }
};

export function SandboxesPanel() {
  const [sandboxes, setSandboxes] = useState<SandboxInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api<SandboxInfo[]>('/api/admin/sandboxes');
      setSandboxes(data);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const totals = {
    provisioned: sandboxes.filter((s) => s.status === 'provisioned').length,
    total: sandboxes.length,
  };

  const { page, setPage, pageCount, pageItems, total, pageSize } = usePagination(sandboxes);

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>
          Sandboxes
          <span className="fleet__sub">
            &nbsp;· {totals.provisioned}/{totals.total} provisioned
          </span>
        </h2>
        <div className="panel__header-actions">
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {loading && sandboxes.length === 0 && (
        <p className="agent-list__empty">Loading sandboxes…</p>
      )}

      {error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && sandboxes.length === 0 && (
        <p className="agent-list__empty">No sandboxes found.</p>
      )}

      {sandboxes.length > 0 && (
        <>
          <div className="fleet-table-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Alias</th>
                  <th>Type</th>
                  <th>Lifecycle</th>
                  <th>Runtime</th>
                  <th>External ID</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="fleet-cell-agent">
                        <span className="fleet-cell-agent__id">{s.agentId}</span>
                        {s.agentName && (
                          <span className="fleet-cell-agent__name">{s.agentName}</span>
                        )}
                      </div>
                    </td>
                    <td>{s.alias}</td>
                    <td>{s.type}</td>
                    <td>
                      <span className={`badge ${lifecycleBadge(s.status)}`}>{s.status}</span>
                    </td>
                    <td>
                      {s.runtime ? (
                        <>
                          <span className={`badge ${runtimeBadge(s.runtime.status)}`}>
                            {s.runtime.status}
                          </span>
                          <div className="fleet-cell-relative" style={{ marginTop: 2 }}>
                            {s.runtime.statusText}
                          </div>
                        </>
                      ) : (
                        <span className="fleet-cell-relative">—</span>
                      )}
                    </td>
                    <td className="fleet-cell-relative" style={{ fontFamily: 'var(--mono)' }}>
                      {s.externalId ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fleet-cards">
            {pageItems.map((s) => (
              <div key={s.id} className="fleet-card">
                <div className="fleet-card__top">
                  <div className="fleet-card__heading">
                    <span className="fleet-card__id">{s.agentId}</span>
                    <span className="fleet-card__name">{s.alias} · {s.type}</span>
                  </div>
                  <span className={`badge ${lifecycleBadge(s.status)}`}>{s.status}</span>
                </div>
                <dl className="fleet-card__stats">
                  <div>
                    <dt>Runtime</dt>
                    <dd>
                      {s.runtime ? (
                        <span className={`badge ${runtimeBadge(s.runtime.status)}`}>
                          {s.runtime.status}
                        </span>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>External ID</dt>
                    <dd style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>
                      {s.externalId ?? '—'}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} />
        </>
      )}
    </div>
  );
}
