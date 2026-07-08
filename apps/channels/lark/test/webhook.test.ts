import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LarkBot } from '../src/bot.js';
import { parseLarkConfig } from '../src/config.js';
import type { LarkInboundMessage } from '../src/bridge.js';

/** Build a bot in webhook mode with recording fakes; no network. */
const makeBot = () => {
  const sentTexts: Array<{ chatId: string; text: string }> = [];
  const handled: LarkInboundMessage[] = [];
  const api = {
    getBotInfo: async () => ({ openId: 'ou_bot', appName: 'TestBot' }),
    sendText: async (chatId: string, text: string) => {
      sentTexts.push({ chatId, text });
      return 'om_1';
    },
  };
  const bridge = {
    handleMessage: async (msg: LarkInboundMessage) => {
      handled.push(msg);
    },
    handleNewSession: async () => {},
  };
  const bot = new LarkBot({
    appId: 'cli_x',
    appSecret: 'secret',
    domainKey: 'feishu',
    mode: 'webhook',
    api: api as never,
    bridge: bridge as never,
    logger: () => {},
  });
  return { bot, handled, sentTexts };
};

const receiveBody = (messageId: string, text: string) => ({
  schema: '2.0',
  header: {
    event_id: `evt_${messageId}`,
    event_type: 'im.message.receive_v1',
    create_time: '1700000000000',
    token: '',
    app_id: 'cli_x',
    tenant_key: 't',
  },
  event: {
    sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: 'oc_chat1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  },
});

describe('LarkBot.handleWebhookRequest', () => {
  test('answers the plaintext url_verification challenge synchronously', async () => {
    const { bot } = makeBot();
    const res = await bot.handleWebhookRequest({
      headers: {},
      rawBody: JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 't' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body ?? '{}'), { challenge: 'abc123' });
  });

  test('rejects invalid JSON with 400', async () => {
    const { bot } = makeBot();
    const res = await bot.handleWebhookRequest({ headers: {}, rawBody: 'not-json' });
    assert.equal(res.status, 400);
  });

  test('rejects an encrypted challenge when no encrypt key is configured', async () => {
    const { bot } = makeBot();
    const res = await bot.handleWebhookRequest({
      headers: {},
      rawBody: JSON.stringify({ encrypt: 'AAAA' }),
    });
    assert.equal(res.status, 400);
  });

  test('acks a message event immediately and dispatches it async to the bridge', async () => {
    const { bot, handled } = makeBot();
    const res = await bot.handleWebhookRequest({
      headers: {},
      rawBody: JSON.stringify(receiveBody('om_msg1', 'hello over webhook')),
    });
    assert.equal(res.status, 200);
    // The dispatch is intentionally async — drain the microtask queue.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(handled.length, 1);
    assert.equal(handled[0]!.text, 'hello over webhook');
    assert.equal(handled[0]!.chatId, 'oc_chat1');
    assert.equal(handled[0]!.mentioned, true); // p2p
  });

  test('dedupes redelivered events by message_id', async () => {
    const { bot, handled } = makeBot();
    const body = JSON.stringify(receiveBody('om_dup', 'once please'));
    await bot.handleWebhookRequest({ headers: {}, rawBody: body });
    await bot.handleWebhookRequest({ headers: {}, rawBody: body });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(handled.length, 1);
  });
});

describe('parseLarkConfig modes', () => {
  const base = { app_id: 'cli_x', app_secret: 's3cret' };

  test('defaults to ws mode', () => {
    assert.equal(parseLarkConfig(base).mode, 'ws');
  });

  test('accepts webhook mode with optional secrets', () => {
    const cfg = parseLarkConfig({
      ...base,
      mode: 'webhook',
      encrypt_key: 'ek',
      verification_token: 'vt',
    });
    assert.equal(cfg.mode, 'webhook');
    assert.equal(cfg.encrypt_key, 'ek');
    assert.equal(cfg.verification_token, 'vt');
  });

  test('unresolved ${{…}} placeholders on optional secrets read as unset', () => {
    const cfg = parseLarkConfig({
      ...base,
      mode: 'webhook',
      encrypt_key: '${{LARK_ENCRYPT_KEY}}',
      verification_token: '${{LARK_VERIFICATION_TOKEN}}',
    });
    assert.equal(cfg.encrypt_key, undefined);
    assert.equal(cfg.verification_token, undefined);
  });

  test('missing app_secret placeholder still rejects', () => {
    assert.throws(() => parseLarkConfig({ app_id: 'cli_x', app_secret: '${{LARK_APP_SECRET}}' }));
  });
});
