import type { StreamFn } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';

/**
 * Wrap a stream function so requests routed through the Amiko router carry
 * the twin the agent acts as. The router stamps the header's value into its
 * billing/usage metadata (metadata.twinId) so the platform's account-usage
 * page can attribute spend per twin. Advisory display metadata only — the
 * router validates the shape and silently drops anything malformed, and a
 * missing header never affects the request.
 *
 * AMIKO_TWIN_ID is seeded as an agent secret next to AMIKO_API_KEY when the
 * platform provisions a hermit twin; agents without it (self-hosted, non-twin)
 * pass through untouched. User-supplied `options.headers` win on conflict.
 */
export const AMIKO_TWIN_ID_HEADER = 'X-Amiko-Twin-Id';

export const withAmikoTwinAttribution = (baseStreamFn: StreamFn | undefined): StreamFn => {
  const next = baseStreamFn ?? streamSimple;
  return async (model, context, options) => {
    const twinId = process.env.AMIKO_TWIN_ID?.trim();
    // A caller-supplied twin header (any casing) wins outright — injecting
    // alongside it would emit two case-variants of the same header and leave
    // the winner to transport-layer luck.
    const callerHasTwinHeader = Object.keys(options?.headers ?? {}).some(
      (key) => key.toLowerCase() === AMIKO_TWIN_ID_HEADER.toLowerCase(),
    );
    if (model.provider !== 'amiko' || !twinId || callerHasTwinHeader) {
      return next(model, context, options);
    }
    const merged = {
      ...(options ?? {}),
      headers: {
        [AMIKO_TWIN_ID_HEADER]: twinId,
        ...(options?.headers ?? {}),
      },
    };
    return next(model, context, merged);
  };
};
