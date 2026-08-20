import { Agent, type Dispatcher } from 'undici';

import {
  createSsrfSafeAgent,
  isBlockedLiteralHost,
  type HostResolver,
} from '../attachments/ssrf.js';

/**
 * Shared SSRF-safe fetch primitive.
 *
 * One hardened acquisition path for every server-side fetch of a caller- or
 * model-supplied URL (attachment URL passthrough, direct web-page fetches for
 * research). Guarantees, per request AND per redirect hop:
 *
 *  - protocol allowlist (attachments: https only; web: http + https)
 *  - no embedded credentials in the URL
 *  - literal-host pre-filter + DNS resolve-validate-pin via the SSRF
 *    dispatcher from `../attachments/ssrf.js` (blocks loopback, private,
 *    link-local, metadata, CGNAT, multicast, and DNS-rebinding targets)
 *  - manual redirect following with a hop cap, every hop re-validated
 *  - caller headers reduced to content-negotiation headers once a redirect
 *    leaves the original origin (credentials never follow a redirect)
 *  - wall-clock timeout combined with an optional caller AbortSignal
 *  - decompressed-body byte cap, either failing or truncating on overflow
 *
 * The body is buffered (streamed with the cap enforced chunk-by-chunk), never
 * handed out as a live stream — callers get bytes that already passed the cap.
 */

export type SafeFetchFailureReason =
  | 'malformed_url'
  | 'protocol_not_allowed'
  | 'credentials_in_url'
  | 'blocked_host'
  | 'too_many_redirects'
  | 'malformed_redirect'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'body_too_large';

export class SafeFetchError extends Error {
  constructor(
    public readonly reason: SafeFetchFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  /** Allowed URL protocols including the trailing colon. Default `['https:']`. */
  allowedProtocols?: readonly string[] | undefined;
  /** Maximum redirect hops before failing. Default 5. */
  maxRedirects?: number | undefined;
  /** Wall-clock timeout covering all hops and the body read. Default 30s. */
  timeoutMs?: number | undefined;
  /** Caller abort signal, combined with the timeout. */
  signal?: AbortSignal | undefined;
  /** Cap on decompressed body bytes. Unlimited when omitted. */
  maxBytes?: number | undefined;
  /** What to do when the body exceeds `maxBytes`. Default `'error'`. */
  onOversize?: 'error' | 'truncate' | undefined;
  /**
   * Extra request headers. On a redirect hop that changes origin, only the
   * `CROSS_ORIGIN_SAFE_HEADERS` content-negotiation headers are re-sent;
   * everything else (authorization, cookies, API keys, …) is dropped for the
   * rest of the chain — the redirect target is chosen by the remote server.
   */
  headers?: Record<string, string> | undefined;
  /** Injectable resolver for tests; drives the SSRF connection pinning. */
  resolveHost?: HostResolver | undefined;
  /**
   * Long-lived SSRF-safe dispatcher (from `createSafeDispatcher`) shared
   * across calls — one TLS/DNS pool per research run instead of one per
   * fetch. Caller owns its lifecycle; when omitted a per-call dispatcher is
   * created and closed. Must be SSRF-safe: passing a plain undici Agent here
   * would bypass the resolve-validate-pin layer.
   */
  dispatcher?: Dispatcher | undefined;
}

export interface SafeFetchResult {
  status: number;
  statusText: string;
  headers: Headers;
  /** Buffered (possibly truncated) response body. */
  body: Buffer;
  truncated: boolean;
  /** URL that produced the final response, after redirects. */
  finalUrl: string;
  redirects: number;
}

/**
 * Build a shareable SSRF-safe dispatcher for callers that make many
 * `safeFetch` calls (one per research run, not one per page).
 * Caller must `await dispatcher.close()` when done.
 */
export const createSafeDispatcher = (resolveHost?: HostResolver): Agent =>
  createSsrfSafeAgent(resolveHost);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_PROTOCOLS: readonly string[] = ['https:'];

/**
 * The only caller headers that may follow a redirect to a different origin.
 * An allowlist (rather than stripping known-sensitive names like the fetch
 * spec does) fails closed for custom credentials such as `x-api-key`.
 */
const CROSS_ORIGIN_SAFE_HEADERS: ReadonlySet<string> = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
]);

const validateHop = (u: URL, allowedProtocols: readonly string[]): void => {
  if (!allowedProtocols.includes(u.protocol)) {
    throw new SafeFetchError(
      'protocol_not_allowed',
      `protocol "${u.protocol}" not allowed (allowed: ${allowedProtocols.join(', ')})`,
    );
  }
  if (u.username || u.password) {
    throw new SafeFetchError(
      'credentials_in_url',
      'URLs with embedded credentials are not allowed',
    );
  }
  if (isBlockedLiteralHost(u.hostname)) {
    throw new SafeFetchError(
      'blocked_host',
      `host "${u.hostname}" is not allowed (SSRF guard)`,
    );
  }
};

