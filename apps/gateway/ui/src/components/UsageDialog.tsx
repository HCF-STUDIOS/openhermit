import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatTokens, formatUsd, type UsageWindow } from './FleetPanel';

interface AgentUsageDetail {
  totals: {
    window24h: UsageWindow;
    window7d: UsageWindow;
    allTime: UsageWindow;
  };
  byModel: Array<{
    model: string;
    provider?: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  daily: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

type WindowKey = 'window24h' | 'window7d' | 'allTime';
type Tab = 'overview' | 'byModel' | 'daily';

const WINDOW_LABELS: Record<WindowKey, string> = {
  window24h: 'Last 24h',
  window7d: 'Last 7 days',
  allTime: 'All time',
};

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  byModel: 'By model',
  daily: 'Daily',
};

export function UsageDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<AgentUsageDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [windowKey, setWindowKey] = useState<WindowKey>('window24h');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<AgentUsageDetail>(`/api/admin/agents/${encodeURIComponent(agentId)}/usage`)
      .then(setDetail)
      .catch((err) => setError((err as Error).message));
  }, [agentId]);

  const win = detail?.totals[windowKey];
  const maxDailyCost = detail
    ? Math.max(0.0001, ...detail.daily.map((d) => d.costUsd))
    : 0.0001;

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Usage — {agentId}</h3>

        {error && <p className="config-error">{error}</p>}
        {!detail && !error && <p className="secrets-empty">Loading…</p>}

        {detail && (
          <>
            <div className="usage-main-tabs" role="tablist" aria-label="Usage view">
              {(Object.keys(TAB_LABELS) as Tab[]).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={tab === k}
                  className={`usage-main-tab${tab === k ? ' usage-main-tab--active' : ''}`}
                  onClick={() => setTab(k)}
                >
                  {TAB_LABELS[k]}
                </button>
              ))}
            </div>

            {tab === 'overview' && win && (
              <div className="usage-tab-panel" role="tabpanel">
                <div className="usage-window-tabs" role="tablist" aria-label="Time range">
                  {(Object.keys(WINDOW_LABELS) as WindowKey[]).map((k) => (
                    <button
                      key={k}
                      role="tab"
                      aria-selected={windowKey === k}
                      className={`btn btn--sm${windowKey === k ? ' btn--primary' : ' btn--ghost'}`}
                      onClick={() => setWindowKey(k)}
                    >
                      {WINDOW_LABELS[k]}
                    </button>
                  ))}
                </div>

                <div className="usage-tiles">
                  <div className="usage-tile">
                    <div className="usage-tile__label">Input tokens</div>
                    <div className="usage-tile__value">{formatTokens(win.inputTokens)}</div>
                  </div>
                  <div className="usage-tile">
                    <div className="usage-tile__label">Output tokens</div>
                    <div className="usage-tile__value">{formatTokens(win.outputTokens)}</div>
                  </div>
                  <div className="usage-tile">
                    <div className="usage-tile__label">Cache read</div>
                    <div className="usage-tile__value">{formatTokens(win.cacheReadTokens)}</div>
                  </div>
                  <div className="usage-tile">
                    <div className="usage-tile__label">Cache write</div>
                    <div className="usage-tile__value">{formatTokens(win.cacheWriteTokens)}</div>
                  </div>
                  <div className="usage-tile usage-tile--cost">
                    <div className="usage-tile__label">Total cost</div>
                    <div className="usage-tile__value">{formatUsd(win.costUsd)}</div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'byModel' && (
              <div className="usage-tab-panel" role="tabpanel">
                <p className="usage-tab-note">All time</p>
                {detail.byModel.length === 0 ? (
                  <p className="secrets-empty">No assistant events yet.</p>
                ) : (
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th className="fleet-table__num">Calls</th>
                        <th className="fleet-table__num">Input</th>
                        <th className="fleet-table__num">Output</th>
                        <th className="fleet-table__num">USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.byModel.map((m, i) => (
                        <tr key={`${m.model}-${m.provider ?? ''}-${i}`}>
                          <td>
                            <div className="usage-model-cell">
                              <span className="usage-model-cell__name">{m.model}</span>
                              {m.provider && (
                                <span className="usage-model-cell__provider">{m.provider}</span>
                              )}
                            </div>
                          </td>
                          <td className="fleet-table__num">{m.calls.toLocaleString()}</td>
                          <td className="fleet-table__num">{formatTokens(m.inputTokens)}</td>
                          <td className="fleet-table__num">{formatTokens(m.outputTokens)}</td>
                          <td className="fleet-table__num">{formatUsd(m.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {tab === 'daily' && (
              <div className="usage-tab-panel" role="tabpanel">
                <p className="usage-tab-note">Last 30 days</p>
                {detail.daily.length === 0 ? (
                  <p className="secrets-empty">No activity in the last 30 days.</p>
                ) : (
                  <div className="usage-daily">
                    {detail.daily.map((d) => (
                      <div className="usage-daily__row" key={d.day}>
                        <span className="usage-daily__day">{d.day}</span>
                        <div className="usage-daily__bar-wrap">
                          <div
                            className="usage-daily__bar"
                            style={{ width: `${Math.max(2, (d.costUsd / maxDailyCost) * 100)}%` }}
                          />
                        </div>
                        <span className="usage-daily__tokens">
                          {formatTokens(d.inputTokens + d.outputTokens)}
                        </span>
                        <span className="usage-daily__cost">{formatUsd(d.costUsd)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
