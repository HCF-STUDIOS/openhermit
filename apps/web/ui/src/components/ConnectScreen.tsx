import { useState, type FormEvent } from 'react';
import { getDisplayName, getUserId, type Connection } from '../api';
import { useTranslation } from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

interface Props {
  defaultGatewayUrl: string;
  defaultAgentId: string;
  defaultToken: string;
  error: string;
  onConnect: (conn: Connection) => Promise<void>;
}

export function ConnectScreen({ defaultGatewayUrl, defaultAgentId, defaultToken, error, onConnect }: Props) {
  const { t } = useTranslation();
  const [gatewayUrl, setGatewayUrl] = useState(defaultGatewayUrl);
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [token, setToken] = useState(defaultToken);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onConnect({
        gatewayUrl: gatewayUrl.trim().replace(/\/+$/, ''),
        agentId: agentId.trim(),
        token: token.trim() || undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="welcome-corner"><LanguageSwitcher /></div>
      <form className="card card--form" onSubmit={handleSubmit}>
        <p className="eyebrow">OpenHermit</p>
        <h1>{t('connect.title')}</h1>
        <p className="hint">
          <span>
            {t('pickAgent.signedInAs')} <strong>{getDisplayName() || t('common.unknown')}</strong>
            {getUserId() && <span className="hint__uid"> · {getUserId()}</span>}
          </span>
          <br />
          <span style={{ color: 'var(--muted)' }}>{t('connect.at')} </span>
          <code style={{ fontSize: 12 }}>{typeof window !== 'undefined' ? window.location.origin : ''}</code>
        </p>

        <label className="field">
          <span className="field__label">{t('setup.gatewayUrl')}</span>
          <input
            className="field__input"
            type="url"
            placeholder={t('connect.gatewayPlaceholder')}
            required
            value={gatewayUrl}
            onChange={e => setGatewayUrl(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">{t('pickAgent.agentId')}</span>
          <input
            className="field__input"
            type="text"
            placeholder={t('connect.agentIdPlaceholder')}
            required
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">{t('connect.accessToken')}</span>
          <input
            className="field__input"
            type="password"
            placeholder={t('connect.accessTokenPlaceholder')}
            value={token}
            onChange={e => setToken(e.target.value)}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button className="btn btn--primary btn--full" type="submit" disabled={loading}>
          {loading ? t('connect.submitting') : t('connect.submit')}
        </button>
      </form>
    </div>
  );
}
