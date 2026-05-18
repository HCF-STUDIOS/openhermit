import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { uploadAttachment, type SessionAttachment } from '../api';

interface Props {
  onSend: (text: string, attachments?: SessionAttachment[]) => void;
  disabled: boolean;
  /** Turn in flight — show Stop instead of Send. */
  running?: boolean;
  onInterrupt?: () => void;
  /** Active session id. Required for uploads; when null, file picker hides. */
  sessionId: string | null;
}

interface PendingUpload {
  /** Stable key so React can identify the row across renders. */
  key: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  attachment?: SessionAttachment;
  error?: string;
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export function Composer({ onSend, disabled, running = false, onInterrupt, sessionId }: Props) {
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const anyUploading = uploads.some((u) => u.status === 'uploading');
  const readyAttachments = uploads
    .filter((u) => u.status === 'done' && u.attachment)
    .map((u) => u.attachment!) as SessionAttachment[];

  const submit = () => {
    const trimmed = text.trim();
    // Allow sending attachments without text (model still gets the references).
    if ((!trimmed && readyAttachments.length === 0) || disabled || anyUploading) return;
    onSend(trimmed, readyAttachments.length > 0 ? readyAttachments : undefined);
    setText('');
    setUploads([]);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (running) {
      onInterrupt?.();
      return;
    }
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (running || disabled || anyUploading) return;
    submit();
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !sessionId) return;
    const list = Array.from(files);
    const rows: PendingUpload[] = list.map((file) => ({
      key: `${Date.now()}-${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      status: 'uploading',
    }));
    setUploads((prev) => [...prev, ...rows]);

    for (const row of rows) {
      try {
        const attachment = await uploadAttachment(sessionId, row.file);
        setUploads((prev) =>
          prev.map((u) => (u.key === row.key ? { ...u, status: 'done', attachment } : u)),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUploads((prev) =>
          prev.map((u) => (u.key === row.key ? { ...u, status: 'error', error: msg } : u)),
        );
      }
    }
  };

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    void handleFiles(e.target.files);
    // Reset the input so picking the same file twice in a row still fires.
    e.target.value = '';
  };

  const removeUpload = (key: string) => {
    setUploads((prev) => prev.filter((u) => u.key !== key));
  };

  const canPickFiles = !!sessionId && !running;
  const sendDisabled =
    disabled
    || anyUploading
    || (!text.trim() && readyAttachments.length === 0);

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {uploads.length > 0 && (
        <div className="composer__attachments">
          {uploads.map((u) => (
            <div
              key={u.key}
              className={
                'composer__chip'
                + (u.status === 'error' ? ' composer__chip--error' : '')
                + (u.status === 'uploading' ? ' composer__chip--pending' : '')
              }
              title={u.error ?? u.file.name}
            >
              <span className="composer__chip-name">{u.file.name}</span>
              <span className="composer__chip-size">{formatBytes(u.file.size)}</span>
              {u.status === 'uploading' && <span className="composer__chip-status">…</span>}
              {u.status === 'error' && <span className="composer__chip-status">!</span>}
              <button
                type="button"
                className="composer__chip-remove"
                onClick={() => removeUpload(u.key)}
                aria-label={`Remove ${u.file.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={3}
        placeholder="Ask OpenHermit to inspect files, run code, search memory, or continue a previous thread..."
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer__actions">
        <div className="composer__actions-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={onPickFiles}
          />
          <button
            type="button"
            className="composer__attach-btn"
            disabled={!canPickFiles}
            onClick={() => fileInputRef.current?.click()}
            title={canPickFiles ? 'Attach files' : 'Attach files (unavailable)'}
            aria-label="Attach files"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <p className="composer__hint">
            {running
              ? 'Click Stop to interrupt the current turn.'
              : anyUploading
                ? 'Uploading attachments…'
                : 'Press Enter to send, Shift+Enter for newline.'}
          </p>
        </div>
        {running ? (
          <button className="btn btn--danger" type="submit" disabled={!onInterrupt}>
            Stop
          </button>
        ) : (
          <button className="btn btn--primary" type="submit" disabled={sendDisabled}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
