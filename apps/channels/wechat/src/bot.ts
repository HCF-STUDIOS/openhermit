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
   * Stop the long-poll loop after this many *consecutive* failures when the
   * channel has never had a single successful poll since it started. This
   * quiesces zombie channels — a WeChat account that was never logged in, or
   * whose session was revoked and never re-established — which would
   * otherwise re-poll at the backoff ceiling forever and storm the logs. A
   * channel that ever succeeds resets the streak on every success, so a
   * logged-in account whose session times out intermittently (and recovers
   * on re-login) never trips this. Set to 0 / undefined to disable (poll
   * forever). Defaults to 50.
   */
  giveUpAfterConsecutiveErrors?: number;
  /**
   * Surface persistent runtime failures (auth/transport errors, server
   * errcodes) to the gateway so they appear in the channels list. Pass
   * `null` once the channel recovers. Called on every loop iteration —
   * the gateway dedupes identical values.
   */
  reportRuntimeError?: (error: string | null) => void;
}

/** Default for {@link WechatBotOptions.giveUpAfterConsecutiveErrors}. */
export const DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_ERRORS = 50;

export class WechatBot {
  private readonly log: (msg: string) => void;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private running = false;
  private getUpdatesBuf = '';
  /** Consecutive failed polls; drives the exponential backoff, reset on success. */
  private consecutiveErrors = 0;
  /** Set true on the first successful poll; gates the give-up guard. */
  private hasSucceeded = false;
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

  /**
   * True once the loop has failed `giveUpAfterConsecutiveErrors` times in a
   * row without ever polling successfully. Never fires for a channel that has
   * had at least one success — those retry forever so a session that recovers
   * on re-login keeps working.
   */
  private shouldGiveUp(): boolean {
    if (this.hasSucceeded) return false;
    const threshold = this.opts.giveUpAfterConsecutiveErrors ?? DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_ERRORS;
    return threshold > 0 && this.consecutiveErrors >= threshold;
  }

  /**
   * Report a terminal give-up error and stop the loop. Returns true so the
   * caller can `break` out of its failure branch.
   */
  private giveUp(lastError: string): boolean {
    const msg = `long-poll stopped after ${this.consecutiveErrors} consecutive failures with no successful poll — last error: ${lastError}. Reconnect/reconfigure the channel to resume.`;
    this.log(msg);
    this.opts.reportRuntimeError?.(msg);
    this.running = false;
    return true;
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
        const msg = `getUpdates failed: ${err instanceof Error ? err.message : String(err)}`;
        if (this.shouldGiveUp()) {
          this.giveUp(msg);
          break;
        }
        const delay = this.backoffMs();
        this.log(`${msg} (retry in ${delay}ms, streak ${this.consecutiveErrors})`);
        this.opts.reportRuntimeError?.(msg);
        await this.sleep(delay);
        continue;
      }

      if (!this.running) break;

      if (resp.get_updates_buf !== undefined) this.getUpdatesBuf = resp.get_updates_buf;

      if (resp.errcode && resp.errcode !== 0) {
        this.consecutiveErrors += 1;
        const msg = `getUpdates errcode=${resp.errcode} ${resp.errmsg ?? ''}`.trim();
        // -14 is documented as "session timeout" — reset cursor and retry.
        if (resp.errcode === -14) this.getUpdatesBuf = '';
        if (this.shouldGiveUp()) {
          this.giveUp(msg);
          break;
        }
        const delay = this.backoffMs();
        this.log(`${msg} (retry in ${delay}ms, streak ${this.consecutiveErrors})`);
        this.opts.reportRuntimeError?.(msg);
        await this.sleep(delay);
        continue;
      }

      // Healthy response — clear any prior runtime error and the backoff streak.
      this.consecutiveErrors = 0;
      this.hasSucceeded = true;
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
