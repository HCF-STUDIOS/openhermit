import { SafeFetchError, safeFetch } from '../../network/safe-fetch.js';

import type {
  WebAcquisition,
  WebFetchOptions,
  WebFetchResult,
  WebProvider,
  WebProviderCapabilities,
  WebSearchOptions,
  WebSearchResult,
} from '../types.js';
import { filterResultsByDomains } from '../domains.js';

const MAX_RESPONSE_BYTES = 200_000;
/** Raw HTML cap before extraction — bounds both memory and Defuddle parse cost. */
const MAX_HTML_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; OpenHermit/1.0)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

type DefuddleFn = (
  htmlOrDom: string,
  url?: string,
  options?: { markdown?: boolean },
) => Promise<{
  content: string;
  title?: string;
  author?: string;
  description?: string;
  domain?: string;
  site?: string;
  published?: string;
  wordCount?: number;
}>;

async function loadDefuddle(): Promise<DefuddleFn> {
  const node = await import('defuddle/node');
  return node.Defuddle;
}

interface FetchedHtml {
  html: string;
  status: number;
  statusText: string;
  mimeType?: string | undefined;
  finalUrl: string;
}

/**
 * Direct page acquisition goes through the shared SSRF-safe fetch: DNS-pinned
 * connections, per-hop redirect validation, timeout, and a raw-byte cap. This
 * provider fetches arbitrary model-chosen URLs, so http is allowed but
 * internal/metadata targets are not.
 */
async function fetchHtml(
  url: string,
  options?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined },
): Promise<FetchedHtml> {
  const result = await safeFetch(url, {
    allowedProtocols: ['http:', 'https:'],
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options?.signal,
    maxBytes: MAX_HTML_BYTES,
    onOversize: 'truncate',
    headers: BROWSER_HEADERS,
  });
  const mimeType = result.headers.get('content-type')?.split(';')[0]?.trim();
  return {
    html: new TextDecoder('utf-8', { fatal: false }).decode(result.body),
    status: result.status,
    statusText: result.statusText,
    mimeType,
    finalUrl: result.finalUrl,
  };
}

function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, maxBytes)),
    truncated: true,
  };
}

/** `<link rel="canonical" href="…">` in either attribute order. */
function extractCanonicalUrl(html: string, baseUrl: string): string | undefined {
  const head = html.slice(0, 65_536);
  const m =
    head.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ??
    head.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (!m?.[1]) return undefined;
  try {
    const resolved = new URL(m[1], baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

/** ISO-normalize when parseable; otherwise keep the raw provider string. */
function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? raw : new Date(t).toISOString();
}

/**
 * Extract search results from Google HTML using Defuddle.
 *
 * Google serves link blocks inside the results page.  Defuddle converts them
 * to Markdown and we parse the link/title/snippet triples out of that Markdown.
 */
async function extractGoogleResults(
  html: string,
  limit: number,
): Promise<WebSearchResult[]> {
  const Defuddle = await loadDefuddle();
  const result = await Defuddle(html, GOOGLE_SEARCH_URL, { markdown: true });
  const content = result.content ?? '';

  // Google's Defuddle-extracted markdown contains blocks like:
  //   [Title](https://example.com)
  //   Snippet text...
  // We extract markdown links as result anchors.
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  // Split content into lines for snippet extraction
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && results.length < limit; i++) {
    const line = lines[i]!;
    linkPattern.lastIndex = 0;
    const match = linkPattern.exec(line);
    if (!match) continue;

    const title = match[1]!;
    const url = match[2]!;

    // Skip Google internal links
    if (url.includes('google.com/') && !url.includes('google.com/url')) continue;
    if (url.includes('accounts.google')) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // Collect snippet from subsequent non-link lines
    const snippetLines: string[] = [];
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const nextLine = lines[j]?.trim();
      if (!nextLine) continue;
      linkPattern.lastIndex = 0;
      if (linkPattern.test(nextLine)) break;
      snippetLines.push(nextLine);
    }

    results.push({
      title,
      url,
      snippet: snippetLines.join(' ').slice(0, 300),
    });
  }

  return results;
}

export class DefuddleWebProvider implements WebProvider {
  readonly name = 'defuddle';

  readonly capabilities: WebProviderCapabilities = {
    nativeDomainFilters: false,
    publishedDates: false,
  };

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.max(1, Math.min(10, options?.limit ?? 5));
    const hasDomainFilters = Boolean(
      options?.includeDomains?.length || options?.excludeDomains?.length,
    );

    const params = new URLSearchParams({
      q: query,
      num: String(limit + 5), // request a few extra to account for filtering
      hl: 'en',
    });

    const { html, status } = await fetchHtml(
      `${GOOGLE_SEARCH_URL}?${params.toString()}`,
      { timeoutMs: options?.timeoutMs, signal: options?.signal },
    );

    if (status !== 200) {
      throw new Error(`Google search returned HTTP ${status}`);
    }

    // With filters active, extract extra candidates so post-filtering can
    // still fill the requested limit.
    const extracted = await extractGoogleResults(
      html,
      hasDomainFilters ? limit + 10 : limit,
    );
    const results = filterResultsByDomains(
      extracted,
      options?.includeDomains,
      options?.excludeDomains,
    ).slice(0, limit);

    // If content_mode is 'full', fetch each result page
    if (options?.contentMode === 'full') {
      await Promise.all(
        results.map(async (r) => {
          try {
            const fetched = await this.fetch(r.url, {
              output: 'markdown',
              maxBytes: 50_000,
              timeoutMs: options?.timeoutMs,
              signal: options?.signal,
            });
            r.content = fetched.content;
          } catch {
            // Content fetch is best-effort
          }
        }),
      );
    }

    return results;
  }

  async fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult> {
    const maxBytes = Math.min(options?.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
    const output = options?.output ?? 'markdown';

    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Only http/https URLs are supported, got: ${parsedUrl.protocol}`);
    }

    let fetched: FetchedHtml;
    try {
      fetched = await fetchHtml(url, {
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      });
    } catch (err) {
      if (err instanceof SafeFetchError) {
        throw new Error(`Fetch failed: ${err.message}`);
      }
      throw err;
    }
    const { html, status, statusText, mimeType, finalUrl } = fetched;
    const retrievedAt = new Date().toISOString();

    if (output === 'raw') {
      const { text, truncated } = truncateToBytes(html, maxBytes);
      return {
        url,
        content: text,
        contentBytes: new TextEncoder().encode(html).byteLength,
        truncated,
        acquisition: {
          canonicalUrl: extractCanonicalUrl(html, finalUrl) ?? finalUrl,
          mimeType,
          status,
          retrievedAt,
        },
        metadata: { status, statusText, output: 'raw' },
      };
    }

    // Markdown mode via Defuddle
    const Defuddle = await loadDefuddle();
    const result = await Defuddle(html, url, { markdown: true });
    const content = result.content ?? '';
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const { text: returnedContent, truncated } = truncateToBytes(content, maxBytes);

    return {
      url,
      title: result.title,
      content: returnedContent,
      contentBytes,
      truncated,
      acquisition: {
        canonicalUrl: extractCanonicalUrl(html, finalUrl) ?? finalUrl,
        mimeType,
        status,
        publisher: result.site ?? result.domain,
        author: result.author,
        publishedAt: normalizeDate(result.published),
        retrievedAt,
      },
      metadata: {
        status,
        statusText,
        output: 'markdown',
        author: result.author,
        description: result.description,
        domain: result.domain,
        site: result.site,
        published: result.published,
        wordCount: result.wordCount,
      },
    };
  }
}
