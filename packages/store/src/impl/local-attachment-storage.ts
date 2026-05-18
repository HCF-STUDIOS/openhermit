import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { AttachmentStorage } from '../interfaces.js';

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
    await mkdir(path.dirname(target), { recursive: true });

    const hasher = createHash('sha256');
    let bytesSeen = 0;
    input.body.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hasher.update(buf);
      bytesSeen += buf.length;
    });

    await pipeline(input.body, createWriteStream(target));
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
