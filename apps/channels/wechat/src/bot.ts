/**
 * Long-poll loop driving the iLink getUpdates stream into the bridge.
 *
 * iLink's getUpdates is server-held until either new messages arrive or
 * the long-poll timeout fires (default ~35s). We re-call it back-to-back
 * — only sleeping briefly on transport errors — and persist the opaque
 * `get_updates_buf` cursor between calls.
 */
import { getUpdates, notifyStart, notifyStop } from './ilink/api.js';
import type { GetUpdatesResp } from './ilink/types.js';
import type { WechatBridge } from './bridge.js';

export interface WechatBotOptions {
  baseUrl: string;
  botToken: string;
  bridge: WechatBridge;
  logger?: (message: string) => void;
  /** Retry delay after a transport failure (ms). */
  retryDelayMs?: number;
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
  private running = false;
  private getUpdatesBuf = '';
  private currentRun: Promise<void> | undefined;

  constructor(private readonly opts: WechatBotOptions) {
    this.log = opts.logger ?? ((m) => console.log(`[wechat-bot] ${m}`));
    this.retryDelayMs = opts.retryDelayMs ?? 2_000;
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
        const msg = `getUpdates failed: ${err instanceof Error ? err.message : String(err)}`;
        this.log(msg);
        this.opts.reportRuntimeError?.(msg);
        await this.sleep(this.retryDelayMs);
        continue;
      }

      if (!this.running) break;

      if (resp.get_updates_buf !== undefined) this.getUpdatesBuf = resp.get_updates_buf;

      if (resp.errcode && resp.errcode !== 0) {
        const msg = `getUpdates errcode=${resp.errcode} ${resp.errmsg ?? ''}`.trim();
        this.log(msg);
        this.opts.reportRuntimeError?.(msg);
        // -14 is documented as "session timeout" — reset cursor and retry.
        if (resp.errcode === -14) this.getUpdatesBuf = '';
        await this.sleep(this.retryDelayMs);
        continue;
      }

      // Healthy response — clear any prior runtime error.
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
