import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchChannels,
  patchChannel,
  removeChannel,
  createExternalChannel,
  setAgentSecret,
  type ChannelInfo,
  type CreatedChannel,
} from '../api';

/**
 * Fixed config skeletons for built-in channels. Token fields are kept as
 * `${{SECRET}}` placeholders that resolve at adapter-start time; the actual
 * secret is written via setAgentSecret.
 */
const BUILTIN_CONFIG_TEMPLATES: Record<string, (extras: Record<string, unknown>) => Record<string, unknown>> = {
  telegram: (extras) => ({
    bot_token: '${{TELEGRAM_BOT_TOKEN}}',
    mode: extras.mode ?? 'polling',
    ...(Array.isArray(extras.allowed_chat_ids) && extras.allowed_chat_ids.length
      ? { allowed_chat_ids: extras.allowed_chat_ids }
      : {}),
  }),
  discord: (extras) => ({
    bot_token: '${{DISCORD_BOT_TOKEN}}',
    ...(Array.isArray(extras.allowed_channel_ids) && extras.allowed_channel_ids.length
      ? { allowed_channel_ids: extras.allowed_channel_ids }
      : {}),
  }),
  slack: (extras) => ({
    bot_token: '${{SLACK_BOT_TOKEN}}',
    app_token: '${{SLACK_APP_TOKEN}}',
    ...(Array.isArray(extras.allowed_channel_ids) && extras.allowed_channel_ids.length
      ? { allowed_channel_ids: extras.allowed_channel_ids }
      : {}),
  }),
};

/**
 * Unified channel management — covers both built-in adapters
 * (telegram/discord/slack, in-process bridges) and owner-issued external
 * tokens (third-party adapters connecting from outside the gateway).
 *
 * Both kinds live in the agent_channels table; the server returns them
 * in one list. Built-in rows are auto-seeded on agent creation and only
 * support enable/disable/config-edit. External rows are created here
 * (with a token issued by the server) and can be revoked.
 */
