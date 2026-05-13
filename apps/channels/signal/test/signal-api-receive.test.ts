import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import { SignalApi } from '../src/signal-api.js';

const withMockWsServer = async (
  handler: (ws: import('ws').WebSocket) => void | Promise<void>,
  fn: (port: number) => Promise<void>,
): Promise<void> => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as { port: number }).port;
  wss.on('connection', (ws) => void handler(ws));
  try {
    await fn(port);
  } finally {
    wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
};

test('streamMessages yields normalized DM envelopes', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({
        envelope: {
          source: '+15559999999',
          sourceNumber: '+15559999999',
          sourceUuid: 'uuid-alice',
          sourceName: 'Alice',
          timestamp: 1701,
          dataMessage: { message: 'hi', attachments: [] },
        },
        account: '+15551234567',
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
      });

      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value, done } = await iter.next();
      assert.equal(done, false);
      assert.equal(value!.text, 'hi');
      assert.equal(value!.sourceUuid, 'uuid-alice');
      assert.equal(value!.sourceNumber, '+15559999999');
      assert.equal(value!.sourceName, 'Alice');
      assert.equal(value!.groupId, undefined);
      assert.equal(value!.isSelf, false);
      await iter.return?.();
    },
  );
});

test('streamMessages yields groupId when envelope is from a group', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({
        envelope: {
          sourceNumber: '+15559999999',
          sourceUuid: 'uuid-alice',
          timestamp: 1702,
          dataMessage: {
            message: 'hey',
            groupInfo: { groupId: 'gid==', type: 'DELIVER' },
          },
        },
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
      });
      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value } = await iter.next();
      assert.equal(value!.groupId, 'gid==');
      await iter.return?.();
    },
  );
});

test('streamMessages marks isSelf=true when sourceUuid matches the bot account', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({
        envelope: {
          sourceNumber: '+15551234567',
          sourceUuid: 'uuid-self',
          timestamp: 1703,
          dataMessage: { message: 'loopback' },
        },
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
        selfUuid: 'uuid-self',
      });
      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value } = await iter.next();
      assert.equal(value!.isSelf, true);
      await iter.return?.();
    },
  );
});

test('streamMessages throws when the WebSocket fails to connect', async () => {
  // Port 1 is reserved (TCP echo on Unix, never listening). Connection refused.
  const api = new SignalApi({
    httpUrl: 'http://127.0.0.1:1',
    account: '+15551234567',
  });
  const iter = api.streamMessages({ signal: AbortSignal.timeout(2000) });
  await assert.rejects(
    async () => { await iter.next(); },
    /ECONNREFUSED|connect/i,
  );
});

test('streamMessages skips non-dataMessage envelopes (receipts, typing, sync)', async () => {
  await withMockWsServer(
    (ws) => {
      ws.send(JSON.stringify({ envelope: { receiptMessage: {} } }));
      ws.send(JSON.stringify({ envelope: { typingMessage: {} } }));
      ws.send(JSON.stringify({
        envelope: {
          sourceNumber: '+15559999999',
          timestamp: 1704,
          dataMessage: { message: 'real msg' },
        },
      }));
    },
    async (port) => {
      const api = new SignalApi({
        httpUrl: `http://localhost:${port}`,
        account: '+15551234567',
      });
      const iter = api.streamMessages({ signal: AbortSignal.timeout(1000) });
      const { value } = await iter.next();
      assert.equal(value!.text, 'real msg');
      await iter.return?.();
    },
  );
});
