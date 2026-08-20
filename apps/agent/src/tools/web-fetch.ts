import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import { type PolicyAwareTool, type ToolContext, asTextContent } from './shared.js';

const MAX_RESPONSE_BYTES = 200_000;

const WebFetchParams = Type.Object({
  url: Type.String({
    description: 'Fully-qualified URL to fetch over HTTP(S).',
  }),
  max_bytes: Type.Optional(
    Type.Number({
      description: `Maximum response body bytes to return. Defaults to ${MAX_RESPONSE_BYTES}.`,
    }),
  ),
  output: Type.Optional(
    Type.Union([
      Type.Literal('raw', {
        description: 'Return the raw HTTP response body.',
      }),
      Type.Literal('markdown', {
        description:
          'Extract main article content as Markdown (default); best for blog posts and documentation.',
      }),
    ], {
      description:
        "Format of returned content: 'raw' is the unprocessed HTTP body; 'markdown' extracts main content.",
    }),
  ),
});

type WebFetchArgs = Static<typeof WebFetchParams>;

export const createWebFetchTool = ({
  webProvider,
}: ToolContext): PolicyAwareTool<typeof WebFetchParams> => ({
  policy: { defaultGrants: [{ type: 'any' }] },
  name: 'web_fetch',
  label: 'Web Fetch',
  description:
    'Fetch a web page and return its content. Use output "markdown" (default) to extract main article content as Markdown, or "raw" for the unprocessed HTTP body. Responses are truncated at max_bytes to avoid flooding the context window.',
  parameters: WebFetchParams,
  execute: async (_toolCallId, args: WebFetchArgs, signal?: AbortSignal) => {
    if (!webProvider) {
      return {
        content: asTextContent('Web provider is not available.'),
        details: {},
      };
    }

    const url = new URL(args.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(
        `web_fetch only supports http/https URLs, got: ${url.protocol}`,
      );
    }

    const requestedBytes = args.max_bytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isFinite(requestedBytes) || requestedBytes < 1) {
      throw new ValidationError('web_fetch max_bytes must be a positive number.');
    }

    const maxBytes = Math.min(Math.floor(requestedBytes), MAX_RESPONSE_BYTES);
    const output = args.output ?? 'markdown';

    const result = await webProvider.fetch(args.url, { maxBytes, output, signal });

    const meta: string[] = [];
    if (result.title) meta.push(`Title: ${result.title}`);
    const md = result.metadata;
    if (md?.author) meta.push(`Author: ${md.author as string}`);
    if (md?.site) meta.push(`Site: ${md.site as string}`);
    if (md?.published) meta.push(`Published: ${md.published as string}`);
    if (md?.wordCount != null) meta.push(`Words: ${md.wordCount as number}`);

    let summary =
      meta.length > 0
        ? `${meta.join(' | ')}\n\n${result.content}`
        : result.content;

    if (result.truncated) {
      summary += `\n\n[Content truncated to ${maxBytes} bytes; total ${result.contentBytes} bytes.]`;
    }

    return {
      content: asTextContent(summary),
      details: {
        url: result.url,
        output,
        title: result.title,
        contentBytes: result.contentBytes,
        truncated: result.truncated,
        ...(result.acquisition ? { acquisition: result.acquisition } : {}),
        ...result.metadata,
      },
    };
  },
});
