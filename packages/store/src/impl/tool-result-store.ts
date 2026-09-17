import type { BlobStorage } from '../interfaces.js';

/** JSON content-type for persisted tool-result payloads. */
const TOOL_RESULT_CONTENT_TYPE = 'application/json';

/**
 * Blob-backed durable store for offloaded tool-result payloads.
 *
 * Large tool results (> the persist threshold) are truncated to a head+tail
 * preview inline and their full text written to
 * `workspace/.openhermit/tool_results/<toolCallId>.json`. That file lives on the
 * agent workspace volume — the last piece of durable state keeping the gateway
 * from being volume-free. This store mirrors each payload into blob storage
 * (keyed by agent + tool-call id) so a fresh gateway with an empty workspace can
 * restore it on demand.
 *
 * Thin wrapper over a `BlobStorage` — reuses the same Local / S3 / Supabase
 * providers as attachments and skills, so tool results can share a provider or
 * be given their own dedicated bucket without a new storage abstraction.
 */
export class ToolResultStore {
  constructor(
    private readonly storage: BlobStorage,
    /**
     * Key prefix. Empty (a dedicated bucket) addresses the root directly:
     * `<agentId>/<toolCallId>.json`. A non-empty prefix isolates the payloads
     * when the provider is shared with attachments.
     */
    private readonly prefix?: string,
  ) {}

  /** Deterministic storage key for a persisted tool result. */
  keyFor(agentId: string, toolCallId: string): string {
    const head = this.prefix ? `${this.prefix}/` : '';
    return `${head}${agentId}/${toolCallId}.json`;
  }

  /** Mirror a tool-result payload to blob storage, overwriting in place. */
  async put(agentId: string, toolCallId: string, text: string): Promise<void> {
    await this.storage.putObject({
      storageKey: this.keyFor(agentId, toolCallId),
      contentType: TOOL_RESULT_CONTENT_TYPE,
      body: Buffer.from(text, 'utf8'),
    });
  }

  /**
   * Fetch a persisted tool-result payload, or `null` when absent. A missing
   * object or read error resolves to `null` rather than throwing — callers
   * treat a miss as "nothing to expand" and degrade gracefully.
   */
  async get(agentId: string, toolCallId: string): Promise<string | null> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.storage.readStream(this.keyFor(agentId, toolCallId));
    } catch {
      return null;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch {
      return null;
    }
  }
}
