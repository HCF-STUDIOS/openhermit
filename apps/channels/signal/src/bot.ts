import type { SignalApi } from './signal-api.js';
import type { SignalBridge } from './bridge.js';

export interface SignalBotOptions {
  signal: SignalApi;
  bridge: SignalBridge;
  logger?: (message: string) => void;
}

export class SignalBot {
  private readonly signal: SignalApi;
  private readonly bridge: SignalBridge;
  private readonly log: (message: string) => void;
  private abortController: AbortController | undefined;
  private running = false;
  private startPromise: Promise<void> | undefined;
  private loopPromise: Promise<void> | undefined;

  constructor(opts: SignalBotOptions) {
    this.signal = opts.signal;
    this.bridge = opts.bridge;
    this.log = opts.logger ?? ((msg) => console.log(`[signal-bot] ${msg}`));
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.startPromise) return this.startPromise;

    const startPromise = (async () => {
      const controller = new AbortController();
      this.abortController = controller;
      await this.signal.probeReceiveMode();
      this.log('probe ok: signal-cli-rest-api MODE=json-rpc');
      this.running = true;
      this.loopPromise = this.receiveLoop(controller.signal);
    })().finally(() => {
      this.startPromise = undefined;
    });

    this.startPromise = startPromise;
    return startPromise;
  }

  async stop(): Promise<void> {
    if (!this.running && !this.startPromise) return;
    this.running = false;
    this.abortController?.abort();
    await this.startPromise?.catch(() => undefined);
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
    this.loopPromise = undefined;
    this.log('bot stopped');
  }

  private async receiveLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1000;
    const MAX_BACKOFF_MS = 30_000;

    while (this.running) {
      try {
        this.log('connecting to receive WS...');
        const stream = this.signal.streamMessages({ signal });
        for await (const msg of stream) {
          backoffMs = 1000;
          try {
            await this.bridge.handleIncoming(msg);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            this.log(`bridge.handleIncoming error: ${m}`);
          }
        }
        if (!this.running) break;
        this.log('WS stream ended; will reconnect');
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.log(`WS receive error: ${m}; reconnect in ${backoffMs}ms`);
      }

      if (!this.running) break;
      await this.sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