/** Map a thrown fetch/read error to a typed SafeFetchError. */
const toSafeFetchError = (err: unknown, url: string): SafeFetchError => {
  if (err instanceof SafeFetchError) return err;
  if (err instanceof Error) {
    const name = err.name;
    const causeName = err.cause instanceof Error ? err.cause.name : '';
    if (name === 'TimeoutError' || causeName === 'TimeoutError') {
      return new SafeFetchError('timeout', `request timed out (url=${url})`);
    }
    if (name === 'AbortError' || causeName === 'AbortError') {
      return new SafeFetchError('aborted', `request aborted (url=${url})`);
    }
    // undici wraps connection failures as `TypeError: fetch failed` with the
    // real error (including SSRF-guard lookup rejections) on `cause`.
    const detail =
      err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
    return new SafeFetchError('network', `${detail} (url=${url})`);
  }
  return new SafeFetchError('network', `${String(err)} (url=${url})`);
};

/**
 * Read the response body enforcing the byte cap chunk-by-chunk, so an
 * unbounded (or lying content-length) response can never exhaust memory.
 */
const readBody = async (
  res: Response,
  maxBytes: number | undefined,
  onOversize: 'error' | 'truncate',
): Promise<{ body: Buffer; truncated: boolean }> => {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (maxBytes !== undefined && total > maxBytes) {
        if (onOversize === 'error') {
          throw new SafeFetchError(
            'body_too_large',
            `body exceeds limit ${maxBytes}`,
          );
        }
        const keep = chunk.length - (total - maxBytes);
        if (keep > 0) chunks.push(chunk.subarray(0, keep));
        return { body: Buffer.concat(chunks), truncated: true };
      }
      chunks.push(chunk);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return { body: Buffer.concat(chunks), truncated: false };
};

export const safeFetch = async (
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> => {
  const allowedProtocols = options.allowedProtocols ?? DEFAULT_PROTOCOLS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onOversize = options.onOversize ?? 'error';

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new SafeFetchError('malformed_url', 'malformed URL');
  }
  validateHop(current, allowedProtocols);

  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  const ownsDispatcher = options.dispatcher === undefined;
  const dispatcher = options.dispatcher ?? createSsrfSafeAgent(options.resolveHost);

  // Filtered down to CROSS_ORIGIN_SAFE_HEADERS the first time a redirect
  // leaves the original origin, and kept filtered from then on (an A→B→A
  // chain never gets its credentials back — B chose the target).
  let headers = options.headers;

  try {
    let res: Response;
    let hops = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        res = await fetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal,
          ...(headers ? { headers } : {}),
          // `dispatcher` is an undici extension to RequestInit, not in lib.dom.
          dispatcher,
        } as RequestInit & { dispatcher: unknown });
      } catch (err) {
        throw toSafeFetchError(err, current.toString());
      }
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        void res.body?.cancel().catch(() => {});
        if (hops >= maxRedirects) {
          throw new SafeFetchError(
            'too_many_redirects',
            `too many redirects (>${maxRedirects})`,
          );
        }
        let next: URL;
        try {
          next = new URL(res.headers.get('location')!, current);
        } catch {
          throw new SafeFetchError('malformed_redirect', 'malformed redirect target');
        }
        validateHop(next, allowedProtocols);
        if (headers && next.origin !== current.origin) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([name]) =>
              CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase()),
            ),
          );
        }
        current = next;
        hops += 1;
        continue;
      }

      // Fast-fail before reading a body the declared size already disqualifies.
      if (onOversize === 'error' && options.maxBytes !== undefined) {
        const contentLength = res.headers.get('content-length');
        if (contentLength) {
          const n = Number(contentLength);
          if (Number.isFinite(n) && n > options.maxBytes) {
            throw new SafeFetchError(
              'body_too_large',
              `content-length ${n} exceeds limit ${options.maxBytes}`,
            );
          }
        }
      }

      let body: Buffer;
      let truncated: boolean;
      try {
        ({ body, truncated } = await readBody(res, options.maxBytes, onOversize));
      } catch (err) {
        throw toSafeFetchError(err, current.toString());
      }

      return {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body,
        truncated,
        finalUrl: current.toString(),
        redirects: hops,
      };
    }
  } finally {
    if (ownsDispatcher) {
      void (dispatcher as Agent).close().catch(() => {});
    }
  }
};
