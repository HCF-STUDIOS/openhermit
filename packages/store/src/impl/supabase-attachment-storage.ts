import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { AttachmentStorage } from '../interfaces.js';

export interface SupabaseAttachmentStorageOptions {
  /** Supabase project URL, e.g. `https://xyz.supabase.co`. */
  url: string;
  /** Storage bucket name. Must exist; this provider does not create it. */
  bucket: string;
  /** Optional key prefix within the bucket. No leading/trailing slashes. */
  prefix?: string;
  /** Default expiry for `getSignedUrl` when caller passes nothing. */
  signedUrlExpiresIn?: number;
  /**
   * Service-role key. If omitted, read from `SUPABASE_SERVICE_ROLE_KEY`.
   * Provided as an option for testability — operators should set the env
   * var, not put the key in gateway config.
   */
  serviceRoleKey?: string;
}

interface SupabaseBucketApi {
  upload(
    path: string,
    body: Buffer,
    options: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: unknown; error: { message: string } | null }>;
  download(path: string): Promise<{ data: unknown; error: { message: string } | null }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
}

interface SupabaseStorageClient {
  from(bucket: string): SupabaseBucketApi;
}

interface SupabaseClient {
  storage: SupabaseStorageClient;
}

interface SupabaseSdkModule {
  createClient: (
    url: string,
    key: string,
    options?: Record<string, unknown>,
  ) => SupabaseClient;
}

/**
 * Supabase-Storage-backed `AttachmentStorage`. The service role key must
 * be supplied via `SUPABASE_SERVICE_ROLE_KEY` (env) — gateway config
 * only carries the bucket pointer and project URL. Signed URLs are
 * supported and used by `attachment_fetch` for short-lived inline links.
 */
export class SupabaseAttachmentStorage implements AttachmentStorage {
  readonly name = 'supabase';

  private constructor(
    private readonly client: SupabaseClient,
    private readonly options: SupabaseAttachmentStorageOptions,
  ) {}

  static async open(
    options: SupabaseAttachmentStorageOptions,
  ): Promise<SupabaseAttachmentStorage> {
    if (!options.url) throw new Error('SupabaseAttachmentStorage: `url` is required');
    if (!options.bucket) throw new Error('SupabaseAttachmentStorage: `bucket` is required');
    if (options.prefix && (options.prefix.startsWith('/') || options.prefix.endsWith('/'))) {
      throw new Error(
        `SupabaseAttachmentStorage: prefix must not start or end with "/": ${options.prefix}`,
      );
    }
    const key = options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      throw new Error(
        'SupabaseAttachmentStorage requires SUPABASE_SERVICE_ROLE_KEY (env). ' +
          'Set the env var on the gateway; do not put it in gateway config.',
      );
    }

    const sdk = await loadOptional<SupabaseSdkModule>(
      '@supabase/supabase-js',
      'Supabase attachment storage requires @supabase/supabase-js. Install it with: npm install @supabase/supabase-js',
    );
    const client = sdk.createClient(options.url, key, {
      auth: { persistSession: false },
    });
    return new SupabaseAttachmentStorage(client, options);
  }

  async put(input: {
    agentId: string;
    sessionId: string;
    attachmentId: string;
    filename: string;
    contentType: string;
    body: NodeJS.ReadableStream;
  }): Promise<{ storageKey: string; sizeBytes: number; sha256: string }> {
    const buffer = await streamToBuffer(input.body);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const storageKey = [
      input.agentId,
      input.sessionId,
      input.attachmentId,
      input.filename,
    ].join('/');

    const { error } = await this.client.storage.from(this.options.bucket).upload(
      this.absoluteKey(storageKey),
      buffer,
      { contentType: input.contentType, upsert: false },
    );
    if (error) {
      throw new Error(`SupabaseAttachmentStorage upload failed: ${error.message}`);
    }
    return { storageKey, sizeBytes: buffer.length, sha256 };
  }

  async readStream(storageKey: string): Promise<NodeJS.ReadableStream> {
    const { data, error } = await this.client.storage
      .from(this.options.bucket)
      .download(this.absoluteKey(storageKey));
    if (error || !data) {
      throw new Error(
        `SupabaseAttachmentStorage download failed for ${storageKey}: ${error?.message ?? 'no data'}`,
      );
    }
    if (data instanceof Buffer) {
      return Readable.from(data);
    }
    // Blob (Node 18+ has it globally). Convert to Node stream.
    if (typeof (data as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
      const ab = await (data as Blob).arrayBuffer();
      return Readable.from(Buffer.from(ab));
    }
    // Already a readable?
    if (isReadable(data)) return data;
    throw new Error(`SupabaseAttachmentStorage: unexpected download payload for ${storageKey}`);
  }

  async getSignedUrl(
    storageKey: string,
    options: { expiresInSeconds: number },
  ): Promise<string | null> {
    const expiresIn = options.expiresInSeconds ?? this.options.signedUrlExpiresIn ?? 300;
    const { data, error } = await this.client.storage
      .from(this.options.bucket)
      .createSignedUrl(this.absoluteKey(storageKey), expiresIn);
    if (error || !data) {
      throw new Error(
        `SupabaseAttachmentStorage createSignedUrl failed for ${storageKey}: ${error?.message ?? 'no data'}`,
      );
    }
    return data.signedUrl;
  }

  async delete(storageKey: string): Promise<void> {
    const { error } = await this.client.storage
      .from(this.options.bucket)
      .remove([this.absoluteKey(storageKey)]);
    if (error) {
      throw new Error(`SupabaseAttachmentStorage delete failed for ${storageKey}: ${error.message}`);
    }
  }

  private absoluteKey(storageKey: string): string {
    if (storageKey.includes('..')) {
      throw new Error(`SupabaseAttachmentStorage rejects key with traversal: ${storageKey}`);
    }
    return this.options.prefix ? `${this.options.prefix}/${storageKey}` : storageKey;
  }
}

async function loadOptional<T>(spec: string, message: string): Promise<T> {
  try {
    return (await import(spec)) as T;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} (${cause})`);
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function isReadable(value: unknown): value is NodeJS.ReadableStream {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { pipe?: unknown }).pipe === 'function'
  );
}
