/**
 * Synthesized outbound adapter for API-created external channels.
 *
 * Plugin channels get a `ChannelOutbound` from their `start()` handle, which is
 * how `session_send`/`canSend` reach them (see resolveOutbound + issue #210).
 * Channels created purely via `POST /api/agents/:id/channels` have no plugin, so
 * they had no outbound path at all. This lets such a channel opt into outbound
 * by putting two fields in its `config`:
 *
 *   - `outboundUrl`           — gateway POSTs `{ sessionId, to, text }` here.
 *   - `recipientMetadataKey`  — which `session.metadata` field holds the `to`.
 *
 * The gateway then registers the resulting `ChannelOutbound` into the runner's
 * outbound map, exactly like a plugin's, so `session_send` works and
 * `session_list.canSend` reports true.
 */
import type { ChannelHandle, ChannelOutbound, ChannelOutboundResult, OutboundSession } from '@openhermit/protocol';

/** Timeout for the outbound delivery POST. */
const DELIVERY_TIMEOUT_MS = 15_000;

interface ExternalOutboundConfig {
  outboundUrl: string;
  recipientMetadataKey: string;
}

/** Extract + validate the outbound-callback config from a channel row's config. */
export const parseExternalOutboundConfig = (
  config: Record<string, unknown> | undefined,
): ExternalOutboundConfig | undefined => {
  const url = config?.outboundUrl;
  const key = config?.recipientMetadataKey;
  if (typeof url === 'string' && url.trim() && typeof key === 'string' && key.trim()) {
    return { outboundUrl: url.trim(), recipientMetadataKey: key.trim() };
  }
  return undefined;
};

/**
 * A `ChannelOutbound` that delivers via an authenticated HTTP POST to the
 * integrator's configured endpoint and resolves the recipient from a
 * configured session-metadata key.
 */
export class HttpChannelOutbound implements ChannelOutbound {
  constructor(
    readonly channel: string,
    private readonly cfg: ExternalOutboundConfig,
    private readonly token: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  async send(params: {
    sessionId: string;
    to: string;
    text: string;
  }): Promise<ChannelOutboundResult> {
    try {
      const res = await fetch(this.cfg.outboundUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ sessionId: params.sessionId, to: params.to, text: params.text }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { success: false, error: `delivery ${res.status}: ${body.slice(0, 200)}` };
      }
      // Integrator may return a message id; otherwise treat 2xx as delivered.
      const messageId = await res
        .json()
        .then((j) => (j && typeof (j as { messageId?: unknown }).messageId === 'string'
          ? (j as { messageId: string }).messageId
          : undefined))
        .catch(() => undefined);
      return messageId ? { success: true, messageId } : { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`external outbound delivery failed for ${this.channel}: ${message}`);
      return { success: false, error: message };
    }
  }

  resolveRecipient(session: OutboundSession): string | undefined {
    const v = session.metadata?.[this.cfg.recipientMetadataKey];
    return typeof v === 'string' && v ? v : undefined;
  }
}

/**
 * Build a synthetic {@link ChannelHandle} for an external channel row that has
 * an outbound-callback config, or `undefined` if it doesn't opt in. The handle
 * carries only `outbound` (there is no bridge to stop).
 */
export const buildExternalOutboundHandle = (
  row: { channelType: string; token: string; config?: Record<string, unknown> },
  log: (msg: string) => void = () => {},
): ChannelHandle | undefined => {
  const cfg = parseExternalOutboundConfig(row.config);
  if (!cfg) return undefined;
  return {
    name: row.channelType,
    outbound: new HttpChannelOutbound(row.channelType, cfg, row.token, log),
    stop: async () => {},
  };
};
