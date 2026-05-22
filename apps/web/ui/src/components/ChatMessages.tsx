import { useEffect, useRef, useMemo, useState } from 'react';
import { marked, type TokenizerExtension, type RendererExtension } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import remend from 'remend';
import DOMPurify from 'dompurify';
import { apiFetch, fetchAttachmentBlobUrl, type SessionAttachment } from '../api';

// ─── KaTeX extension for marked ────────────────────────────────────────────

const mathInline: TokenizerExtension & RendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src: string) { return src.indexOf('$'); },
  tokenizer(src: string) {
    const match = src.match(/^\$([^\$\n]+?)\$/);
    if (match) {
      return { type: 'mathInline', raw: match[0], text: match[1] };
    }
    return undefined;
  },
  renderer(token) {
    try {
      return katex.renderToString(token.text, { throwOnError: false });
    } catch {
      return token.raw;
    }
  },
};

const mathBlock: TokenizerExtension & RendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src: string) { return src.indexOf('$$'); },
  tokenizer(src: string) {
    const match = src.match(/^\$\$([\s\S]+?)\$\$/);
    if (match) {
      return { type: 'mathBlock', raw: match[0], text: match[1].trim() };
    }
    return undefined;
  },
  renderer(token) {
    try {
      return `<div class="math-block">${katex.renderToString(token.text, { throwOnError: false, displayMode: true })}</div>`;
    } catch {
      return `<pre>${token.raw}</pre>`;
    }
  },
};

marked.use({ extensions: [mathBlock, mathInline] });

// ─── Markdown renderer ─────────────────────────────────────────────────────

// Allow common markdown/KaTeX output but strip <script>, event handlers, and
// unsafe URI schemes. Agent output is untrusted; never inject raw HTML.
const SANITIZE_CONFIG: DOMPurify.Config = {
  ADD_TAGS: ['math', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'semantics', 'annotation'],
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onmouseenter', 'onmouseleave'],
};

const renderMarkdown = (text: string, streaming = false): string => {
  const src = streaming ? remend(text, { linkMode: 'text-only' }) : text;
  const raw = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG);
};

// ─── Types ─────────────────────────────────────────────────────────────────

export type MessageAction = { type: string; [key: string]: unknown };

export type ChatItem =
  | { type: 'user'; text: string; streaming: false; name?: string; attachments?: SessionAttachment[] }
  | { type: 'assistant'; text: string; streaming: boolean; name?: string; actions?: MessageAction[]; actionsResolved?: boolean; actionsApproved?: boolean; attachments?: SessionAttachment[] }
  | {
      type: 'attachment';
      sessionId: string;
      attachmentId: string;
      mimeType: string;
      kind: 'image' | 'audio' | 'video' | 'document';
      name?: string;
      size?: number;
      caption?: string;
    }
  | { type: 'event'; text: string; isError: boolean }
  | { type: 'tool'; tool: string; toolCallId?: string; args?: unknown; phase: 'running' | 'done'; isError?: boolean; result?: string }
  | { type: 'approval'; toolName: string; toolCallId: string; args?: unknown; resolved: boolean; approved?: boolean }
  | { type: 'thinking'; text?: string; streaming?: boolean }
  | { type: 'introspection'; tools: Extract<ChatItem, { type: 'tool' }>[]; summary?: string };

interface Props {
  items: ChatItem[];
  agentName?: string;
  loading?: boolean;
  emptyMessage?: string;
  onApproval: (toolCallId: string, approved: boolean) => Promise<void>;
  onMessageAction?: (action: MessageAction, approved: boolean) => Promise<void>;
}

// ─── Components ────────────────────────────────────────────────────────────

function formatValue(value: unknown, indent = 0): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) return formatValue(parsed, indent);
    } catch { /* not JSON, return as-is */ }
    return value;
  }
  if (typeof value !== 'object') return String(value);
  return JSON.stringify(value, null, 2);
}