export function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editConfig, setEditConfig] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editSecrets, setEditSecrets] = useState<Record<string, string>>({});
  const [editExtras, setEditExtras] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  // Create-external flow
  const [creating, setCreating] = useState(false);
  const [newNamespace, setNewNamespace] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<CreatedChannel | null>(null);

  const editDialogRef = useRef<HTMLDialogElement>(null);
  const createDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (editing) editDialogRef.current?.showModal();
    else editDialogRef.current?.close();
  }, [editing]);

  useEffect(() => {
    if (creating) createDialogRef.current?.showModal();
    else createDialogRef.current?.close();
  }, [creating]);

  const load = useCallback(async () => {
    try {
      setChannels(await fetchChannels());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (ch: ChannelInfo) => {
    try {
      await patchChannel(ch.id, { enabled: !ch.enabled });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRemove = async (ch: ChannelInfo) => {
    if (ch.kind === 'builtin') {
      setError(`Built-in channel "${ch.channelType}" cannot be deleted; disable it instead.`);
      return;
    }
    const what = `Revoke external channel "${ch.label ?? ch.namespace}"? Its token will stop working immediately.`;
    if (!confirm(what)) return;
    try {
      await removeChannel(ch.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = (ch: ChannelInfo) => {
    setEditing(ch.id);
    setEditLabel(ch.label ?? '');
    setEditSecrets({});
    setError('');
    if (ch.kind === 'builtin') {
      // Pre-fill structured extras from existing config (token fields stay
      // as placeholders; secrets are entered fresh).
      const cfg = ch.config ?? {};
      const extras: Record<string, unknown> = {};
      if (ch.channelType === 'telegram') {
        extras.mode = cfg.mode ?? 'polling';
        if (Array.isArray(cfg.allowed_chat_ids)) extras.allowed_chat_ids = cfg.allowed_chat_ids;
      } else if (ch.channelType === 'discord' || ch.channelType === 'slack') {
        if (Array.isArray(cfg.allowed_channel_ids)) extras.allowed_channel_ids = cfg.allowed_channel_ids;
      }
      setEditExtras(extras);
      setEditConfig('');
    } else {
      setEditExtras({});
      setEditConfig(JSON.stringify(ch.config, null, 2));
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    const ch = channels.find((c) => c.id === editing);
    if (!ch) return;

    setSaving(true);
    try {
      let nextConfig: Record<string, unknown>;
      if (ch.kind === 'builtin') {
        // 1. Persist any newly-entered secrets first.
        for (const [key, value] of Object.entries(editSecrets)) {
          if (value.trim()) {
            await setAgentSecret(key, value.trim());
          }
        }
        // 2. Build a fixed config skeleton from the channel-type template.
        const tmpl = BUILTIN_CONFIG_TEMPLATES[ch.channelType];
        nextConfig = tmpl ? tmpl(editExtras) : (ch.config ?? {});
      } else {
        try {
          nextConfig = JSON.parse(editConfig || '{}') as Record<string, unknown>;
          if (typeof nextConfig !== 'object' || nextConfig === null) {
            throw new Error('Config must be a JSON object');
          }
        } catch (err) {
          setError(`Invalid JSON: ${(err as Error).message}`);
          setSaving(false);
          return;
        }
      }

      await patchChannel(editing, {
        config: nextConfig,
        label: editLabel.trim() === '' ? null : editLabel.trim(),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateExternal = async () => {
    const ns = newNamespace.trim();
    if (!ns) {
      setError('Namespace is required.');
      return;
    }
    setSaving(true);
    try {
      const created = await createExternalChannel({
        namespace: ns,
        ...(newLabel.trim() ? { label: newLabel.trim() } : {}),
      });
      setCreatedToken(created);
      setNewNamespace('');
      setNewLabel('');
      setCreating(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="manage__empty">Loading...</p>;

  const builtin = channels.filter((c) => c.kind === 'builtin');
  const external = channels.filter((c) => c.kind === 'external');
  const editingChannel = channels.find((c) => c.id === editing);

  return (
    <div className="manage__list">
      {error && <p className="manage__error">{error}</p>}

      {createdToken && (
        <div className="manage__card manage__card--accent">
          <div className="manage__card-info">
            <div className="manage__card-header">
              <span className="manage__card-name">Token issued for {createdToken.namespace}</span>
            </div>
            <p className="manage__card-help">
              Save this now — it won't be shown again.
            </p>
            <pre className="manage__token">{createdToken.token}</pre>
          </div>
          <div className="manage__card-actions">
            <button className="btn btn--sm btn--ghost" onClick={() => setCreatedToken(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <h3 className="manage__section-title">Built-in channels</h3>
      {builtin.length === 0 && (
        <p className="manage__empty">No built-in channels yet (will be seeded on next agent restart).</p>
      )}
      {builtin.map((ch) => (
        <ChannelCard
          key={ch.id}
          ch={ch}
          onToggle={() => void handleToggle(ch)}
          onEdit={() => startEdit(ch)}
          onRemove={() => void handleRemove(ch)}
        />
      ))}

      <h3 className="manage__section-title" style={{ marginTop: 24 }}>
        External channel tokens
      </h3>
      <p className="manage__hint">
        For channel adapters running outside the gateway (a Telegram bot deployed
        elsewhere, a custom bridge). Each token is namespace-scoped and has no
        admin privileges.
      </p>
      {external.length === 0 && (
        <p className="manage__empty">No external tokens issued.</p>
      )}
      {external.map((ch) => (
        <ChannelCard
          key={ch.id}
          ch={ch}
          onToggle={() => void handleToggle(ch)}
          onEdit={() => startEdit(ch)}
          onRemove={() => void handleRemove(ch)}
        />
      ))}

      <div className="manage__add-list">
        <button className="btn btn--sm btn--outline" onClick={() => setCreating(true)}>
          + Issue external channel token
        </button>
      </div>

      <dialog ref={createDialogRef} className="manage__dialog" onClose={() => setCreating(false)}>
        <div className="manage__dialog-header">
          <h3>New external channel</h3>
          <button className="btn btn--sm btn--ghost" onClick={() => setCreating(false)}>Cancel</button>
        </div>
        <div className="manage__dialog-body">
          <div className="manage__field">
            <label className="manage__field-label">Namespace</label>
            <input
              className="manage__field-input"
              placeholder="e.g. telegram-bot, custom-slack"
              value={newNamespace}
              onChange={(e) => setNewNamespace(e.target.value)}
            />
            <span className="manage__field-hint">
              The adapter will only be able to act in this namespace (sender.channel must match).
            </span>
          </div>
          <div className="manage__field">
            <label className="manage__field-label">Label (optional)</label>
            <input
              className="manage__field-input"
              placeholder="Human-readable name"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
        </div>
        <div className="manage__dialog-footer">
          <button className="btn btn--primary" onClick={() => void handleCreateExternal()} disabled={saving}>
            {saving ? 'Creating...' : 'Issue token'}
          </button>
        </div>
      </dialog>

      <dialog ref={editDialogRef} className="manage__dialog" onClose={() => setEditing(null)}>
        {editingChannel && (
          <>
            <div className="manage__dialog-header">
              <h3>Edit {editingChannel.label ?? editingChannel.channelType}</h3>
              <button className="btn btn--sm btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
            <div className="manage__dialog-body">
              <div className="manage__field">
                <label className="manage__field-label">Label</label>
                <input
                  className="manage__field-input"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                />
              </div>
              {editingChannel.kind === 'builtin' ? (
                <BuiltinChannelFields
                  channel={editingChannel}
                  secrets={editSecrets}
                  setSecrets={setEditSecrets}
                  extras={editExtras}
                  setExtras={setEditExtras}
                />
              ) : (
                <div className="manage__field">
                  <label className="manage__field-label">Config (JSON)</label>
                  <textarea
                    className="manage__field-input"
                    rows={10}
                    spellCheck={false}
                    style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                    value={editConfig}
                    onChange={(e) => setEditConfig(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="manage__dialog-footer">
              <button className="btn btn--primary" onClick={() => void handleSaveEdit()} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}

function BuiltinChannelFields({ channel, secrets, setSecrets, extras, setExtras }: {
  channel: ChannelInfo;
  secrets: Record<string, string>;
  setSecrets: (s: Record<string, string>) => void;
  extras: Record<string, unknown>;
  setExtras: (e: Record<string, unknown>) => void;
}) {
  const setSecret = (key: string, value: string) => setSecrets({ ...secrets, [key]: value });
  const setExtra = (key: string, value: unknown) => setExtras({ ...extras, [key]: value });

  return (
    <>
      {(channel.secretKeys ?? []).map((sk) => (
        <div className="manage__field" key={sk.key}>
          <label className="manage__field-label">{sk.label}</label>
          <input
            className="manage__field-input"
            type="password"
            placeholder={sk.placeholder}
            value={secrets[sk.key] ?? ''}
            onChange={(e) => setSecret(sk.key, e.target.value)}
            autoComplete="off"
          />
          <span className="manage__field-hint">
            Stored as secret <code>{sk.key}</code>. Leave blank to keep the existing value.
          </span>
        </div>
      ))}

      {channel.channelType === 'telegram' && (
        <>
          <div className="manage__field">
            <label className="manage__field-label">Mode</label>
            <select
              className="manage__field-input"
              value={(extras.mode as string) ?? 'polling'}
              onChange={(e) => setExtra('mode', e.target.value)}
            >
              <option value="polling">Polling</option>
              <option value="webhook">Webhook</option>
            </select>
          </div>
          {extras.mode === 'webhook' && (
            <div className="manage__field">
              <label className="manage__field-label">Webhook URL</label>
              <code style={{ display: 'block', padding: '8px 10px', background: 'var(--surface, #f4f4f5)', borderRadius: 4, fontSize: 12, wordBreak: 'break-all' }}>
                {`${typeof window !== 'undefined' ? window.location.origin : ''}/api/agents/${channel.agentId}/channels/${channel.namespace}/webhook`}
              </code>
              <span className="manage__field-hint">
                Auto-derived from the gateway URL. Telegram is registered with a per-channel secret_token, so requests are verified server-side.
              </span>
            </div>
          )}
          <div className="manage__field">
            <label className="manage__field-label">Allowed Chat IDs (optional)</label>
            <input
              className="manage__field-input"
              placeholder="comma-separated, e.g. 12345, 67890"
              value={Array.isArray(extras.allowed_chat_ids) ? extras.allowed_chat_ids.join(', ') : ''}
              onChange={(e) => {
                const ids = e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((s) => (Number.isNaN(Number(s)) ? s : Number(s)));
                setExtra('allowed_chat_ids', ids);
              }}
            />
            <span className="manage__field-hint">Leave blank to allow all chats.</span>
          </div>
        </>
      )}

      {(channel.channelType === 'discord' || channel.channelType === 'slack') && (
        <div className="manage__field">
          <label className="manage__field-label">Allowed Channel IDs (optional)</label>
          <input
            className="manage__field-input"
            placeholder="comma-separated, e.g. C0123, C0456"
            value={Array.isArray(extras.allowed_channel_ids) ? extras.allowed_channel_ids.join(', ') : ''}
            onChange={(e) => {
              const ids = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
              setExtra('allowed_channel_ids', ids);
            }}
          />
          <span className="manage__field-hint">Leave blank to allow all channels.</span>
        </div>
      )}
    </>
  );
}

function ChannelCard({ ch, onToggle, onEdit, onRemove }: {
  ch: ChannelInfo;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const statusClass =
    ch.runtimeStatus === 'error' ? 'manage__card-badge--err'
    : ch.enabled ? 'manage__card-badge--on'
    : 'manage__card-badge--off';
  const statusText =
    ch.runtimeStatus === 'connected' ? 'Connected'
    : ch.runtimeStatus === 'error' ? 'Error'
    : ch.enabled ? 'Enabled' : 'Disabled';
  return (
    <div className="manage__card">
      <div className="manage__card-info">
        <div className="manage__card-header">
          <span className="manage__card-name">
            {ch.label ?? ch.channelType}
            {ch.kind === 'external' && (
              <span className="manage__card-meta"> · {ch.namespace}</span>
            )}
          </span>
          <span className={`manage__card-badge ${statusClass}`}>{statusText}</span>
          {ch.kind === 'builtin' && !ch.secretsSet && (
            <span className="manage__card-badge manage__card-badge--warn">Secrets missing</span>
          )}
        </div>
        <div className="manage__card-meta">
          token <code>{ch.tokenPrefix}…</code>
        </div>
        {ch.error && <div className="manage__card-error">{ch.error}</div>}
      </div>
      <div className="manage__card-actions">
        <button className="btn btn--sm btn--ghost" onClick={onEdit}>Edit</button>
        <button
          className={`btn btn--sm ${ch.enabled ? 'btn--ghost' : 'btn--primary'}`}
          onClick={onToggle}
        >
          {ch.enabled ? 'Disable' : 'Enable'}
        </button>
        {ch.kind === 'external' && (
          <button className="btn btn--sm btn--danger" onClick={onRemove}>
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}
