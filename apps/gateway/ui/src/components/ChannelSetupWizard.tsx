import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';

export interface SetupStateAwaitingInput {
  kind: 'awaiting_user_input';
  instructions?: string;
  fields: Array<{ name: string; label: string; type?: 'text' | 'password'; placeholder?: string }>;
}
export interface SetupStateAwaitingExternal {
  kind: 'awaiting_external';
  instructions?: string;
  qrText?: string;
  redirectUrl?: string;
  pollIntervalMs?: number;
}
export interface SetupStateDone { kind: 'done'; config: Record<string, unknown> }
export interface SetupStateError { kind: 'error'; message: string }
export type SetupState = SetupStateAwaitingInput | SetupStateAwaitingExternal | SetupStateDone | SetupStateError;
export interface SetupResponse { sessionId: string; state: SetupState }

interface Props {
  agentId: string;
  channelType: string;
  displayName: string;
  onDone: (config: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Drives `ChannelManifest.setup` through the gateway's HTTP routes. The
 * UI is identical to the web/ui version, but uses the admin-token `api`
 * helper rather than the user-scoped `apiFetch`.
 */
export function ChannelSetupWizard({ agentId, channelType, displayName, onDone, onCancel }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const [formInput, setFormInput] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const apply = useCallback((resp: SetupResponse) => {
    setSessionId(resp.sessionId);
    setState(resp.state);
    setError('');
    if (resp.state.kind === 'awaiting_user_input') {
      const initial: Record<string, string> = {};
      for (const f of resp.state.fields) initial[f.name] = '';
      setFormInput(initial);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        const resp = await api<SetupResponse>(
          `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/begin`,
          { method: 'POST', body: {} },
        );
        if (cancelledRef.current) return;
        apply(resp);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    return () => {
      cancelledRef.current = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [agentId, channelType, apply]);

  useEffect(() => {
    if (!sessionId || !state || state.kind !== 'awaiting_external') return;
    const interval = state.pollIntervalMs ?? 2000;
    const tick = async (): Promise<void> => {
      try {
        const resp = await api<SetupResponse>(
          `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
        );
        if (cancelledRef.current) return;
        apply(resp);
      } catch (err) {
        if (cancelledRef.current) return;
        setError((err as Error).message);
      }
    };
    pollTimerRef.current = setTimeout(() => { void tick(); }, interval);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [sessionId, state, agentId, channelType, apply]);

  useEffect(() => {
    if (state?.kind === 'done') {
      void onDone(state.config);
    }
  }, [state, onDone]);

  const handleCancel = useCallback(async () => {
    if (sessionId) {
      try {
        await api(
          `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
          { method: 'DELETE' },
        );
      } catch { /* ignore */ }
    }
    onCancel();
  }, [sessionId, agentId, channelType, onCancel]);

  const handleSubmit = async (): Promise<void> => {
    if (!sessionId) return;
    setSubmitting(true);
    try {
      const resp = await api<SetupResponse>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}/setup/${encodeURIComponent(sessionId)}`,
        { method: 'POST', body: formInput },
      );
      apply(resp);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ color: 'var(--muted)' }}>
        Linking <strong>{displayName}</strong>. The wizard will close automatically when linking completes.
      </p>
      {error && <p className="config-error">{error}</p>}
      {!state && !error && <p style={{ color: 'var(--muted)' }}>Starting…</p>}
      {state?.kind === 'awaiting_external' && <ExternalStep state={state} />}
      {state?.kind === 'awaiting_user_input' && (
        <div className="field">
          {state.instructions && <p style={{ color: 'var(--muted)' }}>{state.instructions}</p>}
          {state.fields.map((f) => (
            <label className="field" key={f.name}>
              <span className="field__label">{f.label}</span>
              <input
                className="field__input"
                type={f.type === 'password' ? 'password' : 'text'}
                placeholder={f.placeholder ?? ''}
                value={formInput[f.name] ?? ''}
                onChange={(e) => setFormInput({ ...formInput, [f.name]: e.target.value })}
                autoComplete="off"
              />
            </label>
          ))}
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      )}
      {state?.kind === 'error' && <p className="config-error">{state.message}</p>}
      {state?.kind === 'done' && <p style={{ color: 'var(--muted)' }}>Linked. Saving…</p>}
      <div className="dialog__actions">
        <button className="btn btn--ghost" type="button" onClick={() => void handleCancel()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExternalStep({ state }: { state: SetupStateAwaitingExternal }) {
  return (
    <>
      {state.instructions && <p style={{ color: 'var(--muted)' }}>{state.instructions}</p>}
      {state.qrText && <QrBox text={state.qrText} />}
      {state.redirectUrl && (
        <p>
          <a href={state.redirectUrl} target="_blank" rel="noreferrer">Open login page ↗</a>
        </p>
      )}
      <p style={{ color: 'var(--muted)' }}>Waiting for confirmation…</p>
    </>
  );
}

function QrBox({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(text, { type: 'svg', margin: 1, width: 220 })
      .then((s) => { if (live) setSvg(s); })
      .catch((e: unknown) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [text]);
  if (err) return <p className="config-error">QR render failed: {err}</p>;
  if (!svg) return <p style={{ color: 'var(--muted)' }}>Rendering QR…</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div dangerouslySetInnerHTML={{ __html: svg }} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
      <code style={{ fontSize: 11, wordBreak: 'break-all', maxWidth: 240, textAlign: 'center', opacity: 0.7 }}>
        {text}
      </code>
    </div>
  );
}
