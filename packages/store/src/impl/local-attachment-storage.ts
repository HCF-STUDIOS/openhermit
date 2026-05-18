import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { AttachmentStorage } from '../interfaces.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o644;

export interface LocalAttachmentStorageOptions {
  /**
   * Absolute root directory under which attachments are stored, e.g.
   * `~/.openhermit/attachments`. Created on demand. Object keys are
   * relative to this root.
   */
  root: string;
}

/**
 * Disk-backed `AttachmentStorage`. Lays files out as
 * `<root>/<agentId>/<sessionId>/<attachmentId>/<safeName>` so an
 * operator can `ls` the directory and reason about session ownership.
 * Signed URLs are not meaningful for local disk — `getSignedUrl`
 * returns `null` so callers fall back to streaming.
 */
export class LocalAttachmentStorage implements AttachmentStorage {
  readonly name = 'local';

  constructor(private readonly options: LocalAttachmentStorageOptions) {
    if (!path.isAbsolute(options.root)) {
      throw new Error(`LocalAttachmentStorage root must be absolute: ${options.root}`);
    }
  }

  async put(input: {
    agentId: string;
    sessionId: string;
    attachmentId: string;
    filename: string;
    contentType: string;
    body: NodeJS.ReadableStream;
  }): Promise<{ storageKey: string; sizeBytes: number; sha256: string }> {
    const storageKey = path.posix.join(
      input.agentId,
      input.sessionId,
      input.attachmentId,
      input.filename,
    );
    const target = this.resolveKey(storageKey);
    await this.mkdirWithPerms(path.dirname(target));

    const hasher = createHash('sha256');
    let bytesSeen = 0;
    input.body.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hasher.update(buf);
      bytesSeen += buf.length;
    });

    await pipeline(input.body, createWriteStream(target, { mode: FILE_MODE }));
    await chmod(target, FILE_MODE);
    const stats = await stat(target);
    // Prefer the on-disk size; bytesSeen is a sanity check.
    if (stats.size !== bytesSeen) {
      throw new Error(
        `LocalAttachmentStorage size mismatch for ${storageKey}: streamed ${bytesSeen} but wrote ${stats.size}`,
      );
    }
    return {
      storageKey,
      sizeBytes: stats.size,
      sha256: hasher.digest('hex'),
    };
  }

  async readStream(storageKey: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.resolveKey(storageKey));
  }

  async getSignedUrl(): Promise<string | null> {
    return null;
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.resolveKey(storageKey), { force: true });
  }

  /**
   * Create the directory chain under root with 0o700 perms. Walks
   * the relative tail of the path so we set perms on the directories
   * we own (one per agent/session/attachment level), without trying
   * to chmod the user's home directory.
   */
  private async mkdirWithPerms(target: string): Promise<void> {
    const rootResolved = path.resolve(this.options.root);
    await mkdir(rootResolved, { recursive: true, mode: DIR_MODE });
    const rel = path.relative(rootResolved, target);
    if (!rel || rel.startsWith('..')) return;
    const parts = rel.split(path.sep);
    let cur = rootResolved;
    for (const part of parts) {
      cur = path.join(cur, part);
      await mkdir(cur, { recursive: true, mode: DIR_MODE });
      try {
        await chmod(cur, DIR_MODE);
      } catch {
        // best-effort — perms tighten on disk-backed dev only
      }
    }
  }

  private resolveKey(storageKey: string): string {
    // Defence in depth: storage keys are server-generated, but reject
    // any traversal in case a future caller plumbs a user value
    // through.
    if (storageKey.includes('..')) {
      throw new Error(`LocalAttachmentStorage rejects key with traversal: ${storageKey}`);
    }
    const resolved = path.resolve(this.options.root, storageKey);
    const rootResolved = path.resolve(this.options.root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`LocalAttachmentStorage key escapes root: ${storageKey}`);
    }
    return resolved;
  }
}
