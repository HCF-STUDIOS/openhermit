import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  S3AttachmentStorage,
  SupabaseAttachmentStorage,
} from '@openhermit/store';

// These tests assert validation / option handling that doesn't require
// the real SDK packages to be installed. The factories load the SDK
// lazily, so calling `open()` will throw with our actionable message in
// CI where the optional deps aren't installed — that's part of the
// contract.

test('S3AttachmentStorage.open: missing bucket rejected', async () => {
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => S3AttachmentStorage.open({} as any),
    /bucket.*required/i,
  );
});

test('S3AttachmentStorage.open: prefix with leading slash rejected', async () => {
  await assert.rejects(
    () => S3AttachmentStorage.open({ bucket: 'b', prefix: '/bad' }),
    /must not start or end with/,
  );
});

test('S3AttachmentStorage.open: actionable error when SDK missing', async () => {
  // The optional dep is intentionally not installed in store/. The open()
  // call should surface a clear "install ..." message rather than a raw
  // module-not-found.
  try {
    await S3AttachmentStorage.open({ bucket: 'b', region: 'us-east-1' });
    assert.fail('expected open() to throw because @aws-sdk/client-s3 is not installed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /@aws-sdk\/client-s3/);
  }
});

test('SupabaseAttachmentStorage.open: missing url rejected (no env, no option)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    await assert.rejects(
      () => SupabaseAttachmentStorage.open({ bucket: 'b' }),
      /SUPABASE_URL/,
    );
  } finally {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
  }
});

test('SupabaseAttachmentStorage.open: missing bucket rejected', async () => {
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => SupabaseAttachmentStorage.open({ url: 'https://x.supabase.co' } as any),
    /bucket.*required/i,
  );
});

test('SupabaseAttachmentStorage.open: missing service-role key rejected', async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await assert.rejects(
      () => SupabaseAttachmentStorage.open({ url: 'https://x.supabase.co', bucket: 'b' }),
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  } finally {
    if (prev !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test('SupabaseAttachmentStorage.open: actionable error when SDK missing', async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-test-key';
  try {
    await SupabaseAttachmentStorage.open({
      url: 'https://x.supabase.co',
      bucket: 'b',
    });
    assert.fail('expected open() to throw because @supabase/supabase-js is not installed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /@supabase\/supabase-js/);
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test('SupabaseAttachmentStorage.open: accepts new OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY', async () => {
  const prevRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevSecret = process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY = 'sb_secret_fake';
  try {
    // Gets past the key check and fails only because the SDK isn't installed.
    await SupabaseAttachmentStorage.open({ url: 'https://x.supabase.co', bucket: 'b' });
    assert.fail('expected open() to throw because @supabase/supabase-js is not installed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /@supabase\/supabase-js/);
  } finally {
    if (prevRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevRole;
    if (prevSecret === undefined) delete process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY;
    else process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY = prevSecret;
  }
});

test('SupabaseAttachmentStorage.open: deprecated OPENHERMIT_ATTACHMENT_SUPABASE_SERVICE_KEY still works + warns', async () => {
  const prevRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevSecret = process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY;
  const prevLegacy = process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY;
  process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SERVICE_KEY = 'legacy-jwt-key';
  const origWarn = console.warn;
  let warned = '';
  console.warn = (msg?: unknown) => {
    warned += String(msg);
  };
  try {
    await SupabaseAttachmentStorage.open({ url: 'https://x.supabase.co', bucket: 'b' });
    assert.fail('expected open() to throw because @supabase/supabase-js is not installed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /@supabase\/supabase-js/);
    assert.match(warned, /OPENHERMIT_ATTACHMENT_SUPABASE_SERVICE_KEY is deprecated/);
  } finally {
    console.warn = origWarn;
    if (prevRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevRole;
    if (prevSecret === undefined) delete process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY;
    else process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SECRET_KEY = prevSecret;
    if (prevLegacy === undefined) delete process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SERVICE_KEY;
    else process.env.OPENHERMIT_ATTACHMENT_SUPABASE_SERVICE_KEY = prevLegacy;
  }
});
