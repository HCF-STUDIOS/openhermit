import { useState, useEffect, type FormEvent } from 'react';
import {
  exchangeToken,
  getDeviceFingerprint,
  getDisplayName,
  importDeviceKey,
  isNewDevice,
  loadGatewayUrl,
  saveGatewayUrl,
  setDisplayName,
  setGateway,
} from '../api';
import { useTranslation } from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

interface Props {
  onComplete: () => void;
}

/**
 * Step 1 — gateway connect.
 *
 * Generates a per-device ECDSA key (if not already), asks for the
 * gateway URL + display name, exchanges the device key for a
 * gateway-level JWT. The JWT has no agent in it; agent selection is
 * step 2 (PickAgentScreen).
 */
export function SetupScreen({ onComplete }: Props) {
  const { t } = useTranslation();
  const [fingerprint, setFingerprint] = useState('');
  const [gatewayUrl, setGatewayUrl] = useState(loadGatewayUrl() ?? window.location.origin);
  const [name, setName] = useState(getDisplayName() ?? '');
  const [isNew, setIsNew] = useState(true);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'new' | 'restore'>('new');
  const [restoreKey, setRestoreKey] = useState('');

  useEffect(() => {
    (async () => {
      const fp = await getDeviceFingerprint();
      setFingerprint(fp);
      setIsNew(isNewDevice());
      setLoading(false);
    })();
  }, []);

  const shortFp = fingerprint
    ? `${fingerprint.slice(0, 8)}...${fingerprint.slice(-8)}`
    : '';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const url = gatewayUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    setError('');
    setSubmitting(true);
    try {
      saveGatewayUrl(url);
      setGateway(url);
      if (mode === 'restore') {
        const ok = importDeviceKey(restoreKey.trim());
        if (!ok) throw new Error(t('setup.errInvalidKey'));
        // Use the imported display name if present, otherwise fall back to
        // whatever the user typed (or the existing one).
        const importedName = getDisplayName();
        const dn = importedName || name.trim();
        if (!dn) throw new Error(t('setup.errNameRequired'));
        if (!importedName) setDisplayName(dn);
        await exchangeToken(dn);
      } else {
        const dn = name.trim();
        if (!dn) throw new Error(t('setup.errNameRequired'));
        setDisplayName(dn);
        await exchangeToken(dn);
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return null;

  return (
    <div className="center-screen">
      <div className="welcome-corner"><LanguageSwitcher /></div>
      <form className="card card--form" onSubmit={handleSubmit}>
        <p className="eyebrow">OpenHermit</p>
        <h1>{isNew ? t('setup.welcome') : t('setup.connectTitle')}</h1>
        <p className="hint">
          {mode === 'restore'
            ? t('setup.hintRestore')
            : isNew
            ? t('setup.hintNew')
            : t('setup.hintExisting')}
        </p>

        <div className="device-key-display">
          <span className="field__label">{t('setup.deviceKeyFingerprint')}</span>
          <code className="device-key-value">{shortFp}</code>
        </div>

        <div className="welcome-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'new'}
            className={`welcome-tab${mode === 'new' ? ' welcome-tab--active' : ''}`}
            onClick={() => { setMode('new'); setError(''); }}
          >
            {t('setup.tabNew')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'restore'}
            className={`welcome-tab${mode === 'restore' ? ' welcome-tab--active' : ''}`}
            onClick={() => { setMode('restore'); setError(''); }}
          >
            {t('setup.tabRestore')}
          </button>
        </div>

        {mode === 'restore' && (
          <label className="field">
            <span className="field__label">{t('setup.deviceKeyJsonLabel')}</span>
            <textarea
              className="field__input"
              rows={6}
              placeholder='{"publicKey":{…},"privateKey":{…},"displayName":"…"}'
              required
              value={restoreKey}
              onChange={(e) => setRestoreKey(e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
            />
            <span className="field__help">{t('setup.deviceKeyJsonHelp')}</span>
          </label>
        )}

        <label className="field">
          <span className="field__label">{t('setup.gatewayUrl')}</span>
          <input
            className="field__input"
            type="url"
            placeholder="https://hermit.example.com"
            required
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
          />
        </label>

        {mode === 'new' && (
          <label className="field">
            <span className="field__label">{t('setup.displayName')}</span>
            <input
              className="field__input"
              type="text"
              placeholder={t('setup.displayNamePlaceholder')}
              required
              autoFocus={isNew}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}

        {error && <p className="form-error">{error}</p>}

        <button
          className="btn btn--primary btn--full"
          type="submit"
          disabled={
            !gatewayUrl.trim() ||
            submitting ||
            (mode === 'new' && !name.trim()) ||
            (mode === 'restore' && !restoreKey.trim())
          }
        >
          {submitting
            ? t('setup.submitConnecting')
            : mode === 'restore'
            ? t('setup.submitRestore')
            : isNew
            ? t('setup.submitNew')
            : t('setup.submitContinue')}
        </button>
      </form>
    </div>
  );
}
