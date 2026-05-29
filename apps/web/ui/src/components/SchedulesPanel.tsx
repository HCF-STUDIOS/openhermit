import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSchedules, createSchedule, updateSchedule, deleteSchedule,
  triggerSchedule, fetchScheduleRuns,
  type ScheduleInfo, type ScheduleRunInfo,
} from '../api';
import { useTranslation } from '../i18n';

export function SchedulesPanel() {
  const { t } = useTranslation();
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [runsScheduleId, setRunsScheduleId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSchedules(await fetchSchedules());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handlePauseResume = async (s: ScheduleInfo) => {
    try {
      await updateSchedule(s.scheduleId, { status: s.status === 'paused' ? 'active' : 'paused' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('schedules.deleteConfirm', { id }))) return;
    try {
      await deleteSchedule(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleTrigger = async (id: string) => {
    try {
      await triggerSchedule(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) return <p className="manage__empty">{t('common.loading')}</p>;
  if (error) return <p className="manage__error">{error}</p>;

  return (
    <div>
      <div className="manage__toolbar">
        <button className="btn btn--sm btn--primary" onClick={() => setShowCreate(true)}>{t('schedules.create')}</button>
      </div>

      {schedules.length === 0 && <p className="manage__empty">{t('schedules.empty')}</p>}

      <div className="manage__list">
        {schedules.map((s) => (
          <div className="manage__card" key={s.scheduleId}>
            <div className="manage__card-info">
              <div className="manage__card-header">
                <span className="manage__card-name">{s.scheduleId}</span>
                <span className={`manage__badge manage__badge--${s.type}`}>{s.type}</span>
                <span className={`manage__badge manage__badge--${s.status}`}>{s.status}</span>
              </div>
              <div className="manage__card-desc">{s.prompt.length > 100 ? s.prompt.slice(0, 100) + '...' : s.prompt}</div>
              <div className="manage__card-meta">
                {s.cronExpression && <>{t('schedules.cron', { expr: s.cronExpression })}</>}
                {s.runAt && <>{t('schedules.runAt', { time: new Date(s.runAt).toLocaleString() })}</>}
                {s.nextRunAt && <>{t('schedules.next', { time: new Date(s.nextRunAt).toLocaleString() })}</>}
                {s.runCount > 0 && <>{t('schedules.runCount', { n: String(s.runCount) })}</>}
                {s.consecutiveErrors > 0 && <>{t('schedules.errors', { n: String(s.consecutiveErrors) })}</>}
              </div>
            </div>
            <div className="manage__card-actions">
              <button className="btn btn--sm btn--ghost" onClick={() => setRunsScheduleId(s.scheduleId)}>{t('schedules.runs')}</button>
              <button className="btn btn--sm btn--ghost" onClick={() => void handleTrigger(s.scheduleId)}>{t('schedules.trigger')}</button>
              <button className="btn btn--sm btn--ghost" onClick={() => void handlePauseResume(s)}>
                {t(s.status === 'paused' ? 'schedules.resume' : 'schedules.pause')}
              </button>
              <button className="btn btn--sm btn--danger" onClick={() => void handleDelete(s.scheduleId)}>{t('common.delete')}</button>
            </div>
          </div>
        ))}
      </div>

      {showCreate && <CreateScheduleDialog onClose={() => setShowCreate(false)} onCreated={load} />}
      {runsScheduleId && <RunsDialog scheduleId={runsScheduleId} onClose={() => setRunsScheduleId(null)} />}
    </div>
  );
}

function CreateScheduleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<'cron' | 'once'>('cron');
  const [prompt, setPrompt] = useState('');
  const [cronExpression, setCronExpression] = useState('');
  const [runAt, setRunAt] = useState('');
  const [scheduleId, setScheduleId] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createSchedule({
        type,
        prompt,
        ...(scheduleId.trim() ? { id: scheduleId.trim() } : {}),
        ...(type === 'cron' ? { cronExpression } : {}),
        ...(type === 'once' ? { runAt: new Date(runAt).toISOString() } : {}),
      });
      onClose();
      onCreated();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <dialog ref={dialogRef} className="manage__dialog" onClose={onClose}>
      <form className="manage__dialog-form" onSubmit={handleSubmit}>
        <h3>{t('schedules.dialogTitle')}</h3>

        <label className="manage__field">
          <span className="manage__field-label">{t('schedules.fieldIdOptional')}</span>
          <input className="manage__field-input" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} placeholder={t('schedules.idPlaceholder')} />
        </label>

        <div className="manage__field">
          <span className="manage__field-label">{t('schedules.fieldType')}</span>
          <div className="manage__radio-group">
            <label><input type="radio" checked={type === 'cron'} onChange={() => setType('cron')} /> {t('schedules.typeCron')}</label>
            <label><input type="radio" checked={type === 'once'} onChange={() => setType('once')} /> {t('schedules.typeOnce')}</label>
          </div>
        </div>

        <label className="manage__field">
          <span className="manage__field-label">{t('schedules.fieldPrompt')}</span>
          <textarea className="manage__field-input manage__field-textarea" required value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
        </label>

        {type === 'cron' && (
          <label className="manage__field">
            <span className="manage__field-label">{t('schedules.fieldCron')}</span>
            <input className="manage__field-input" required value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} placeholder="*/30 * * * *" />
          </label>
        )}

        {type === 'once' && (
          <label className="manage__field">
            <span className="manage__field-label">{t('schedules.fieldRunAt')}</span>
            <input className="manage__field-input" type="datetime-local" required value={runAt} onChange={(e) => setRunAt(e.target.value)} />
          </label>
        )}

        <div className="manage__dialog-actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn--primary" type="submit">{t('schedules.dialogCreate')}</button>
        </div>
      </form>
    </dialog>
  );
}

function RunsDialog({ scheduleId, onClose }: { scheduleId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [runs, setRuns] = useState<ScheduleRunInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    fetchScheduleRuns(scheduleId)
      .then(setRuns)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [scheduleId]);

  return (
    <dialog ref={dialogRef} className="manage__dialog manage__dialog--wide" onClose={onClose}>
      <div className="manage__dialog-form">
        <h3>{t('schedules.runsTitle', { id: scheduleId })}</h3>

        {loading && <p className="manage__empty">{t('common.loading')}</p>}
        {error && <p className="manage__error">{error}</p>}

        {!loading && !error && runs.length === 0 && <p className="manage__empty">{t('schedules.runsEmpty')}</p>}

        {runs.length > 0 && (
          <div className="manage__runs">
            {runs.map((r) => (
              <div className="manage__run" key={r.runId}>
                <span className={`manage__badge manage__badge--${r.status}`}>{r.status}</span>
                <span>{new Date(r.startedAt).toLocaleString()}</span>
                {r.durationMs != null && <span>{(r.durationMs / 1000).toFixed(1)}s</span>}
                {r.error && <span className="manage__run-error">{r.error}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="manage__dialog-actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </dialog>
  );
}
