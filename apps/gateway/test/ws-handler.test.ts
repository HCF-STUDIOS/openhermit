import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { ChannelRegistry, createJwtConfig, type AuthResolverOptions } from '../src/auth.js';
import { attachGatewayWs } from '../src/ws-handler.js';
import type { AgentInstanceManager } from '../src/agent-instance.js';

const CHANNEL_KEY = 'test-channel-key';

const makeInstancesStub = (): AgentInstanceManager =>
  ({
    getOrHydrate: async () => ({}) as never,
    wsConnect: () => {},
    wsDisconnect: () => {},
    touch: () => {},
  }) as unknown as AgentInstanceManager;

const makeAuthOptions = (): AuthResolverOptions => {
  const channels = new ChannelRegistry();
  channels.register({
    channelId: 'chan-1',
    apiKey: CHANNEL_KEY,
    agentId: 'agent-a',
  });
  return {
    userProviders: [],
    channels,
    jwt: createJwtConfig('test-secret'),
  };
};

const listen = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
};

const connect = (
  port: number,
  agentId: string,
): Promise<{ opened: boolean; statusCode?: number }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/${agentId}/ws`, {
      headers: { authorization: `Bearer ${CHANNEL_KEY}` },
    });
    ws.on('open', () => {
      ws.close();
      resolve({ opened: true });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ opened: false, statusCode: res.statusCode });
    });
    ws.on('error', (err) => {
      // 'unexpected-response' already resolved for HTTP rejections; anything
      // else (socket destroyed without a response) counts as not opened.
      if (err.message.includes('Unexpected server response')) return;
      resolve({ opened: false });
    });
    setTimeout(() => reject(new Error('ws connect timed out')), 5000).unref();
  });

test('channel token scoped to agent A cannot open a ws at agent B\'s URL', async () => {
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(), auth: makeAuthOptions() });
  const port = await listen(server);
  try {
    const result = await connect(port, 'agent-b');
    assert.equal(result.opened, false);
    assert.equal(result.statusCode, 403);
  } finally {
    server.close();
  }
});

test('channel token scoped to agent A can open a ws at agent A\'s URL', async () => {
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(), auth: makeAuthOptions() });
  const port = await listen(server);
  try {
    const result = await connect(port, 'agent-a');
    assert.equal(result.opened, true);
  } finally {
    server.close();
  }
});
