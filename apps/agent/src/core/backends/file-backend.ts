import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat as fsStat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { NotFoundError, ValidationError } from '@openhermit/shared';

// ── Types ────────────────────────────────────────────────────────────────

export type FileWriteMode = 'create' | 'overwrite' | 'append';

export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
  size?: number;
}

export interface FileStat {
  type: 'file' | 'directory' | 'other';
  size: number;
  /** ISO timestamp of last modification. */
  mtime: string;
}

export interface FileReadResult {
  /** Raw bytes. Encode for transport at the tool layer. */
  data: Buffer;
}

export interface FileBackend {
  /**
   * Read a file. Paths are interpreted as the agent sees them inside the
   * sandbox (container-side). Throws if the path doesn't exist.
   */
  read(filePath: string): Promise<FileReadResult>;
  write(filePath: string, data: Buffer, mode: FileWriteMode): Promise<void>;
  list(dirPath: string): Promise<DirEntry[]>;
  /** Returns null if the path does not exist. */
  stat(filePath: string): Promise<FileStat | null>;
  delete(filePath: string): Promise<void>;
}

// ── Shared helpers ───────────────────────────────────────────────────────

/** Map a fs.stat to our DirEntry/FileStat type tag. */
const fileTypeOf = (s: { isFile(): boolean; isDirectory(): boolean }): 'file' | 'directory' | 'other' =>
  s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other';

/** Reject empty / relative / traversal-y paths. We require absolute, normalised. */
export const requireAbsolutePath = (p: string): string => {
  if (!p || typeof p !== 'string') {
    throw new ValidationError('path must be a non-empty string.');
  }
  if (!path.posix.isAbsolute(p)) {
    throw new ValidationError(`path must be absolute (got "${p}").`);
  }
  const normalised = path.posix.normalize(p);
  if (normalised.includes('/../')) {
    throw new ValidationError(`path must not contain ".." segments (got "${p}").`);
  }
  return normalised;
};

// ── HostFileBackend ──────────────────────────────────────────────────────

/**
 * Operates directly on a local filesystem rooted at `root`.
 * Used by:
 *   - the `host` exec backend (root = agentHome)
 *   - the `docker` exec backend with bind-mount (root = workspaceDir on host,
 *     mapped to agentHome inside the container)
 *
 * The agent always speaks in container-side paths (e.g. `/root/foo`); this
 * class translates them to host paths via `containerRoot` → `hostRoot`.
 */
export class HostFileBackend implements FileBackend {
  private realHostRoot: string | null = null;

  constructor(
    private readonly hostRoot: string,
    private readonly containerRoot: string,
  ) {}

  private async getRealHostRoot(): Promise<string> {
    if (this.realHostRoot === null) {
      this.realHostRoot = await realpath(this.hostRoot);
    }
    return this.realHostRoot;
  }

  /** Translate a container-side path to a host-side absolute path. */
  private translate(containerPath: string): string {
    const abs = requireAbsolutePath(containerPath);
    if (abs !== this.containerRoot && !abs.startsWith(`${this.containerRoot}/`)) {
      throw new ValidationError(
        `path "${abs}" is outside the sandbox root "${this.containerRoot}". File tools only see paths under the agent's home; for system files use exec.`,
      );
    }
    if (this.hostRoot === this.containerRoot) {
      return abs;
    }
    const rel = abs === this.containerRoot ? '' : abs.slice(this.containerRoot.length + 1);
    return rel ? path.join(this.hostRoot, rel) : this.hostRoot;
  }

