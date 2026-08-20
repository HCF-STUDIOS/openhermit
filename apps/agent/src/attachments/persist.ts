import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { OpenHermitError } from '@openhermit/shared';
import type { SessionAttachment } from '@openhermit/protocol';
import type {
  AttachmentStorage,
  AttachmentStore,
} from '@openhermit/store';

import type { AgentRunner } from '../agent-runner.js';

import { SafeFetchError, safeFetch } from '../network/safe-fetch.js';

import { resolveMimeType, sanitizeName } from './helpers.js';
import { type HostResolver } from './ssrf.js';

/**
 * URL-passthrough resolver for inbound `postMessage` attachments shaped as
 * `{ type: 'file', url, mimeType?, name? }`. The gateway fetches the URL
 * server-side, persists the bytes via the same `session_attachments` path as
 * an explicit `/attachments` upload, materializes into the sandbox, and
 * returns an `id`-shaped `SessionAttachment` ready for model context.
 *
 * Errors throw `OpenHermitError('attachment_fetch_failed', 400)` so the whole
 * `postMessage` fails fast — silently dropping the upload is worse than a 4xx
 * the caller can retry. SSRF guards reject non-https URLs, IP-literal hosts in
 * private / loopback / link-local / metadata ranges, and — crucially — any
 * hostname that *resolves* to such an address. Resolution, validation, and
 * connection are pinned to the same address (see `./ssrf.ts`), so a domain
 * that aliases to 127.0.0.1 / 169.254.169.254 or rebinds mid-request cannot
 * smuggle a request to an internal target. Per-hop checks cover redirects.
 */
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

const ALLOWED_PROTOCOLS: readonly string[] = ['https:'];

const MAX_REDIRECT_HOPS = 5;

const fail = (message: string, code = 'attachment_fetch_failed'): never => {
  throw new OpenHermitError(message, code, 400);
};

