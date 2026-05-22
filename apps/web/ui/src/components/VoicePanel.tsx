import { useEffect, useState } from 'react';
import {
  fetchAgentConfig,
  putAgentConfig,
  fetchAgentSecrets,
  type AgentConfig,
} from '../api';

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
        setError('Speed must be a positive number.');
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

  if (loading) return <p className="manage__empty">Loading…</p>;
  if (error && !config) return <p className="manage__empty">{error}</p>;
  if (!config) return null;

  return (
    <div className="basic-panel">
      <div className="basic-panel__intro">
        <p className="eyebrow">Voice</p>
        <p className="basic-panel__hint">
          Speech-to-text (inbound voice messages) and text-to-speech (outbound
          replies). Each direction is independent — enable only what you need.
          Only ElevenLabs is supported in this build.
        </p>
      </div>

      {hasKey ? (
        <p className="basic-panel__hint basic-panel__hint--ok">
          ✓ API key set: <code>{ELEVENLABS_KEY}</code>
        </p>
      ) : (
        <p className="basic-panel__hint basic-panel__hint--warn">
          ✗ No API key. Add <code>{ELEVENLABS_KEY}</code> in the Secrets tab
          before enabling voice.
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
          {' '}Enable speech-to-text (STT)
        </label>
        <p className="basic-panel__hint">
          Inbound voice messages from channels are transcribed before the agent
          sees them.
        </p>
      </div>

      {sttEnabled && (
        <div className="basic-panel__field">
          <label htmlFor="voice-stt-model">STT model id</label>
          <input
            id="voice-stt-model"
            type="text"
            value={sttModelId}
            onChange={(e) => setSttModelId(e.target.value)}
            placeholder="scribe_v1 (default)"
            autoComplete="off"
          />
          <p className="basic-panel__hint">
            Optional. ElevenLabs Scribe model id. Leave blank for the default
            (<code>scribe_v1</code>).
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
          {' '}Enable text-to-speech (TTS)
        </label>
        <p className="basic-panel__hint">
          Final replies are synthesized and sent back as audio on channels that
          support voice.
        </p>
      </div>

      {ttsEnabled && (
        <>
          <div className="basic-panel__field">
            <label htmlFor="voice-tts-voice">TTS voice id</label>
            <input
              id="voice-tts-voice"
              type="text"
              value={ttsVoiceId}
              onChange={(e) => setTtsVoiceId(e.target.value)}
              placeholder="21m00Tcm4TlvDq8ikWAM (Rachel, default)"
              autoComplete="off"
            />
            <p className="basic-panel__hint">
              Optional. The ElevenLabs voice id (from{' '}
              <code>/v1/voices</code>). Leave blank to use the built-in default
              voice.
            </p>
          </div>

          <div className="basic-panel__field">
            <label htmlFor="voice-tts-model">TTS model id</label>
            <input
              id="voice-tts-model"
              type="text"
              value={ttsModelId}
              onChange={(e) => setTtsModelId(e.target.value)}
              placeholder="eleven_multilingual_v2 (default)"
              autoComplete="off"
            />
            <p className="basic-panel__hint">
              Optional. ElevenLabs TTS model id. Leave blank for the default.
            </p>
          </div>

          <div className="basic-panel__field">
            <label htmlFor="voice-tts-speed">Speed</label>
            <input
              id="voice-tts-speed"
              type="text"
              inputMode="decimal"
              value={ttsSpeed}
              onChange={(e) => setTtsSpeed(e.target.value)}
              placeholder="1.0 (default)"
              autoComplete="off"
            />
            <p className="basic-panel__hint">
              Optional playback rate multiplier; ~0.7–1.2 is typical. Leave
              blank for the provider default.
            </p>
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
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && !dirty && (
          <span className="basic-panel__saved">Saved at {savedAt}</span>
        )}
      </div>
    </div>
  );
}
