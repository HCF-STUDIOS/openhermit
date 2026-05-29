import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WhatsAppApi } from '../src/whatsapp-api.js';

/**
 * Build a WhatsAppApi with a stubbed socket so we can assert the Baileys
 * message content `sendMedia` produces for each kind without a real connection.
 */
function apiWithFakeSock(): { api: WhatsAppApi; sends: Array<{ jid: string; content: any }> } {
  const sends: Array<{ jid: string; content: any }> = [];
  const api = new WhatsAppApi({
    authProfile: 'default',
    credentialStore: {
      get: async () => undefined,
      list: async () => ({}),
      set: async () => undefined,
      delete: async () => undefined,
      replace: async () => undefined,
      clear: async () => undefined,
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (api as any).sock = {
    sendMessage: async (jid: string, content: any) => {
      sends.push({ jid, content });
      return { key: { id: 'mid-1' } };
    },
  };
  return { api, sends };
}

const bytes = Uint8Array.from([1, 2, 3]);

test('sendMedia routes image with caption', async () => {
  const { api, sends } = apiWithFakeSock();
  await api.sendMedia('15551234567@s.whatsapp.net', {
    bytes,
    mimeType: 'image/png',
    kind: 'image',
    filename: 'pic.png',
    caption: 'hi',
  });
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.content.mimetype, 'image/png');
  assert.equal(sends[0]!.content.caption, 'hi');
  assert.ok(sends[0]!.content.image);
});

test('sendMedia sends ogg audio as a push-to-talk voice note without caption', async () => {
  const { api, sends } = apiWithFakeSock();
  await api.sendMedia('15551234567@s.whatsapp.net', {
    bytes,
    mimeType: 'audio/ogg',
    kind: 'audio',
    filename: 'reply.ogg',
    caption: 'ignored',
  });
  assert.equal(sends[0]!.content.ptt, true);
  assert.ok(sends[0]!.content.audio);
  assert.equal(sends[0]!.content.caption, undefined);
});

test('sendMedia treats ogg/opus with MIME params as a voice note', async () => {
  const { api, sends } = apiWithFakeSock();
  await api.sendMedia('15551234567@s.whatsapp.net', {
    bytes,
    mimeType: 'audio/ogg; codecs=opus',
    kind: 'audio',
    filename: 'note.ogg',
  });
  assert.equal(sends[0]!.content.ptt, true);
});

test('sendMedia sends document with fileName', async () => {
  const { api, sends } = apiWithFakeSock();
  await api.sendMedia('15551234567@s.whatsapp.net', {
    bytes,
    mimeType: 'application/pdf',
    kind: 'document',
    filename: 'report.pdf',
  });
  assert.equal(sends[0]!.content.fileName, 'report.pdf');
  assert.ok(sends[0]!.content.document);
});
