import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ChannelSetupWizard } from './ChannelSetupWizard';

interface AgentInfo {
  agentId: string;
  name?: string;
}

interface ChannelSecretKey { key: string; label: string; placeholder: string }

interface ChannelManifestSummary {
  key: string;
  namespace: string;
  displayName: string;
  origin: 'built-in' | 'external';
  supportsSetup: boolean;
  secretKeys?: ChannelSecretKey[];
  defaultConfig?: Record<string, unknown>;
}

interface ChannelRecord {
  id: string;
  agentId: string;
  kind: 'builtin' | 'external';
  channelType: string;
  namespace: string;
  label: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  secretKeys?: ChannelSecretKey[];
  secretsSet: boolean;
  runtimeStatus?: string;
  error?: string;
}

interface CreatedChannelResponse extends ChannelRecord {
  token: string;
}

type GroupKey = 'builtin' | 'package' | 'token';

/**
 * Per-agent channel management with three groups:
 *   1. Built-in (telegram/slack/discord, ship with the gateway).
 *   2. Package-installed (loaded via `channelPackages` config, e.g. WeChat) —
 *      with a "Set up" wizard for the manifest's interactive auth flow.
 *   3. Owner-issued external tokens for adapters outside the gateway.
 */
export function ChannelsPanel() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState('');
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [manifests, setManifests] = useState<ChannelManifestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ChannelRecord | null>(null);
  const [setupFor, setSetupFor] = useState<ChannelRecord | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreatedChannelResponse | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const list = await api<AgentInfo[]>('/api/agents');
      setAgents(list);
      if (list.length > 0 && !agentId) setAgentId(list[0].agentId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agentId]);

  const loadChannels = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      setChannels(await api<ChannelRecord[]>(`/api/agents/${encodeURIComponent(agentId)}/channels`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const loadManifests = useCallback(async () => {
    try {
      setManifests(await api<ChannelManifestSummary[]>('/api/channel-manifests'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void loadAgents(); }, [loadAgents]);
  useEffect(() => { void loadChannels(); }, [loadChannels]);
  useEffect(() => { void loadManifests(); }, [loadManifests]);

  const manifestByKey = new Map(manifests.map((m) => [m.key, m]));

  const groupOf = (ch: ChannelRecord): GroupKey => {
    if (ch.kind === 'external') return 'token';
    return manifestByKey.get(ch.channelType)?.origin === 'external' ? 'package' : 'builtin';
  };

  const handleToggle = async (ch: ChannelRecord) => {
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(ch.id)}`, {
        method: 'PATCH',
        body: { enabled: !ch.enabled },
      });
      await loadChannels();
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    }
  };

  const handleDelete = async (ch: ChannelRecord) => {
    if (ch.kind === 'builtin') {
      alert(`Built-in channel "${ch.channelType}" cannot be deleted; disable it instead.`);
      return;
    }
    const confirmMsg = `Revoke external channel "${ch.label ?? ch.namespace}"? Its token will stop working immediately.`;
    if (!confirm(confirmMsg)) return;
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(ch.id)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
    await loadChannels();
  };

  const handleSetupDone = async (config: Record<string, unknown>): Promise<void> => {
    if (!setupFor) return;
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(setupFor.id)}`, {
        method: 'PATCH',
        body: { config, enabled: true },
      });
      setSetupFor(null);
      await loadChannels();
    } catch (err) {
      alert(`Set-up failed: ${(err as Error).message}`);
    }
  };

  const statusClass = (ch: ChannelRecord) => {
    if (ch.runtimeStatus === 'error') return 'badge--failed';
    if (ch.runtimeStatus === 'connected') return 'badge--active';
    if (ch.enabled) return 'badge--running';
    return 'badge--paused';
  };

  const statusText = (ch: ChannelRecord) => {
    if (ch.runtimeStatus === 'connected') return 'connected';
    if (ch.runtimeStatus === 'error') return 'error';
    return ch.enabled ? 'enabled' : 'disabled';
  };

  const builtin = channels.filter((c) => groupOf(c) === 'builtin');
  const pkg = channels.filter((c) => groupOf(c) === 'package');
  const token = channels.filter((c) => groupOf(c) === 'token');

  const renderCard = (ch: ChannelRecord, group: GroupKey) => {
    const manifest = manifestByKey.get(ch.channelType);
    const canSetup = group === 'package' && manifest?.supportsSetup === true;
    const displayName = ch.label ?? manifest?.displayName ?? ch.channelType;
    return (
      <ChannelCard
        key={ch.id}
        ch={ch}
        displayName={displayName}
        statusClass={statusClass(ch)}
        statusText={statusText(ch)}
        canSetup={canSetup}
        onSetup={() => setSetupFor(ch)}
        onEdit={() => setEditing(ch)}
        onToggle={() => void handleToggle(ch)}
        onDelete={() => void handleDelete(ch)}
      />
    );
  };

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Channels</h2>
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

      {error && <p className="agent-list__empty">{error}</p>}

      {createdToken && (
        <div className="schedule-card" style={{ borderLeft: '3px solid var(--accent, #4f8cf6)', marginBottom: 16 }}>
          <div className="schedule-card__info">
            <div>
              <span className="skill-card__name">Token issued for {createdToken.namespace}</span>
            </div>
            <div className="schedule-card__prompt" style={{ marginTop: 4 }}>
              Save this now — it won't be shown again.
            </div>
            <pre style={{
              fontFamily: 'var(--mono, monospace)',
              fontSize: 12,
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
              background: 'var(--surface, #f4f4f5)',
              border: '1px solid var(--border, #e5e5e5)',
              borderRadius: 4,
              padding: '8px 10px',
              margin: '6px 0 0',
            }}>{createdToken.token}</pre>
          </div>
          <div className="schedule-card__actions">
            <button className="btn btn--sm" onClick={() => setCreatedToken(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 16, marginBottom: 4, fontSize: '0.9rem', color: 'var(--muted)' }}>Built-in</h3>
      <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: 'var(--muted)' }}>
        Ship with the gateway. Add secrets, then enable.
      </p>
      {loading && channels.length === 0 && agentId && (
        <p className="agent-list__empty">Loading channels…</p>
      )}
      {!loading && builtin.length === 0 && agentId && (
        <p className="agent-list__empty">No built-in channels for this agent.</p>
      )}
      <div className="schedule-list">
        {builtin.map((ch) => renderCard(ch, 'builtin'))}
      </div>

      <h3 style={{ marginTop: 24, marginBottom: 4, fontSize: '0.9rem', color: 'var(--muted)' }}>
        Package-installed
      </h3>
      <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: 'var(--muted)' }}>
        Loaded via the gateway's <code>channelPackages</code> config. Click <strong>Set up</strong> to link.
      </p>
      {!loading && pkg.length === 0 && agentId && (
        <p className="agent-list__empty">
          No channel packages installed. Run <code>hermit gateway config set channelPackages '["@scope/pkg"]'</code> and restart the gateway.
        </p>
      )}
      <div className="schedule-list">
        {pkg.map((ch) => renderCard(ch, 'package'))}
      </div>

      <h3 style={{ marginTop: 24, marginBottom: 4, fontSize: '0.9rem', color: 'var(--muted)' }}>
        External tokens
      </h3>
      <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: 'var(--muted)' }}>
        For adapters running outside the gateway. Each token is namespace-scoped.
      </p>
      {!loading && token.length === 0 && agentId && (
        <p className="agent-list__empty">No external tokens issued.</p>
      )}
      <div className="schedule-list">
        {token.map((ch) => renderCard(ch, 'token'))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button
          className="btn btn--sm"
          onClick={() => setIssuing(true)}
          disabled={!agentId}
        >
          + Issue new token
        </button>
      </div>

      {editing && (
        <EditChannelDialog
          agentId={agentId}
          channel={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void loadChannels(); }}
        />
      )}
      {setupFor && (
        <SetupChannelDialog
          agentId={agentId}
          channel={setupFor}
          displayName={manifestByKey.get(setupFor.channelType)?.displayName ?? setupFor.channelType}
          onClose={() => setSetupFor(null)}
          onDone={handleSetupDone}
        />
      )}
      {issuing && agentId && (
        <IssueTokenDialog
          agentId={agentId}
          onClose={() => setIssuing(false)}
          onCreated={(created) => {
            setCreatedToken(created);
            setIssuing(false);
            void loadChannels();
          }}
        />
      )}
    </div>
  );
}