const deriveNameFromUrl = (url: URL): string | undefined => {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

export interface ResolveAttachmentByUrlInput {
  agentId: string;
  sessionId: string;
  uploaderUserId: string | null;
  url: string;
  hintMimeType?: string | undefined;
  hintName?: string | undefined;
  maxBytes: number;
  attachmentStore: AttachmentStore;
  attachmentStorage: AttachmentStorage;
  runtime: AgentRunner;
  logger?: ((message: string) => void) | undefined;
  /**
   * Hostname → resolved IPs. Injectable for tests; defaults to a real DNS
   * lookup. The same resolver drives the connection-pinning dispatcher, so a
   * stub here exercises the full SSRF path deterministically.
   */
  resolveHost?: HostResolver | undefined;
}

export const resolveAttachmentByUrl = async (
  input: ResolveAttachmentByUrlInput,
): Promise<SessionAttachment> => {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    fail(`attachment_fetch_failed: malformed URL`);
    throw new Error('unreachable');
  }

  // The shared SSRF-safe fetch primitive re-validates protocol + host on every
  // redirect hop and pins DNS resolution to the validated address (see
  // ../network/safe-fetch.ts and ./ssrf.ts). Attachments stay https-only.
  let fetched: Awaited<ReturnType<typeof safeFetch>>;
  try {
    fetched = await safeFetch(input.url, {
      allowedProtocols: ALLOWED_PROTOCOLS,
      maxRedirects: MAX_REDIRECT_HOPS,
      timeoutMs: ATTACHMENT_FETCH_TIMEOUT_MS,
      maxBytes: input.maxBytes,
      onOversize: 'error',
      resolveHost: input.resolveHost,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      if (err.reason === 'body_too_large') {
        fail(`attachment_fetch_failed: ${err.message}`, 'attachment_too_large');
      }
      if (err.reason === 'protocol_not_allowed') {
        fail(
          `attachment_fetch_failed: protocol "${parsed.protocol}" not allowed (https only)`,
        );
      }
      fail(`attachment_fetch_failed: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    fail(`attachment_fetch_failed: ${msg}`);
    throw new Error('unreachable');
  }

  if (fetched.status < 200 || fetched.status >= 300) {
    fail(
      `attachment_fetch_failed: upstream returned ${fetched.status} (url=${fetched.finalUrl})`,
    );
  }

  const bytes = fetched.body;
  if (bytes.length === 0) {
    fail(`attachment_fetch_failed: empty response body`);
  }

  const originalName =
    input.hintName ?? deriveNameFromUrl(parsed) ?? 'upload';
  const safeName = sanitizeName(originalName);
  // Strip `; charset=...` so MIME-only regex in resolveMimeType accepts the
  // server-declared type (e.g. `text/plain; charset=utf-8` → `text/plain`).
  const serverContentType = fetched.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim();
  const mimeType = resolveMimeType(
    bytes,
    safeName,
    serverContentType || input.hintMimeType,
  );

  return persistAttachmentBytes({
    agentId: input.agentId,
    sessionId: input.sessionId,
    uploaderUserId: input.uploaderUserId,
    originalName,
    safeName,
    mimeType,
    bytes,
    attachmentStore: input.attachmentStore,
    attachmentStorage: input.attachmentStorage,
    runtime: input.runtime,
    logger: input.logger,
  });
};

/**
 * Walk a `SessionMessage.attachments[]` array and resolve any entry shaped as
 * `{ url, !id }` via the URL-passthrough path. Existing `id`-shape entries
 * pass through untouched. The returned array preserves order.
 *
 * If `payload.attachments` has no URL-only entries, returns the input
 * untouched without contacting storage — keeping the hot path cheap.
 */
export const resolveInboundAttachments = async (
  attachments: SessionAttachment[] | undefined,
  base: Omit<ResolveAttachmentByUrlInput, 'url' | 'hintMimeType' | 'hintName'>,
): Promise<SessionAttachment[] | undefined> => {
  if (!attachments || attachments.length === 0) return attachments;
  if (!attachments.some((a) => !a.id && typeof a.url === 'string' && a.url.length > 0)) {
    return attachments;
  }

  const resolved: SessionAttachment[] = [];
  for (const att of attachments) {
    if (!att.id && typeof att.url === 'string' && att.url.length > 0) {
      const r = await resolveAttachmentByUrl({
        ...base,
        url: att.url,
        hintMimeType: att.mimeType,
        hintName: att.name,
      });
      resolved.push(r);
    } else {
      resolved.push(att);
    }
  }
  return resolved;
};

export interface PersistAttachmentFromPathInput {
  agentId: string;
  sessionId: string;
  uploaderUserId: string | null;
  /** Path inside the sandbox to upload — read via the runtime's file backend. */
  sandboxRelativePath: string;
  /** Optional display name override. Defaults to the basename of the path. */
  name?: string | undefined;
  /** Hard cap; bytes larger than this throw `attachment_too_large`. */
  maxBytes: number;
  attachmentStore: AttachmentStore;
  attachmentStorage: AttachmentStorage;
  runtime: AgentRunner;
  logger?: ((message: string) => void) | undefined;
}

/**
 * Read a file out of the running session's sandbox and persist it through the
 * same pipeline as URL passthrough. Used by `attachment_upload` so an agent
 * can publish a sandbox-generated file (image, audio) to durable storage and
 * get back a wire-shaped attachment with `id` and `sandboxPath`.
 */
export const persistAttachmentFromSandbox = async (
  input: PersistAttachmentFromPathInput,
): Promise<SessionAttachment> => {
  const rawPath = input.sandboxRelativePath.trim();
  if (rawPath.length === 0) {
    throw new OpenHermitError(
      'attachment_upload_failed: path is required',
      'attachment_upload_failed',
      400,
    );
  }

  let bytes: Buffer;
  try {
    const result = await input.runtime.readSandboxFile({
      sessionId: input.sessionId,
      path: rawPath,
      maxBytes: input.maxBytes,
    });
    bytes = result.bytes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpenHermitError(
      `attachment_upload_failed: ${msg}`,
      'attachment_upload_failed',
      400,
    );
  }

  if (bytes.length === 0) {
    throw new OpenHermitError(
      'attachment_upload_failed: file is empty',
      'attachment_upload_failed',
      400,
    );
  }
  if (bytes.length > input.maxBytes) {
    throw new OpenHermitError(
      `attachment_upload_failed: ${bytes.length} bytes exceeds limit ${input.maxBytes}`,
      'attachment_too_large',
      400,
    );
  }

  const basename = rawPath.split(/[\\/]/).pop() || 'upload';
  const originalName = input.name ?? basename;
  const safeName = sanitizeName(originalName);
  const mimeType = resolveMimeType(bytes, safeName, undefined);

  return persistAttachmentBytes({
    agentId: input.agentId,
    sessionId: input.sessionId,
    uploaderUserId: input.uploaderUserId,
    originalName,
    safeName,
    mimeType,
    bytes,
    attachmentStore: input.attachmentStore,
    attachmentStorage: input.attachmentStorage,
    runtime: input.runtime,
    logger: input.logger,
  });
};

interface PersistAttachmentBytesInput {
  agentId: string;
  sessionId: string;
  uploaderUserId: string | null;
  originalName: string;
  safeName: string;
  mimeType: string;
  bytes: Buffer;
  attachmentStore: AttachmentStore;
  attachmentStorage: AttachmentStorage;
  runtime: AgentRunner;
  logger?: ((message: string) => void) | undefined;
}

const persistAttachmentBytes = async (
  input: PersistAttachmentBytesInput,
): Promise<SessionAttachment> => {
  const attachmentId = `att_${randomUUID().replace(/-/g, '')}`;
  const putResult = await input.attachmentStorage.put({
    agentId: input.agentId,
    sessionId: input.sessionId,
    attachmentId,
    filename: input.safeName,
    contentType: input.mimeType,
    body: Readable.from(input.bytes),
  });

  // If the metadata create fails after a successful blob put, the bytes
  // would be orphaned in storage forever. Best-effort compensating delete
  // before re-throwing so callers see the real error.
  let record;
  try {
    record = await input.attachmentStore.create({
      id: attachmentId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      uploaderUserId: input.uploaderUserId,
      originalName: input.originalName,
      safeName: input.safeName,
      mimeType: input.mimeType,
      sizeBytes: putResult.sizeBytes,
      sha256: putResult.sha256,
      storageProvider: input.attachmentStorage.name,
      storageKey: putResult.storageKey,
    });
  } catch (createErr) {
    try {
      await input.attachmentStorage.delete(putResult.storageKey);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      input.logger?.(
        `[attachments-persist] failed to clean up orphan blob ${putResult.storageKey} after metadata create failure: ${msg}`,
      );
    }
    throw createErr;
  }

  let sandboxPath: string | undefined;
  let materializationState: 'copied' | 'failed' = 'copied';
  try {
    const m = await input.runtime.materializeAttachmentToSandbox({
      sessionId: input.sessionId,
      attachmentId,
      safeName: input.safeName,
      bytes: input.bytes,
    });
    sandboxPath = m.sandboxPath;
    await input.attachmentStore.setMaterialization(attachmentId, {
      sandboxId: m.sandboxId,
      sandboxPath: m.sandboxPath,
      state: 'copied',
    });
  } catch (err) {
    materializationState = 'failed';
    const msg = err instanceof Error ? err.message : String(err);
    input.logger?.(
      `[attachments-persist] materialization failed for ${attachmentId}: ${msg}`,
    );
    await input.attachmentStore.setMaterialization(attachmentId, {
      state: 'failed',
      error: msg,
    });
  }

  return {
    id: record.id,
    type: 'file',
    name: record.originalName,
    mimeType: input.mimeType,
    size: putResult.sizeBytes,
    sha256: putResult.sha256,
    ...(sandboxPath ? { sandboxPath } : {}),
    materializationState,
  };
};
