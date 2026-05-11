/**
 * Telegram bot. Polling mode runs a local long-poll loop; webhook mode
 * registers a Telegram webhook against a gateway-hosted URL and exposes
 * `handleWebhookRequest` for the gateway dispatcher to call.
 */

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
  pollingInterval?: number;
  logger?: (message: string) => void;
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

  constructor(private readonly options: BotOptions) {
    this.api = new TelegramApi(options.botToken);
    this.bridge = options.bridge;
    this.log = options.logger ?? ((msg: string) => console.log(`[telegram-bot] ${msg}`));
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
        for (const update of updates) {
          // Fire-and-forget so callback_query updates aren't blocked behind
          // long-running message handlers (which wait for agent_end SSE).
          void this.handleUpdate(update);
          this.pollOffset = update.update_id + 1;
        }
      } catch (error) {
        if (!this.running) break;
        if (error instanceof DOMException && error.name === 'AbortError') break;
        const message =
          error instanceof Error ? error.message : String(error);
        this.log(`polling error: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, this.options.pollingInterval ?? 1000));
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
