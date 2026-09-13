/**
 * Long-poll loop driving the iLink getUpdates stream into the bridge.
 *
 * iLink's getUpdates is server-held until either new messages arrive or
 * the long-poll timeout fires (default ~35s). We re-call it back-to-back
 * — only sleeping briefly on transport errors — and persist the opaque
 * `get_updates_buf` cursor between calls.
 */
import { computeBackoffMs } from '@openhermit/shared';

import { getUpdates, notifyStart, notifyStop } from './ilink/api.js';
import type { GetUpdatesResp } from './ilink/types.js';
import type { WechatBridge } from './bridge.js';

export interface WechatBotOptions {
  baseUrl: string;
  botToken: string;
  bridge: WechatBridge;
  logger?: (message: string) => void;
  /** Base retry delay after the first failure (ms). Doubles per consecutive failure. */
  retryDelayMs?: number;
  /**
   * Ceiling for the exponential backoff (ms). A dead session (errcode -14
   * after a WeChat logout) otherwise re-polls every `retryDelayMs` forever —
   * across many agents that becomes a request storm that saturates the
   * gateway. Backing off to this ceiling cuts a stuck channel to one poll
   * per interval while still recovering within it once the user re-logs in.
   */
  maxRetryDelayMs?: number;
  /**
   * Surface persistent runtime failures (auth/transport errors, server
   * errcodes) to the gateway so they appear in the channels list. Pass
   * `null` once the channel recovers. Called on every loop iteration —
   * the gateway dedupes identical values.
   */
  reportRuntimeError?: (error: string | null) => void;
}

export class WechatBot {
  private readonly log: (msg: string) => void;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private running = false;
  private getUpdatesBuf = '';
  /** Consecutive failed polls; drives the exponential backoff, reset on success. */
  private consecutiveErrors = 0;
  private currentRun: Promise<void> | undefined;

  constructor(private readonly opts: WechatBotOptions) {
    this.log = opts.logger ?? ((m) => console.log(`[wechat-bot] ${m}`));
    this.retryDelayMs = opts.retryDelayMs ?? 2_000;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 60_000;
  }

  /** Exponential backoff with jitter for the current failure streak. */
  private backoffMs(): number {
    return computeBackoffMs(this.consecutiveErrors, this.retryDelayMs, this.maxRetryDelayMs);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log('starting long-poll loop');

    try {
      await notifyStart({ baseUrl: this.opts.baseUrl, token: this.opts.botToken });
    } catch (err) {
      this.log(`notifyStart failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }

    this.currentRun = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.log('stopping');

    try {
      await notifyStop({ baseUrl: this.opts.baseUrl, token: this.opts.botToken });
    } catch (err) {
      this.log(`notifyStop failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await this.currentRun?.catch(() => undefined);
    this.currentRun = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let resp: GetUpdatesResp | undefined;
      try {
        resp = await getUpdates({
          baseUrl: this.opts.baseUrl,
          token: this.opts.botToken,
          get_updates_buf: this.getUpdatesBuf,
        });
      } catch (err) {
        if (!this.running) break;
        this.consecutiveErrors += 1;
        const delay = this.backoffMs();
        const msg = `getUpdates failed: ${err instanceof Error ? err.message : String(err)}`;
        this.log(`${msg} (retry in ${delay}ms, streak ${this.consecutiveErrors})`);
        this.opts.reportRuntimeError?.(msg);
        await this.sleep(delay);
        continue;
      }

      if (!this.running) break;

      if (resp.get_updates_buf !== undefined) this.getUpdatesBuf = resp.get_updates_buf;

      if (resp.errcode && resp.errcode !== 0) {
        this.consecutiveErrors += 1;
        const delay = this.backoffMs();
        const msg = `getUpdates errcode=${resp.errcode} ${resp.errmsg ?? ''}`.trim();
        this.log(`${msg} (retry in ${delay}ms, streak ${this.consecutiveErrors})`);
        this.opts.reportRuntimeError?.(msg);
        // -14 is documented as "session timeout" — reset cursor and retry.
        if (resp.errcode === -14) this.getUpdatesBuf = '';
        await this.sleep(delay);
        continue;
      }

      // Healthy response — clear any prior runtime error and the backoff streak.
      this.consecutiveErrors = 0;
      this.opts.reportRuntimeError?.(null);

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        if (!this.running) break;
        try {
          await this.opts.bridge.handleMessage(msg);
        } catch (err) {
          this.log(`handleMessage error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
