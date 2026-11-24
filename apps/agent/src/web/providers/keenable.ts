import type {
  WebFetchOptions,
  WebFetchResult,
  WebProvider,
  WebProviderCapabilities,
  WebSearchOptions,
  WebSearchResult,
} from '../types.js';
import { combineTimeoutSignal, filterResultsByDomains } from '../domains.js';

const KEENABLE_API_BASE = 'https://api.keenable.ai';
const KEENABLE_TITLE = 'OpenHermit';
const MAX_RESPONSE_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface KeenableSearchResult {
  title?: string;
  url: string;
  snippet?: string;
  description?: string;
}

interface KeenableSearchResponse {
  results?: KeenableSearchResult[];
}

interface KeenableFetchPage {
  url?: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  total_chars?: number;
  error?: { status?: number; message?: string; error?: string };
}

interface KeenableFetchResponse {
  results?: KeenableFetchPage[];
}

/**
 * Keenable search + fetch. Works with or without a key: with KEENABLE_API_KEY
 * it calls the keyed endpoints, otherwise the public keyless ones (shared
 * per-IP rate limit). Keyless calls must identify the app via X-Keenable-Title.
 */
export class KeenableWebProvider implements WebProvider {
  readonly name = 'keenable';

  readonly capabilities: WebProviderCapabilities = {
    nativeDomainFilters: false,
    publishedDates: false,
  };

  constructor(private readonly apiKey?: string) {}

  private endpoint(path: '/v1/search' | '/v1/fetch'): string {
    return `${KEENABLE_API_BASE}${path}${this.apiKey ? '' : '/public'}`;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(this.apiKey
        ? { 'X-API-Key': this.apiKey }
        : { 'X-Keenable-Title': KEENABLE_TITLE }),
    };
  }

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.max(1, Math.min(10, options?.limit ?? 5));

    // A single include domain can be narrowed upstream with `site:`; every
    // filter is still enforced by the strict post-filter below.
    const include = options?.includeDomains;
    const q = include?.length === 1 ? `site:${include[0]} ${query}` : query;

    const response = await fetch(this.endpoint('/v1/search'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ query: q, max_results: limit }),
      signal: combineTimeoutSignal(
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options?.signal,
      ),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Keenable search failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    const data = await response.json() as KeenableSearchResponse;

    const mapped = (data.results ?? [])
      .filter((r) => typeof r.url === 'string' && r.url.length > 0)
      .map((r) => {
        const text = r.snippet || r.description || '';
        return {
          title: r.title || r.url,
          url: r.url,
          snippet: text.slice(0, 300),
        };
      });

    const results = filterResultsByDomains(
      mapped,
      options?.includeDomains,
      options?.excludeDomains,
    ).slice(0, limit);

    if (options?.contentMode === 'full') {
      await Promise.all(results.map(async (result) => {
        try {
          const page = await this.fetch(result.url, {
            output: 'markdown',
            maxBytes: 50_000,
            timeoutMs: options?.timeoutMs,
            signal: options?.signal,
          });
          Object.assign(result, { content: page.content });
        } catch {
          // Like Defuddle, page enrichment is best-effort; retain the snippet.
        }
      }));
    }
    return results;
  }

  async fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult> {
    if (options?.output === 'raw') {
      throw new Error('Keenable fetch supports markdown only; raw output is not available');
    }
    const maxBytes = Math.min(options?.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);

    const response = await fetch(this.endpoint('/v1/fetch'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        urls: [url],
        content: { max_chars: maxBytes },
      }),
      signal: combineTimeoutSignal(
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options?.signal,
      ),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Keenable fetch failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    const body = await response.json() as KeenableFetchResponse;
    const data = body.results?.[0];
    if (data?.error) {
      throw new Error(
        `Keenable fetch failed: ${data.error.message || data.error.error || 'page error'}`,
      );
    }
    const content = data?.content ?? '';
    const encoded = new TextEncoder().encode(content);
    const contentBytes = encoded.byteLength;
    const localTruncated = contentBytes > maxBytes;
    const truncated = data.truncated === true || localTruncated;
    const returnedContent = localTruncated
      ? new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, maxBytes))
      : content;
    const finalUrl = data?.url || url;

    return {
      url: finalUrl,
      ...(data?.title ? { title: data.title } : {}),
      content: returnedContent,
      contentBytes,
      truncated,
      metadata: { output: 'markdown', ...(data?.total_chars !== undefined ? { totalChars: data.total_chars } : {}) },
      acquisition: {
        canonicalUrl: finalUrl,
        retrievedAt: new Date().toISOString(),
      },
    };
  }
}
