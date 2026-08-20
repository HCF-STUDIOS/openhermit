export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string | undefined;
  publishedDate?: string | undefined;
  score?: number | undefined;
}

export interface WebSearchOptions {
  /** Maximum number of results. Default 5, max 10. */
  limit?: number | undefined;
  /** Restrict results to these domains (strict; providers post-filter). */
  includeDomains?: string[] | undefined;
  /** Never return results from these domains (strict; providers post-filter). */
  excludeDomains?: string[] | undefined;
  /** Request full page content instead of snippets. */
  contentMode?: 'snippet' | 'full' | undefined;
  /** Wall-clock timeout for the whole search call. Provider default when omitted. */
  timeoutMs?: number | undefined;
  /** Caller abort signal, combined with the timeout. */
  signal?: AbortSignal | undefined;
}

/**
 * Typed acquisition provenance for a fetched page. Fields a provider cannot
 * supply are left undefined rather than inferred — "unknown" is honest.
 */
export interface WebAcquisition {
  /** Canonical URL declared by the page or resolved by the provider. */
  canonicalUrl?: string | undefined;
  /** MIME type of the fetched resource (charset stripped). */
  mimeType?: string | undefined;
  /** HTTP status of the final response, when the provider fetched directly. */
  status?: number | undefined;
  publisher?: string | undefined;
  author?: string | undefined;
  /** Publication date as reported, normalized to ISO 8601 when parseable. */
  publishedAt?: string | undefined;
  /** ISO timestamp of when the content was retrieved. */
  retrievedAt: string;
}

export interface WebFetchResult {
  url: string;
  title?: string | undefined;
  content: string;
  contentBytes: number;
  truncated: boolean;
  acquisition?: WebAcquisition | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface WebFetchOptions {
  /** Maximum response bytes. Default 200KB. */
  maxBytes?: number | undefined;
  /** 'markdown' extracts main content; 'raw' returns unprocessed body. */
  output?: 'raw' | 'markdown' | undefined;
  /** Wall-clock timeout for the whole fetch call. Provider default when omitted. */
  timeoutMs?: number | undefined;
  /** Caller abort signal, combined with the timeout. */
  signal?: AbortSignal | undefined;
}

export interface WebProviderCapabilities {
  /** Provider forwards domain filters to its API (all providers also post-filter). */
  nativeDomainFilters: boolean;
  /** Provider can report publication dates on search results. */
  publishedDates: boolean;
}

export interface WebProvider {
  readonly name: string;
  readonly capabilities?: WebProviderCapabilities | undefined;
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
  fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult>;
}
