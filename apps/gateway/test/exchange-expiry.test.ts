import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGatewayApp } from '../src/app.js';
import { ChannelRegistry, signJwt } from '../src/auth.js';

// /api/auth/exchange must not mint a session for a token whose `exp` passes
// while the single-use consume write is in flight (the expiry sweep may have
// purged an earlier redemption's jti by then).

const jwt = { secret: new TextEncoder().encode('test-secret-test-secret-test-secret') };

const build = (consumeDelayMs: number) => {
  const consumed = new Set<string>();
  const consumedJtiStore = {
    tryConsume: async (jti: string) => {
      await new Promise((r) => setTimeout(r, consumeDelayMs));
      if (consumed.has(jti)) return false;
      consumed.add(jti);
      return true;
    },
  };
  const channels = new ChannelRegistry();
  return createGatewayApp({
    instances: {} as never,
    userStore: { resolve: async () => 'usr-1', get: async () => ({ userId: 'usr-1' }) } as never,
    consumedJtiStore: consumedJtiStore as never,
    channelRegistry: channels,
    adminToken: 'admin',
    auth: { userProviders: [], channels, jwt, adminToken: 'admin' },
    logger: () => {},
  });
};

const redeem = async (app: ReturnType<typeof build>, token: string) =>
  app.request('/api/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

test('exchange: a token that expires during the consume write is refused', async () => {
  const app = build(2100);
  const { token } = await signJwt(jwt, {
    channel: 'web',
    channelUserId: 'u1',
    purpose: 'exchange',
    expiry: '1s',
  });
  const res = await redeem(app, token);
  assert.equal(res.status, 401);
});

test('exchange: a fresh token is redeemed once', async () => {
  const app = build(0);
  const { token } = await signJwt(jwt, { channel: 'web', channelUserId: 'u1', purpose: 'exchange', expiry: '60s' });
  assert.equal((await redeem(app, token)).status, 200);
  assert.equal((await redeem(app, token)).status, 401);
});
