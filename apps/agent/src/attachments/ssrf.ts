import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

import { Agent } from 'undici';

/**
 * SSRF protections for the attachment URL-passthrough fetch path.
 *
 * Two layers, because each catches what the other can't:
 *
 *  1. `isBlockedLiteralHost` — a cheap, synchronous check on the URL hostname.
 *     Rejects `localhost` and any IP-literal host (IPv4 or IPv6, brackets and
 *     zone-ids stripped) that lands in a private / loopback / link-local /
 *     metadata / unspecified range *before* we open a socket. No DNS needed.
 *
 *  2. `makeSsrfLookup` / `createSsrfSafeAgent` — a custom DNS lookup wired into
 *     the undici dispatcher. For every connection (initial request *and* each
 *     redirect hop) it resolves the hostname, rejects if ANY resolved address
 *     is blocked, and connects to exactly the address it validated. Because the
 *     dispatcher performs the only name resolution, there is no second lookup an
 *     attacker can answer differently — this closes the DNS-alias bypass and the
 *     DNS-rebinding TOCTOU window (the validated address is pinned through
 *     connection establishment).
 */

export type HostResolver = (hostname: string) => Promise<string[]>;

/** Real resolver — all A/AAAA records, in system order. */
export const defaultResolver: HostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

/** IPv4 dotted-quad → blocked if private / loopback / link-local / etc. */
const isBlockedV4 = (ip: string): boolean => {
  const o = ip.split('.').map((s) => Number(s));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → fail closed
  }
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
};

/**
 * Extract an embedded IPv4 from an IPv4-mapped/-compatible IPv6 address, in
 * either textual form: `::ffff:127.0.0.1` or its compressed hex form
 * `::ffff:7f00:1`. Returns null when there's no embedded IPv4.
 */
const extractMappedV4 = (ip: string): string | null => {
  const m = ip.match(/^::(?:ffff:)?(.+)$/);
  if (!m || !m[1]) return null;
  const rest = m[1];
  if (isIP(rest) === 4) return rest; // ::ffff:127.0.0.1
  const parts = rest.split(':');
  if (parts.length === 2) {
    const hi = parseInt(parts[0]!, 16);
    const lo = parseInt(parts[1]!, 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
  }
  return null;
};

/**
 * True if a *resolved* IP literal (v4 or v6) is in a range we refuse to fetch
 * from. Anything we can't recognise as a routable public address fails closed.
 */
export const isBlockedAddress = (raw: string): boolean => {
  let ip = raw.trim().toLowerCase();
  const pct = ip.indexOf('%'); // strip zone-id, e.g. fe80::1%eth0
  if (pct !== -1) ip = ip.slice(0, pct);

  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) {
    const mapped = extractMappedV4(ip);
    if (mapped) return isBlockedV4(mapped);
    if (ip === '::1' || ip === '::') return true; // loopback / unspecified
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
    if (ip.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }
  return true; // not an IP literal we understand → fail closed
};

/**
 * Synchronous pre-connection check on a URL hostname. Strips IPv6 brackets
 * (`URL.hostname` keeps them, e.g. `[::1]`) and zone-ids before testing IP
 * literals. Non-literal hostnames return false here — they're validated by the
 * dispatcher lookup once resolved.
 */
export const isBlockedLiteralHost = (hostname: string): boolean => {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) !== 0) return isBlockedAddress(h);
  return false;
};

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

type LookupOptions = { all?: boolean };

/**
 * Build a `net`-compatible lookup that resolves via `resolver`, rejects if any
 * resolved address is blocked, and otherwise returns the validated address(es)
 * — pinning the connection to what was validated.
 */
export const makeSsrfLookup =
  (resolver: HostResolver = defaultResolver) =>
  (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolver(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(new Error(`SSRF guard: "${hostname}" has no DNS records`));
          return;
        }
        const blocked = addresses.find((a) => isBlockedAddress(a));
        if (blocked) {
          callback(
            new Error(
              `SSRF guard: "${hostname}" resolves to blocked address ${blocked}`,
            ),
          );
          return;
        }
        if (options && options.all) {
          callback(
            null,
            addresses.map((a) => ({ address: a, family: isIP(a) === 6 ? 6 : 4 })),
          );
        } else {
          const chosen = addresses[0]!;
          callback(null, chosen, isIP(chosen) === 6 ? 6 : 4);
        }
      })
      .catch((err) => {
        callback(err instanceof Error ? err : new Error(String(err)));
      });
  };

/**
 * An undici dispatcher whose connector resolves + validates + pins every
 * outbound connection (including redirect hops) through `makeSsrfLookup`.
 * Caller owns the returned Agent and should `await agent.close()` when done.
 */
export const createSsrfSafeAgent = (resolver: HostResolver = defaultResolver): Agent =>
  new Agent({
    connect: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lookup: makeSsrfLookup(resolver) as any,
    },
  });
