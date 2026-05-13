export interface SignalApiOptions {
  httpUrl: string;
  account: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface SendResult {
  timestamp: number;
}

export class SignalApi {
  readonly httpUrl: string;
  readonly account: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SignalApiOptions) {
    this.httpUrl = opts.httpUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.fetchImpl = opts.fetch ?? fetch;
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
        // Non-fatal: log only. Typing indicators are best-effort UX.
        console.error(`[signal-api] typing-indicator failed (${res.status}): ${body}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[signal-api] typing-indicator error: ${msg}`);
    }
  }

  /**
   * Verify the daemon was started with MODE=json-rpc. The /v1/receive
   * WebSocket only upgrades successfully when the daemon is in that mode,
   * but the failure mode is a silent connect-then-disconnect — much better
   * to catch this at startup with a clear message.
   */
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
}
