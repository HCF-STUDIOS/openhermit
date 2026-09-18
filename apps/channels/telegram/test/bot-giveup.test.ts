import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TelegramBot } from '../src/bot.js';
import type { TelegramBridge } from '../src/bridge.js';

/**
 * Drive the polling loop with a stubbed global fetch: getMe succeeds so the
 * bot connects, every getUpdates returns Telegram's `Conflict` error (the
 * duplicate-token / never-succeeded case). The loop must give up after the
 * configured streak instead of polling forever.
 */
function stubFetch(onGetUpdates: () => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    const body = u.includes('/getMe')
      ? { ok: true, result: { id: 1, username: 'testbot' } }
      : u.includes('/deleteWebhook')
        ? { ok: true, result: true }
        : onGetUpdates();
    return { json: async () => body } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const noopBridge = {} as unknown as TelegramBridge;

test('polling gives up after N never-succeeded failures', async () => {
  const reports: (string | null)[] = [];
  const restore = stubFetch(() => ({
    ok: false,
    description: 'Conflict: terminated by other getUpdates request',
  }));
  try {
    const bot = new TelegramBot({
      botToken: 'x',
      bridge: noopBridge,
      mode: 'polling',
      pollingInterval: 1,
      maxRetryDelayMs: 1,
      giveUpAfterConsecutiveErrors: 5,
      logger: () => {},
      reportRuntimeError: (e) => reports.push(e),
    });
    await bot.start();
    // Poll to give the background loop time to exhaust the streak.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (reports.some((r) => r?.includes('polling stopped after'))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await bot.stop();
    const terminal = reports.filter((r) => r?.includes('polling stopped after'));
    assert.equal(terminal.length, 1, 'expected exactly one terminal give-up report');
    assert.match(terminal[0]!, /5 consecutive failures/);
  } finally {
    restore();
  }
});

test('polling keeps retrying after a success resets the streak', async () => {
  const reports: (string | null)[] = [];
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    // One success early clears hasSucceeded=false, so the guard never fires.
    if (calls === 2) return { ok: true, result: [] };
    return { ok: false, description: 'Conflict: terminated by other getUpdates request' };
  });
  try {
    const bot = new TelegramBot({
      botToken: 'x',
      bridge: noopBridge,
      mode: 'polling',
      pollingInterval: 1,
      maxRetryDelayMs: 1,
      giveUpAfterConsecutiveErrors: 5,
      logger: () => {},
      reportRuntimeError: (e) => reports.push(e),
    });
    await bot.start();
    await new Promise((r) => setTimeout(r, 300));
    await bot.stop();
    assert.equal(
      reports.some((r) => r?.includes('polling stopped after')),
      false,
      'a bot that ever succeeded must never give up',
    );
  } finally {
    restore();
  }
});
