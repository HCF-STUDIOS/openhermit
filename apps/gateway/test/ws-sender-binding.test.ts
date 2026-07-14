import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import {
  ChannelRegistry,
  createJwtConfig,
  signJwt,
  type AuthResolverOptions,
  type JwtConfig,
} from '../src/auth.js';
import { attachGatewayWs } from '../src/ws-handler.js';
import type { AgentInstanceManager } from '../src/agent-instance.js';
import type { AgentRunner } from '@openhermit/agent/agent-runner';

const CHANNEL_KEY = 'test-channel-key';
const JWT_SECRET = 'test-secret';

interface PostCapture {
  sender?: { channel: string; channelUserId: string; displayName?: string };
}

// Records the sender the WS handler forwards to postMessage.
const makeRuntimeStub = (capture: PostCapture): AgentRunner =>
  ({
    resolveCallerUserId: async () => 'user-internal-id',
    verifySessionAccess: async () => {},
    ensureSessionLoaded: async () => {},
    postMessage: async (_sessionId: string, message: { sender?: PostCapture['sender'] }) => {
      capture.sender = message.sender;
      return { sessionId: 'web:s1', triggered: false };
    },
  }) as unknown as AgentRunner;

const makeInstancesStub = (runtime: AgentRunner): AgentInstanceManager =>
  ({
    getOrHydrate: async () => runtime,
    wsConnect: () => {},
    wsDisconnect: () => {},
    touch: () => {},
  }) as unknown as AgentInstanceManager;

const makeAuthOptions = (): { options: AuthResolverOptions; jwt: JwtConfig } => {
  const channels = new ChannelRegistry();
  channels.register({ channelId: 'chan-1', apiKey: CHANNEL_KEY, agentId: 'agent-a' });
  const jwt = createJwtConfig(JWT_SECRET);
  return { options: { userProviders: [], channels, jwt }, jwt };
};

const listen = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
};

// Open a ws, send one session.message, resolve with the response frame.
const postOverWs = (
  port: number,
  agentId: string,
  token: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/${agentId}/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ kind: 'request', id: 'r1', method: 'session.message', params }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { kind: string; id?: string };
      if (msg.kind === 'response') {
        ws.close();
        resolve(msg as Record<string, unknown>);
      }
    });
    ws.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('ws post timed out')), 5000).unref();
  });

test('ws user-mode caller posting sender=owner is coerced to the authenticated caller', async () => {
  const capture: PostCapture = {};
  const { options, jwt } = makeAuthOptions();
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(makeRuntimeStub(capture)), auth: options });
  const port = await listen(server);
  try {
    const { token } = await signJwt(jwt, { channel: 'web', channelUserId: 'guest-fingerprint' });
    const res = await postOverWs(port, 'agent-a', token, {
      sessionId: 'web:s1',
      text: 'hi',
      // A guest with a valid JWT declares the owner's identity on another channel.
      sender: { channel: 'lark', channelUserId: 'owner-open-id' },
    });
    assert.ok('result' in res, `expected ok response, got ${JSON.stringify(res)}`);
    assert.deepEqual(capture.sender, { channel: 'web', channelUserId: 'guest-fingerprint' });
  } finally {
    server.close();
  }
});

test('ws user-mode caller binds identity even when no sender is declared', async () => {
  const capture: PostCapture = {};
  const { options, jwt } = makeAuthOptions();
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(makeRuntimeStub(capture)), auth: options });
  const port = await listen(server);
  try {
    const { token } = await signJwt(jwt, { channel: 'web', channelUserId: 'guest-fingerprint' });
    await postOverWs(port, 'agent-a', token, { sessionId: 'web:s1', text: 'hi' });
    assert.deepEqual(capture.sender, { channel: 'web', channelUserId: 'guest-fingerprint' });
  } finally {
    server.close();
  }
});

test('ws channel-mode sender within the namespace passes through unchanged', async () => {
  const capture: PostCapture = {};
  const { options } = makeAuthOptions();
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(makeRuntimeStub(capture)), auth: options });
  const port = await listen(server);
  try {
    const res = await postOverWs(port, 'agent-a', CHANNEL_KEY, {
      sessionId: 'chan-1:s1',
      text: 'hi',
      sender: { channel: 'chan-1', channelUserId: 'ou_someone' },
    });
    assert.ok('result' in res, `expected ok response, got ${JSON.stringify(res)}`);
    assert.deepEqual(capture.sender, { channel: 'chan-1', channelUserId: 'ou_someone' });
  } finally {
    server.close();
  }
});

test('ws channel-mode cross-namespace sender is rejected', async () => {
  const capture: PostCapture = {};
  const { options } = makeAuthOptions();
  const server = createServer();
  attachGatewayWs(server, { instances: makeInstancesStub(makeRuntimeStub(capture)), auth: options });
  const port = await listen(server);
  try {
    const res = await postOverWs(port, 'agent-a', CHANNEL_KEY, {
      sessionId: 'chan-1:s1',
      text: 'hi',
      sender: { channel: 'other', channelUserId: 'x' },
    });
    assert.ok('error' in res, `expected error response, got ${JSON.stringify(res)}`);
    assert.equal((res.error as { code: string }).code, 'INVALID_PARAMS');
    assert.equal(capture.sender, undefined);
  } finally {
    server.close();
  }
});
