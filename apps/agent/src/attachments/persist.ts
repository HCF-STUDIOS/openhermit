import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { OpenHermitError } from '@openhermit/shared';
import type { SessionAttachment } from '@openhermit/protocol';
import type {
  AttachmentStorage,
  AttachmentStore,
} from '@openhermit/store';

import type { AgentRunner } from '../agent-runner.js';

import { resolveMimeType, sanitizeName } from './helpers.js';

/**
 * URL-passthrough resolver for inbound `postMessage` attachments shaped as
 * `{ type: 'file', url, mimeType?, name? }`. The gateway fetches the URL
 * server-side, persists the bytes via the same `session_attachments` path as
 * an explicit `/attachments` upload, materializes into the sandbox, and
 * returns an `id`-shaped `SessionAttachment` ready for model context.
 *
 * Errors throw `OpenHermitError('attachment_fetch_failed', 400)` so the whole
 * `postMessage` fails fast — silently dropping the upload is worse than a 4xx
 * the caller can retry. SSRF guards reject non-https and private / loopback
 * / link-local hosts (incl. 169.254.169.254 cloud-metadata).
 */
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

const ALLOWED_PROTOCOLS = new Set(['https:']);

const MAX_REDIRECT_HOPS = 5;

const fail = (message: string, code = 'attachment_fetch_failed'): never => {
  throw new OpenHermitError(message, code, 400);
};

const isBlockedHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // IPv4 literal — block private / loopback / link-local / unspecified.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // includes EC2/GCP metadata
    return false;
  }

  // IPv6 — match common literal forms. Brackets are stripped by URL.hostname.
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA fc00::/7
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
      return true; // link-local fe80::/10
    return false;
  }

  return false;
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
  // Manual redirect follow so the SSRF protocol+host guards run on *every*
  // hop. `redirect: 'follow'` would only validate the initial URL — a 302 to
  // http://169.254.169.254/ would otherwise sneak past.
  const validateHop = (u: URL): void => {
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
      fail(
        `attachment_fetch_failed: protocol "${u.protocol}" not allowed (https only)`,
      );
    }
    if (isBlockedHost(u.hostname)) {
      fail(
        `attachment_fetch_failed: host "${u.hostname}" is not allowed (SSRF guard)`,
      );
    }
  };
  validateHop(parsed);

  const signal = AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS);
  let res: Response;
  let current = parsed;
  let hops = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`attachment_fetch_failed: ${msg} (url=${current.toString()})`);
      throw new Error('unreachable');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      if (hops >= MAX_REDIRECT_HOPS) {
        fail(
          `attachment_fetch_failed: too many redirects (>${MAX_REDIRECT_HOPS})`,
        );
      }
      let next: URL;
      try {
        next = new URL(res.headers.get('location')!, current);
      } catch {
        fail(`attachment_fetch_failed: malformed redirect target`);
        throw new Error('unreachable');
      }
      validateHop(next);
      current = next;
      hops += 1;
      continue;
    }
    break;
  }
  if (!res.ok) {
    fail(
      `attachment_fetch_failed: upstream returned ${res.status} (url=${current.toString()})`,
    );
  }

  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > input.maxBytes) {
      fail(
        `attachment_fetch_failed: content-length ${n} exceeds limit ${input.maxBytes}`,
        'attachment_too_large',
      );
    }
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length === 0) {
    fail(`attachment_fetch_failed: empty response body`);
  }
  if (bytes.length > input.maxBytes) {
    fail(
      `attachment_fetch_failed: body ${bytes.length} exceeds limit ${input.maxBytes}`,
      'attachment_too_large',
    );
  }

  const originalName =
    input.hintName ?? deriveNameFromUrl(parsed) ?? 'upload';
  const safeName = sanitizeName(originalName);
  // Strip `; charset=...` so MIME-only regex in resolveMimeType accepts the
  // server-declared type (e.g. `text/plain; charset=utf-8` → `text/plain`).
  const serverContentType = res.headers
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
