import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as tar from 'tar';

import type { AttachmentStorage } from '../interfaces.js';
import {
  buildSkillBlobKey,
  toSkillBlobPath,
  type SkillArtifactRef,
} from '../skill-artifacts.js';

/** gzip content-type for skill archives. */
const SKILL_TAR_CONTENT_TYPE = 'application/gzip';

/** sha256 (hex) of a buffer. */
export const sha256Hex = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex');

/**
 * Pack a skill directory into a gzipped tar buffer.
 *
 * `portable: true` strips uid/gid/mtime jitter from tar entries, and node's
 * gzip writes a zeroed header mtime, so identical file contents produce a
 * byte-identical archive — its sha256 is then a stable content fingerprint we
 * can use for dedup (skip re-upload when unchanged).
 */
export const packSkillDir = async (dir: string): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const stream = tar.create({ gzip: true, cwd: dir, portable: true }, ['.']);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

/** Extract a gzipped skill-tar buffer into `destDir` (created if missing). */
export const unpackSkillTar = async (buf: Buffer, destDir: string): Promise<void> => {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract({ cwd: destDir });
    extract.on('finish', resolve);
    extract.on('error', reject);
    extract.end(buf);
  });
};

export interface PutSkillResult {
  /** `blob:`-scheme pointer for `skills.path`. */
  path: string;
  /** Bare storage key (without the `blob:` scheme). */
  storageKey: string;
  /** sha256 of the archive — record in `skills.metadata` for future dedup. */
  sha256: string;
  sizeBytes: number;
  /** True when the prior sha matched and no upload was performed. */
  skipped: boolean;
}

/**
 * Stores skill directories as gzipped tar objects in blob storage, addressed by
 * a deterministic key derived from (source, slug, ownerAgentId). Thin wrapper
 * over `AttachmentStorage.putObject` / `readStream` — the same Local / S3 /
 * Supabase providers used for attachments back it, so no new storage config is
 * introduced.
 */
export class SkillArtifactStore {
  constructor(
    private readonly storage: AttachmentStorage,
    private readonly prefix?: string,
  ) {}

  /** Deterministic storage key for a skill (without the `blob:` scheme). */
  keyFor(ref: SkillArtifactRef): string {
    return buildSkillBlobKey(ref, this.prefix);
  }

  /**
   * Pack `dir` and publish it at the skill's deterministic key, overwriting any
   * existing archive. When `priorSha256` matches the freshly packed archive the
   * upload is skipped and `skipped: true` is returned — the caller can reuse the
   * existing pointer unchanged.
   */
  async putSkill(
    ref: SkillArtifactRef,
    dir: string,
    opts?: { priorSha256?: string },
  ): Promise<PutSkillResult> {
    const buffer = await packSkillDir(dir);
    const sha256 = sha256Hex(buffer);
    const storageKey = this.keyFor(ref);
    if (opts?.priorSha256 && opts.priorSha256 === sha256) {
      return {
        path: toSkillBlobPath(storageKey),
        storageKey,
        sha256,
        sizeBytes: buffer.length,
        skipped: true,
      };
    }
    const result = await this.storage.putObject({
      storageKey,
      contentType: SKILL_TAR_CONTENT_TYPE,
      body: buffer,
    });
    return {
      path: toSkillBlobPath(result.storageKey),
      storageKey: result.storageKey,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
      skipped: false,
    };
  }

  /** Read a skill archive back as a buffer, by storage key. */
  async getArchive(storageKey: string): Promise<Buffer> {
    const stream = await this.storage.readStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }

  /** Fetch a skill archive by storage key and extract it into `destDir`. */
  async restoreTo(storageKey: string, destDir: string): Promise<void> {
    const buffer = await this.getArchive(storageKey);
    await unpackSkillTar(buffer, destDir);
  }

  /** Remove a skill archive by storage key. */
  async deleteArchive(storageKey: string): Promise<void> {
    await this.storage.delete(storageKey);
  }
}
