import type {
  WebFetchOptions,
  WebFetchResult,
  WebProvider,
  WebProviderCapabilities,
  WebSearchOptions,
  WebSearchResult,
} from '../types.js';
import { combineTimeoutSignal, filterResultsByDomains } from '../domains.js';

const EXA_API_BASE = 'https://api.exa.ai';
const MAX_RESPONSE_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface ExaSearchResult {
  title?: string;
  url: string;
  text?: string;
  highlights?: string[];
  publishedDate?: string;
  score?: number;
}

interface ExaSearchResponse {
  results: ExaSearchResult[];
}

interface ExaContentsResult {
  title?: string;
  url: string;
  text?: string;
  author?: string;
  publishedDate?: string;
}

interface ExaContentsResponse {
  results: ExaContentsResult[];
}

export class ExaWebProvider implements WebProvider {
  readonly name = 'exa';

  readonly capabilities: WebProviderCapabilities = {
    nativeDomainFilters: true,
    publishedDates: true,
  };

  constructor(private readonly apiKey: string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.max(1, Math.min(10, options?.limit ?? 5));
    const wantContent = options?.contentMode === 'full';

    const body: Record<string, unknown> = {
      query,
      numResults: limit,
      type: 'auto',
    };

    if (wantContent) {
      body.contents = { text: true };
    } else {
      body.contents = { highlights: true };
    }

    if (options?.includeDomains?.length) {
      body.includeDomains = options.includeDomains;
    }
    if (options?.excludeDomains?.length) {
      body.excludeDomains = options.excludeDomains;
    }

    const response = await fetch(`${EXA_API_BASE}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combineTimeoutSignal(
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options?.signal,
      ),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Exa search failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    const data = await response.json() as ExaSearchResponse;

    const mapped = data.results.map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: r.highlights?.join(' … ') ?? r.text?.slice(0, 300) ?? '',
      ...(wantContent && r.text ? { content: r.text } : {}),
      ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      ...(r.score != null ? { score: r.score } : {}),
    }));

    // Strict post-filter: the API forwards filters natively, but domain
    // restrictions are a source-policy boundary, not a ranking hint.
    return filterResultsByDomains(
      mapped,
      options?.includeDomains,
      options?.excludeDomains,
    );
  }

  async fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult> {
    const maxBytes = Math.min(options?.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);

    // Exa contents API extracts clean text from a URL
    const response = await fetch(`${EXA_API_BASE}/contents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        urls: [url],
        text: true,
      }),
      signal: combineTimeoutSignal(
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options?.signal,
      ),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Exa fetch failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    const data = await response.json() as ExaContentsResponse;
    const result = data.results[0];

    if (!result) {
      throw new Error(`Exa returned no content for ${url}`);
    }

    const content = result.text ?? '';
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const truncated = contentBytes > maxBytes;
    const returnedContent = truncated
      ? new TextDecoder('utf-8', { fatal: false }).decode(
          new TextEncoder().encode(content).slice(0, maxBytes),
        )
      : content;

    return {
      url: result.url,
      title: result.title,
      content: returnedContent,
      contentBytes,
      truncated,
      acquisition: {
        canonicalUrl: result.url,
        author: result.author,
        publishedAt: result.publishedDate,
        retrievedAt: new Date().toISOString(),
      },
      metadata: {
        author: result.author,
        publishedDate: result.publishedDate,
      },
    };
  }
}
