import { PNG } from 'pngjs';
// jsqr is a CJS UMD bundle; NodeNext won't synthesize a callable default,
// so pull it off the namespace import explicitly.
import * as jsqrModule from 'jsqr';
type JsQRFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;
const jsQR = (jsqrModule as unknown as { default: JsQRFn }).default;

export interface QrLinkOptions {
  httpUrl: string;
  account: string;
  fetch?: typeof fetch;
}

export class QrLinkSession {
  readonly httpUrl: string;
  readonly account: string;
  /** Decoded `sgnl://linkdevice?…` URI from the daemon-rendered QR PNG. */
  readonly qrUri: string;
  readonly qrPngDataUrl: string;
  private readonly fetchImpl: typeof fetch;

  private constructor(
    opts: QrLinkOptions,
    qrUri: string,
    qrPngDataUrl: string,
  ) {
    this.httpUrl = opts.httpUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.fetchImpl = opts.fetch ?? fetch;
    this.qrUri = qrUri;
    this.qrPngDataUrl = qrPngDataUrl;
  }

  static async begin(opts: QrLinkOptions): Promise<QrLinkSession> {
    const fetchImpl = opts.fetch ?? fetch;
    const httpUrl = opts.httpUrl.replace(/\/+$/, '');
    const url = `${httpUrl}/v1/qrcodelink?device_name=openhermit`;
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`signal-cli-rest-api QR-link failed (${res.status}): ${body}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const b64 = Buffer.from(buf).toString('base64');
    const dataUrl = `data:image/png;base64,${b64}`;

    let png: PNG;
    try {
      png = PNG.sync.read(Buffer.from(buf));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `signal-cli-rest-api returned a QR PNG we could not parse: ${message}`,
      );
    }
    const rgba = new Uint8ClampedArray(png.data);
    const decoded = jsQR(rgba, png.width, png.height);
    if (!decoded) {
      throw new Error(
        'signal-cli-rest-api returned a QR PNG we could not decode',
      );
    }
    const qrUri = decoded.data;
    if (!qrUri.startsWith('sgnl://linkdevice?')) {
      throw new Error('signal-cli-rest-api returned an unexpected QR payload');
    }
    return new QrLinkSession(opts, qrUri, dataUrl);
  }

  async poll(): Promise<'awaiting' | 'linked'> {
    const res = await this.fetchImpl(`${this.httpUrl}/v1/accounts`);
    if (!res.ok) return 'awaiting';
    let accounts: unknown;
    try {
      accounts = (await res.json()) as unknown;
    } catch {
      return 'awaiting';
    }
    if (!Array.isArray(accounts)) return 'awaiting';
    return accounts.includes(this.account) ? 'linked' : 'awaiting';
  }
}
