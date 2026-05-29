import { WebSocket } from 'ws';

/** Bound attachment downloads so a stalled connection can't block the queue. */
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15_000;

export interface SignalApiOptions {
  httpUrl: string;
  account: string;
  selfUuid?: string;
  fetch?: typeof fetch;
}

/** An inbound attachment referenced in a Signal dataMessage. */
export interface SignalAttachment {
  id: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

export interface SignalIncomingMessage {
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  text: string;
  groupId?: string;
  timestamp: number;
  isSelf: boolean;
  attachments?: SignalAttachment[];
}

export interface SendResult {
  timestamp: number;
}

/** Optional outbound extras for a send. */
export interface SendOptions {
  /** signal-cli-rest-api base64 strings, e.g. `data:<mime>;filename=<n>;base64,<data>`. */
  base64Attachments?: string[];
}

export class SignalApi {
  readonly httpUrl: string;
  readonly account: string;
  private readonly fetchImpl: typeof fetch;
  private readonly selfUuid: string | undefined;

  constructor(opts: SignalApiOptions) {
    this.httpUrl = opts.httpUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.fetchImpl = opts.fetch ?? fetch;
    this.selfUuid = opts.selfUuid;
  }

  async sendDirectMessage(recipient: string, message: string, opts?: SendOptions): Promise<SendResult> {
    return this.send([recipient], message, opts);
  }

  async sendGroupMessage(groupId: string, message: string, opts?: SendOptions): Promise<SendResult> {
    return this.send([groupId], message, opts);
  }

  private async send(recipients: string[], message: string, opts?: SendOptions): Promise<SendResult> {
    const res = await this.fetchImpl(`${this.httpUrl}/v2/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        number: this.account,
        recipients,
        message,
        text_mode: 'styled',
        ...(opts?.base64Attachments && opts.base64Attachments.length > 0
          ? { base64_attachments: opts.base64Attachments }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`signal-cli-rest-api send failed (${res.status}): ${body}`);
    }
    const json = (await res.json()) as { timestamp?: number };
    return { timestamp: json.timestamp ?? Date.now() };
  }

  /**
   * Download an inbound attachment's bytes by id via `GET /v1/attachments/{id}`.
   * When `maxBytes` is given the cap is enforced here: an oversized declared
   * content-length is rejected up front, and the body is streamed and aborted
   * the moment it crosses the limit.
   */
  async downloadAttachment(
    id: string,
    maxBytes?: number,
  ): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
    const res = await this.fetchImpl(`${this.httpUrl}/v1/attachments/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`signal-cli-rest-api attachment download failed (${res.status})`);
    }
    const contentType = res.headers.get('content-type') ?? undefined;

    if (maxBytes !== undefined) {
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`Signal attachment exceeds the ${maxBytes}-byte limit (content-length ${declared})`);
      }
    }

    if (maxBytes === undefined || !res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
        throw new Error(`Signal attachment exceeds the ${maxBytes}-byte limit (${bytes.byteLength} bytes)`);
      }
      return { bytes, contentType };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`Signal attachment exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: out, contentType };
  }

  async sendTyping(recipient: string): Promise<void> {
    try {
      const res = await this.fetchImpl(
        `${this.httpUrl}/v1/typing-indicator/${encodeURIComponent(this.account)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recipient }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[signal-api] typing-indicator failed (${res.status}): ${body}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[signal-api] typing-indicator error: ${msg}`);
    }
  }

  async probeReceiveMode(): Promise<void> {
    const res = await this.fetchImpl(`${this.httpUrl}/v1/about`);
    if (!res.ok) {
      throw new Error(`signal-cli-rest-api /v1/about returned ${res.status}; is the URL correct?`);
    }
    const json = (await res.json()) as { mode?: string };
    if (json.mode !== 'json-rpc') {
      throw new Error(
        `signal-cli-rest-api must run with MODE=json-rpc (got ${json.mode ?? 'unknown'}). ` +
          `Set MODE=json-rpc in the container env and restart.`,
      );
    }
  }

  async *streamMessages(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SignalIncomingMessage> {
    if (opts.signal?.aborted) return;

    const wsUrl = this.httpUrl.replace(/^http/, 'ws')
      + `/v1/receive/${encodeURIComponent(this.account)}`;
    const ws = new WebSocket(wsUrl);

    const queue: SignalIncomingMessage[] = [];
    const waiters: Array<(msg: SignalIncomingMessage | null) => void> = [];
    let closed = false;
    let openError: Error | undefined;

    const push = (msg: SignalIncomingMessage | null): void => {
      const w = waiters.shift();
      if (w) w(msg);
      else if (msg) queue.push(msg);
    };

    ws.on('message', (data) => {
      try {
        const raw = JSON.parse(data.toString());
        const normalized = this.normalizeEnvelope(raw);
        if (normalized) push(normalized);
      } catch {
        // skip malformed frames; the daemon occasionally emits non-JSON keepalives
      }
    });
    ws.on('close', () => { closed = true; push(null); });
    ws.on('error', (err) => { openError = err as Error; closed = true; push(null); });

    const onAbort = (): void => { try { ws.close(); } catch { /* ignore */ } };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) {
          if (openError) throw openError;
          return;
        }
        const next = await new Promise<SignalIncomingMessage | null>((resolve) => waiters.push(resolve));
        if (!next) {
          if (openError) throw openError;
          return;
        }
        yield next;
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  private normalizeEnvelope(raw: unknown): SignalIncomingMessage | null {
    if (!raw || typeof raw !== 'object') return null;
    const env = (raw as { envelope?: Record<string, unknown> }).envelope;
    if (!env || typeof env !== 'object') return null;

    const data = env.dataMessage as Record<string, unknown> | undefined;
    if (!data) return null;
    const text = typeof data.message === 'string' ? data.message : '';
    const attachments = parseAttachments(data.attachments);
    // Forward only if there's text or at least one attachment to download.
    if (!text && attachments.length === 0) return null;

    const sourceUuid = typeof env.sourceUuid === 'string' ? env.sourceUuid : undefined;
    const sourceNumber = typeof env.sourceNumber === 'string' ? env.sourceNumber : undefined;
    const sourceName = typeof env.sourceName === 'string' ? env.sourceName : undefined;
    const timestamp = typeof env.timestamp === 'number' ? env.timestamp : Date.now();

    const groupInfo = data.groupInfo as { groupId?: string } | undefined;
    const groupId = typeof groupInfo?.groupId === 'string' ? groupInfo.groupId : undefined;

    const isSelf =
      (this.selfUuid !== undefined && sourceUuid === this.selfUuid) ||
      (sourceNumber !== undefined && sourceNumber === this.account);

    const out: SignalIncomingMessage = { text, timestamp, isSelf };
    if (sourceUuid) out.sourceUuid = sourceUuid;
    if (sourceNumber) out.sourceNumber = sourceNumber;
    if (sourceName) out.sourceName = sourceName;
    if (groupId) out.groupId = groupId;
    if (attachments.length > 0) out.attachments = attachments;
    return out;
  }
}

/** Parse the `dataMessage.attachments` array into typed descriptors. */
function parseAttachments(raw: unknown): SignalAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string') continue;
    const att: SignalAttachment = { id: a.id };
    if (typeof a.contentType === 'string') att.contentType = a.contentType;
    if (typeof a.filename === 'string') att.filename = a.filename;
    if (typeof a.size === 'number') att.size = a.size;
    out.push(att);
  }
  return out;
}
