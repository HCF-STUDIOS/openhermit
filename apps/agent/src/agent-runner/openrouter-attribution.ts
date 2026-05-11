import type { StreamFn } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';

const OPENROUTER_REFERER = 'https://openhermit.ai';
const OPENROUTER_TITLE = 'OpenHermit';

/**
 * Wrap a stream function so that requests routed through OpenRouter carry
 * the app-attribution headers OpenRouter uses for its dashboard / app
 * leaderboard. See https://openrouter.ai/docs/api/reference/overview#headers
 *
 * No-op for non-OpenRouter providers. User-supplied headers in
 * `options.headers` override the defaults so callers can customize when
 * embedding OpenHermit elsewhere.
 */
export const withOpenRouterAttribution = (baseStreamFn: StreamFn | undefined): StreamFn => {
  const next = baseStreamFn ?? streamSimple;
  return async (model, context, options) => {
    if (model.provider !== 'openrouter') {
      return next(model, context, options);
    }
    const merged = {
      ...(options ?? {}),
      headers: {
        'HTTP-Referer': OPENROUTER_REFERER,
        'X-OpenRouter-Title': OPENROUTER_TITLE,
        ...(options?.headers ?? {}),
      },
    };
    return next(model, context, merged);
  };
};
