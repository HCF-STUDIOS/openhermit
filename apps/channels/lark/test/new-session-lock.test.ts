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

test('handleNewSession waits for an in-flight turn on the same chat before tearing down', async () => {
  const bridge = newBridge();
  const controller = new AbortController();
  (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions.set('lark:old', controller);
  (bridge as unknown as { chatSessions: Map<string, string> }).chatSessions.set('chat-1', 'lark:old');

  const client = (bridge as unknown as { client: Record<string, unknown> }).client;
  client.openSession = async () => ({});
  (bridge as unknown as { startAttachmentSubscription: () => void }).startAttachmentSubscription = () => {};
  (bridge as unknown as { resolveInboundMedia: () => Promise<unknown[]> }).resolveInboundMedia = async () => [];

  // Hold the in-flight turn open at postMessage so the chat lock stays held.
  let releasePost: (() => void) | undefined;
  const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
  client.postMessage = async () => { await postGate; return { triggered: false }; };

  const turn = bridge.handleMessage(inbound());
  // The chat lock is set synchronously before handleMessage awaits; /new queues behind it.
  const fresh = bridge.handleNewSession('chat-1');

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(controller.signal.aborted, false, '/new must not tear down while the turn is in flight');

  releasePost!();
  await turn;
  await fresh;

  assert.equal(controller.signal.aborted, true, 'teardown runs once the in-flight turn releases the lock');
});

test('bridge.stop aborts every live persistent subscription (the leak the manifest stop now closes)', () => {
  const bridge = newBridge();
  const a = new AbortController();
  const b = new AbortController();
  const subs = (bridge as unknown as { subscriptions: Map<string, AbortController> }).subscriptions;
  subs.set('lark:s1', a);
  subs.set('lark:s2', b);

  bridge.stop();

  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);
  assert.equal(bridge.subscriptionCount, 0);
});
