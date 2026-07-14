import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LarkBridge, type LarkInboundMessage } from '../src/bridge.js';

const fakeLarkApi = { sendText: async () => 'sent-id' } as unknown as ConstructorParameters<typeof LarkBridge>[0];

function newBridge(): LarkBridge {
  return new LarkBridge(fakeLarkApi, { baseUrl: 'http://test.local', token: 'tok' }, () => {});
}

function inbound(overrides: Partial<LarkInboundMessage> = {}): LarkInboundMessage {
  return {
    chatId: 'chat-1',
    chatType: 'p2p',
    messageId: 'om_msg_123',
    senderOpenId: 'ou_sender',
    senderName: 'Sender',
    text: 'hello',
    mentioned: true,
    ...overrides,
  };
}

test('handleMessage forwards the inbound Lark message id into postMessage (enables mid-turn folding)', async () => {
  const bridge = newBridge();
  const client = (bridge as unknown as { client: Record<string, unknown> }).client;
  client.listSessions = async () => [];
  client.openSession = async () => ({});
  (bridge as unknown as { startAttachmentSubscription: () => void }).startAttachmentSubscription = () => {};

  let captured: Record<string, unknown> | undefined;
  client.postMessage = async (_sessionId: string, payload: Record<string, unknown>) => {
    captured = payload;
    return { triggered: false };
  };

  await bridge.handleMessage(inbound({ messageId: 'om_forward_me' }));

  assert.ok(captured, 'postMessage should have been called');
  assert.equal(captured!.messageId, 'om_forward_me');
});

test('handleNewSession tears down the superseded session subscription', async () => {
  const bridge = newBridge();
  const controller = new AbortController();
  (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions.set('lark:old', controller);
  (bridge as unknown as { subscriptionCursors: Map<string, number> }).subscriptionCursors.set('lark:old', 5);
  (bridge as unknown as { chatSessions: Map<string, string> }).chatSessions.set('chat-1', 'lark:old');

  await bridge.handleNewSession('chat-1');

  assert.equal(controller.signal.aborted, true, 'old subscription must be aborted');
  assert.equal(bridge.subscriptionCount, 0, 'old subscription must be dropped');
});

test('stale-session fallback tears down the abandoned session subscription', async () => {
  const bridge = newBridge();
  const controller = new AbortController();
  (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions.set('lark:stale', controller);
  (bridge as unknown as { chatSessions: Map<string, string> }).chatSessions.set('chat-1', 'lark:stale');

  const client = (bridge as unknown as { client: Record<string, unknown> }).client;
  client.openSession = async (spec: { sessionId: string }) => {
    if (spec.sessionId === 'lark:stale') throw new Error('404 Session not found');
    return {};
  };
  (bridge as unknown as { startAttachmentSubscription: () => void }).startAttachmentSubscription = () => {};
  client.postMessage = async () => ({ triggered: false });

  await bridge.handleMessage(inbound());

  assert.equal(controller.signal.aborted, true, 'stale subscription must be aborted');
  assert.equal(bridge.subscriptionCount, 0, 'stale subscription must be dropped');
});
