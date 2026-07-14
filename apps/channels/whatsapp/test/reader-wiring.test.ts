import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WhatsAppBridge, type WhatsAppIncomingMessage } from '../src/bridge.js';

// D2: an inbound message may carry no platform id. postMessage assigns and
// returns one; the per-turn reader must be scoped to that server-assigned id,
// not the absent inbound id (which would fall back to closing on any foreign
// agent_end).

const fakeWhatsApp = {} as unknown as ConstructorParameters<typeof WhatsAppBridge>[0];

function newBridge(): WhatsAppBridge {
  return new WhatsAppBridge(fakeWhatsApp, { baseUrl: 'http://test.local', token: 'tok' }, {}, () => {});
}

test('whatsapp: an inbound message with no id scopes its reader to the server-assigned messageId', async () => {
  const bridge = newBridge();
  let capturedOwnId: string | undefined = 'UNSET';
  const sent: string[] = [];

  const internals = bridge as unknown as Record<string, unknown>;
  internals.getSessionId = async () => 'sess';
  internals.ensureSession = async () => {};
  internals.client = {
    postMessage: async () => ({ sessionId: 'sess', messageId: 'assigned-B', triggered: true }),
  };
  internals.waitForAgentResponse = async (_sessionId: string, ownMessageId?: string) => {
    capturedOwnId = ownMessageId;
    return { text: 'B-reply' };
  };
  internals.send = async (params: { text: string }) => {
    sent.push(params.text);
    return { success: true };
  };

  const event: WhatsAppIncomingMessage = {
    chatJid: '15551234567@s.whatsapp.net',
    senderJid: '15551234567@s.whatsapp.net',
    senderNumber: '+15551234567',
    text: 'hello',
    isGroup: false,
    mentioned: true,
  };

  await bridge.handleIncoming(event);

  assert.equal(capturedOwnId, 'assigned-B', 'reader must be scoped to the assigned id, not the absent inbound id');
  assert.deepEqual(sent, ['B-reply']);
});
