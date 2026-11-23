import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { ChannelRegistry } from '../src/auth.js';
import { attachGatewayWs } from '../src/ws-handler.js';

// WebSocket transport guards: a channel token is confined to its own agent
// (upgrade) and its own `<namespace>:` sessions (every session RPC), the
// same rules the HTTP routes apply.

const jwt = { secret: new TextEncoder().encode('test-secret-test-secret-test-secret') };

const startServer = async (t: import('node:test').TestContext) => {
  const calls: string[] = [];
  const runtime = {
    resolveCallerUserId: async () => 'usr-1',
    verifySessionAccess: async () => {},
    openSession: async (spec: { sessionId: string }) => {
      calls.push(`open:${spec.sessionId}`);
      return { spec };
    },
    listSessionMessages: async (sessionId: string) => {
      calls.push(`history:${sessionId}`);
      return [];
    },
    deleteSession: async (sessionId: string) => {
      calls.push(`delete:${sessionId}`);
    },
    listSessions: async (query: { channel?: string }) => {
      calls.push(`list:${query.channel ?? '*'}`);
      return [];
    },
  };
  const instances = {
    getOrHydrate: async () => runtime,
    wsConnect: () => {},
    wsDisconnect: () => {},
    touch: () => {},
  };
  const channels = new ChannelRegistry();
  channels.register({ channelId: 'ch-1', apiKey: 'chan-key-a', namespace: 'acme', agentId: 'agent-a' });

  const server: Server = createServer();
  const wss = attachGatewayWs(server, {
    instances: instances as never,
    auth: { userProviders: [], channels, jwt },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    // Upgraded sockets aren't tracked by the http server; terminate them
    // or server.close() waits forever.
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  return { calls, url: (agentId: string) => `ws://127.0.0.1:${port}/api/agents/${agentId}/ws` };
};

const connect = (url: string, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });

const rpc = (ws: WebSocket, method: string, params: Record<string, unknown>) =>
  new Promise<{ result?: unknown; error?: { code: string; message: string } }>((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(String(data)) as { kind: string; id: string };
      if (msg.kind === 'response' && msg.id === id) {
        ws.off('message', onMessage);
        resolve(msg as never);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
  });

test('WS upgrade: channel token for a different agent is rejected', async (t) => {
  const { url } = await startServer(t);
  await assert.rejects(connect(url('agent-b'), 'chan-key-a'), /HTTP 401/);
  const ok = await connect(url('agent-a'), 'chan-key-a');
  ok.close();
});

test('WS RPC: channel token cannot touch sessions outside its namespace', async (t) => {
  const { url, calls } = await startServer(t);
  const ws = await connect(url('agent-a'), 'chan-key-a');
  t.after(() => ws.close());

  const source = { kind: 'channel', platform: 'acme', interactive: true };
  for (const [method, params] of [
    ['session.open', { sessionId: 'telegram:123', source }],
    ['session.history', { sessionId: 'telegram:123' }],
    ['session.delete', { sessionId: 'web:abc' }],
    ['session.subscribe', { sessionId: 'web:abc' }],
    ['session.interrupt', { sessionId: 'other' }],
  ] as const) {
    const res = await rpc(ws, method, params);
    assert.equal(res.error?.code, 'INVALID_PARAMS', `${method} should be refused`);
  }
  assert.deepEqual(calls, []);

  const own = await rpc(ws, 'session.history', { sessionId: 'acme:123' });
  assert.equal(own.error, undefined);
  assert.deepEqual(calls, ['history:acme:123']);
});

test('WS session.list: channel token cannot widen the namespace filter', async (t) => {
  const { url, calls } = await startServer(t);
  const ws = await connect(url('agent-a'), 'chan-key-a');
  t.after(() => ws.close());
  await rpc(ws, 'session.list', { channel: 'telegram' });
  await rpc(ws, 'session.list', {});
  assert.deepEqual(calls, ['list:acme', 'list:acme']);
});
