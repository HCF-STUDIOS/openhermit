import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { OpenHermitError } from '@openhermit/shared';

import { resolveAttachmentByUrl } from '../src/attachments/index.js';
import {
  isBlockedAddress,
  isBlockedLiteralHost,
  makeSsrfLookup,
  type HostResolver,
} from '../src/attachments/ssrf.js';

// ─── isBlockedAddress: resolved IP literals ───────────────────────────────

test('isBlockedAddress: blocks private / loopback / link-local / metadata v4', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '224.0.0.1', // multicast
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedAddress: allows routable public v4', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test('isBlockedAddress: blocks v6 loopback / ULA / link-local / mapped-v4', () => {
  for (const ip of [
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0', // zone id stripped
    '::ffff:127.0.0.1', // IPv4-mapped, dotted
    '::ffff:7f00:1', // IPv4-mapped, hex form (== 127.0.0.1)
    '::ffff:a9fe:a9fe', // 169.254.169.254
    'ff02::1', // multicast
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedAddress: allows public v6 and mapped-public-v4', () => {
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('isBlockedAddress: fails closed on garbage', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress(''), true);
});

// ─── isBlockedLiteralHost: URL.hostname forms ─────────────────────────────

test('isBlockedLiteralHost: strips IPv6 brackets (regression: [::1] bypass)', () => {
  // URL.hostname keeps the brackets; the old guard compared against "::1" and
  // never matched, so https://[::1]/ reached fetch. This locks that shut.
  assert.equal(isBlockedLiteralHost('[::1]'), true);
  assert.equal(isBlockedLiteralHost('[fe80::1]'), true);
  assert.equal(isBlockedLiteralHost('[::ffff:127.0.0.1]'), true);
});

test('isBlockedLiteralHost: blocks localhost and numeric IPv4 literals', () => {
  assert.equal(isBlockedLiteralHost('localhost'), true);
  assert.equal(isBlockedLiteralHost('foo.localhost'), true);
  assert.equal(isBlockedLiteralHost('127.0.0.1'), true);
  assert.equal(isBlockedLiteralHost('169.254.169.254'), true);
});

test('isBlockedLiteralHost: passes ordinary hostnames (resolved later)', () => {
  // Not a literal IP — the dispatcher lookup validates it post-resolution.
  assert.equal(isBlockedLiteralHost('cdn.example.com'), false);
  assert.equal(isBlockedLiteralHost('8.8.8.8.nip.io'), false);
});

// ─── makeSsrfLookup: resolve → validate → pin ─────────────────────────────

const runLookup = (
  resolver: HostResolver,
  hostname: string,
  options: { all?: boolean } = {},
): Promise<{ err: Error | null; address?: unknown; family?: number }> =>
  new Promise((resolve) => {
    makeSsrfLookup(resolver)(hostname, options, (err, address, family) => {
      // Build conditionally: under exactOptionalPropertyTypes an explicit
      // `address: undefined` is not assignable to an optional `address?`.
      const out: { err: Error | null; address?: unknown; family?: number } = {
        err: err ?? null,
      };
      if (address !== undefined) out.address = address;
      if (family !== undefined) out.family = family;
      resolve(out);
    });
  });

test('makeSsrfLookup: rejects a host that resolves to a blocked address (DNS alias)', async () => {
  const r = await runLookup(async () => ['169.254.169.254'], 'metadata.evil.test');
  assert.ok(r.err, 'expected an error');
  assert.match(r.err!.message, /SSRF guard/);
  assert.match(r.err!.message, /169\.254\.169\.254/);
});

test('makeSsrfLookup: rejects when ANY resolved address is blocked', async () => {
  const r = await runLookup(
    async () => ['93.184.216.34', '127.0.0.1'],
    'mixed.evil.test',
  );
  assert.ok(r.err, 'one blocked address must reject the whole set');
});

test('makeSsrfLookup: rejects empty resolution', async () => {
  const r = await runLookup(async () => [], 'void.test');
  assert.ok(r.err);
  assert.match(r.err!.message, /no DNS records/);
});

test('makeSsrfLookup: pins the validated public address (single form)', async () => {
  const r = await runLookup(async () => ['93.184.216.34'], 'cdn.example.com');
  assert.equal(r.err, null);
  assert.equal(r.address, '93.184.216.34');
  assert.equal(r.family, 4);
});

test('makeSsrfLookup: returns all validated addresses when options.all', async () => {
  const r = await runLookup(
    async () => ['93.184.216.34', '2606:4700::1111'],
    'cdn.example.com',
    { all: true },
  );
  assert.equal(r.err, null);
  assert.deepEqual(r.address, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700::1111', family: 6 },
  ]);
});

// ─── End-to-end through resolveAttachmentByUrl (injected resolver) ─────────

// The fetch is refused at connect, so persistence is never reached. These
// stubs throw if touched — proving no bytes are ever stored — and let the test
// run without a database.
const unreachable = (label: string) =>
  new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(`${label} must not be reached when connect is blocked`);
        };
      },
    },
  );

test('resolveAttachmentByUrl: DNS-alias host (public name → private IP) is blocked at connect', async () => {
  // A perfectly ordinary-looking hostname that we make resolve to loopback.
  // It clears the literal-host pre-filter, then the pinned dispatcher lookup
  // refuses to connect — no socket to an internal target is ever opened.
  const resolveHost: HostResolver = async () => ['127.0.0.1'];

  await assert.rejects(
    () =>
      resolveAttachmentByUrl({
        agentId: `t-${randomUUID().slice(0, 8)}`,
        sessionId: `s-${randomUUID().slice(0, 8)}`,
        uploaderUserId: null,
        url: 'https://images.totally-legit-cdn.test/cat.png',
        maxBytes: 1024 * 1024,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attachmentStore: unreachable('attachmentStore') as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attachmentStorage: unreachable('attachmentStorage') as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: unreachable('runtime') as any,
        resolveHost,
      }),
    (err: unknown) =>
      err instanceof OpenHermitError && err.code === 'attachment_fetch_failed',
  );
});
