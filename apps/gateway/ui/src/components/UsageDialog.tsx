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

const WINDOW_LABELS: Record<WindowKey, string> = {
  window24h: 'Last 24h',
  window7d: 'Last 7 days',
  allTime: 'All time',
};

export function UsageDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<AgentUsageDetail | null>(null);
  const [error, setError] = useState('');
  const [windowKey, setWindowKey] = useState<WindowKey>('window24h');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<AgentUsageDetail>(`/api/admin/agents/${encodeURIComponent(agentId)}/usage`)
      .then(setDetail)
      .catch((err) => setError((err as Error).message));
  }, [agentId]);

  const window = detail?.totals[windowKey];
  const maxDailyCost = detail
    ? Math.max(0.0001, ...detail.daily.map((d) => d.costUsd))
    : 0.0001;

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Usage — {agentId}</h3>

        {error && <p className="config-error">{error}</p>}
        {!detail && !error && <p className="secrets-empty">Loading…</p>}

        {detail && window && (
          <>
            <section className="usage-section usage-section--totals">
              <header className="usage-section__head">
                <h4 className="usage-section__title">Totals</h4>
                <div className="usage-window-tabs" role="tablist" aria-label="Time range for totals">
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
              </header>

              <div className="usage-tiles">
                <div className="usage-tile">
                  <div className="usage-tile__label">Input tokens</div>
                  <div className="usage-tile__value">{formatTokens(window.inputTokens)}</div>
                </div>
                <div className="usage-tile">
                  <div className="usage-tile__label">Output tokens</div>
                  <div className="usage-tile__value">{formatTokens(window.outputTokens)}</div>
                </div>
                <div className="usage-tile">
                  <div className="usage-tile__label">Cache read</div>
                  <div className="usage-tile__value">{formatTokens(window.cacheReadTokens)}</div>
                </div>
                <div className="usage-tile">
                  <div className="usage-tile__label">Cache write</div>
                  <div className="usage-tile__value">{formatTokens(window.cacheWriteTokens)}</div>
                </div>
                <div className="usage-tile usage-tile--cost">
                  <div className="usage-tile__label">Total cost</div>
                  <div className="usage-tile__value">{formatUsd(window.costUsd)}</div>
                </div>
              </div>
            </section>

            <section className="usage-section">
              <header className="usage-section__head">
                <h4 className="usage-section__title">By model</h4>
                <span className="usage-section__range">All time</span>
              </header>
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
            </section>

            <section className="usage-section">
              <header className="usage-section__head">
                <h4 className="usage-section__title">Daily</h4>
                <span className="usage-section__range">Last 30 days</span>
              </header>
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
            </section>
          </>
        )}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
