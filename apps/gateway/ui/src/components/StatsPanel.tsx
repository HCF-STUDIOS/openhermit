import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatTokens, formatUsd, type UsageWindow } from './FleetPanel';

interface Stats {
  uptime: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  agents: { running: number };
  counts?: { users?: number; sessions?: number; sessionEvents?: number };
  usage?: { window24h: UsageWindow; allTime: UsageWindow };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
    </div>
  );
}

export function StatsPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => {
      api<Stats>('/api/admin/stats')
        .then(setStats)
        .catch((err) => setError((err as Error).message));
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <div className="panel"><p>{error}</p></div>;
  if (!stats) return <div className="panel"><p>Loading...</p></div>;

  const c = stats.counts ?? {};

  return (
    <div className="panel">
      <h2>Gateway Stats</h2>
      <div className="stats-grid">
        <div className="stats-section">
          <h3 className="stats-section__title">System</h3>
          <div className="stats-row">
            <StatCard label="Uptime" value={formatUptime(stats.uptime)} />
            <StatCard label="RSS Memory" value={formatBytes(stats.memory.rss)} />
            <StatCard label="Heap Used" value={formatBytes(stats.memory.heapUsed)} />
            <StatCard label="Heap Total" value={formatBytes(stats.memory.heapTotal)} />
          </div>
        </div>
        <div className="stats-section">
          <h3 className="stats-section__title">Data</h3>
          <div className="stats-row">
            <StatCard label="Running Agents" value={stats.agents.running} />
            <StatCard label="Users" value={c.users ?? 0} />
            <StatCard label="Sessions" value={c.sessions ?? 0} />
            <StatCard label="Session Events" value={c.sessionEvents ?? 0} />
          </div>
        </div>
        {stats.usage && (
          <div className="stats-section">
            <h3 className="stats-section__title">Token Usage</h3>
            <div className="stats-row">
              <StatCard
                label="Tokens 24h"
                value={formatTokens(stats.usage.window24h.inputTokens + stats.usage.window24h.outputTokens)}
              />
              <StatCard label="Cost 24h" value={formatUsd(stats.usage.window24h.costUsd)} />
              <StatCard
                label="Tokens all-time"
                value={formatTokens(stats.usage.allTime.inputTokens + stats.usage.allTime.outputTokens)}
              />
              <StatCard label="Cost all-time" value={formatUsd(stats.usage.allTime.costUsd)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
