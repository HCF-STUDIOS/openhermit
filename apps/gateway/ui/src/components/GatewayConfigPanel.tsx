import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface GatewayConfig {
  ui?: boolean;
  cors?: { origin?: string };
  sandboxPresets?: Record<string, { type: string; config: Record<string, unknown> }>;
  autoProvisionSandbox?: string | null;
}

interface ConfigResponse {
  config: GatewayConfig;
  source: 'db' | 'file' | 'defaults' | 'memory';
  persistent: boolean;
}

export function GatewayConfigPanel() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [source, setSource] = useState<string>('');
  const [persistent, setPersistent] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [saving, setSaving] = useState(false);

  const [corsOrigin, setCorsOrigin] = useState('');
  const [autoProvision, setAutoProvision] = useState('');
  const [presetsText, setPresetsText] = useState('');
  const [presetsError, setPresetsError] = useState('');

  const applyConfig = useCallback((cfg: GatewayConfig) => {
    setConfig(cfg);
    setCorsOrigin(cfg.cors?.origin ?? '*');
    setAutoProvision(cfg.autoProvisionSandbox ?? '');
    setPresetsText(JSON.stringify(cfg.sandboxPresets ?? {}, null, 2));
    setPresetsError('');
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

  const save = async () => {
    setError('');
    setInfo('');
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
      return;
    }

    const next: GatewayConfig = {
      ...(config ?? {}),
      cors: { origin: corsOrigin },
      sandboxPresets: presets as GatewayConfig['sandboxPresets'],
      autoProvisionSandbox: autoProvision.trim() === '' ? null : autoProvision.trim(),
    };
    // Never send `ui: false` — server rejects it anyway.
    delete next.ui;

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
      {error && <p style={{ color: 'var(--red)' }}>{error}</p>}
      {info && <p style={{ color: 'var(--green, #2a8)' }}>{info}</p>}

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
