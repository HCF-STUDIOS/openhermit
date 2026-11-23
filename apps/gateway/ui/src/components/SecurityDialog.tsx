import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * Raw JSON editor for the agent's security policy. Same shape as
 * ConfigDialog; backed by GET/PUT /api/agents/:id/security. Lets owners
 * flip `access` between public/protected/private, set `access_token`,
 * edit `channel_tokens`, etc. without going through the database.
 *
 * The gateway validates `access` is one of the three known values and
 * the runtime reloads its in-memory policy after a successful PUT.
 */
export function SecurityDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('Loading...');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api(`/api/agents/${encodeURIComponent(agentId)}/security`)
      .then((data) => setText(JSON.stringify(data, null, 2)))
      .catch((err) => {
        setText('');
        setError((err as Error).message);
      });
  }, [agentId]);

  const save = async () => {
    setError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Invalid JSON.');
      return;
    }
    setSaving(true);
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/security`, {
        method: 'PUT',
        body: parsed,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Security: {agentId}</h3>
        <p className="config-hint">
          <code>access</code> ∈ <code>"public"</code> / <code>"protected"</code> /{' '}
          <code>"private"</code>. <code>"protected"</code> requires an{' '}
          <code>access_token</code>. Other fields:{' '}
          <code>channel_tokens</code>. Tool approval / deny rules live in
          policy rows, not here.
        </p>
        <textarea
          className="config-editor"
          rows={20}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={saving}
        />
        {error && <p className="config-error">{error}</p>}
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose} disabled={saving}>
            Close
          </button>
          <button className="btn btn--primary" type="button" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
