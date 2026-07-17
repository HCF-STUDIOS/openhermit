import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { ChannelRegistry, createJwtConfig, type AuthResolverOptions } from '../src/auth.js';
import { attachGatewayWs } from '../src/ws-handler.js';
import type { AgentInstanceManager } from '../src/agent-instance.js';

const CHANNEL_KEY = 'test-channel-key';

const makeRuntimeStub = () => {
  const subscribed: string[] = [];
  return {
    subscribed,
    runtime: {
      events: {
        subscribeFrom: (sessionId: string) => {
          subscribed.push(sessionId);
          return () => {};
        },
      },
      // Channel connections carry no channelUserId, so the caller never
      // resolves to a userId; mirror that here.
      resolveCallerUserId: async () => undefined,
      verifySessionAccess: async () => {
        throw new Error('verifySessionAccess should not be reached in these tests');
      },
    } as never,
  };
};

const makeInstancesStub = (runtime: never): AgentInstanceManager =>
  ({
    getOrHydrate: async () => runtime,
    wsConnect: () => {},
    wsDisconnect: () => {},
    touch: () => {},
  }) as unknown as AgentInstanceManager;

const makeAuthOptions = (): AuthResolverOptions => {
  const channels = new ChannelRegistry();
  channels.register({
    channelId: 'chan-1',
    apiKey: CHANNEL_KEY,
    namespace: 'amiko',
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

interface WsResponse {
  kind: 'response';
  id: string;
  result?: { subscribed?: boolean };
  error?: { code: string; message: string };
}

const subscribeOnce = (port: number, sessionId: string): Promise<WsResponse> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/agent-a/ws`, {
      headers: { authorization: `Bearer ${CHANNEL_KEY}` },
    });
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          kind: 'request',
          id: 'req-1',
          method: 'session.subscribe',
          params: { sessionId },
        }),
      );
    });
    ws.on('message', (data) => {
      ws.close();
      resolve(JSON.parse(String(data)) as WsResponse);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws subscribe timed out')), 5000).unref();
  });

test('channel token subscribes to a session in its own namespace', async () => {
  const { runtime, subscribed } = makeRuntimeStub();
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(runtime), auth: makeAuthOptions() });
  const port = await listen(server);
  try {
    const response = await subscribeOnce(port, 'amiko:conv-1');
    assert.equal(response.result?.subscribed, true);
    assert.deepEqual(subscribed, ['amiko:conv-1']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('channel token cannot subscribe outside its namespace', async () => {
  const { runtime, subscribed } = makeRuntimeStub();
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(runtime), auth: makeAuthOptions() });
  const port = await listen(server);
  try {
    const response = await subscribeOnce(port, 'telegram:conv-9');
    assert.equal(response.error?.code, 'SESSION_NOT_FOUND');
    assert.deepEqual(subscribed, []);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
