import { useEffect, useState } from 'react';
import {
  fetchAgentConfig,
  putAgentConfig,
  fetchAgentSecrets,
  type AgentConfig,
} from '../api';
import { useTranslation } from '../i18n';

const ELEVENLABS_KEY = 'ELEVENLABS_API_KEY';

interface SttConfig {
  provider: 'elevenlabs';
  model_id?: string;
}

interface TtsConfig {
  provider: 'elevenlabs';
  voice_id?: string;
  model_id?: string;
  speed?: number;
}

interface VoiceConfig {
  stt?: SttConfig;
  tts?: TtsConfig;
}

const readVoice = (config: AgentConfig | null): VoiceConfig =>
  (config?.voice as VoiceConfig | undefined) ?? {};

export function VoicePanel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // STT form state
  const [sttEnabled, setSttEnabled] = useState(false);
  const [sttModelId, setSttModelId] = useState('');

  // TTS form state
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsVoiceId, setTtsVoiceId] = useState('');
  const [ttsModelId, setTtsModelId] = useState('');
  const [ttsSpeed, setTtsSpeed] = useState('');

  useEffect(() => {
    Promise.all([
      fetchAgentConfig(),
      fetchAgentSecrets().catch(() => ({} as Record<string, string>)),
    ])
      .then(([c, sec]) => {
        setConfig(c);
        setSecrets(sec);
        const voice = readVoice(c);
        setSttEnabled(Boolean(voice.stt));
        setSttModelId(voice.stt?.model_id ?? '');
        setTtsEnabled(Boolean(voice.tts));
        setTtsVoiceId(voice.tts?.voice_id ?? '');
        setTtsModelId(voice.tts?.model_id ?? '');
        setTtsSpeed(
          voice.tts?.speed !== undefined ? String(voice.tts.speed) : '',
        );
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const hasKey = Boolean(secrets[ELEVENLABS_KEY]);

  const buildVoice = (): VoiceConfig => {
    const next: VoiceConfig = {};
    if (sttEnabled) {
      const stt: SttConfig = { provider: 'elevenlabs' };
      const trimmed = sttModelId.trim();
      if (trimmed) stt.model_id = trimmed;
      next.stt = stt;
    }
    if (ttsEnabled) {
      const tts: TtsConfig = { provider: 'elevenlabs' };
      const trimmedVoice = ttsVoiceId.trim();
      const trimmedModel = ttsModelId.trim();
      const trimmedSpeed = ttsSpeed.trim();
      if (trimmedVoice) tts.voice_id = trimmedVoice;
      if (trimmedModel) tts.model_id = trimmedModel;
      if (trimmedSpeed) {
        const n = Number(trimmedSpeed);
        if (Number.isFinite(n) && n > 0) tts.speed = n;
      }
      next.tts = tts;
    }
    return next;
  };

  const handleSave = async () => {
    if (!config) return;
    if (ttsSpeed.trim()) {
      const n = Number(ttsSpeed.trim());
      if (!Number.isFinite(n) || n <= 0) {
        setError(t('voice.speedInvalid'));
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      const voice = buildVoice();
      const next: AgentConfig = { ...config };
      if (voice.stt || voice.tts) {
        next.voice = voice;
      } else {
        delete (next as Record<string, unknown>).voice;
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

  const currentVoice = readVoice(config);
  const currentStt = currentVoice.stt;
  const currentTts = currentVoice.tts;
  const dirty =
    config != null && (
      sttEnabled !== Boolean(currentStt)
      || sttModelId !== (currentStt?.model_id ?? '')
      || ttsEnabled !== Boolean(currentTts)
      || ttsVoiceId !== (currentTts?.voice_id ?? '')
      || ttsModelId !== (currentTts?.model_id ?? '')
      || ttsSpeed !== (currentTts?.speed !== undefined ? String(currentTts.speed) : '')
    );

  if (loading) return <p className="manage__empty">{t('common.loading')}</p>;
  if (error && !config) return <p className="manage__empty">{error}</p>;
  if (!config) return null;

  return (
    <div className="basic-panel">
      <div className="basic-panel__intro">
        <p className="eyebrow">{t('voice.eyebrow')}</p>
        <p className="basic-panel__hint">{t('voice.hint')}</p>
      </div>

      {hasKey ? (
        <p className="basic-panel__hint basic-panel__hint--ok">
          {t('voice.apiKeySet')}<code>{ELEVENLABS_KEY}</code>
        </p>
      ) : (
        <p className="basic-panel__hint basic-panel__hint--warn">
          {t('voice.apiKeyMissingPrefix')}<code>{ELEVENLABS_KEY}</code>{t('voice.apiKeyMissingSuffix')}
        </p>
      )}

      {/* ── STT ─────────────────────────────────────────────────────── */}
      <div className="basic-panel__field">
        <label>
          <input
            type="checkbox"
            checked={sttEnabled}
            onChange={(e) => setSttEnabled(e.target.checked)}
          />
          {' '}{t('voice.enableStt')}
        </label>
        <p className="basic-panel__hint">{t('voice.sttHint')}</p>
      </div>

      {sttEnabled && (
        <div className="basic-panel__field">
          <label htmlFor="voice-stt-model">{t('voice.sttModelLabel')}</label>
          <input
            id="voice-stt-model"
            type="text"
            value={sttModelId}
            onChange={(e) => setSttModelId(e.target.value)}
            placeholder={t('voice.sttModelPlaceholder')}
            autoComplete="off"
          />
          <p className="basic-panel__hint">
            {t('voice.sttModelHintPrefix')}<code>scribe_v1</code>{t('voice.sttModelHintSuffix')}
          </p>
        </div>
      )}

      {/* ── TTS ─────────────────────────────────────────────────────── */}
      <div className="basic-panel__field">
        <label>
          <input
            type="checkbox"
            checked={ttsEnabled}
            onChange={(e) => setTtsEnabled(e.target.checked)}
          />
          {' '}{t('voice.enableTts')}
        </label>
        <p className="basic-panel__hint">{t('voice.ttsHint')}</p>
      </div>

      {ttsEnabled && (
        <>
          <div className="basic-panel__field">
            <label htmlFor="voice-tts-voice">{t('voice.ttsVoiceLabel')}</label>
            <input
              id="voice-tts-voice"
              type="text"
              value={ttsVoiceId}
              onChange={(e) => setTtsVoiceId(e.target.value)}
              placeholder={t('voice.ttsVoicePlaceholder')}
              autoComplete="off"
            />
            <p className="basic-panel__hint">
              {t('voice.ttsVoiceHintPrefix')}<code>/v1/voices</code>{t('voice.ttsVoiceHintSuffix')}
            </p>
          </div>

          <div className="basic-panel__field">
            <label htmlFor="voice-tts-model">{t('voice.ttsModelLabel')}</label>
            <input
              id="voice-tts-model"
              type="text"
              value={ttsModelId}
              onChange={(e) => setTtsModelId(e.target.value)}
              placeholder={t('voice.ttsModelPlaceholder')}
              autoComplete="off"
            />
            <p className="basic-panel__hint">{t('voice.ttsModelHint')}</p>
          </div>

          <div className="basic-panel__field">
            <label htmlFor="voice-tts-speed">{t('voice.ttsSpeedLabel')}</label>
            <input
              id="voice-tts-speed"
              type="text"
              inputMode="decimal"
              value={ttsSpeed}
              onChange={(e) => setTtsSpeed(e.target.value)}
              placeholder={t('voice.ttsSpeedPlaceholder')}
              autoComplete="off"
            />
            <p className="basic-panel__hint">{t('voice.ttsSpeedHint')}</p>
          </div>
        </>
      )}

      {error && config && <p className="basic-panel__error">{error}</p>}

      <div className="basic-panel__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || !dirty}
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
