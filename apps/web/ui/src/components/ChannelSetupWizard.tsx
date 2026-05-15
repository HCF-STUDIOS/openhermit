import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  beginChannelSetup,
  cancelChannelSetup,
  pollChannelSetup,
  submitChannelSetup,
  type ChannelSetupResponse,
  type ChannelSetupState,
} from '../api';

interface Props {
  channelType: string;
  displayName: string;
  /** Called when the wizard reaches `done` and we hold the final config. */
  onDone: (config: Record<string, unknown>) => void | Promise<void>;
  /** Called when the user clicks "Cancel" or after an error is dismissed. */
  onCancel: () => void;
}

/**
 * Generic UI for `ChannelManifest.setup`. Drives the
 * `begin → poll/submit → done|error` state machine, renders a QR code for
 * `awaiting_external` states with `qrText`, and surfaces an input form for
 * `awaiting_user_input` states. Channel-specific behavior lives entirely
 * in the manifest's `setup` handlers — this component just shuttles bytes.
 */
export function ChannelSetupWizard({ channelType, displayName, onDone, onCancel }: Props): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<ChannelSetupState | null>(null);
  const [error, setError] = useState('');
  const [formInput, setFormInput] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const apply = useCallback((resp: ChannelSetupResponse) => {
    setSessionId(resp.sessionId);
    setState(resp.state);
    setError('');
    if (resp.state.kind === 'awaiting_user_input') {
      const initial: Record<string, string> = {};
      for (const f of resp.state.fields) initial[f.name] = '';
      setFormInput(initial);
    }
  }, []);

  // Kick off setup on mount.
  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        const resp = await beginChannelSetup(channelType);
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
  }, [channelType, apply]);

  // Poll while awaiting an external event (QR scan, OAuth callback).
  useEffect(() => {
    if (!sessionId || !state || state.kind !== 'awaiting_external') return;
    const interval = state.pollIntervalMs ?? 2000;
    const tick = async (): Promise<void> => {
      try {
        const resp = await pollChannelSetup(channelType, sessionId);
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
  }, [sessionId, state, channelType, apply]);

  // Hand off to the parent on `done`.
  useEffect(() => {
    if (state?.kind === 'done') {
      void onDone(state.config);
    }
  }, [state, onDone]);

  const handleCancel = useCallback(async () => {
    if (sessionId) {
      try { await cancelChannelSetup(channelType, sessionId); } catch { /* ignore */ }
    }
    onCancel();
  }, [sessionId, channelType, onCancel]);

  const handleSubmit = async (): Promise<void> => {
    if (!sessionId) return;
    setSubmitting(true);
    try {
      const resp = await submitChannelSetup(channelType, sessionId, formInput);
      apply(resp);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="manage__field" style={{ gap: 12 }}>
      <p className="manage__hint">
        Linking <strong>{displayName}</strong>. The wizard will close automatically when linking completes.
      </p>
      {error && <p className="manage__error">{error}</p>}
      {!state && !error && <p className="manage__empty">Starting…</p>}
      {state?.kind === 'awaiting_external' && (
        <ExternalStep state={state} />
      )}
      {state?.kind === 'awaiting_user_input' && (
        <div className="manage__field">
          {state.instructions && <p className="manage__hint">{state.instructions}</p>}
          {state.fields.map((f) => (
            <div className="manage__field" key={f.name}>
              <label className="manage__field-label">{f.label}</label>
              <input
                className="manage__field-input"
                type={f.type === 'password' ? 'password' : 'text'}
                placeholder={f.placeholder ?? ''}
                value={formInput[f.name] ?? ''}
                onChange={(e) => setFormInput({ ...formInput, [f.name]: e.target.value })}
                autoComplete="off"
              />
            </div>
          ))}
          <button
            className="btn btn--primary"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      )}
      {state?.kind === 'error' && (
        <p className="manage__error">{state.message}</p>
      )}
      {state?.kind === 'done' && (
        <p className="manage__hint">Linked. Saving…</p>
      )}
      <div className="manage__card-actions">
        <button className="btn btn--sm btn--ghost" onClick={() => void handleCancel()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExternalStep({ state }: { state: Extract<ChannelSetupState, { kind: 'awaiting_external' }> }): JSX.Element {
  return (
    <>
      {state.instructions && <p className="manage__hint">{state.instructions}</p>}
      {state.qrText && <QrBox text={state.qrText} />}
      {state.redirectUrl && (
        <p className="manage__hint">
          <a href={state.redirectUrl} target="_blank" rel="noreferrer">
            Open login page ↗
          </a>
        </p>
      )}
      <p className="manage__empty">Waiting for confirmation…</p>
    </>
  );
}

function QrBox({ text }: { text: string }): JSX.Element {
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(text, { type: 'svg', margin: 1, width: 220 })
      .then((s) => { if (live) setSvg(s); })
      .catch((e: unknown) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [text]);
  if (err) return <p className="manage__error">QR render failed: {err}</p>;
  if (!svg) return <p className="manage__empty">Rendering QR…</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div dangerouslySetInnerHTML={{ __html: svg }} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
      <code style={{ fontSize: 11, wordBreak: 'break-all', maxWidth: 240, textAlign: 'center', opacity: 0.7 }}>
        {text}
      </code>
    </div>
  );
}
