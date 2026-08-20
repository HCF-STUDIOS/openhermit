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
 * Expand an IPv6 literal into its 8 16-bit groups, handling `::` compression
 * and a trailing embedded dotted-quad in any position the grammar allows.
 * Working on numeric groups instead of the textual form means every spelling
 * of an address (`::1`, `0::1`, `0:0:0:0:0:0:0:1`) hits the same checks.
 * Returns null on anything unexpected — callers fail closed.
 */
const v6Groups = (ip: string): number[] | null => {
  const parseChunk = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const out: number[] = [];
    for (const part of chunk.split(':')) {
      if (part.includes('.')) {
        const o = part.split('.').map((s) => Number(s));
        if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null;
        }
        out.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = parseChunk(halves[0]!);
  const right = halves.length === 2 ? parseChunk(halves[1] ?? '') : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  return [...left, ...(Array(fill).fill(0) as number[]), ...right];
};

/**
 * True if a *resolved* IP literal (v4 or v6) is in a range we refuse to fetch
 * from. Anything we can't recognise as a routable public address fails closed.
 *
 * IPv6 forms that embed an IPv4 (mapped `::ffff:0:0/96`, deprecated
 * compatible `::/96`, SIIT-translated, NAT64 well-known prefix `64:ff9b::/96`,
 * 6to4 `2002::/16`) are judged by the embedded IPv4 — otherwise an attacker
 * DNS record like `64:ff9b::a00:1` would reach 10.0.0.1 through a NAT64
 * translator despite the v4 rules.
 */
export const isBlockedAddress = (raw: string): boolean => {
  let ip = raw.trim().toLowerCase();
  const pct = ip.indexOf('%'); // strip zone-id, e.g. fe80::1%eth0
  if (pct !== -1) ip = ip.slice(0, pct);

  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) {
    const g = v6Groups(ip);
    if (!g) return true; // unparseable → fail closed
    const embeddedV4 = (hi: number, lo: number): boolean =>
      isBlockedV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    const zeroThrough = (n: number): boolean => g.slice(0, n + 1).every((x) => x === 0);
    // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96 — judge
    // the embedded v4. `::` (0.0.0.0) and `::1` (0.0.0.1) land in the 0/8
    // block, covering unspecified and loopback in the same branch.
    if (zeroThrough(4) && (g[5] === 0xffff || g[5] === 0)) return embeddedV4(g[6]!, g[7]!);
    // SIIT "IPv4-translated" ::ffff:0:0:0/96 (non-routable translator form)
    if (zeroThrough(3) && g[4] === 0xffff && g[5] === 0) return embeddedV4(g[6]!, g[7]!);
    // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) — judge the embedded
    // v4; DNS64 networks legitimately return public addresses in this prefix.
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return embeddedV4(g[6]!, g[7]!);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
    if (g[0] === 0x2002) return embeddedV4(g[1]!, g[2]!); // 6to4: embedded v4 tunnel endpoint
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32 — obsolete relay tunneling, embedded v4 obfuscated
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local (RFC 3879)
    if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
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
