/**
 * iLink HTTP transport — minimal, text-only.
 *
 * Wire format mirrors Tencent's `@tencent-weixin/openclaw-weixin` package:
 *   - JSON over HTTPS to a per-bot `baseurl` (IDC-routed at login time).
 *   - Auth: `Authorization: Bearer <bot_token>` +
 *           `AuthorizationType: ilink_bot_token`.
 *   - Identity headers: `iLink-App-Id`, `iLink-App-ClientVersion`,
 *     `X-WECHAT-UIN` (random uint32, base64-encoded).
 *
 * The `iLink-App-Id` value is read from this package's own `package.json`
 * (`ilink_appid` field). Operators who run their own iLink app should
 * fork-and-patch that field or set the `OPENHERMIT_WECHAT_APP_ID` env var.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BaseInfo,
  GetUpdatesReq,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  NotifyStartResp,
  NotifyStopResp,
  QrCodeResponse,
  QrStatusResponse,
  SendMessageReq,
  SendMessageResp,
} from './types.js';

interface PackageJson {
  name?: string;
  version?: string;
  ilink_appid?: string;
}

const isOwnPackageJson = (parsed: PackageJson): boolean => {
  if (parsed.ilink_appid !== undefined) return true;
  return typeof parsed.name === 'string' && parsed.name.includes('channel-wechat');
};

const readPackageJsonFromDir = (startDir: string): PackageJson => {
  try {
    let dir = startDir;
    const { root } = path.parse(dir);
    while (dir && dir !== root) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as PackageJson;
          if (isOwnPackageJson(parsed)) return parsed;
        } catch {
          // Malformed package.json — keep walking up.
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall through.
  }
  return {};
};

const pkg = readPackageJsonFromDir(path.dirname(fileURLToPath(import.meta.url)));

const CHANNEL_VERSION = pkg.version ?? 'unknown';
const ILINK_APP_ID = process.env.OPENHERMIT_WECHAT_APP_ID ?? pkg.ilink_appid ?? '';

const buildClientVersion = (version: string): number => {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
};

const ILINK_APP_CLIENT_VERSION = buildClientVersion(pkg.version ?? '0.0.0');

/** Fixed iLink entry point for QR-login bootstrap (per-bot URLs come from `baseurl`). */
export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Default `bot_type` for ilink get_bot_qrcode (personal WeChat). */
export const DEFAULT_BOT_TYPE = '3';

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

const ensureTrailingSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

const randomWechatUin = (): string => {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
};

const buildCommonHeaders = (): Record<string, string> => ({
  'iLink-App-Id': ILINK_APP_ID,
  'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
});

const buildPostHeaders = (token?: string): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
};

export const buildBaseInfo = (botAgent?: string): BaseInfo => ({
  channel_version: CHANNEL_VERSION,
  bot_agent: botAgent && botAgent.trim() ? botAgent.trim() : 'OpenHermit',
});

interface FetchParams {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
}

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  label: string,
): Promise<string> => {
  const controller = timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
  const timer =
    controller && timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  try {
    const res = await fetch(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text}`);
    return text;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const apiGet = async (params: FetchParams): Promise<string> => {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  return fetchWithTimeout(
    url.toString(),
    { method: 'GET', headers: buildCommonHeaders() },
    params.timeoutMs,
    params.label,
  );
};

export const apiPost = async (
  params: FetchParams & { body: string; token?: string },
): Promise<string> => {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  return fetchWithTimeout(
    url.toString(),
    { method: 'POST', headers: buildPostHeaders(params.token), body: params.body },
    params.timeoutMs,
    params.label,
  );
};

// ─── QR login ──────────────────────────────────────────────────────────

export const fetchQrCode = async (
  apiBaseUrl: string,
  botType: string,
): Promise<QrCodeResponse> => {
  const raw = await apiPost({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: [] }),
    label: 'fetchQrCode',
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
  });
  return JSON.parse(raw) as QrCodeResponse;
};

export const pollQrStatus = async (
  apiBaseUrl: string,
  qrcode: string,
  timeoutMs: number = DEFAULT_LONG_POLL_TIMEOUT_MS,
): Promise<QrStatusResponse> => {
  try {
    const raw = await apiGet({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs,
      label: 'pollQrStatus',
    });
    return JSON.parse(raw) as QrStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    // Treat gateway/network hiccups as transient.
    return { status: 'wait' };
  }
};

// ─── Bot runtime ──────────────────────────────────────────────────────

export interface WeixinApiOptions {
  baseUrl: string;
  token: string;
  /** Optional override for the bot_agent header. */
  botAgent?: string;
}

export const getUpdates = async (
  opts: WeixinApiOptions & GetUpdatesReq & { timeoutMs?: number },
): Promise<GetUpdatesResp> => {
  const timeout = opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const raw = await apiPost({
      baseUrl: opts.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: opts.get_updates_buf ?? '',
        base_info: buildBaseInfo(opts.botAgent),
      }),
      token: opts.token,
      timeoutMs: timeout,
      label: 'getUpdates',
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const resp: GetUpdatesResp = { ret: 0, msgs: [] };
      if (opts.get_updates_buf !== undefined) resp.get_updates_buf = opts.get_updates_buf;
      return resp;
    }
    throw err;
  }
};

export const sendMessage = async (
  opts: WeixinApiOptions & { body: SendMessageReq },
): Promise<SendMessageResp> => {
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...opts.body, base_info: buildBaseInfo(opts.botAgent) }),
    token: opts.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
  });
  try {
    return raw ? (JSON.parse(raw) as SendMessageResp) : {};
  } catch {
    return {};
  }
};

/**
 * Request a CDN upload slot for outbound media. Returns the upload URL plus the
 * `upload_param` the client may use to assemble one. The bytes themselves are
 * POSTed separately via {@link uploadToCdn}.
 */
export const getUploadUrl = async (
  opts: WeixinApiOptions & { req: GetUploadUrlReq; timeoutMs?: number },
): Promise<GetUploadUrlResp> => {
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: JSON.stringify({ ...opts.req, base_info: buildBaseInfo(opts.botAgent) }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'getUploadUrl',
  });
  return JSON.parse(raw) as GetUploadUrlResp;
};

/**
 * Upload already-encrypted bytes to the WeChat C2C CDN. The download reference
 * comes back in the `x-encrypted-param` response header (not the body); it is
 * what an outbound media item references via `media.encrypt_query_param`.
 */
export const uploadToCdn = async (params: {
  uploadUrl: string;
  ciphertext: Buffer;
  timeoutMs?: number;
}): Promise<{ downloadEncryptedQueryParam: string }> => {
  const res = await fetch(params.uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(params.ciphertext),
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`uploadToCdn ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const downloadEncryptedQueryParam = res.headers.get('x-encrypted-param');
  if (!downloadEncryptedQueryParam) {
    throw new Error('uploadToCdn: response missing x-encrypted-param header');
  }
  return { downloadEncryptedQueryParam };
};

export const notifyStart = async (opts: WeixinApiOptions): Promise<NotifyStartResp> => {
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    body: JSON.stringify({ base_info: buildBaseInfo(opts.botAgent) }),
    token: opts.token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStart',
  });
  return JSON.parse(raw) as NotifyStartResp;
};

export const notifyStop = async (opts: WeixinApiOptions): Promise<NotifyStopResp> => {
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    body: JSON.stringify({ base_info: buildBaseInfo(opts.botAgent) }),
    token: opts.token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStop',
  });
  return JSON.parse(raw) as NotifyStopResp;
};
