import { useEffect, useState } from 'react';
import {
  fetchAgentSecrets,
  setAgentSecret,
  setAgentSecretPassThrough,
  deleteAgentSecret,
} from '../api';

interface RowState {
  key: string;
  /** Server-supplied masked preview. */
  masked: string;
  /** Whether this secret is injected as an env var into sandboxes. */
  passThrough: boolean;
  /** Current edit-in-progress value; empty until the user types. */
  draft: string;
  /** This row is currently mid-PUT/DELETE. */
  busy: boolean;
}

export function SecretsPanel() {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newPassThrough, setNewPassThrough] = useState(false);
  const [adding, setAdding] = useState(false);

  const loadFromServer = async () => {
    const map = await fetchAgentSecrets();
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
  }, []);

  const updateRow = (key: string, patch: Partial<RowState>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const saveRow = async (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (!row || row.draft === '') return;
    setError('');
    updateRow(key, { busy: true });
    try {
      await setAgentSecret(key, row.draft, { passThrough: row.passThrough });
      await loadFromServer();
    } catch (err) {
      setError((err as Error).message);
      updateRow(key, { busy: false });
    }
  };

  const togglePassThrough = async (key: string, next: boolean) => {
    setError('');
    updateRow(key, { passThrough: next, busy: true });
    try {
      await setAgentSecretPassThrough(key, next);
      await loadFromServer();
    } catch (err) {
      setError((err as Error).message);
      updateRow(key, { passThrough: !next, busy: false });
    }
  };

  const deleteRow = async (key: string) => {
    setError('');
    updateRow(key, { busy: true });
    try {
      await deleteAgentSecret(key);
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
      await setAgentSecret(k, newValue, { passThrough: newPassThrough });
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

  if (loading) return <p className="manage__empty">Loading…</p>;
  if (error && rows.length === 0) return <p className="manage__empty">{error}</p>;

  return (
    <div className="secrets-panel">
      <div className="secrets-panel__intro">
        <p className="eyebrow">Secrets</p>
        <p className="secrets-panel__hint">
          Provider API keys, channel tokens, and other credentials. Existing
          values are never returned to the browser; the placeholder shows how
          the server has masked the current value. Each row saves
          independently — type a new value and click <strong>Save</strong> on
          that row, or <strong>Delete</strong> to remove the secret. Toggle
          <strong> Pass to sandbox</strong> to inject the secret as an
          environment variable into this agent's sandboxes at startup
          (takes effect on the next sandbox start).
        </p>
      </div>

      <div className="secrets-panel__list">
        {rows.length === 0 ? (
          <p className="manage__empty">No secrets configured yet.</p>
        ) : (
          rows.map((r) => (
            <div className="secrets-row" key={r.key}>
              <span className="secrets-row__key">{r.key}</span>
              <input
                type="text"
                className="secrets-row__value"
                value={r.draft}
                onChange={(e) => updateRow(r.key, { draft: e.target.value })}
                placeholder={r.masked || 'unchanged'}
                disabled={r.busy}
                autoComplete="off"
              />
              <label className="secrets-row__passthrough" title="Inject as env var into sandboxes">
                <input
                  type="checkbox"
                  checked={r.passThrough}
                  disabled={r.busy}
                  onChange={(e) => void togglePassThrough(r.key, e.target.checked)}
                />
                <span>Pass to sandbox</span>
              </label>
              <div className="secrets-row__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={r.busy || r.draft === ''}
                  onClick={() => void saveRow(r.key)}
                >
                  {r.busy ? '…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm secrets-row__delete"
                  disabled={r.busy}
                  onClick={() => {
                    if (window.confirm(`Delete secret "${r.key}"?`)) void deleteRow(r.key);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="secrets-panel__add">
        <input
          type="text"
          placeholder="Key (e.g. ANTHROPIC_API_KEY)"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          disabled={adding}
        />
        <input
          type="password"
          placeholder="Value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          disabled={adding}
        />
        <label className="secrets-panel__passthrough" title="Inject as env var into sandboxes">
          <input
            type="checkbox"
            checked={newPassThrough}
            disabled={adding}
            onChange={(e) => setNewPassThrough(e.target.checked)}
          />
          <span>Pass to sandbox</span>
        </label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={adding || !newKey.trim()}
          onClick={() => void addNew()}
        >
          {adding ? '…' : 'Add'}
        </button>
      </div>

      {error && <p className="basic-panel__error">{error}</p>}
    </div>
  );
}
