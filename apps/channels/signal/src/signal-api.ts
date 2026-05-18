import { WebSocket } from 'ws';

export interface SignalApiOptions {
  httpUrl: string;
  account: string;
  selfUuid?: string;
  fetch?: typeof fetch;
}

export interface SignalIncomingMessage {
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  text: string;
  groupId?: string;
  timestamp: number;
  isSelf: boolean;
}

export interface SendResult {
  timestamp: number;
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

  async sendDirectMessage(recipient: string, message: string): Promise<SendResult> {
    return this.send([recipient], message);
  }

  async sendGroupMessage(groupId: string, message: string): Promise<SendResult> {
    return this.send([groupId], message);
  }

  private async send(recipients: string[], message: string): Promise<SendResult> {
    const res = await this.fetchImpl(`${this.httpUrl}/v2/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        number: this.account,
        recipients,
        message,
        text_mode: 'styled',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`signal-cli-rest-api send failed (${res.status}): ${body}`);
    }
    const json = (await res.json()) as { timestamp?: number };
    return { timestamp: json.timestamp ?? Date.now() };
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
    if (!text) return null;

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
    return out;
  }
}
