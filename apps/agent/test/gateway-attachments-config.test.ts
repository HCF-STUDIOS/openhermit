import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGatewayConfig } from '../../../apps/gateway/src/config.js';

test('parseGatewayConfig: attachments omitted yields no block (local default at boot)', () => {
  const out = parseGatewayConfig({});
  assert.equal(out.attachments, undefined);
});

test('parseGatewayConfig: attachments local with explicit root', () => {
  const out = parseGatewayConfig({
    attachments: { storage: { provider: 'local', root: '/srv/openhermit/attachments' } },
  });
  assert.deepEqual(out.attachments, {
    storage: { provider: 'local', root: '/srv/openhermit/attachments' },
  });
});

test('parseGatewayConfig: attachments s3 parses required + optional fields', () => {
  const out = parseGatewayConfig({
    attachments: {
      storage: {
        provider: 's3',
        bucket: 'oh-attachments',
        region: 'us-east-1',
        prefix: 'prod',
        endpoint: 'https://abc.r2.cloudflarestorage.com',
        forcePathStyle: true,
        signedUrlExpiresIn: 900,
      },
      limits: { maxBytes: 100_000_000, sandboxCopyMaxBytes: 4_000_000 },
    },
  });
  assert.equal(out.attachments?.storage.provider, 's3');
  assert.deepEqual(out.attachments, {
    storage: {
      provider: 's3',
      bucket: 'oh-attachments',
      region: 'us-east-1',
      prefix: 'prod',
      endpoint: 'https://abc.r2.cloudflarestorage.com',
      forcePathStyle: true,
      signedUrlExpiresIn: 900,
    },
    limits: { maxBytes: 100_000_000, sandboxCopyMaxBytes: 4_000_000 },
  });
});

test('parseGatewayConfig: attachments supabase requires url + bucket', () => {
  const out = parseGatewayConfig({
    attachments: {
      storage: {
        provider: 'supabase',
        url: 'https://xyz.supabase.co',
        bucket: 'attachments',
        prefix: 'agents',
      },
    },
  });
  assert.equal(out.attachments?.storage.provider, 'supabase');
  assert.deepEqual(out.attachments?.storage, {
    provider: 'supabase',
    url: 'https://xyz.supabase.co',
    bucket: 'attachments',
    prefix: 'agents',
  });
});

test('parseGatewayConfig: s3 without bucket fails', () => {
  assert.throws(
    () => parseGatewayConfig({ attachments: { storage: { provider: 's3' } } }),
    /bucket is required/,
  );
});

test('parseGatewayConfig: supabase without url fails', () => {
  assert.throws(
    () =>
      parseGatewayConfig({
        attachments: { storage: { provider: 'supabase', bucket: 'a' } },
      }),
    /url is required/,
  );
});

test('parseGatewayConfig: unknown provider rejected', () => {
  assert.throws(
    () => parseGatewayConfig({ attachments: { storage: { provider: 'gcs' } } }),
    /provider must be one of/,
  );
});

test('parseGatewayConfig: s3 prefix with leading slash is rejected via parser? (allowed for now, validated at impl open)', () => {
  // The parser is loose about prefix shape; S3AttachmentStorage.open()
  // is the place that enforces "no leading/trailing /" with an
  // actionable error. The parser only checks types.
  const out = parseGatewayConfig({
    attachments: { storage: { provider: 's3', bucket: 'b', prefix: 'ok-prefix' } },
  });
  assert.equal(
    (out.attachments?.storage as { prefix?: string }).prefix,
    'ok-prefix',
  );
});

test('parseGatewayConfig: rejects negative or non-integer limits', () => {
  assert.throws(
    () =>
      parseGatewayConfig({
        attachments: {
          storage: { provider: 'local' },
          limits: { maxBytes: -1 },
        },
      }),
    /must be a positive integer/,
  );
  assert.throws(
    () =>
      parseGatewayConfig({
        attachments: {
          storage: { provider: 'local' },
          limits: { sandboxCopyMaxBytes: 1.5 },
        },
      }),
    /must be a positive integer/,
  );
});
