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

interface Props {
  gatewayUrl: string;
  onPick: (conn: Connection) => Promise<void>;
  onSignOut: () => void;
}

/**
 * Step 2 — agent selection.
 *
 * Shows the user's current memberships (click to enter chat) and a form
 * to join a new agent. For protected agents the access token field is
 * required; otherwise it's left blank.
 */
export function PickAgentScreen({ gatewayUrl, onPick, onSignOut }: Props) {
  const [memberships, setMemberships] = useState<AgentMembership[] | null>(null);
  const [error, setError] = useState('');
  const [joinAgentId, setJoinAgentId] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
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
      setCopyMsg(`${label} copied`);
      setTimeout(() => setCopyMsg(''), 1800);
    } catch {
      setCopyMsg('Copy failed — select and copy manually');
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
      <div className="card card--form" style={{ maxWidth: 520 }}>
        <p className="eyebrow">OpenHermit</p>
        <h1>Pick an agent</h1>
        <p className="hint">
          <span>
            Signed in as <strong>{getDisplayName() || 'Unknown'}</strong>
            {getUserId() && <span className="hint__uid"> · {getUserId()}</span>}
          </span>
          <br />
          <span style={{ color: 'var(--muted)' }}>gateway: </span>
          <code style={{ fontSize: 12 }}>{gatewayUrl}</code>
        </p>

        {error && <p className="form-error">{error}</p>}

        <h3 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 8 }}>
          Your agents
        </h3>
        {memberships === null && <p className="hint">Loading…</p>}
        {memberships !== null && memberships.length === 0 && (
          <p className="hint">No agent memberships yet — join one below.</p>
        )}
        {memberships !== null && memberships.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {memberships.map((m) => (
              <button
                key={m.agentId}
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => void enter(m)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', textAlign: 'left',
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
                  background: m.status === 'running' ? 'var(--success-bg, #dcfce7)' : 'var(--surface, #f4f4f5)',
                  color: m.status === 'running' ? 'var(--success, #166534)' : 'var(--muted)',
                }}>
                  {m.status}
                </span>
              </button>
            ))}
          </div>
        )}

        {!joinOpen ? (
          <button
            className="btn btn--ghost btn--full"
            type="button"
            onClick={() => setJoinOpen(true)}
            style={{ marginTop: 16 }}
          >
            + Join another agent
          </button>
        ) : (
          <>
            <h3 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 24, marginBottom: 8 }}>
              Join another agent
            </h3>
            <form onSubmit={handleJoin}>
              <label className="field">
                <span className="field__label">Agent ID</span>
                <input
                  className="field__input"
                  type="text"
                  placeholder="e.g. one"
                  required
                  autoFocus
                  value={joinAgentId}
                  onChange={(e) => setJoinAgentId(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field__label">Agent invite token</span>
                <input
                  className="field__input"
                  type="password"
                  placeholder="Only if the agent is protected"
                  value={joinToken}
                  onChange={(e) => setJoinToken(e.target.value)}
                />
                <span className="field__help">
                  Per-agent shared secret from the agent's owner (set with
                  <code> hermit agents create --access-token …</code>). This is
                  <strong> not</strong> your bearer token.
                </span>
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
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={!joinAgentId.trim() || busy}
                  style={{ flex: 1 }}
                >
                  {busy ? 'Joining...' : 'Join'}
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
          {tokensOpen ? 'Hide access tokens' : 'Show access tokens'}
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
                <strong>API bearer token (your JWT)</strong>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void copy(accessToken, 'Bearer token')}
                  disabled={!accessToken}
                >
                  Copy
                </button>
              </div>
              <p className="hint" style={{ margin: '0 0 6px' }}>
                Short-lived (~24h). Use as <code>Authorization: Bearer &lt;token&gt;</code> for the
                CLI, curl, or any HTTP integration. Auto-refreshes from your device key when it
                expires. <strong>Don't paste this into the "Agent invite token" field</strong> when joining an agent — that field is a separate per-agent secret.
              </p>
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
                {accessToken || 'Loading…'}
              </code>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <strong>Device key</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setShowDeviceKey((v) => !v)}
                    disabled={!deviceKeyJson}
                  >
                    {showDeviceKey ? 'Hide' : 'Reveal'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void copy(deviceKeyJson, 'Device key')}
                    disabled={!deviceKeyJson}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <p className="hint" style={{ margin: '0 0 6px' }}>
                Fingerprint: <code style={{ fontSize: 11 }}>{fingerprint ? `${fingerprint.slice(0, 8)}…${fingerprint.slice(-8)}` : '—'}</code>
                <br />
                <span style={{ color: 'var(--danger, #b91c1c)' }}>
                  ⚠ This is your private key. Anyone with it can sign in as you. Save it to a
                  password manager to add another device — never paste it into chat or email.
                </span>
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
                  {deviceKeyJson || 'Loading…'}
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
          Sign out
        </button>
      </div>
    </div>
  );
}
