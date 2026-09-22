import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAgentSecrets,
  setAgentSecret,
  setAgentSecretPassThrough,
  deleteAgentSecret,
} from '../api';
import { useTranslation } from '../i18n';

interface RowState {
  key: string;
  /** Server-supplied masked preview. */
  masked: string;
  /** Whether this secret is injected as an env var into sandboxes. */
  passThrough: boolean;
  /** This row is currently mid-PUT/DELETE. */
  busy: boolean;
}

/** Which dialog is open, if any. `null` key + mode 'add' is the add flow. */
type DialogState =
  | { mode: 'add' }
  | { mode: 'edit'; key: string; passThrough: boolean; masked: string }
  | null;

export function SecretsPanel() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);

  const loadFromServer = useCallback(async () => {
    const map = await fetchAgentSecrets();
    setRows(
      Object.keys(map).sort().map((k) => ({
        key: k,
        masked: map[k]?.masked ?? '',
        passThrough: map[k]?.passThrough ?? false,
        busy: false,
      })),
    );
  }, []);

  useEffect(() => {
    loadFromServer()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [loadFromServer]);

  // Auto-dismiss the success toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const updateRow = (key: string, patch: Partial<RowState>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
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

  if (loading) return <p className="manage__empty">{t('common.loading')}</p>;
  if (error && rows.length === 0) return <p className="manage__empty">{error}</p>;

  return (
    <div className="secrets-panel">
      <div className="secrets-panel__intro">
        <p className="eyebrow">{t('secrets.eyebrow')}</p>
        <p className="secrets-panel__hint">
          {t('secrets.hintPrefix')}<strong>{t('common.edit')}</strong>
          {t('secrets.hintMiddle1')}<strong>{t('common.delete')}</strong>
          {t('secrets.hintMiddle2')}<strong>{t('secrets.passToSandbox')}</strong>
          {t('secrets.hintSuffix')}
        </p>
      </div>

      <div className="manage__toolbar">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => setDialog({ mode: 'add' })}
        >
          {t('secrets.add')}
        </button>
      </div>

      {toast && <p className="secrets-panel__toast" role="status">{toast}</p>}

      <div className="secrets-panel__list">
        {rows.length === 0 ? (
          <p className="manage__empty">{t('secrets.empty')}</p>
        ) : (
          rows.map((r) => (
            <div className="secrets-row" key={r.key}>
              <span className="secrets-row__key">{r.key}</span>
              <span className="secrets-row__value secrets-row__value--display" title={r.masked}>
                {r.masked || <span className="secrets-row__value-empty">{t('secrets.valueHidden')}</span>}
              </span>
              <label className="secrets-row__passthrough" title={t('secrets.passToSandboxTitle')}>
                <input
                  type="checkbox"
                  checked={r.passThrough}
                  disabled={r.busy}
                  onChange={(e) => void togglePassThrough(r.key, e.target.checked)}
                />
                <span>{t('secrets.passToSandbox')}</span>
              </label>
              <div className="secrets-row__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={r.busy}
                  onClick={() =>
                    setDialog({ mode: 'edit', key: r.key, passThrough: r.passThrough, masked: r.masked })
                  }
                >
                  {r.busy ? '…' : t('common.edit')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm secrets-row__delete"
                  disabled={r.busy}
                  onClick={() => {
                    if (window.confirm(t('secrets.deleteConfirm', { key: r.key }))) void deleteRow(r.key);
                  }}
                >
                  {t('common.delete')}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {error && <p className="basic-panel__error">{error}</p>}

      {dialog && (
        <SecretDialog
          dialog={dialog}
          existingKeys={rows.map((r) => r.key)}
          onClose={() => setDialog(null)}
          onSaved={async (message) => {
            await loadFromServer();
            setToast(message);
          }}
        />
      )}
    </div>
  );
}

function SecretDialog({
  dialog,
  existingKeys,
  onClose,
  onSaved,
}: {
  dialog: Exclude<DialogState, null>;
  existingKeys: string[];
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const isEdit = dialog.mode === 'edit';
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState(isEdit ? dialog.key : '');
  const [value, setValue] = useState('');
  const [passThrough, setPassThrough] = useState(isEdit ? dialog.passThrough : false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    if (!isEdit && existingKeys.includes(k)) {
      setError(t('secrets.duplicateError', { key: k }));
      return;
    }
    // Editing requires a new value — the current one is never returned to the
    // browser, so an empty submit would blank the secret rather than keep it.
    if (isEdit && value === '') {
      setError(t('secrets.editValueRequired'));
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await setAgentSecret(k, value, { passThrough });
      await onSaved(
        isEdit
          ? t('secrets.saveSuccess', { key: k })
          : t('secrets.addSuccess', { key: k }),
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="manage__dialog" onClose={onClose}>
      <form className="manage__dialog-form" onSubmit={handleSubmit}>
        <h3>{isEdit ? t('secrets.dialogEditTitle') : t('secrets.dialogAddTitle')}</h3>

        <label className="manage__field">
          <span className="manage__field-label">{t('secrets.fieldKey')}</span>
          <input
            className="manage__field-input"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="ANTHROPIC_API_KEY"
            autoComplete="off"
            autoFocus={!isEdit}
            required
            readOnly={isEdit}
            disabled={submitting || isEdit}
          />
        </label>

        <label className="manage__field">
          <span className="manage__field-label">{t('secrets.fieldValue')}</span>
          <input
            type="password"
            className="manage__field-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isEdit ? dialog.masked : ''}
            autoComplete="off"
            autoFocus={isEdit}
            disabled={submitting}
          />
        </label>

        <label className="manage__field manage__field--inline">
          <input
            type="checkbox"
            checked={passThrough}
            disabled={submitting}
            onChange={(e) => setPassThrough(e.target.checked)}
          />
          <span>{t('secrets.passToSandboxAdd')}</span>
        </label>

        {error && <p className="manage__error">{error}</p>}

        <div className="manage__dialog-actions">
          <button className="btn btn--ghost" type="button" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn--primary"
            type="submit"
            disabled={submitting || !key.trim()}
          >
            {submitting ? '…' : isEdit ? t('common.save') : t('common.add')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