function ChannelCard({ ch, displayName, statusClass, statusText, canSetup, onSetup, onEdit, onToggle, onDelete }: {
  ch: ChannelRecord;
  displayName: string;
  statusClass: string;
  statusText: string;
  canSetup: boolean;
  onSetup: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="schedule-card">
      <div className="schedule-card__info">
        <div>
          <span className="skill-card__name">
            {displayName}
            {ch.kind === 'external' && (
              <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>· {ch.namespace}</span>
            )}
          </span>
          <span className={`badge ${statusClass}`}>{statusText}</span>
          {ch.kind === 'builtin' && !ch.secretsSet && (
            <span className="badge badge--failed" title="Required env vars not set">secrets missing</span>
          )}
        </div>
        <div className="schedule-card__meta">
          token <code>{ch.tokenPrefix}…</code>
          {' | '}created {new Date(ch.createdAt).toLocaleDateString()}
          {ch.error && (
            <span className="schedule-card__errors"> | {ch.error}</span>
          )}
        </div>
      </div>
      <div className="schedule-card__actions">
        {canSetup && (
          <button className="btn btn--sm btn--primary" onClick={onSetup}>Set up</button>
        )}
        <button className="btn btn--sm" onClick={onEdit}>Edit</button>
        <button className="btn btn--sm" onClick={onToggle}>
          {ch.enabled ? 'Disable' : 'Enable'}
        </button>
        {ch.kind === 'external' && (
          <button className="btn btn--sm btn--danger" onClick={onDelete}>
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

function EditChannelDialog({ agentId, channel, onClose, onSaved }: {
  agentId: string;
  channel: ChannelRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState(channel.label ?? '');
  const [configJson, setConfigJson] = useState(JSON.stringify(channel.config, null, 2));
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(configJson || '{}') as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Config must be an object');
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channel.id)}`, {
        method: 'PATCH',
        body: { config: parsed, label: label.trim() === '' ? null : label.trim() },
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form className="dialog__form" onSubmit={handleSubmit}>
        <h3>Edit {channel.channelType}</h3>
        {error && <p className="config-error">{error}</p>}
        <label className="field">
          <span className="field__label">Label</span>
          <input className="field__input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Config (JSON)</span>
          <textarea
            className="field__input"
            rows={10}
            spellCheck={false}
            style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
            value={configJson}
            onChange={(e) => setConfigJson(e.target.value)}
          />
          {channel.secretKeys && channel.secretKeys.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Reference secrets with <code>{'${{NAME}}'}</code>. Expected keys:{' '}
              {channel.secretKeys.map((sk) => sk.key).join(', ')}.
            </span>
          )}
        </label>
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="submit">Save</button>
        </div>
      </form>
    </dialog>
  );
}

function SetupChannelDialog({ agentId, channel, displayName, onClose, onDone }: {
  agentId: string;
  channel: ChannelRecord;
  displayName: string;
  onClose: () => void;
  onDone: (config: Record<string, unknown>) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <div className="dialog__form">
        <h3>Link {displayName}</h3>
        <ChannelSetupWizard
          agentId={agentId}
          channelType={channel.channelType}
          displayName={displayName}
          onDone={onDone}
          onCancel={onClose}
        />
      </div>
    </dialog>
  );
}

function IssueTokenDialog({ agentId, onClose, onCreated }: {
  agentId: string;
  onClose: () => void;
  onCreated: (created: CreatedChannelResponse) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [namespace, setNamespace] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const ns = namespace.trim();
    if (!ns) { setError('Namespace is required.'); return; }
    try {
      const created = await api<CreatedChannelResponse>(
        `/api/agents/${encodeURIComponent(agentId)}/channels`,
        { method: 'POST', body: { namespace: ns, ...(label.trim() ? { label: label.trim() } : {}) } },
      );
      onCreated(created);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form className="dialog__form" onSubmit={handleSubmit}>
        <h3>New external channel token</h3>
        {error && <p className="config-error">{error}</p>}
        <label className="field">
          <span className="field__label">Namespace</span>
          <input
            className="field__input"
            required
            placeholder="e.g. telegram-bot, custom-slack"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            The adapter will only be able to act in this namespace. The token has no admin privileges.
          </span>
        </label>
        <label className="field">
          <span className="field__label">Label (optional)</span>
          <input
            className="field__input"
            placeholder="Human-readable name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="submit">Issue token</button>
        </div>
      </form>
    </dialog>
  );
}
