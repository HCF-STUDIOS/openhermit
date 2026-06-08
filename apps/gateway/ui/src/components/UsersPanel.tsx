import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Pagination, usePagination } from './Pagination';

interface UserSummary {
  userId: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  identityCount: number;
  agentCount: number;
}

interface UserIdentity {
  userId: string;
  channel: string;
  channelUserId: string;
  createdAt: string;
}

interface UserAgentBinding {
  userId: string;
  agentId: string;
  role: 'owner' | 'user' | 'guest';
  createdAt: string;
}

const REFRESH_MS = 15_000;

const formatDate = (iso: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

export function UsersPanel() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [identities, setIdentities] = useState<Record<string, UserIdentity[]>>({});
  const [agents, setAgents] = useState<Record<string, UserAgentBinding[]>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const data = await api<UserSummary[]>('/api/admin/users');
      setUsers(data);
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

  const { page, setPage, pageCount, pageItems, total, pageSize } = usePagination(users);

  const toggleExpand = async (userId: string) => {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    if (!identities[userId] || !agents[userId]) {
      setDetailLoading((prev) => ({ ...prev, [userId]: true }));
      try {
        const [ids, ags] = await Promise.all([
          api<UserIdentity[]>(`/api/admin/users/${encodeURIComponent(userId)}/identities`),
          api<UserAgentBinding[]>(`/api/admin/users/${encodeURIComponent(userId)}/agents`),
        ]);
        setIdentities((prev) => ({ ...prev, [userId]: ids }));
        setAgents((prev) => ({ ...prev, [userId]: ags }));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setDetailLoading((prev) => ({ ...prev, [userId]: false }));
      }
    }
  };

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>
          Users
          <span className="fleet__sub">&nbsp;· {users.length} total</span>
        </h2>
        <div className="panel__header-actions">
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {loading && users.length === 0 && (
        <p className="agent-list__empty">Loading users…</p>
      )}

      {error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && users.length === 0 && (
        <p className="agent-list__empty">No users yet.</p>
      )}

      {users.length > 0 && (
        <>
          <div className="fleet-table-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="fleet-table__num">Identities</th>
                  <th className="fleet-table__num">Agents</th>
                  <th>Created</th>
                  <th>Updated</th>
                  <th className="fleet-table__actions"></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((u) => (
                  <Fragment key={u.userId}>
                    <tr>
                      <td>
                        <div className="fleet-cell-agent">
                          <span className="fleet-cell-agent__id">
                            {u.name || u.userId}
                          </span>
                          {u.name && (
                            <span className="fleet-cell-agent__name">{u.userId}</span>
                          )}
                        </div>
                      </td>
                      <td className="fleet-table__num">{u.identityCount}</td>
                      <td className="fleet-table__num">{u.agentCount}</td>
                      <td className="fleet-cell-relative">{formatDate(u.createdAt)}</td>
                      <td className="fleet-cell-relative">{formatDate(u.updatedAt)}</td>
                      <td className="fleet-table__actions">
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => void toggleExpand(u.userId)}
                          aria-expanded={expanded === u.userId}
                        >
                          {expanded === u.userId ? 'Hide' : 'View'}
                        </button>
                      </td>
                    </tr>
                    {expanded === u.userId && (
                      <tr>
                        <td colSpan={6} className="users-identities">
                          <UserDetail
                            loading={detailLoading[u.userId] ?? false}
                            identities={identities[u.userId] ?? []}
                            agents={agents[u.userId] ?? []}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fleet-cards">
            {pageItems.map((u) => (
              <div key={u.userId} className="fleet-card">
                <div className="fleet-card__top">
                  <div className="fleet-card__heading">
                    <span className="fleet-card__id">{u.name || u.userId}</span>
                    {u.name && <span className="fleet-card__name">{u.userId}</span>}
                  </div>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void toggleExpand(u.userId)}
                    aria-expanded={expanded === u.userId}
                  >
                    {expanded === u.userId ? 'Hide' : 'View'}
                  </button>
                </div>
                <dl className="fleet-card__stats">
                  <div>
                    <dt>Identities</dt>
                    <dd>{u.identityCount}</dd>
                  </div>
                  <div>
                    <dt>Agents</dt>
                    <dd>{u.agentCount}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd style={{ fontSize: '0.75rem' }}>{formatDate(u.createdAt)}</dd>
                  </div>
                </dl>
                {expanded === u.userId && (
                  <div className="users-identities">
                    <UserDetail
                      loading={detailLoading[u.userId] ?? false}
                      identities={identities[u.userId] ?? []}
                      agents={agents[u.userId] ?? []}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function UserDetail({
  loading,
  identities,
  agents,
}: {
  loading: boolean;
  identities: UserIdentity[];
  agents: UserAgentBinding[];
}) {
  if (loading) return <p className="users-identities__empty">Loading…</p>;
  return (
    <div className="users-detail">
      <div className="users-detail__section">
        <div className="users-detail__title">Agent roles</div>
        {agents.length === 0 ? (
          <p className="users-identities__empty">No agent assignments.</p>
        ) : (
          <table className="users-identities__table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Role</th>
                <th>Assigned</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agentId}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.82rem' }}>{a.agentId}</td>
                  <td>
                    <span className={`badge users-role users-role--${a.role}`}>{a.role}</span>
                  </td>
                  <td className="fleet-cell-relative">{formatDate(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="users-detail__section">
        <div className="users-detail__title">Identities</div>
        {identities.length === 0 ? (
          <p className="users-identities__empty">No identities linked.</p>
        ) : (
          <table className="users-identities__table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Channel User ID</th>
                <th>Linked</th>
              </tr>
            </thead>
            <tbody>
              {identities.map((i) => (
                <tr key={`${i.channel}:${i.channelUserId}`}>
                  <td><span className="fleet-chip">{i.channel}</span></td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{i.channelUserId}</td>
                  <td className="fleet-cell-relative">{formatDate(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