function FormatJson({ value, maxLen = 1200 }: { value: unknown; maxLen?: number }) {
  if (value === undefined || value === null) return null;

  let obj = value;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { /* not JSON */ }
  }

  if (typeof obj === 'string') {
    const display = obj.length > maxLen ? obj.slice(0, maxLen) + '…' : obj;
    return <pre className="tool-card__pre">{display}</pre>;
  }

  if (typeof obj !== 'object' || obj === null) {
    return <pre className="tool-card__pre">{String(obj)}</pre>;
  }

  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v] as const)
    : Object.entries(obj as Record<string, unknown>);

  if (entries.length === 0) return null;

  return (
    <div className="tool-card__kv">
      {entries.map(([key, val]) => {
        const display = formatValue(val);
        const truncated = display.length > maxLen ? display.slice(0, maxLen) + '…' : display;
        return (
          <div key={key} className="tool-card__kv-row">
            <span className="tool-card__kv-key">{key}</span>
            <pre className="tool-card__kv-val">{truncated}</pre>
          </div>
        );
      })}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<ChatItem, { type: 'tool' }> }) {
  const icon = item.phase === 'done'
    ? (item.isError ? '✗' : '✓')
    : (item.phase === 'running' ? '●' : '○');
  const statusLabel = item.phase === 'done'
    ? (item.isError ? 'error' : 'done')
    : item.phase;

  const doneClass = item.phase === 'done' ? (item.isError ? 'tool-card--error' : 'tool-card--done') : '';
  const hasBody = item.args != null || item.result;

  return (
    <details className={`tool-card ${doneClass}`} open={item.phase !== 'done'}>
      <summary className="tool-card__header">
        <span className="tool-card__label">Tool:</span>
        <span className="tool-card__name">{item.tool}</span>
        <span
          className={`tool-card__icon${item.phase === 'done' ? (item.isError ? ' tool-card__icon--error' : ' tool-card__icon--done') : ''}`}
          aria-label={statusLabel}
          title={statusLabel}
        >
          {icon}
        </span>
      </summary>
      {hasBody && (
        <div className="tool-card__body">
          {item.args != null && (
            <div className="tool-card__section">
              <FormatJson value={item.args} />
            </div>
          )}
          {item.result && (
            <div className="tool-card__section tool-card__section--result">
              <FormatJson value={item.result} />
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function formatChipSize(n?: number): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChip({ attachment }: { attachment: SessionAttachment }) {
  const name = attachment.name || attachment.id || 'attachment';
  const size = formatChipSize(attachment.size);
  return (
    <div className="attachment-chip" title={attachment.mimeType || undefined}>
      <span className="attachment-chip__icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </span>
      <span className="attachment-chip__name">{name}</span>
      {size && <span className="attachment-chip__size">{size}</span>}
    </div>
  );
}

function AttachmentMedia({ item }: { item: Extract<ChatItem, { type: 'attachment' }> }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBlobUrl(null);
    setError(null);
    let cancelled = false;
    let url: string | null = null;
    fetchAttachmentBlobUrl(item.sessionId, item.attachmentId)
      .then((res) => {
        if (cancelled) {
          URL.revokeObjectURL(res.url);
          return;
        }
        url = res.url;
        setBlobUrl(res.url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.sessionId, item.attachmentId]);

  if (error) {
    return (
      <div className="event event--error">
        [attachment] failed to load {item.name || item.attachmentId}: {error}
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="message__body">
        Loading attachment {item.name || item.attachmentId}<span className="thinking-dots" />
      </div>
    );
  }

  const downloadName = item.name || item.attachmentId;

  return (
    <div className="message__attachment">
      {item.kind === 'image' && (
        <a href={blobUrl} target="_blank" rel="noreferrer" download={downloadName}>
          <img
            src={blobUrl}
            alt={item.name || 'attachment'}
            style={{ maxWidth: '100%', maxHeight: 480, borderRadius: 8 }}
          />
        </a>
      )}
      {item.kind === 'audio' && (
        <audio controls src={blobUrl} style={{ width: '100%' }} />
      )}
      {item.kind === 'video' && (
        <video
          controls
          src={blobUrl}
          style={{ maxWidth: '100%', maxHeight: 480, borderRadius: 8 }}
        />
      )}
      {item.kind === 'document' && (
        <a
          className="attachment-chip"
          href={blobUrl}
          target="_blank"
          rel="noreferrer"
          download={downloadName}
          title={item.mimeType}
        >
          <span className="attachment-chip__icon" aria-hidden="true">📎</span>
          <span className="attachment-chip__name">{downloadName}</span>
        </a>
      )}
      {item.caption && (
        <div
          className="message__body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.caption, false) }}
        />
      )}
    </div>
  );
}

function ApprovalCard({ item, onApproval }: { item: Extract<ChatItem, { type: 'approval' }>; onApproval: Props['onApproval'] }) {
  if (item.resolved) {
    return (
      <div className="event">
        {item.approved ? `[approved] ${item.toolName}` : `[denied] ${item.toolName}`}
      </div>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-card__title">Approval required · {item.toolName}</div>
      <div className="approval-card__body">
        {item.args != null ? <FormatJson value={item.args} /> : 'No arguments'}
      </div>
      <div className="approval-card__actions">
        <button className="btn btn--primary" onClick={() => void onApproval(item.toolCallId, true)}>Approve</button>
        <button className="btn btn--ghost" onClick={() => void onApproval(item.toolCallId, false)}>Deny</button>
      </div>
    </div>
  );
}

// ─── Turn grouping ────────────────────────────────────────────────────────

type Turn =
  | { kind: 'user'; items: Extract<ChatItem, { type: 'user' }>[] }
  | { kind: 'assistant'; items: ChatItem[] }
  | { kind: 'event'; item: Extract<ChatItem, { type: 'event' }> }
  | { kind: 'introspection'; item: Extract<ChatItem, { type: 'introspection' }> };

const isAssistantItem = (item: ChatItem) =>
  item.type === 'assistant' ||
  item.type === 'tool' ||
  item.type === 'approval' ||
  item.type === 'thinking' ||
  item.type === 'attachment';

function groupIntoTurns(items: ChatItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.type === 'user') {
      turns.push({ kind: 'user', items: [item] });
    } else if (item.type === 'event') {
      turns.push({ kind: 'event', item });
    } else if (item.type === 'introspection') {
      turns.push({ kind: 'introspection', item });
    } else if (isAssistantItem(item)) {
      const last = turns[turns.length - 1];
      if (last?.kind === 'assistant') {
        last.items.push(item);
      } else {
        turns.push({ kind: 'assistant', items: [item] });
      }
    }
  }
  return turns;
}

// ─── Main ──────────────────────────────────────────────────────────────────

export function ChatMessages({ items, agentName, loading, emptyMessage, onApproval, onMessageAction }: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const displayAgentName = agentName || 'Assistant';

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [items]);

  if (loading) {
    return (
      <section className="chat__messages" ref={containerRef}>
        <div className="empty-state">Loading session history<span className="thinking-dots" /></div>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section className="chat__messages" ref={containerRef}>
        <div className="empty-state">{emptyMessage ?? 'Start a conversation or select a session from the sidebar.'}</div>
      </section>
    );
  }

  const turns = groupIntoTurns(items);

  return (
    <section className="chat__messages" ref={containerRef}>
      {turns.map((turn, ti) => {
        if (turn.kind === 'user') {
          const item = turn.items[0];
          return (
            <article key={ti} className="message message--user">
              <div className="message__title">{item.name || 'You'}</div>
              {item.text && <div className="message__body">{item.text}</div>}
              {item.attachments && item.attachments.length > 0 && (
                <div className="message__attachments">
                  {item.attachments.map((a, ai) => (
                    <AttachmentChip key={a.id || `${ai}-${a.name}`} attachment={a} />
                  ))}
                </div>
              )}
            </article>
          );
        }

        if (turn.kind === 'event') {
          return (
            <div key={ti} className={`event${turn.item.isError ? ' event--error' : ''}`}>
              {turn.item.isError ? `[error] ${turn.item.text}` : turn.item.text}
            </div>
          );
        }

        if (turn.kind === 'introspection') {
          const { tools, summary } = turn.item;
          return (
            <details key={ti} className="introspection-block">
              <summary className="introspection-block__header">
                Introspection{summary ? ` — ${summary}` : ''}
              </summary>
              <div className="introspection-block__body">
                {tools.map((tool, ii) => <ToolCard key={ii} item={tool} />)}
              </div>
            </details>
          );
        }

        const nameItem = turn.items.find(i => i.type === 'assistant' && i.name);
        const turnName = (nameItem as any)?.name || displayAgentName;

        return (
          <article key={ti} className="message message--assistant">
            <div className="message__title">{turnName}</div>
            {turn.items.map((item, ii) => {
              switch (item.type) {
                case 'assistant':
                  return (
                    <div key={ii}>
                      <div className="message__body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text, item.streaming) }} />
                      {item.actions && item.actions.length > 0 && (
                        <div className="message__actions">
                          {item.actionsResolved ? (
                            <div className="message__actions-status">
                              {item.actionsApproved ? '✅ Approved' : '✗ Rejected'}
                            </div>
                          ) : (
                            item.actions.map((action, ai) => (
                              <div key={ai} className="message__actions-row">
                                <button
                                  className="btn btn--primary"
                                  onClick={() => onMessageAction && void onMessageAction(action, true)}
                                  disabled={!onMessageAction}
                                >Approve</button>
                                <button
                                  className="btn btn--ghost"
                                  onClick={() => onMessageAction && void onMessageAction(action, false)}
                                  disabled={!onMessageAction}
                                >Reject</button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                case 'tool':
                  return <ToolCard key={ii} item={item} />;
                case 'approval':
                  return <ApprovalCard key={ii} item={item} onApproval={onApproval} />;
                case 'attachment':
                  return <AttachmentMedia key={ii} item={item} />;
                case 'thinking':
                  return item.text ? (
                    <details key={ii} className="thinking-block" open={item.streaming}>
                      <summary className="thinking-block__header">
                        {item.streaming ? <>Thinking<span className="thinking-dots" /></> : 'Thinking'}
                      </summary>
                      <div className="thinking-block__body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text, item.streaming) }} />
                    </details>
                  ) : (
                    <div key={ii} className="message__body thinking-indicator">Thinking<span className="thinking-dots" /></div>
                  );
              }
            })}
          </article>
        );
      })}
    </section>
  );
}
