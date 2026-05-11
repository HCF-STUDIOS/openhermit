import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface AgentInfo {
  agentId: string;
  name?: string;
}

interface ChannelSecretKey { key: string; label: string; placeholder: string }

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

/**
 * Per-agent channel management: select an agent, see all its channel rows
 * (built-in adapters + owner-issued external tokens), enable/disable,
 * edit config + label, revoke / reset, issue new external tokens.
 *
 * Mirrors the SchedulesPanel UX: agent picker on top, list of cards below.
 */
export function ChannelsPanel() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState('');
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ChannelRecord | null>(null);
  const [creating, setCreating] = useState(false);
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

  useEffect(() => { void loadAgents(); }, [loadAgents]);
  useEffect(() => { void loadChannels(); }, [loadChannels]);

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

  const builtin = channels.filter((c) => c.kind === 'builtin');
  const external = channels.filter((c) => c.kind === 'external');

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Channels</h2>
        <button
          className="btn btn--primary btn--sm"
          onClick={() => setCreating(true)}
          disabled={!agentId}
        >
          New external token
        </button>
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

      <h3 style={{ marginTop: 16, marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Built-in</h3>
      {loading && channels.length === 0 && agentId && (
        <p className="agent-list__empty">Loading channels…</p>
      )}
      {!loading && builtin.length === 0 && agentId && (
        <p className="agent-list__empty">No built-in channels yet for this agent.</p>
      )}
      <div className="schedule-list">
        {builtin.map((ch) => (
          <ChannelCard
            key={ch.id}
            ch={ch}
            statusClass={statusClass(ch)}
            statusText={statusText(ch)}
            onEdit={() => setEditing(ch)}
            onToggle={() => void handleToggle(ch)}
            onDelete={() => void handleDelete(ch)}
          />
        ))}
      </div>

      <h3 style={{ marginTop: 24, marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>
        External tokens
      </h3>
      {!loading && external.length === 0 && agentId && (
        <p className="agent-list__empty">No external tokens issued.</p>
      )}
      <div className="schedule-list">
        {external.map((ch) => (
          <ChannelCard
            key={ch.id}
            ch={ch}
            statusClass={statusClass(ch)}
            statusText={statusText(ch)}
            onEdit={() => setEditing(ch)}
            onToggle={() => void handleToggle(ch)}
            onDelete={() => void handleDelete(ch)}
          />
        ))}
      </div>

      {editing && (
        <EditChannelDialog
          agentId={agentId}
          channel={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void loadChannels(); }}
        />
      )}
      {creating && agentId && (
        <CreateChannelDialog
          agentId={agentId}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreatedToken(created);
            setCreating(false);
            void loadChannels();
          }}
        />
      )}
    </div>
  );
}

function ChannelCard({ ch, statusClass, statusText, onEdit, onToggle, onDelete }: {
  ch: ChannelRecord;
  statusClass: string;
  statusText: string;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="schedule-card">
      <div className="schedule-card__info">
        <div>
          <span className="skill-card__name">
            {ch.label ?? ch.channelType}
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

function CreateChannelDialog({ agentId, onClose, onCreated }: {
  agentId: string;
  onClose: () => void;
  onCreated: (created: CreatedChannelResponse) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [namespace, setNamespace] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
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
