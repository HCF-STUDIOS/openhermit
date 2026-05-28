import { useEffect, useState, type FormEvent } from 'react';
import {
  exportDeviceKey,
  getDeviceFingerprint,
  getDisplayName,
  getJwt,
  getUserId,
  joinAgent,
  listMyAgents,
  type AgentMembership,
  type Connection,
} from '../api';
import { useTranslation } from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

interface Props {
  gatewayUrl: string;
  onPick: (conn: Connection) => Promise<void>;
  onSignOut: () => void;
  initialJoinAgentId?: string;
  initialJoinToken?: string;
  initialError?: string;
}

/**
 * Step 2 — agent selection.
 *
 * Shows the user's current memberships (click to enter chat) and a form
 * to join a new agent. For protected agents the access token field is
 * required; otherwise it's left blank.
 */
export function PickAgentScreen({
  gatewayUrl,
  onPick,
  onSignOut,
  initialJoinAgentId,
  initialJoinToken,
  initialError,
}: Props) {
  const { t } = useTranslation();
  const [memberships, setMemberships] = useState<AgentMembership[] | null>(null);
  const [error, setError] = useState(initialError ?? '');
  const [joinAgentId, setJoinAgentId] = useState(initialJoinAgentId ?? '');
  const [joinToken, setJoinToken] = useState(initialJoinToken ?? '');
  const [busy, setBusy] = useState(false);
  const [joinOpen, setJoinOpen] = useState(Boolean(initialJoinAgentId));
  const [tokensOpen, setTokensOpen] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [deviceKeyJson, setDeviceKeyJson] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [showDeviceKey, setShowDeviceKey] = useState(false);
  const [copyMsg, setCopyMsg] = useState('');

  const refresh = async (): Promise<void> => {
    try {
      setMemberships(await listMyAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const openTokens = async (): Promise<void> => {
    setTokensOpen((v) => !v);
    if (!accessToken) {
      try {
        const [jwt, fp] = await Promise.all([getJwt(), getDeviceFingerprint()]);
        setAccessToken(jwt);
        setFingerprint(fp);
        setDeviceKeyJson(exportDeviceKey() ?? '');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMsg(t('pickAgent.copySuccess', { label }));
      setTimeout(() => setCopyMsg(''), 1800);
    } catch {
      setCopyMsg(t('pickAgent.copyFailed'));
    }
  };

  const enter = async (m: AgentMembership): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      await onPick({ gatewayUrl, agentId: m.agentId, role: m.role });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleJoin = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const id = joinAgentId.trim();
    if (!id) return;
    setError('');
    setBusy(true);
    try {
      const membership = await joinAgent(id, joinToken.trim() || undefined);
      await onPick({
        gatewayUrl,
        agentId: id,
        role: membership.role,
        ...(joinToken.trim() ? { token: joinToken.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="welcome-corner"><LanguageSwitcher /></div>
      <div className="card card--form" style={{ maxWidth: 520 }}>
        <p className="eyebrow">OpenHermit</p>
        <h1>{t('pickAgent.title')}</h1>
        <p className="hint">
          <span>
            {t('pickAgent.signedInAs')} <strong>{getDisplayName() || t('common.unknown')}</strong>
            {getUserId() && <span className="hint__uid"> · {getUserId()}</span>}
          </span>
          <br />
          <span style={{ color: 'var(--muted)' }}>{t('pickAgent.gateway')} </span>
          <code style={{ fontSize: 12 }}>{gatewayUrl}</code>
        </p>

        {error && <p className="form-error">{error}</p>}

        <h3 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 8 }}>
          {t('pickAgent.yourAgents')}
        </h3>
        {memberships === null && <p className="hint">{t('common.loading')}</p>}
        {memberships !== null && memberships.length === 0 && (
          <p className="hint">{t('pickAgent.empty')}</p>
        )}
        {memberships !== null && memberships.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {memberships.map((m) => {
              const isDisabled = m.status === 'disabled';
              return (
                <button
                  key={m.agentId}
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy || isDisabled}
                  title={isDisabled ? t('pickAgent.disabledTitle') : undefined}
                  onClick={() => void enter(m)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 12px', textAlign: 'left',
                    opacity: isDisabled ? 0.55 : 1,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <strong>{m.name ?? m.agentId}</strong>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{m.agentId} · {m.role}</span>
                  </span>
                  <span style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: isDisabled ? 'var(--surface, #f4f4f5)' : 'var(--success-bg, #dcfce7)',
                    color: isDisabled ? 'var(--muted)' : 'var(--success, #166534)',
                  }}>
                    {m.status}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!joinOpen ? (
          <button
            className="btn btn--ghost btn--full"
            type="button"
            onClick={() => setJoinOpen(true)}
            style={{ marginTop: 16 }}
          >
            {t('pickAgent.joinAnother')}
          </button>
        ) : (
          <>
            <h3 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 24, marginBottom: 8 }}>
              {t('pickAgent.joinAnotherHeading')}
            </h3>
            <form onSubmit={handleJoin}>
              <label className="field">
                <span className="field__label">{t('pickAgent.agentId')}</span>
                <input
                  className="field__input"
                  type="text"
                  placeholder={t('pickAgent.agentIdPlaceholder')}
                  required
                  autoFocus
                  value={joinAgentId}
                  onChange={(e) => setJoinAgentId(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field__label">{t('pickAgent.inviteToken')}</span>
                <input
                  className="field__input"
                  type="password"
                  placeholder={t('pickAgent.inviteTokenPlaceholder')}
                  value={joinToken}
                  onChange={(e) => setJoinToken(e.target.value)}
                />
                <span className="field__help">{t('pickAgent.inviteTokenHelp')}</span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => {
                    setJoinOpen(false);
                    setJoinAgentId('');
                    setJoinToken('');
                  }}
                  disabled={busy}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={!joinAgentId.trim() || busy}
                  style={{ flex: 1 }}
                >
                  {busy ? t('pickAgent.joining') : t('pickAgent.join')}
                </button>
              </div>
            </form>
          </>
        )}

        <button
          className="btn btn--ghost btn--sm"
          type="button"
          onClick={() => void openTokens()}
          style={{ marginTop: 16 }}
        >
          {tokensOpen ? t('pickAgent.hideTokens') : t('pickAgent.showTokens')}
        </button>
        {tokensOpen && (
          <div
            style={{
              marginTop: 8,
              padding: 12,
              border: '1px solid var(--border, #e4e4e7)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              fontSize: 13,
            }}
          >
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <strong>{t('pickAgent.bearerTitle')}</strong>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void copy(accessToken, t('pickAgent.bearerLabel'))}
                  disabled={!accessToken}
                >
                  {t('common.copy')}
                </button>
              </div>
              <p className="hint" style={{ margin: '0 0 6px' }}>{t('pickAgent.bearerHelp')}</p>
              <code
                style={{
                  display: 'block',
                  fontSize: 11,
                  padding: '8px 10px',
                  background: 'var(--surface, #f4f4f5)',
                  borderRadius: 6,
                  wordBreak: 'break-all',
                  maxHeight: 80,
                  overflow: 'auto',
                }}
              >
                {accessToken || t('common.loading')}
              </code>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <strong>{t('pickAgent.deviceKey')}</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setShowDeviceKey((v) => !v)}
                    disabled={!deviceKeyJson}
                  >
                    {showDeviceKey ? t('pickAgent.hide') : t('pickAgent.reveal')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void copy(deviceKeyJson, t('pickAgent.deviceKeyLabel'))}
                    disabled={!deviceKeyJson}
                  >
                    {t('common.copy')}
                  </button>
                </div>
              </div>
              <p className="hint" style={{ margin: '0 0 6px' }}>
                {t('pickAgent.fingerprintLabel')} <code style={{ fontSize: 11 }}>{fingerprint ? `${fingerprint.slice(0, 8)}…${fingerprint.slice(-8)}` : '—'}</code>
                <br />
                <span style={{ color: 'var(--danger, #b91c1c)' }}>{t('pickAgent.deviceKeyWarning')}</span>
              </p>
              {showDeviceKey && (
                <code
                  style={{
                    display: 'block',
                    fontSize: 11,
                    padding: '8px 10px',
                    background: 'var(--surface, #f4f4f5)',
                    borderRadius: 6,
                    whiteSpace: 'pre',
                    maxHeight: 160,
                    overflow: 'auto',
                  }}
                >
                  {deviceKeyJson || t('common.loading')}
                </code>
              )}
            </div>

            {copyMsg && <p className="hint" style={{ margin: 0, color: 'var(--success, #166534)' }}>{copyMsg}</p>}
          </div>
        )}

        <button
          className="btn btn--ghost btn--sm"
          type="button"
          onClick={onSignOut}
          style={{ marginTop: 16, marginLeft: 8 }}
        >
          {t('pickAgent.signOut')}
        </button>
      </div>
    </div>
  );
}
