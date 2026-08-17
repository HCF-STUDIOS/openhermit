import { Type, type Static } from '@mariozechner/pi-ai';

import { type PolicyAwareTool, type ToolContext, asTextContent } from './shared.js';

const WebSearchParams = Type.Object({
  query: Type.String({
    description: 'Search query string.',
  }),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of results to return. Defaults to 5, max 10.',
    }),
  ),
  content_mode: Type.Optional(
    Type.Union([
      Type.Literal('snippet', {
        description: 'Return short snippets for each result (default).',
      }),
      Type.Literal('full', {
        description: 'Return full page content for each result.',
      }),
    ], {
      description: 'Whether to return short snippets or full page content.',
    }),
  ),
  include_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Only return results from these domains (subdomains included), e.g. ["sec.gov", "example.com"].',
    }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Never return results from these domains (subdomains included).',
    }),
  ),
});

type WebSearchArgs = Static<typeof WebSearchParams>;

export const createWebSearchTool = ({
  webProvider,
}: ToolContext): PolicyAwareTool<typeof WebSearchParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'web_search',
  label: 'Web Search',
  description:
    'Search the web for information. Returns a list of results with titles, URLs, and snippets. Use content_mode "full" to also retrieve the full page content for each result.',
  parameters: WebSearchParams,
  execute: async (_toolCallId, args: WebSearchArgs, signal?: AbortSignal) => {
    if (!webProvider) {
      return {
        content: asTextContent('Web provider is not available.'),
        details: {},
      };
    }

    const limit = Math.max(1, Math.min(10, args.limit ?? 5));
    const contentMode = args.content_mode ?? 'snippet';

    const results = await webProvider.search(args.query, {
      limit,
      contentMode,
      includeDomains: args.include_domains,
      excludeDomains: args.exclude_domains,
      signal,
    });

    if (results.length === 0) {
      return {
        content: asTextContent(`No results found for: ${args.query}`),
        details: { query: args.query, resultCount: 0 },
      };
    }

    const formatted = results.map((r, i) => {
      const lines = [
        `### ${i + 1}. ${r.title}`,
        r.url,
        '',
        r.snippet,
      ];
      if (r.content) {
        lines.push('', '---', '', r.content);
      }
      return lines.join('\n');
    }).join('\n\n');

    const summary = `Found ${results.length} result(s) for: ${args.query}\n\n${formatted}`;

    return {
      content: asTextContent(summary),
      details: {
        query: args.query,
        resultCount: results.length,
        results: results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
          ...(r.score != null ? { score: r.score } : {}),
        })),
      },
    };
  },
});
