import type {
  WebFetchOptions,
  WebFetchResult,
  WebProvider,
  WebProviderCapabilities,
  WebSearchOptions,
  WebSearchResult,
} from '../types.js';
import { combineTimeoutSignal, filterResultsByDomains } from '../domains.js';

const TAVILY_API_BASE = 'https://api.tavily.com';
const MAX_RESPONSE_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
}

interface TavilyExtractResult {
  url: string;
  raw_content: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
}

export class TavilyWebProvider implements WebProvider {
  readonly name = 'tavily';

  readonly capabilities: WebProviderCapabilities = {
    nativeDomainFilters: true,
    publishedDates: true,
  };

  constructor(private readonly apiKey: string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.max(1, Math.min(10, options?.limit ?? 5));
    const wantContent = options?.contentMode === 'full';

    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query,
      max_results: limit,
      include_answer: false,
      include_raw_content: wantContent,
    };

    if (options?.includeDomains?.length) {
      body.include_domains = options.includeDomains;
    }
    if (options?.excludeDomains?.length) {
      body.exclude_domains = options.excludeDomains;
    }

    const response = await fetch(`${TAVILY_API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combineTimeoutSignal(
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options?.signal,
      ),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tavily search failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    const data = await response.json() as TavilySearchResponse;

    const mapped = data.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 300),
      ...(wantContent && r.raw_content ? { content: r.raw_content } : {}),
      ...(r.published_date ? { publishedDate: r.published_date } : {}),
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

    const response = await fetch(`${TAVILY_API_BASE}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        urls: [url],
      }),
      signal: combineTimeoutSignal(
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options?.signal,
      ),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tavily fetch failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    const data = await response.json() as TavilyExtractResponse;
    const result = data.results[0];

    if (!result) {
      throw new Error(`Tavily returned no content for ${url}`);
    }

    const content = result.raw_content ?? '';
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const truncated = contentBytes > maxBytes;
    const returnedContent = truncated
      ? new TextDecoder('utf-8', { fatal: false }).decode(
          new TextEncoder().encode(content).slice(0, maxBytes),
        )
      : content;

    return {
      url: result.url,
      content: returnedContent,
      contentBytes,
      truncated,
      acquisition: {
        canonicalUrl: result.url,
        retrievedAt: new Date().toISOString(),
      },
    };
  }
}
