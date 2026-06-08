import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Pagination, usePagination } from './Pagination';

interface AgentInfo {
  agentId: string;
  name?: string;
}

interface ScheduleRecord {
  agentId: string;
  scheduleId: string;
  type: 'cron' | 'once';
  status: 'active' | 'paused' | 'completed' | 'failed';
  cronExpression?: string;
  runAt?: string;
  prompt: string;
  delivery: { kind: 'silent' | 'session'; sessionId?: string };
  policy: { timeout_seconds?: number };
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  consecutiveErrors: number;
  lastError?: string;
}

interface ScheduleRunRecord {
  id: number;
  agentId: string;
  scheduleId: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  sessionId?: string;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}

export function SchedulesPanel() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState('');
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [runsSchedule, setRunsSchedule] = useState<ScheduleRecord | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const list = await api<AgentInfo[]>('/api/agents');
      setAgents(list);
      if (list.length > 0 && !agentId) setAgentId(list[0].agentId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agentId]);

  const loadSchedules = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      setSchedules(await api<ScheduleRecord[]>(`/api/agents/${encodeURIComponent(agentId)}/schedules`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void loadAgents(); }, [loadAgents]);
  useEffect(() => { void loadSchedules(); }, [loadSchedules]);

  const handleToggle = async (s: ScheduleRecord) => {
    const newStatus = s.status === 'active' ? 'paused' : 'active';
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(s.scheduleId)}`, {
        method: 'PUT',
        body: { status: newStatus },
      });
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    }
    await loadSchedules();
  };

  const handleDelete = async (s: ScheduleRecord) => {
    if (!confirm(`Delete schedule "${s.scheduleId}"?`)) return;
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(s.scheduleId)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
    await loadSchedules();
  };

  const statusClass = (status: string) => {
    switch (status) {
      case 'active': return 'badge--active';
      case 'paused': return 'badge--paused';
      case 'completed': return 'badge--completed';
      case 'failed': return 'badge--failed';
      default: return 'badge--stopped';
    }
  };

  const fmtTime = (t?: string) => t ? new Date(t).toLocaleString() : '—';

  const { page, setPage, pageCount, pageItems, total, pageSize } = usePagination(schedules);

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Schedules</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)} disabled={!agentId}>
          Create Schedule
        </button>
      </div>

      <label className="field schedule-agent-select">
        <span className="field__label">Agent</span>
        <select
          className="field__input"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>{a.agentId}{a.name ? ` — ${a.name}` : ''}</option>
          ))}
        </select>
      </label>

      {loading && schedules.length === 0 && agentId && (
        <p className="agent-list__empty">Loading schedules…</p>
      )}

      {!loading && error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && schedules.length === 0 && agentId && (
        <p className="agent-list__empty">No schedules for this agent.</p>
      )}

      <div className="schedule-list">
        {pageItems.map((s) => (
          <div className="schedule-card" key={s.scheduleId}>
            <div className="schedule-card__info">
              <div>
                <span className="skill-card__name">{s.scheduleId}</span>
                <span className={`badge badge--sm ${s.type === 'cron' ? 'badge--running' : 'badge--stopped'}`}>{s.type}</span>
                <span className={`badge ${statusClass(s.status)}`}>{s.status}</span>
              </div>
              <div className="schedule-card__prompt">
                {s.prompt.length > 80 ? s.prompt.slice(0, 80) + '...' : s.prompt}
              </div>
              <div className="schedule-card__meta">
                {s.type === 'cron' && s.cronExpression && <span>Cron: <code>{s.cronExpression}</code></span>}
                {s.type === 'once' && s.runAt && <span>Run at: {fmtTime(s.runAt)}</span>}
                {' | '}Runs: {s.runCount}
                {s.nextRunAt && <>{' | '}Next: {fmtTime(s.nextRunAt)}</>}
                {s.lastRunAt && <>{' | '}Last: {fmtTime(s.lastRunAt)}</>}
                {s.consecutiveErrors > 0 && (
                  <span className="schedule-card__errors"> | Errors: {s.consecutiveErrors}</span>
                )}
              </div>
            </div>
            <div className="schedule-card__actions">
              <button className="btn btn--sm" onClick={() => setRunsSchedule(s)}>Runs</button>
              <button className="btn btn--sm" onClick={() => handleToggle(s)}>
                {s.status === 'active' ? 'Pause' : 'Resume'}
              </button>
              <button className="btn btn--sm btn--danger" onClick={() => handleDelete(s)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} />

      {showCreate && agentId && (
        <CreateScheduleDialog
          agentId={agentId}
          onClose={() => setShowCreate(false)}
          onSaved={loadSchedules}
        />
      )}
      {runsSchedule && agentId && (
        <RunsDialog
          agentId={agentId}
          schedule={runsSchedule}
          onClose={() => setRunsSchedule(null)}
        />
      )}
    </div>
  );
}

// -- Create dialog --

function CreateScheduleDialog({
  agentId,
  onClose,
  onSaved,
}: {
  agentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<'cron' | 'once'>('cron');
  const [prompt, setPrompt] = useState('');
  const [cronExpression, setCronExpression] = useState('');
  const [runAt, setRunAt] = useState('');
  const [deliveryKind, setDeliveryKind] = useState<'silent' | 'session'>('silent');
  const [sessionId, setSessionId] = useState('');
  const [timeout, setTimeout] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    const body: Record<string, unknown> = {
      type,
      prompt: prompt.trim(),
      delivery: { kind: deliveryKind, ...(deliveryKind === 'session' && sessionId.trim() ? { sessionId: sessionId.trim() } : {}) },
      policy: timeout ? { timeout_seconds: Number(timeout) } : {},
    };
    if (type === 'cron') body.cron_expression = cronExpression.trim();
    if (type === 'once') body.run_at = runAt;
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/schedules`, {
        method: 'POST',
        body,
      });
      onClose();
      onSaved();
    } catch (err) {
      alert(`Failed to create schedule: ${(err as Error).message}`);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form className="dialog__form" onSubmit={handleSubmit}>
        <h3>Create Schedule</h3>
        <label className="field">
          <span className="field__label">Type</span>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <label><input type="radio" name="type" checked={type === 'cron'} onChange={() => setType('cron')} /> Cron</label>
            <label><input type="radio" name="type" checked={type === 'once'} onChange={() => setType('once')} /> Once</label>
          </div>
        </label>
        <label className="field">
          <span className="field__label">Prompt</span>
          <textarea className="field__input" required rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        {type === 'cron' && (
          <label className="field">
            <span className="field__label">Cron Expression</span>
            <input className="field__input" required placeholder="e.g. 0 9 * * *" value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} />
          </label>
        )}
        {type === 'once' && (
          <label className="field">
            <span className="field__label">Run At (ISO datetime)</span>
            <input className="field__input" required type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field__label">Delivery</span>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <label><input type="radio" name="delivery" checked={deliveryKind === 'silent'} onChange={() => setDeliveryKind('silent')} /> Silent</label>
            <label><input type="radio" name="delivery" checked={deliveryKind === 'session'} onChange={() => setDeliveryKind('session')} /> Session</label>
          </div>
        </label>
        {deliveryKind === 'session' && (
          <label className="field">
            <span className="field__label">Session ID</span>
            <input className="field__input" placeholder="Optional session ID" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field__label">Timeout (seconds, optional)</span>
          <input className="field__input" type="number" placeholder="e.g. 300" value={timeout} onChange={(e) => setTimeout(e.target.value)} />
        </label>
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="submit">Create</button>
        </div>
      </form>
    </dialog>
  );
}

// -- Runs dialog --

function RunsDialog({
  agentId,
  schedule,
  onClose,
}: {
  agentId: string;
  schedule: ScheduleRecord;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [runs, setRuns] = useState<ScheduleRunRecord[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRuns(await api<ScheduleRunRecord[]>(
        `/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(schedule.scheduleId)}/runs`
      ));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agentId, schedule.scheduleId]);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  useEffect(() => { void load(); }, [load]);

  const statusClass = (status: string) => {
    switch (status) {
      case 'completed': return 'badge--active';
      case 'running': return 'badge--running';
      case 'failed': return 'badge--failed';
      case 'skipped': return 'badge--paused';
      default: return 'badge--stopped';
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Runs — {schedule.scheduleId}</h3>
        {error && <p className="config-error">{error}</p>}
        {runs.length === 0 && !error && (
          <p className="secrets-empty">No runs yet.</p>
        )}
        {runs.length > 0 && (
          <div className="schedule-runs-table-wrap">
            <table className="schedule-runs-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td><span className={`badge ${statusClass(r.status)}`}>{r.status}</span></td>
                    <td>{new Date(r.startedAt).toLocaleString()}</td>
                    <td>{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="schedule-runs-table__error">{r.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
