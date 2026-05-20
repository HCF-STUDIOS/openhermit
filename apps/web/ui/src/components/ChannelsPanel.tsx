import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchChannels,
  fetchChannelManifests,
  patchChannel,
  removeChannel,
  createExternalChannel,
  setAgentSecret,
  type ChannelConfigField,
  type ChannelInfo,
  type ChannelManifestSummary,
  type CreatedChannel,
} from '../api';
import { ChannelSetupWizard } from './ChannelSetupWizard';

/**
 * Hardcoded fallback skeletons for the original built-in channels. Used
 * only when the gateway didn't ship a `defaultConfig` for the row (older
 * gateway, or a channel without its own manifest schema). Newer channels
 * declare their own `secretKeys` / `configFields` / `defaultConfig` on
 * the manifest, which the UI consumes directly.
 */
const BUILTIN_DEFAULT_CONFIGS: Record<string, Record<string, unknown>> = {
  telegram: { bot_token: '${{TELEGRAM_BOT_TOKEN}}', mode: 'polling' },
  discord: { bot_token: '${{DISCORD_BOT_TOKEN}}' },
  slack: { bot_token: '${{SLACK_BOT_TOKEN}}', app_token: '${{SLACK_APP_TOKEN}}' },
};

const BUILTIN_CONFIG_FIELDS: Record<string, ChannelConfigField[]> = {
  telegram: [
    {
      kind: 'select', key: 'mode', label: 'Mode', defaultValue: 'polling',
      options: [
        { value: 'polling', label: 'Polling' },
        { value: 'webhook', label: 'Webhook' },
      ],
    },
    {
      kind: 'webhook_url', label: 'Webhook URL',
      help: 'Auto-derived from the gateway URL. Telegram is registered with a per-channel secret_token, so requests are verified server-side.',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
    {
      kind: 'string_list', key: 'allowed_chat_ids', label: 'Allowed Chat IDs (optional)',
      placeholder: 'comma-separated, e.g. 12345, 67890',
      help: 'Leave blank to allow all chats.',
    },
  ],
  discord: [
    {
      kind: 'string_list', key: 'allowed_channel_ids', label: 'Allowed Channel IDs (optional)',
      placeholder: 'comma-separated, e.g. C0123, C0456',
      help: 'Leave blank to allow all channels.',
    },
  ],
  slack: [
    {
      kind: 'string_list', key: 'allowed_channel_ids', label: 'Allowed Channel IDs (optional)',
      placeholder: 'comma-separated, e.g. C0123, C0456',
      help: 'Leave blank to allow all channels.',
    },
  ],
};

/**
 * Resolve the form schema for a channel row. Plugin-declared schema on
 * the row wins; otherwise fall back to the hardcoded built-in defaults.
 */
function resolveSchema(ch: ChannelInfo): {
  secretKeys: ChannelInfo['secretKeys'];
  configFields: ChannelConfigField[];
  defaultConfig: Record<string, unknown>;
} | null {
  const fields = ch.configFields ?? BUILTIN_CONFIG_FIELDS[ch.channelType];
  const defaultConfig = ch.defaultConfig ?? BUILTIN_DEFAULT_CONFIGS[ch.channelType];
  const hasSecrets = (ch.secretKeys?.length ?? 0) > 0;
  if (!hasSecrets && (!fields || fields.length === 0)) return null;
  return {
    secretKeys: ch.secretKeys,
    configFields: fields ?? [],
    defaultConfig: defaultConfig ?? {},
  };
}

function parseStringList(raw: string, numeric: boolean): Array<string | number> {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (numeric && !Number.isNaN(Number(s)) ? Number(s) : s));
}

function shouldShow(field: ChannelConfigField, extras: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  return extras[field.showWhen.field] === field.showWhen.equals;
}

