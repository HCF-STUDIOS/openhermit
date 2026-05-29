import { useEffect, useMemo, useState } from 'react';
import {
  fetchAgentConfig,
  putAgentConfig,
  fetchProviderCatalog,
  fetchAgentSecrets,
  type AgentConfig,
  type ProviderCatalogEntry,
} from '../api';
import { useTranslation } from '../i18n';

/**
 * Convention pi-ai uses to look up an API key for a provider:
 * `<UPPERCASE_NAME>_API_KEY`, with non-alphanumerics replaced by `_`.
 * A few providers have curated alternate names (e.g. google).
 */
const candidateSecretNames = (provider: string): string[] => {
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
  const extras: Record<string, string[]> = {
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  };
  return extras[provider] ?? [upper];
};

const providerHasKey = (
  provider: string,
  secrets: Record<string, string>,
): boolean => candidateSecretNames(provider).some((name) => Boolean(secrets[name]));

type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high';

const THINKING_LEVELS: Thinking[] = ['off', 'minimal', 'low', 'medium', 'high'];
const CUSTOM = '__custom__';

export function BasicPanel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState('');
  const [providerMode, setProviderMode] = useState<'preset' | 'custom'>('preset');
  const [model, setModel] = useState('');
  const [modelMode, setModelMode] = useState<'preset' | 'custom'>('preset');
  const [thinking, setThinking] = useState<Thinking | ''>('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchAgentConfig(),
      fetchProviderCatalog(),
      fetchAgentSecrets().catch(() => ({} as Record<string, string>)),
    ])
      .then(([c, cat, sec]) => {
        setConfig(c);
        setCatalog(cat);
        setSecrets(sec);
        const initialProvider = c.model?.provider ?? '';
        setProvider(initialProvider);
        // If the existing provider isn't in the catalog, drop the user
        // straight into custom mode so they can edit the free-text value.
        const isKnownProvider = cat.some((e) => e.provider === initialProvider);
        setProviderMode(isKnownProvider || !initialProvider ? 'preset' : 'custom');
        const initialModel = c.model?.model ?? '';
        setModel(initialModel);
        const knownModelsForProvider = cat.find((e) => e.provider === initialProvider)?.models ?? [];
        const isKnownModel = knownModelsForProvider.some((m) => m.id === initialModel);
        setModelMode(isKnownModel || !initialModel ? 'preset' : 'custom');
        setThinking((c.model?.thinking as Thinking) ?? '');
        setBaseUrl(c.model?.base_url ?? '');
        setApi(c.model?.api ?? '');
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const modelsForProvider = useMemo(() => {
    return catalog.find((e) => e.provider === provider)?.models ?? [];
  }, [catalog, provider]);

  const dirty = config != null && (
    provider !== (config.model?.provider ?? '')
    || model !== (config.model?.model ?? '')
    || thinking !== ((config.model?.thinking as Thinking | undefined) ?? '')
    || baseUrl !== (config.model?.base_url ?? '')
    || api !== (config.model?.api ?? '')
  );

  const selectedModelEntry = useMemo(() => {
    const entry = catalog.find((p) => p.provider === provider);
    return entry?.models.find((m) => m.id === model);
  }, [catalog, provider, model]);

  const handleSave = async () => {
    if (!config || !provider.trim() || !model.trim()) return;
    setSaving(true);
    setError('');
    try {
      const trimmedBaseUrl = baseUrl.trim();
      const trimmedApi = api.trim();
      const next: AgentConfig = {
        ...config,
        model: {
          ...config.model,
          provider: provider.trim(),
          model: model.trim(),
          ...(thinking ? { thinking } : {}),
          ...(trimmedBaseUrl ? { base_url: trimmedBaseUrl } : {}),
          ...(trimmedApi ? { api: trimmedApi } : {}),
        },
      };
      if (!thinking && next.model.thinking) {
        delete (next.model as Record<string, unknown>).thinking;
      }
      if (!trimmedBaseUrl && next.model.base_url) {
        delete (next.model as Record<string, unknown>).base_url;
      }
      if (!trimmedApi && next.model.api) {
        delete (next.model as Record<string, unknown>).api;
      }
      await putAgentConfig(next);
      setConfig(next);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="manage__empty">{t('common.loading')}</p>;
  if (error && !config) return <p className="manage__empty">{error}</p>;
  if (!config) return null;

  return (
    <div className="basic-panel">
      <div className="basic-panel__intro">
        <p className="eyebrow">{t('basic.eyebrow')}</p>
        <p className="basic-panel__hint">{t('basic.hint')}</p>
      </div>

      <div className="basic-panel__field">
        <label htmlFor="basic-provider">{t('basic.provider')}</label>
        {providerMode === 'preset' ? (
          <select
            id="basic-provider"
            value={catalog.some((e) => e.provider === provider) ? provider : ''}
            onChange={(e) => {
              const value = e.target.value;
              if (value === CUSTOM) {
                setProviderMode('custom');
                return;
              }
              setProvider(value);
              // When switching provider via the dropdown, clear the model
              // so the user picks one from the new provider's list, and
              // return the model field to preset mode in case they were
              // previously in custom mode.
              if (value !== provider) {
                setModel('');
                setModelMode('preset');
              }
            }}
          >
            <option value="">{t('basic.pickProvider')}</option>
            {catalog.map((e) => (
              <option key={e.provider} value={e.provider}>
                {t('basic.providerOptionCounts', {
                  flag: providerHasKey(e.provider, secrets) ? '✓' : '✗',
                  provider: e.provider,
                  count: String(e.models.length),
                })}
              </option>
            ))}
            <option value={CUSTOM}>{t('basic.providerCustom')}</option>
          </select>
        ) : (
          <div className="basic-panel__custom-row">
            <input
              id="basic-provider"
              type="text"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder={t('basic.providerCustomPlaceholder')}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setProviderMode('preset');
                if (!catalog.some((e) => e.provider === provider)) {
                  setProvider('');
                  setModel('');
                }
              }}
            >
              {t('basic.pickFromList')}
            </button>
          </div>
        )}
        {provider && (
          providerHasKey(provider, secrets) ? (
            <p className="basic-panel__hint basic-panel__hint--ok">
              {t('basic.apiKeySet', { name: candidateSecretNames(provider).find((n) => secrets[n]) ?? '' })}
            </p>
          ) : (
            <p className="basic-panel__hint basic-panel__hint--warn">
              {t('basic.apiKeyMissingPrefix')}<code>{candidateSecretNames(provider)[0]}</code>{t('basic.apiKeyMissingSuffix')}
            </p>
          )
        )}
      </div>

      {providerMode === 'custom' && (
        <>
          <div className="basic-panel__field">
            <label htmlFor="basic-base-url">{t('basic.baseUrl')}</label>
            <input
              id="basic-base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
            />
            <p className="basic-panel__hint">{t('basic.baseUrlHint')}</p>
          </div>
          <div className="basic-panel__field">
            <label htmlFor="basic-api">{t('basic.apiProtocol')}</label>
            <select
              id="basic-api"
              value={api}
              onChange={(e) => setApi(e.target.value)}
            >
              <option value="">{t('basic.pickProtocol')}</option>
              <option value="openai-completions">openai-completions</option>
              <option value="anthropic-messages">anthropic-messages</option>
            </select>
            <p className="basic-panel__hint">{t('basic.apiProtocolHint')}</p>
          </div>
        </>
      )}

      <div className="basic-panel__field">
        <label htmlFor="basic-model">{t('basic.model')}</label>
        {modelMode === 'preset' && modelsForProvider.length > 0 ? (
          <select
            id="basic-model"
            value={modelsForProvider.some((m) => m.id === model) ? model : ''}
            onChange={(e) => {
              const value = e.target.value;
              if (value === CUSTOM) {
                setModelMode('custom');
                return;
              }
              setModel(value);
            }}
          >
            <option value="">{t('basic.pickModel')}</option>
            {modelsForProvider.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
            <option value={CUSTOM}>{t('basic.providerCustom')}</option>
          </select>
        ) : (
          <div className="basic-panel__custom-row">
            <input
              id="basic-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={modelsForProvider[0]?.id ?? 'e.g. google/gemini-3-flash-preview'}
              autoComplete="off"
            />
            {modelsForProvider.length > 0 && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setModelMode('preset');
                  if (!modelsForProvider.some((m) => m.id === model)) setModel('');
                }}
              >
                {t('basic.pickFromList')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="basic-panel__field">
        <label htmlFor="basic-thinking">{t('basic.thinking')}</label>
        <select
          id="basic-thinking"
          value={thinking}
          onChange={(e) => setThinking(e.target.value as Thinking | '')}
        >
          <option value="">{t('basic.thinkingDefault')}</option>
          {THINKING_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>{lvl}</option>
          ))}
        </select>
        {selectedModelEntry?.reasoning && thinking === 'off' && (
          <p className="basic-panel__hint basic-panel__hint--warn">
            {t('basic.thinkingOffWarning', { model })}
          </p>
        )}
        {selectedModelEntry?.reasoning && thinking === '' && (
          <p className="basic-panel__hint">
            {t('basic.thinkingDefaultNote', { model })}
          </p>
        )}
      </div>

      {error && config && <p className="basic-panel__error">{error}</p>}

      <div className="basic-panel__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || !dirty || !provider.trim() || !model.trim()}
          onClick={() => void handleSave()}
        >
          {t(saving ? 'common.saving' : 'common.save')}
        </button>
        {savedAt && !dirty && (
          <span className="basic-panel__saved">{t('basic.savedAt', { time: savedAt })}</span>
        )}
      </div>
    </div>
  );
}
