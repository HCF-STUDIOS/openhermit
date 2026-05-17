/**
 * Thin client over signal-cli-rest-api's QR-link endpoint plus the
 * `/v1/accounts` poll used to detect when linking completes.
 *
 * signal-cli-rest-api returns the link payload as a PNG; we decode it
 * once at session start and expose the underlying `sgnl://linkdevice?…`
 * URI so callers can render their own QR (which is what the wizard
 * spec asks for).
 */
import { PNG } from 'pngjs';
// jsqr ships a UMD bundle: under NodeNext its types resolve as a CJS
// module whose default export is the callable. esModuleInterop's synthetic
// default doesn't bind under NodeNext, so we pull the default off the
// namespace import explicitly.
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
  /**
   * @deprecated Kept for backward compat with earlier 0.2.x consumers.
   *   New code should render its own QR from {@link qrUri}.
   */
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
    // signal-cli-rest-api's link endpoint takes device_name as a query
    // param and does NOT take the phone number — the number is chosen at
    // scan time on the user's phone, not pre-bound to the QR.
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
