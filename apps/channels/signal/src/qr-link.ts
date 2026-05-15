/**
 * Thin client over signal-cli-rest-api's QR-link endpoint plus the
 * `/v1/accounts` poll used to detect when linking completes.
 */
export interface QrLinkOptions {
  httpUrl: string;
  account: string;
  fetch?: typeof fetch;
}

export class QrLinkSession {
  readonly httpUrl: string;
  readonly account: string;
  readonly qrPngDataUrl: string;
  private readonly fetchImpl: typeof fetch;

  private constructor(opts: QrLinkOptions, qrPngDataUrl: string) {
    this.httpUrl = opts.httpUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.fetchImpl = opts.fetch ?? fetch;
    this.qrPngDataUrl = qrPngDataUrl;
  }

  static async begin(opts: QrLinkOptions): Promise<QrLinkSession> {
    const fetchImpl = opts.fetch ?? fetch;
    const httpUrl = opts.httpUrl.replace(/\/+$/, '');
    const url = `${httpUrl}/v1/qrcodelink/${encodeURIComponent(opts.account)}`;
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`signal-cli-rest-api QR-link failed (${res.status}): ${body}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const b64 = Buffer.from(buf).toString('base64');
    const dataUrl = `data:image/png;base64,${b64}`;
    return new QrLinkSession(opts, dataUrl);
  }

  async poll(): Promise<'awaiting' | 'linked'> {
    const res = await this.fetchImpl(`${this.httpUrl}/v1/accounts`);
    if (!res.ok) return 'awaiting';
    const accounts = (await res.json()) as unknown;
    if (!Array.isArray(accounts)) return 'awaiting';
    return accounts.includes(this.account) ? 'linked' : 'awaiting';
  }
}