  /**
   * Translate + realpath boundary check. Resolves symlinks and verifies
   * the real path still falls within hostRoot, preventing symlink escape.
   * For write operations on new files, checks the parent directory instead.
   */
  private async resolve(containerPath: string, mustExist = true): Promise<string> {
    const hostPath = this.translate(containerPath);
    const root = await this.getRealHostRoot();
    let real: string;
    try {
      real = await realpath(hostPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist) {
        const parent = path.dirname(hostPath);
        try {
          const realParent = await realpath(parent);
          if (realParent !== root && !realParent.startsWith(`${root}/`)) {
            throw new ValidationError(
              `path resolves outside the sandbox root (symlink escape in parent directory).`,
            );
          }
        } catch (parentErr) {
          if (parentErr instanceof ValidationError) throw parentErr;
        }
        return hostPath;
      }
      throw err;
    }
    if (real !== root && !real.startsWith(`${root}/`)) {
      throw new ValidationError(
        `path resolves outside the sandbox root (symlink escape detected).`,
      );
    }
    return real;
  }

  async read(filePath: string): Promise<FileReadResult> {
    const resolved = await this.resolve(filePath);
    try {
      const data = await readFile(resolved);
      return { data };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`File not found: ${filePath}`);
      }
      throw err;
    }
  }

  async write(filePath: string, data: Buffer, mode: FileWriteMode): Promise<void> {
    const resolved = await this.resolve(filePath, false);
    await mkdir(path.dirname(resolved), { recursive: true });
    if (mode === 'create') {
      try {
        await writeFile(resolved, data, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ValidationError(`File already exists (mode=create): ${filePath}`);
        }
        throw err;
      }
    } else if (mode === 'append') {
      await appendFile(resolved, data);
    } else {
      await writeFile(resolved, data);
    }
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    const resolved = await this.resolve(dirPath);
    let entries;
    try {
      entries = await readdir(resolved, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Directory not found: ${dirPath}`);
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        throw new ValidationError(`Not a directory: ${dirPath}`);
      }
      throw err;
    }
    const result: DirEntry[] = [];
    for (const e of entries) {
      const entryPath = path.join(resolved, e.name);
      let size: number | undefined;
      if (e.isFile()) {
        try {
          size = (await fsStat(entryPath)).size;
        } catch {
          // skip — entry may have been removed between readdir and stat
        }
      }
      result.push({
        name: e.name,
        type: fileTypeOf(e),
        ...(size !== undefined ? { size } : {}),
      });
    }
    return result;
  }

  async stat(filePath: string): Promise<FileStat | null> {
    let resolved: string;
    try {
      resolved = await this.resolve(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const s = await fsStat(resolved);
      return {
        type: fileTypeOf(s),
        size: s.size,
        mtime: s.mtime.toISOString(),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(filePath: string): Promise<void> {
    const resolved = await this.resolve(filePath);
    try {
      await unlink(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`File not found: ${filePath}`);
      }
      if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
        throw new ValidationError(`Refusing to delete a directory (file_delete is single-file only): ${filePath}`);
      }
      throw err;
    }
  }
}

// ── E2BFileBackend ───────────────────────────────────────────────────────

/**
 * Delegates to the e2b SDK's `sandbox.files.*` methods.
 * The sandbox handle is lazily provided after `ensure()`.
 */
export class E2BFileBackend implements FileBackend {
  sandbox: import('e2b').Sandbox | null = null;
  ensureSandbox: (() => Promise<void>) | null = null;

  private get sb(): import('e2b').Sandbox {
    if (!this.sandbox) throw new ValidationError('E2B sandbox is not connected. Call ensure() first.');
    return this.sandbox;
  }

  private async ready(): Promise<void> {
    if (!this.sandbox && this.ensureSandbox) await this.ensureSandbox();
  }

  async read(filePath: string): Promise<FileReadResult> {
    requireAbsolutePath(filePath);
    await this.ready();
    const bytes = await this.sb.files.read(filePath, { format: 'bytes' });
    return { data: Buffer.from(bytes) };
  }

  async write(filePath: string, data: Buffer, mode: FileWriteMode): Promise<void> {
    requireAbsolutePath(filePath);
    await this.ready();
    if (mode === 'create') {
      const exists = await this.sb.files.exists(filePath);
      if (exists) throw new ValidationError(`File already exists (mode=create): ${filePath}`);
    }
    if (mode === 'append') {
      let existing = Buffer.alloc(0);
      try {
        const bytes = await this.sb.files.read(filePath, { format: 'bytes' });
        existing = Buffer.from(bytes);
      } catch {
        // File doesn't exist — append acts like create.
      }
      const buf = Buffer.concat([existing, data]);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      await this.sb.files.write(filePath, ab);
    } else {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await this.sb.files.write(filePath, ab);
    }
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    requireAbsolutePath(dirPath);
    await this.ready();
    const entries = await this.sb.files.list(dirPath);
    return entries.map((e) => ({
      name: e.name,
      type: e.type === 'dir' ? 'directory' as const : e.type === 'file' ? 'file' as const : 'other' as const,
      ...(e.type === 'file' ? { size: e.size } : {}),
    }));
  }

  async stat(filePath: string): Promise<FileStat | null> {
    requireAbsolutePath(filePath);
    await this.ready();
    try {
      const info = await this.sb.files.getInfo(filePath);
      return {
        type: info.type === 'dir' ? 'directory' : info.type === 'file' ? 'file' : 'other',
        size: info.size,
        mtime: info.modifiedTime ? info.modifiedTime.toISOString() : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  async delete(filePath: string): Promise<void> {
    requireAbsolutePath(filePath);
    await this.ready();
    await this.sb.files.remove(filePath);
  }
}

// ── DaytonaFileBackend ───────────────────────────────────────────────────

/**
 * Delegates to `sandbox.fs.*` methods.
 * The sandbox handle is lazily provided after `ensure()`.
 */
export class DaytonaFileBackend implements FileBackend {
  sandbox: import('@daytonaio/sdk').Sandbox | null = null;
  ensureSandbox: (() => Promise<void>) | null = null;

  private get sb(): import('@daytonaio/sdk').Sandbox {
    if (!this.sandbox) throw new ValidationError('Daytona sandbox is not connected. Call ensure() first.');
    return this.sandbox;
  }

  private async ready(): Promise<void> {
    if (!this.sandbox && this.ensureSandbox) await this.ensureSandbox();
  }

  async read(filePath: string): Promise<FileReadResult> {
    requireAbsolutePath(filePath);
    await this.ready();
    const raw = await this.sb.fs.downloadFile(filePath);
    return { data: Buffer.from(raw) };
  }

  async write(filePath: string, data: Buffer, mode: FileWriteMode): Promise<void> {
    requireAbsolutePath(filePath);
    await this.ready();
    const dir = path.posix.dirname(filePath);
    if (dir !== '/') {
      try { await this.sb.fs.createFolder(dir, '755'); } catch { /* may exist */ }
    }
    if (mode === 'create') {
      try {
        await this.sb.fs.getFileDetails(filePath);
        throw new ValidationError(`File already exists (mode=create): ${filePath}`);
      } catch (err) {
        if (err instanceof ValidationError) throw err;
      }
    }
    if (mode === 'append') {
      let existing = Buffer.alloc(0);
      try {
        const raw = await this.sb.fs.downloadFile(filePath);
        existing = Buffer.from(raw);
      } catch {
        // File doesn't exist — append acts like create.
      }
      await this.sb.fs.uploadFile(Buffer.concat([existing, data]), filePath);
    } else {
      await this.sb.fs.uploadFile(data, filePath);
    }
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    requireAbsolutePath(dirPath);
    await this.ready();
    const entries = await this.sb.fs.listFiles(dirPath);
    return entries.map((e) => ({
      name: e.name,
      type: e.isDir ? 'directory' as const : 'file' as const,
      ...(!e.isDir ? { size: e.size } : {}),
    }));
  }

  async stat(filePath: string): Promise<FileStat | null> {
    requireAbsolutePath(filePath);
    await this.ready();
    try {
      const info = await this.sb.fs.getFileDetails(filePath);
      return {
        type: info.isDir ? 'directory' : 'file',
        size: info.size,
        mtime: info.modTime,
      };
    } catch {
      return null;
    }
  }

  async delete(filePath: string): Promise<void> {
    requireAbsolutePath(filePath);
    await this.ready();
    await this.sb.fs.deleteFile(filePath);
  }
}