function pickInitialExtras(fields: ChannelConfigField[], persisted: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'webhook_url') continue;
    const existing = persisted[f.key];
    if (existing !== undefined && existing !== null) {
      out[f.key] = existing;
    } else if (f.kind === 'select' && f.defaultValue !== undefined) {
      out[f.key] = f.defaultValue;
    }
  }
  return out;
}

function buildConfigFromExtras(
  fields: ChannelConfigField[],
  extras: Record<string, unknown>,
  defaultConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaultConfig };
  for (const f of fields) {
    if (f.kind === 'webhook_url') continue;
    if (!shouldShow(f, extras)) continue;
    const value = extras[f.key];
    if (f.kind === 'select') {
      if (typeof value === 'string' && value.length > 0) merged[f.key] = value;
      else if (f.defaultValue !== undefined) merged[f.key] = f.defaultValue;
    } else if (f.kind === 'text') {
      if (typeof value === 'string' && value.trim() !== '') merged[f.key] = value.trim();
    } else if (f.kind === 'string_list') {
      if (Array.isArray(value) && value.length > 0) merged[f.key] = value;
    }
  }
  return merged;
}

type GroupKey = 'builtin' | 'package' | 'token';

/**
 * Unified channel management — three groups:
 *   1. Built-in (telegram/slack/discord, ship with the gateway).
 *   2. Package-installed (loaded via `channelPackages` config, e.g. WeChat).
 *      Typically require an interactive Set-up wizard to provision config.
 *   3. Owner-issued external tokens for adapters running outside the gateway.
 *
 * Built-in and package rows are auto-seeded on agent create (one row per
 * registered manifest, disabled). Token rows are created on demand here.
 */
