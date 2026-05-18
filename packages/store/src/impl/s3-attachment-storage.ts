import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

import type { AttachmentStorage } from '../interfaces.js';

export interface S3AttachmentStorageOptions {
  bucket: string;
  region?: string;
  /** Optional key prefix; e.g. `attachments`. No leading or trailing slashes. */
  prefix?: string;
  /** S3-compatible endpoint (Cloudflare R2, MinIO). Leave unset for AWS. */
  endpoint?: string;
  /** Required for MinIO and most S3-compatible services. */
  forcePathStyle?: boolean;
  /** Default expiry for `getSignedUrl` when caller passes nothing. */
  signedUrlExpiresIn?: number;
}

/**
 * Minimal shape of the AWS SDK v3 S3Client we use. Declared locally so this
 * file imports nothing from `@aws-sdk/*` at module-load time — the SDK is an
 * optional dep and we import dynamically in `open()`.
 */
interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

interface SdkModule {
  S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
}

interface PresignerModule {
  getSignedUrl: (
    client: S3ClientLike,
    command: unknown,
    options: { expiresIn: number },
  ) => Promise<string>;
}

/**
 * S3-backed `AttachmentStorage`. Credentials come from the AWS default
 * credential chain (env vars, shared config, instance profile / IRSA).
 * The gateway config holds only non-secret resource pointers: bucket,
 * region, prefix, endpoint.
 *
 * Works with any S3-compatible service (AWS, Cloudflare R2, MinIO,
 * Backblaze B2) by setting `endpoint` and `forcePathStyle` as needed.
 */
export class S3AttachmentStorage implements AttachmentStorage {
  readonly name = 's3';

  private constructor(
    private readonly client: S3ClientLike,
    private readonly sdk: SdkModule,
    private readonly presigner: PresignerModule,
    private readonly options: S3AttachmentStorageOptions,
  ) {}

  /**
   * Async factory: dynamically imports `@aws-sdk/client-s3` and
   * `@aws-sdk/s3-request-presigner` so installs that don't use S3 don't
   * need the deps. Throws with an actionable message when the packages
   * aren't installed.
   */
  static async open(options: S3AttachmentStorageOptions): Promise<S3AttachmentStorage> {
    if (!options.bucket || typeof options.bucket !== 'string') {
      throw new Error('S3AttachmentStorage: `bucket` is required');
    }
    if (options.prefix && (options.prefix.startsWith('/') || options.prefix.endsWith('/'))) {
      throw new Error(
        `S3AttachmentStorage: prefix must not start or end with "/": ${options.prefix}`,
      );
    }

    const sdk = await loadOptional<SdkModule>(
      '@aws-sdk/client-s3',
      'S3 attachment storage requires @aws-sdk/client-s3. Install it with: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
    );
    const presigner = await loadOptional<PresignerModule>(
      '@aws-sdk/s3-request-presigner',
      'S3 attachment storage requires @aws-sdk/s3-request-presigner. Install it with: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
    );

    const clientConfig: Record<string, unknown> = {};
    if (options.region) clientConfig['region'] = options.region;
    if (options.endpoint) clientConfig['endpoint'] = options.endpoint;
    if (options.forcePathStyle !== undefined) {
      clientConfig['forcePathStyle'] = options.forcePathStyle;
    }
    const client = new sdk.S3Client(clientConfig);
    return new S3AttachmentStorage(client, sdk, presigner, options);
  }

  async put(input: {
    agentId: string;
    sessionId: string;
    attachmentId: string;
    filename: string;
    contentType: string;
    body: NodeJS.ReadableStream;
  }): Promise<{ storageKey: string; sizeBytes: number; sha256: string }> {
    const storageKey = this.makeStorageKey(
      input.agentId,
      input.sessionId,
      input.attachmentId,
      input.filename,
    );

    // Tap the stream so we can compute sha256 + size in a single pass
    // without pulling the whole body into memory.
    const hasher = createHash('sha256');
    let bytesSeen = 0;
    const tap = new PassThrough();
    input.body.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hasher.update(buf);
      bytesSeen += buf.length;
    });
    // Forward to a pass-through so the SDK gets a fresh Readable.
    (input.body as Readable).pipe(tap);

    const cmd = new this.sdk.PutObjectCommand({
      Bucket: this.options.bucket,
      Key: this.absoluteKey(storageKey),
      Body: tap,
      ContentType: input.contentType,
    });
    await this.client.send(cmd);

    return {
      storageKey,
      sizeBytes: bytesSeen,
      sha256: hasher.digest('hex'),
    };
  }

  async readStream(storageKey: string): Promise<NodeJS.ReadableStream> {
    const cmd = new this.sdk.GetObjectCommand({
      Bucket: this.options.bucket,
      Key: this.absoluteKey(storageKey),
    });
    const out = (await this.client.send(cmd)) as { Body?: unknown };
    const body = out.Body;
    if (!body || !isReadable(body)) {
      throw new Error(`S3AttachmentStorage: response body for ${storageKey} was not a readable stream`);
    }
    return body;
  }

  async getSignedUrl(
    storageKey: string,
    options: { expiresInSeconds: number },
  ): Promise<string | null> {
    const expiresIn = options.expiresInSeconds ?? this.options.signedUrlExpiresIn ?? 300;
    const cmd = new this.sdk.GetObjectCommand({
      Bucket: this.options.bucket,
      Key: this.absoluteKey(storageKey),
    });
    return this.presigner.getSignedUrl(this.client, cmd, { expiresIn });
  }

  async delete(storageKey: string): Promise<void> {
    const cmd = new this.sdk.DeleteObjectCommand({
      Bucket: this.options.bucket,
      Key: this.absoluteKey(storageKey),
    });
    await this.client.send(cmd);
  }

  private makeStorageKey(
    agentId: string,
    sessionId: string,
    attachmentId: string,
    filename: string,
  ): string {
    return [agentId, sessionId, attachmentId, filename].join('/');
  }

  private absoluteKey(storageKey: string): string {
    if (storageKey.includes('..')) {
      throw new Error(`S3AttachmentStorage rejects key with traversal: ${storageKey}`);
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

function isReadable(value: unknown): value is NodeJS.ReadableStream {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { pipe?: unknown }).pipe === 'function'
  );
}
