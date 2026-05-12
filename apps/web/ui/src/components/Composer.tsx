import { useState, useRef, type FormEvent, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  /** Turn in flight — show Stop instead of Send. */
  running?: boolean;
  onInterrupt?: () => void;
}

export function Composer({ onSend, disabled, running = false, onInterrupt }: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (running) {
      onInterrupt?.();
      return;
    }
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (running || disabled) return;
    const trimmed = text.trim();
    if (trimmed) {
      onSend(trimmed);
      setText('');
    }
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        rows={3}
        placeholder="Ask OpenHermit to inspect files, run code, search memory, or continue a previous thread..."
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer__actions">
        <p className="composer__hint">
          {running ? 'Click Stop to interrupt the current turn.' : 'Press Enter to send, Shift+Enter for newline.'}
        </p>
        {running ? (
          <button className="btn btn--danger" type="submit" disabled={!onInterrupt}>
            Stop
          </button>
        ) : (
          <button className="btn btn--primary" type="submit" disabled={disabled || !text.trim()}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