export function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [manifests, setManifests] = useState<ChannelManifestSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Edit-row state.
  const [editing, setEditing] = useState<string | null>(null);
  const [editConfig, setEditConfig] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editSecrets, setEditSecrets] = useState<Record<string, string>>({});
  const [editExtras, setEditExtras] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  // Set-up wizard (re-uses the manifest's ChannelSetup state machine to
  // populate an already-seeded row's config). `setupFor` carries the row.
  const [setupFor, setSetupFor] = useState<ChannelInfo | null>(null);

  // Issue-token flow.
  const [issuing, setIssuing] = useState(false);
  const [newNamespace, setNewNamespace] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<CreatedChannel | null>(null);

  const editDialogRef = useRef<HTMLDialogElement>(null);
  const setupDialogRef = useRef<HTMLDialogElement>(null);
  const issueDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (editing) editDialogRef.current?.showModal();
    else editDialogRef.current?.close();
  }, [editing]);
  useEffect(() => {
    if (setupFor) setupDialogRef.current?.showModal();
    else setupDialogRef.current?.close();
  }, [setupFor]);
  useEffect(() => {
    if (issuing) issueDialogRef.current?.showModal();
    else issueDialogRef.current?.close();
  }, [issuing]);

  const load = useCallback(async () => {
    try {
      const [chs, mans] = await Promise.all([fetchChannels(), fetchChannelManifests()]);
      setChannels(chs);
      setManifests(mans);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const manifestByKey = new Map(manifests.map((m) => [m.key, m]));

  const groupOf = (ch: ChannelInfo): GroupKey => {
    if (ch.kind === 'external') return 'token';
    return manifestByKey.get(ch.channelType)?.origin === 'external' ? 'package' : 'builtin';
  };

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
    const schema = resolveSchema(ch);
    if (schema) {
      setEditExtras(pickInitialExtras(schema.configFields, ch.config ?? {}));
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
      const schema = resolveSchema(ch);
      if (schema) {
        for (const [key, value] of Object.entries(editSecrets)) {
          if (value.trim()) {
            await setAgentSecret(key, value.trim());
          }
        }
        nextConfig = buildConfigFromExtras(schema.configFields, editExtras, schema.defaultConfig);
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

  const handleSetupDone = async (config: Record<string, unknown>): Promise<void> => {
    if (!setupFor) return;
    try {
      await patchChannel(setupFor.id, { config, enabled: true });
      setSetupFor(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openIssue = () => {
    setIssuing(true);
    setNewNamespace('');
    setNewLabel('');
    setError('');
  };

  const handleIssueToken = async () => {
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
      setIssuing(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="manage__empty">Loading...</p>;

  const builtin = channels.filter((c) => groupOf(c) === 'builtin');
  const pkg = channels.filter((c) => groupOf(c) === 'package');
  const token = channels.filter((c) => groupOf(c) === 'token');
  const editingChannel = channels.find((c) => c.id === editing);

  const renderCard = (ch: ChannelInfo, group: GroupKey) => {
    const manifest = manifestByKey.get(ch.channelType);
    const canSetup = group === 'package' && manifest?.supportsSetup === true;
    const displayName = ch.label ?? manifest?.displayName ?? ch.channelType;
    return (
      <ChannelCard
        key={ch.id}
        ch={ch}
        displayName={displayName}
        canSetup={canSetup}
        onSetup={() => setSetupFor(ch)}
        onToggle={() => void handleToggle(ch)}
        onEdit={() => startEdit(ch)}
        onRemove={() => void handleRemove(ch)}
      />
    );
  };

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
      <p className="manage__hint">Ship with the gateway. Add secrets, then enable.</p>
      {builtin.length === 0 && (
        <p className="manage__empty">No built-in channels yet (seeded on next agent restart).</p>
      )}
      {builtin.map((ch) => renderCard(ch, 'builtin'))}

      <h3 className="manage__section-title" style={{ marginTop: 24 }}>Package-installed channels</h3>
      <p className="manage__hint">
        Loaded via the gateway's <code>channelPackages</code> config. Use <strong>Set up</strong> to link an account interactively.
      </p>
      {pkg.length === 0 && (
        <p className="manage__empty">No channel packages installed. Add one via <code>hermit gateway config set channelPackages '["@scope/pkg"]'</code> and restart the gateway.</p>
      )}
      {pkg.map((ch) => renderCard(ch, 'package'))}

      <h3 className="manage__section-title" style={{ marginTop: 24 }}>External channel tokens</h3>
      <p className="manage__hint">
        For channel adapters running outside the gateway. Each token is namespace-scoped.
      </p>
      {token.length === 0 && (
        <p className="manage__empty">No external tokens issued.</p>
      )}
      {token.map((ch) => renderCard(ch, 'token'))}
      <div className="manage__add-list">
        <button className="btn btn--sm btn--outline" onClick={openIssue}>
          + Issue new token
        </button>
      </div>

      <dialog ref={setupDialogRef} className="manage__dialog" onClose={() => setSetupFor(null)}>
        {setupFor && (
          <>
            <div className="manage__dialog-header">
              <h3>Link {manifestByKey.get(setupFor.channelType)?.displayName ?? setupFor.channelType}</h3>
              <button className="btn btn--sm btn--ghost" onClick={() => setSetupFor(null)}>Cancel</button>
            </div>
            <div className="manage__dialog-body">
              <ChannelSetupWizard
                channelType={setupFor.channelType}
                displayName={manifestByKey.get(setupFor.channelType)?.displayName ?? setupFor.channelType}
                onDone={handleSetupDone}
                onCancel={() => setSetupFor(null)}
              />
            </div>
          </>
        )}
      </dialog>

      <dialog ref={issueDialogRef} className="manage__dialog" onClose={() => setIssuing(false)}>
        <div className="manage__dialog-header">
          <h3>New external channel token</h3>
          <button className="btn btn--sm btn--ghost" onClick={() => setIssuing(false)}>Cancel</button>
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
          <button className="btn btn--primary" onClick={() => void handleIssueToken()} disabled={saving}>
            {saving ? 'Creating...' : 'Issue token'}
          </button>
        </div>
      </dialog>

      <dialog ref={editDialogRef} className="manage__dialog" onClose={() => setEditing(null)}>
        {editingChannel && (
          <>
            <div className="manage__dialog-header">
              <h3>Edit {editingChannel.label ?? manifestByKey.get(editingChannel.channelType)?.displayName ?? editingChannel.channelType}</h3>
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
              {resolveSchema(editingChannel) ? (
                <ChannelConfigFormFields
                  channel={editingChannel}
                  schema={resolveSchema(editingChannel)!}
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

function ChannelConfigFormFields({
  channel,
  schema,
  secrets,
  setSecrets,
  extras,
  setExtras,
}: {
  channel: ChannelInfo;
  schema: {
    secretKeys: ChannelInfo['secretKeys'];
    configFields: ChannelConfigField[];
    defaultConfig: Record<string, unknown>;
  };
  secrets: Record<string, string>;
  setSecrets: (s: Record<string, string>) => void;
  extras: Record<string, unknown>;
  setExtras: (e: Record<string, unknown>) => void;
}) {
  const setSecret = (key: string, value: string) => setSecrets({ ...secrets, [key]: value });
  const setExtra = (key: string, value: unknown) => setExtras({ ...extras, [key]: value });

  return (
    <>
      {(schema.secretKeys ?? []).map((sk) => (
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

      {schema.configFields.map((field) => {
        if (!shouldShow(field, extras)) return null;
        if (field.kind === 'select') {
          const current = (extras[field.key] as string | undefined) ?? field.defaultValue ?? '';
          return (
            <div className="manage__field" key={field.key}>
              <label className="manage__field-label">{field.label}</label>
              <select
                className="manage__field-input"
                value={current}
                onChange={(e) => setExtra(field.key, e.target.value)}
              >
                {field.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {field.help && <span className="manage__field-hint">{field.help}</span>}
            </div>
          );
        }
        if (field.kind === 'text') {
          return (
            <div className="manage__field" key={field.key}>
              <label className="manage__field-label">{field.label}</label>
              <input
                className="manage__field-input"
                placeholder={field.placeholder}
                value={(extras[field.key] as string | undefined) ?? ''}
                onChange={(e) => setExtra(field.key, e.target.value)}
              />
              {field.help && <span className="manage__field-hint">{field.help}</span>}
            </div>
          );
        }
        if (field.kind === 'string_list') {
          const numeric = field.key.endsWith('_chat_ids');
          const value = Array.isArray(extras[field.key]) ? (extras[field.key] as Array<string | number>) : [];
          return (
            <div className="manage__field" key={field.key}>
              <label className="manage__field-label">{field.label}</label>
              <input
                className="manage__field-input"
                placeholder={field.placeholder}
                value={value.join(', ')}
                onChange={(e) => setExtra(field.key, parseStringList(e.target.value, numeric))}
              />
              {field.help && <span className="manage__field-hint">{field.help}</span>}
            </div>
          );
        }
        // webhook_url — read-only informational display.
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        const url = `${origin}/api/agents/${channel.agentId}/channels/${channel.namespace}/webhook`;
        return (
          <div className="manage__field" key={`webhook-url-${field.label}`}>
            <label className="manage__field-label">{field.label}</label>
            <code style={{ display: 'block', padding: '8px 10px', background: 'var(--surface, #f4f4f5)', borderRadius: 4, fontSize: 12, wordBreak: 'break-all' }}>
              {url}
            </code>
            {field.help && <span className="manage__field-hint">{field.help}</span>}
          </div>
        );
      })}
    </>
  );
}

function ChannelCard({ ch, displayName, canSetup, onSetup, onToggle, onEdit, onRemove }: {
  ch: ChannelInfo;
  displayName: string;
  canSetup: boolean;
  onSetup: () => void;
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
            {displayName}
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
        {canSetup && (
          <button className="btn btn--sm btn--primary" onClick={onSetup}>Set up</button>
        )}
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
