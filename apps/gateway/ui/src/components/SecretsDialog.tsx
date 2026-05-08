import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface RowState {
  key: string;
  /** Server-supplied masked preview. */
  masked: string;
  /** Whether this secret is injected into sandbox env at exec time. */
  passThrough: boolean;
  /** Current edit-in-progress value; empty until the user types. */
  draft: string;
  /** This row is currently mid-PUT/DELETE. */
  busy: boolean;
}

export function SecretsDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newPassThrough, setNewPassThrough] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const loadFromServer = async () => {
    const map = await api<Record<string, { masked: string; passThrough: boolean }>>(
      `/api/agents/${encodeURIComponent(agentId)}/secrets`,
    );
    setRows(
      Object.keys(map).sort().map((k) => ({
        key: k,
        masked: map[k]?.masked ?? '',
        passThrough: map[k]?.passThrough ?? false,
        draft: '',
        busy: false,
      })),
    );
  };

  useEffect(() => {
    loadFromServer()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [agentId]);

  const updateRow = (key: string, patch: Partial<RowState>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const saveRow = async (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (!row || row.draft === '') return;
    setError('');
    updateRow(key, { busy: true });
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { value: row.draft, passThrough: row.passThrough },
      });
      await loadFromServer();
    } catch (err) {
      setError((err as Error).message);
      updateRow(key, { busy: false });
    }
  };

  const togglePassThrough = async (key: string, next: boolean) => {
    setError('');
    updateRow(key, { busy: true, passThrough: next });
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { passThrough: next },
      });
      await loadFromServer();
    } catch (err) {
      setError((err as Error).message);
      // Revert optimistic toggle on failure.
      updateRow(key, { busy: false, passThrough: !next });
    }
  };

  const deleteRow = async (key: string) => {
    setError('');
    updateRow(key, { busy: true });
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      await loadFromServer();
    } catch (err) {
      setError((err as Error).message);
      updateRow(key, { busy: false });
    }
  };

  const addNew = async () => {
    const k = newKey.trim();
    if (!k) return;
    if (rows.some((r) => r.key === k)) {
      setError(`Secret "${k}" already exists`);
      return;
    }
    setError('');
    setAdding(true);
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(k)}`, {
        method: 'PUT',
        body: { value: newValue, passThrough: newPassThrough },
      });
      setNewKey('');
      setNewValue('');
      setNewPassThrough(false);
      await loadFromServer();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Secrets: {agentId}</h3>

        {loading && <p className="secrets-empty">Loading...</p>}

        {!loading && rows.length === 0 && (
          <p className="secrets-empty">No secrets configured.</p>
        )}

        {rows.map((r) => (
          <div className="secret-row" key={r.key}>
            <span className="secret-row__key">{r.key}</span>
            <input
              className="secret-row__value"
              type="text"
              value={r.draft}
              placeholder={r.masked || 'unchanged'}
              disabled={r.busy}
              onChange={(e) => updateRow(r.key, { draft: e.target.value })}
            />
            <label className="secret-row__passthrough" title="Inject into sandbox env at exec time">
              <input
                type="checkbox"
                checked={r.passThrough}
                disabled={r.busy}
                onChange={(e) => void togglePassThrough(r.key, e.target.checked)}
              />
              <span>Pass through</span>
            </label>
            <button
              className="btn btn--sm btn--primary"
              type="button"
              disabled={r.busy || r.draft === ''}
              onClick={() => void saveRow(r.key)}
            >
              {r.busy ? '…' : 'Save'}
            </button>
            <button
              className="btn btn--sm btn--danger"
              type="button"
              disabled={r.busy}
              onClick={() => {
                if (window.confirm(`Delete secret "${r.key}"?`)) void deleteRow(r.key);
              }}
            >
              Delete
            </button>
          </div>
        ))}

        <div className="secrets-add">
          <input
            className="field__input field__input--inline"
            placeholder="Key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            disabled={adding}
          />
          <input
            className="field__input field__input--inline"
            placeholder="Value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            disabled={adding}
          />
          <label className="secret-row__passthrough" title="Inject into sandbox env at exec time">
            <input
              type="checkbox"
              checked={newPassThrough}
              disabled={adding}
              onChange={(e) => setNewPassThrough(e.target.checked)}
            />
            <span>Pass through</span>
          </label>
          <button
            className="btn btn--sm btn--primary"
            type="button"
            onClick={() => void addNew()}
            disabled={adding || !newKey.trim()}
          >
            {adding ? '…' : 'Add'}
          </button>
        </div>

        {error && <p className="config-error">{error}</p>}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
