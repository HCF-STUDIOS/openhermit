/**
 * Channel launcher helpers shared between the gateway's ChannelPool and
 * any other caller that needs to start one channel from a manifest.
 *
 * Built-in channel wrappers used to live here as hardcoded
 * startTelegram/startSlack/startDiscord functions; they have moved
 * into each channel package as the default-exported `ChannelManifest`.
 */

import type {
  ChannelContext,
  ChannelHandle,
  ChannelManifest,
  ChannelOutbound,
  WebhookHandler,
  WebhookRequest,
  WebhookResponse,
} from '@openhermit/protocol';

// Re-export the channel runtime types that used to live here. Consumers
// like `@openhermit/gateway` import them via `@openhermit/agent/channels`;
// the canonical definitions are in `@openhermit/protocol` so that
// third-party channel plugins can depend on a stable contract.
export type {
  ChannelContext,
  ChannelHandle,
  ChannelOutbound,
  WebhookHandler,
  WebhookRequest,
  WebhookResponse,
};

export interface ChannelStatus {
  name: string;
  status: 'connected' | 'error';
  error?: string;
}

export interface SingleChannelResult {
  handle?: ChannelHandle;
  status: ChannelStatus;
}

/**
 * Start a single channel by manifest. Applies `parseConfig` if the
 * manifest declares one, then invokes `start()`. Errors are caught and
 * surfaced as an error status — the caller decides whether the failure
 * is fatal.
 */
export const startSingleChannel = async (
  manifest: ChannelManifest,
  config: unknown,
  context: ChannelContext,
): Promise<SingleChannelResult> => {
  try {
    const parsed = manifest.parseConfig ? manifest.parseConfig(config) : config;
    const handle = await manifest.start(parsed, context);
    if (handle) {
      return { handle, status: { name: manifest.key, status: 'connected' } };
    }
    return { status: { name: manifest.key, status: 'error', error: 'Failed to start' } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.logger(manifest.key, `failed to start ${manifest.key} channel: ${msg}`);
    return { status: { name: manifest.key, status: 'error', error: msg } };
  }
};

export const stopChannels = async (handles: ChannelHandle[]): Promise<void> => {
  for (const handle of handles) {
    try {
      await handle.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[channels] error stopping ${handle.name}: ${message}`);
    }
  }
};
