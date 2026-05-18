import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface GatewayConfig {
  ui?: boolean;
  cors?: { origin?: string };
  sandboxPresets?: Record<string, { type: string; config: Record<string, unknown> }>;
  autoProvisionSandbox?: string | null;
  /** npm package names to dynamic-import as channel plugins at boot. */
  channelPackages?: string[];
  /** Attachment storage block — not yet in the Settings form, edit via JSON tab. */
  attachments?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ConfigResponse {
  config: GatewayConfig;
  source: 'db' | 'file' | 'defaults' | 'memory';
  persistent: boolean;
}

type Tab = 'settings' | 'json';

export function GatewayConfigPanel() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [source, setSource] = useState<string>('');
  const [persistent, setPersistent] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>('settings');

  // Settings tab state
  const [corsOrigin, setCorsOrigin] = useState('');
  const [autoProvision, setAutoProvision] = useState('');
  const [presetsText, setPresetsText] = useState('');
  const [presetsError, setPresetsError] = useState('');
  const [channelPackagesText, setChannelPackagesText] = useState('');

  // JSON tab state
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');

  const applyConfig = useCallback((cfg: GatewayConfig) => {
    setConfig(cfg);
    setCorsOrigin(cfg.cors?.origin ?? '*');
    setAutoProvision(cfg.autoProvisionSandbox ?? '');
    setPresetsText(JSON.stringify(cfg.sandboxPresets ?? {}, null, 2));
    setPresetsError('');
    setChannelPackagesText((cfg.channelPackages ?? []).join('\n'));
    // The JSON tab strips `ui` to mirror what the server actually accepts
    // (it rejects ui: false). Keep the rest verbatim so users can see and
    // edit fields the Settings form doesn't expose (e.g. attachments).
    const forJson = { ...cfg };
    delete forJson.ui;
    setJsonText(JSON.stringify(forJson, null, 2));
    setJsonError('');
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api<ConfigResponse>('/api/admin/gateway/config');
      applyConfig(data.config);
      setSource(data.source);
      setPersistent(data.persistent);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [applyConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  const buildFromSettings = (): GatewayConfig | null => {
    let presets: Record<string, unknown>;
    try {
      const parsed = JSON.parse(presetsText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('sandboxPresets must be a JSON object');
      }
      presets = parsed as Record<string, unknown>;
      setPresetsError('');
    } catch (err) {
      setPresetsError((err as Error).message);
      return null;
    }

    const channelPackages = channelPackagesText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Carry over any other-tab fields (e.g. attachments) the form doesn't
    // expose, so a Settings save doesn't drop them.
    const next: GatewayConfig = {
      ...(config ?? {}),
      cors: { origin: corsOrigin },
      sandboxPresets: presets as GatewayConfig['sandboxPresets'],
      autoProvisionSandbox: autoProvision.trim() === '' ? null : autoProvision.trim(),
      channelPackages,
    };
    delete next.ui;
    return next;
  };

  const buildFromJson = (): GatewayConfig | null => {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('config must be a JSON object');
      }
      const next = parsed as GatewayConfig;
      delete next.ui;
      setJsonError('');
      return next;
    } catch (err) {
      setJsonError((err as Error).message);
      return null;
    }
  };

  const save = async () => {
    setError('');
    setInfo('');
    const next = tab === 'json' ? buildFromJson() : buildFromSettings();
    if (!next) return;

    setSaving(true);
    try {
      const result = await api<{ ok: boolean; config: GatewayConfig; restart_required: boolean }>(
        '/api/admin/gateway/config',
        { method: 'PUT', body: next },
      );
      applyConfig(result.config);
      setSource('db');
      setInfo(result.restart_required
        ? 'Saved. Restart the gateway for the change to take effect.'
        : 'Saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    // Re-derive the destination tab from the current applied config so
    // unsaved edits in the source tab don't silently leak across. Users
    // who want their edits preserved should save first.
    if (config) applyConfig(config);
    setTab(next);
  };

  if (!config) {
    return (
      <div className="panel">
        {error ? <p>{error}</p> : <p>Loading...</p>}
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Gateway Config</h2>
      <p style={{ opacity: 0.7, fontSize: '0.9em' }}>
        Source: <code>{source}</code>
        {!persistent && ' — set DATABASE_URL to persist changes'}
        {' · '}Changes require a gateway restart to take effect.
      </p>

      <div className="usage-main-tabs" role="tablist" aria-label="Config view">
        <button
          role="tab"
          aria-selected={tab === 'settings'}
          className={`usage-main-tab${tab === 'settings' ? ' usage-main-tab--active' : ''}`}
          onClick={() => switchTab('settings')}
        >
          Settings
        </button>
        <button
          role="tab"
          aria-selected={tab === 'json'}
          className={`usage-main-tab${tab === 'json' ? ' usage-main-tab--active' : ''}`}
          onClick={() => switchTab('json')}
        >
          JSON
        </button>
      </div>

      {error && <p style={{ color: 'var(--red)' }}>{error}</p>}
      {info && <p style={{ color: 'var(--green, #2a8)' }}>{info}</p>}

      {tab === 'settings' && (
        <div style={{ maxWidth: 640 }}>
          <label className="field">
            <span className="field__label">CORS origin</span>
            <input
              type="text"
              className="field__input"
              value={corsOrigin}
              onChange={(e) => setCorsOrigin(e.target.value)}
              placeholder="*"
            />
          </label>

          <label className="field">
            <span className="field__label">Auto-provision sandbox preset</span>
            <input
              type="text"
              className="field__input"
              value={autoProvision}
              onChange={(e) => setAutoProvision(e.target.value)}
              placeholder="(empty = disabled)"
            />
          </label>

          <label className="field">
            <span className="field__label">Channel packages</span>
            <textarea
              className="field__input"
              value={channelPackagesText}
              onChange={(e) => setChannelPackagesText(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder="@openhermit/channel-wechat"
              style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
            />
            <span style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              One npm package name per line (or comma-separated). Each must default-export a
              ChannelManifest. Install with <code>npm install &lt;pkg&gt;</code> in the gateway
              install dir, then list it here. Restart required.
            </span>
          </label>

          <label className="field">
            <span className="field__label">Sandbox presets (JSON)</span>
            <textarea
              className="field__input"
              value={presetsText}
              onChange={(e) => setPresetsText(e.target.value)}
              rows={14}
              spellCheck={false}
              style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
            />
            {presetsError && (
              <span style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{presetsError}</span>
            )}
          </label>
        </div>
      )}

      {tab === 'json' && (
        <div style={{ maxWidth: 900 }}>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
            Full gateway config as JSON. Edit any field — including ones not exposed in
            Settings (e.g. <code>attachments.storage</code>) — and save. Switching tabs
            discards unsaved edits in this view.
          </p>
          <textarea
            className="field__input"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            rows={28}
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: '0.85rem', width: '100%' }}
          />
          {jsonError && (
            <p style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4 }}>{jsonError}</p>
          )}
        </div>
      )}

      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
        <button className="btn btn--primary" onClick={save} disabled={saving || !persistent}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn--ghost" onClick={() => void load()} disabled={saving}>
          Reload
        </button>
      </div>
    </div>
  );
}
