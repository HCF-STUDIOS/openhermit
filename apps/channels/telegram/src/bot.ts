/**
 * Telegram bot. Polling mode runs a local long-poll loop; webhook mode
 * registers a Telegram webhook against a gateway-hosted URL and exposes
 * `handleWebhookRequest` for the gateway dispatcher to call.
 */

import { computeBackoffMs } from '@openhermit/shared';

import { TelegramApi, type TelegramUpdate } from './telegram-api.js';
import type { TelegramBridge } from './bridge.js';

export interface BotOptions {
  botToken: string;
  bridge: TelegramBridge;
  mode: 'polling' | 'webhook';
  /** Public HTTPS URL where Telegram should POST updates (webhook mode). */
  webhookUrl?: string;
  /** Secret expected in `X-Telegram-Bot-Api-Secret-Token`; we set this on Telegram and verify on incoming. */
  webhookSecret?: string;
  /** Base delay after the first polling failure (ms). Doubles per consecutive failure. */
  pollingInterval?: number;
  /**
   * Ceiling for the exponential backoff after consecutive polling errors
   * (ms). A persistently failing poll (e.g. a Debox bot returning "Bad
   * Request" every call, or a revoked token) otherwise re-polls every
   * `pollingInterval` forever — across many channels that storms the
   * gateway. Backing off to this ceiling caps a stuck channel to one poll
   * per interval. Defaults to 60s.
   */
  maxRetryDelayMs?: number;
  logger?: (message: string) => void;
  /**
   * Surface persistent polling-loop errors to the gateway so they show
   * up in the channels list. Pass `null` once polling recovers. Called
   * on every iteration — the gateway dedupes identical values.
   */
  reportRuntimeError?: (error: string | null) => void;
}

export interface WebhookRequestLike {
  headers: Record<string, string>;
  rawBody: string;
}

export interface WebhookResponseLike {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly bridge: TelegramBridge;
  private readonly log: (message: string) => void;
  private running = false;
  private pollOffset: number | undefined;
  private pollAbort: AbortController | undefined;
  /** Consecutive failed polls; drives the exponential backoff, reset on success. */
  private consecutiveErrors = 0;

  constructor(private readonly options: BotOptions) {
    this.api = new TelegramApi(options.botToken);
    this.bridge = options.bridge;
    this.log = options.logger ?? ((msg: string) => console.log(`[telegram-bot] ${msg}`));
  }

  /** Exponential backoff with jitter for the current failure streak. */
  private backoffMs(): number {
    return computeBackoffMs(
      this.consecutiveErrors,
      this.options.pollingInterval ?? 1000,
      this.options.maxRetryDelayMs ?? 60_000,
    );
  }

  async start(): Promise<void> {
    const me = await this.api.getMe();
    this.log(`connected as @${me.username ?? me.first_name} (${me.id})`);
    this.running = true;

    if (this.options.mode === 'webhook') {
      await this.startWebhook();
    } else {
      // Fire-and-forget: polling loop runs in background so start() resolves immediately.
      // Catch any unexpected throw so it never bubbles up as an unhandled rejection
      // (which would crash the whole gateway).
      void this.startPolling().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`polling task crashed: ${message}`);
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();

    if (this.options.mode === 'webhook') {
      try {
        await this.api.deleteWebhook();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`error deleting webhook: ${message}`);
      }
    }

    this.log('bot stopped');
  }

  // --- Polling mode ---

  private async startPolling(): Promise<void> {
    // Best-effort: failure here (e.g. network timeout to api.telegram.org)
    // must not crash the gateway. Polling can proceed without it.
    try {
      await this.api.deleteWebhook();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`deleteWebhook failed (continuing): ${message}`);
    }
    this.log('polling mode started');

    this.pollAbort = new AbortController();

    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.pollOffset, 30, this.pollAbort.signal);
        this.consecutiveErrors = 0;
        this.options.reportRuntimeError?.(null);
        for (const update of updates) {
          // Fire-and-forget so callback_query updates aren't blocked behind
          // long-running message handlers (which wait for agent_end SSE).
          void this.handleUpdate(update);
          this.pollOffset = update.update_id + 1;
        }
      } catch (error) {
        if (!this.running) break;
        if (error instanceof DOMException && error.name === 'AbortError') break;
        this.consecutiveErrors += 1;
        const delay = this.backoffMs();
        const message =
          error instanceof Error ? error.message : String(error);
        this.log(`polling error: ${message} (retry in ${delay}ms, streak ${this.consecutiveErrors})`);
        this.options.reportRuntimeError?.(`polling error: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // --- Webhook mode ---

  private async startWebhook(): Promise<void> {
    const url = this.options.webhookUrl;
    if (!url) {
      throw new Error('webhook_url is required in webhook mode (gateway should derive it).');
    }

    await this.api.setWebhook(url, this.options.webhookSecret);
    this.log(`webhook mode started → ${url}`);
  }

  /**
   * Called by the gateway's webhook dispatcher. Verifies the
   * `X-Telegram-Bot-Api-Secret-Token` header (if configured) and
   * processes the update asynchronously.
   */
  async handleWebhookRequest(req: WebhookRequestLike): Promise<WebhookResponseLike> {
    if (this.options.webhookSecret) {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (got !== this.options.webhookSecret) {
        return { status: 401, body: 'unauthorized' };
      }
    }

    let update: TelegramUpdate;
    try {
      update = JSON.parse(req.rawBody) as TelegramUpdate;
    } catch {
      return { status: 400, body: 'invalid json' };
    }

    // A delivered webhook is the same recovery signal as a successful poll:
    // it proves the bot token is good and Telegram is actually routing to
    // us. Clear any stale `last_error` so the UI stops showing an error
    // that's already been resolved.
    this.options.reportRuntimeError?.(null);

    // Dispatch asynchronously so we ack Telegram immediately.
    void this.handleUpdate(update);
    return { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } };
  }

  // --- Update handling ---

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      try {
        await this.bridge.handleCallbackQuery(update.callback_query);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`error handling callback query: ${message}`);
      }
      return;
    }

    if (!update.message) {
      return;
    }

    try {
      await this.bridge.handleMessage(update.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.log(`error handling message from chat ${update.message.chat.id}: ${message}`);
      try {
        await this.api.sendMessage(
          update.message.chat.id,
          `Sorry, something went wrong. Please try again.`,
        );
      } catch {
        // Can't even send an error message — just log.
      }
    }
  }
}
