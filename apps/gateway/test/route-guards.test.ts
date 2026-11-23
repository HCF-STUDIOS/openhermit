import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChannelManifestRegistry } from '@openhermit/protocol';

import { createGatewayApp } from '../src/app.js';
import { ChannelRegistry, signJwt } from '../src/auth.js';

// App-level guard tests: real Hono app + real auth resolution, with the
// agent runtime and stores stubbed. Covers the security fixes that live in
// the route handlers themselves.

const AGENT = 'agent-a';
const jwt = { secret: new TextEncoder().encode('test-secret-test-secret-test-secret') };
const ADMIN = 'admin-token';

interface Harness {
  request: (path: string, init?: RequestInit & { token?: string; userId?: string }) => Promise<Response>;
  deleted: string[];
  created: unknown[];
}

const buildHarness = (opts: {
  /** channel/channelUserId → global user id */
  identities?: Record<string, string>;
  /** userId → role on AGENT */
  roles?: Record<string, 'owner' | 'user' | 'guest'>;
  /** sessionId → participant user ids */
  participants?: Record<string, string[]>;
} = {}): Harness => {
  const identities = opts.identities ?? {};
  const roles = opts.roles ?? {};
  const participants = opts.participants ?? {};
  const deleted: string[] = [];
  const created: unknown[] = [];

  const runtime = {
    resolveCallerUserId: async (c: { channel: string; channelUserId: string }) =>
      identities[`${c.channel}:${c.channelUserId}`],
    resolveCallerRole: async (c: { channel: string; channelUserId: string }) => {
      const id = identities[`${c.channel}:${c.channelUserId}`];
      return id ? roles[id] ?? 'guest' : undefined;
    },
    verifySessionAccess: async (sessionId: string, userId: string) => {
      if (!(participants[sessionId] ?? []).includes(userId)) {
        const { NotFoundError } = await import('@openhermit/shared');
        throw new NotFoundError(`Session not found: ${sessionId}`);
      }
    },
    deleteSession: async (sessionId: string) => {
      deleted.push(sessionId);
    },
    security: {},
  };

  const instances = {
    getOrHydrate: async (agentId: string) => (agentId === AGENT || agentId === 'agent-b' ? runtime : undefined),
  };

  const userStore = {
    resolve: async (channel: string, channelUserId: string) => identities[`${channel}:${channelUserId}`],
    get: async (userId: string) => ({ userId, name: `name-${userId}` }),
    getAgentRole: async (_scope: unknown, userId: string) => roles[userId],
    listByAgent: async () => Object.entries(roles).map(([userId, role]) => ({ userId, role })),
  };

  const channels = new ChannelRegistry();
  channels.register({ channelId: 'ch-1', apiKey: 'chan-key-a', namespace: 'acme', agentId: AGENT });

  const agentChannelStore = {
    listForAgent: async () => [],
    createExternal: async (input: unknown) => {
      created.push(input);
      return { id: 'new', token: 'tok', namespace: (input as { namespace: string }).namespace };
    },
  };

  const app = createGatewayApp({
    instances: instances as never,
    userStore: userStore as never,
    agentChannelStore: agentChannelStore as never,
    manifestRegistry: new ChannelManifestRegistry(),
    channelRegistry: channels,
    adminToken: ADMIN,
    auth: { userProviders: [], channels, jwt, adminToken: ADMIN },
    logger: () => {},
  });

  return {
    deleted,
    created,
    request: (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.token) headers.set('authorization', `Bearer ${init.token}`);
      if (init.userId) headers.set('x-channel-user-id', init.userId);
      return app.request(path, { ...init, headers });
    },
  };
};

const userToken = async (channel: string, channelUserId: string): Promise<string> =>
  (await signJwt(jwt, { channel, channelUserId })).token;

// ── DELETE session fails closed ─────────────────────────────────────────

test('DELETE session: unresolved user token is refused, nothing deleted', async () => {
  const h = buildHarness({ participants: { 's1': ['usr-alice'] } });
  const token = await userToken('web', 'stranger');
  const res = await h.request(`/api/agents/${AGENT}/sessions/s1`, { method: 'DELETE', token });
  assert.equal(res.status, 404);
  assert.deepEqual(h.deleted, []);
});

test('DELETE session: resolved non-participant is refused', async () => {
  const h = buildHarness({
    identities: { 'web:bob': 'usr-bob' },
    participants: { 's1': ['usr-alice'] },
  });
  const res = await h.request(`/api/agents/${AGENT}/sessions/s1`, {
    method: 'DELETE',
    token: await userToken('web', 'bob'),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(h.deleted, []);
});

test('DELETE session: participant and admin may delete', async () => {
  const h = buildHarness({
    identities: { 'web:alice': 'usr-alice' },
    participants: { 's1': ['usr-alice'] },
  });
  const ok = await h.request(`/api/agents/${AGENT}/sessions/s1`, {
    method: 'DELETE',
    token: await userToken('web', 'alice'),
  });
  assert.equal(ok.status, 200);
  const admin = await h.request(`/api/agents/${AGENT}/sessions/s2`, { method: 'DELETE', token: ADMIN });
  assert.equal(admin.status, 200);
  assert.deepEqual(h.deleted, ['s1', 's2']);
});

test('DELETE session: channel token with no resolvable sender is refused', async () => {
  const h = buildHarness({ participants: { 'acme:s1': ['usr-alice'] } });
  const res = await h.request(`/api/agents/${AGENT}/sessions/acme:s1`, { method: 'DELETE', token: 'chan-key-a' });
  assert.equal(res.status, 404);
  assert.deepEqual(h.deleted, []);
});

// ── /ownership identity lookup ──────────────────────────────────────────

test('ownership: a user token may look up only its own identity', async () => {
  const h = buildHarness({
    identities: { 'web:alice': 'usr-alice', 'telegram:victim': 'usr-victim' },
    roles: { 'usr-alice': 'owner' },
  });
  const token = await userToken('web', 'alice');
  const self = await h.request(`/api/agents/${AGENT}/ownership?channel=web&channelUserId=alice`, { token });
  assert.equal(self.status, 200);
  assert.equal((await self.json() as { me: { userId: string } }).me.userId, 'usr-alice');

  const other = await h.request(`/api/agents/${AGENT}/ownership?channel=telegram&channelUserId=victim`, { token });
  assert.equal(other.status, 401);

  const plain = await h.request(`/api/agents/${AGENT}/ownership`, { token });
  assert.equal(plain.status, 200);
  assert.equal((await plain.json() as { hasOwner: boolean }).hasOwner, true);
});

test('ownership: a channel token may only look up its own namespace; admin is unrestricted', async () => {
  const h = buildHarness({ identities: { 'telegram:victim': 'usr-victim', 'acme:u1': 'usr-u1' } });
  const foreign = await h.request(`/api/agents/${AGENT}/ownership?channel=telegram&channelUserId=victim`, { token: 'chan-key-a' });
  assert.equal(foreign.status, 401);
  const own = await h.request(`/api/agents/${AGENT}/ownership?channel=acme&channelUserId=u1`, { token: 'chan-key-a' });
  assert.equal(own.status, 200);
  const admin = await h.request(`/api/agents/${AGENT}/ownership?channel=telegram&channelUserId=victim`, { token: ADMIN });
  assert.equal((await admin.json() as { me: { userId: string } }).me.userId, 'usr-victim');
});

// ── voice requires a binding on the agent ───────────────────────────────

test('voice: a user with no binding on the agent is refused', async () => {
  const h = buildHarness({ identities: { 'web:stranger': 'usr-stranger' } });
  const token = await userToken('web', 'stranger');
  for (const path of ['voice/stt', 'voice/tts']) {
    const res = await h.request(`/api/agents/${AGENT}/${path}`, {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bytes: 'AAAA', mimeType: 'audio/ogg', text: 'hi', outputMimeType: 'audio/mpeg' }),
    });
    assert.equal(res.status, 401, path);
  }
});

test('voice: oversized TTS text is rejected before reaching a provider', async () => {
  const h = buildHarness({ identities: { 'web:alice': 'usr-alice' }, roles: { 'usr-alice': 'user' } });
  const res = await h.request(`/api/agents/${AGENT}/voice/tts`, {
    method: 'POST',
    token: await userToken('web', 'alice'),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(10_001), outputMimeType: 'audio/mpeg' }),
  });
  assert.equal(res.status, 400);
});

test('voice: channel token for another agent is refused', async () => {
  const h = buildHarness();
  const res = await h.request(`/api/agents/agent-b/voice/tts`, {
    method: 'POST',
    token: 'chan-key-a',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi', outputMimeType: 'audio/mpeg' }),
  });
  assert.equal(res.status, 401);
});

// ── external channel namespace reservation ─────────────────────────────

test('channels: external namespace may not shadow a builtin or first-party channel', async () => {
  const h = buildHarness();
  for (const namespace of ['telegram', 'discord', 'slack', 'web', 'cli', 'Web']) {
    const res = await h.request(`/api/agents/${AGENT}/channels`, {
      method: 'POST',
      token: ADMIN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace }),
    });
    assert.equal(res.status, 400, namespace);
  }
  assert.deepEqual(h.created, []);

  const ok = await h.request(`/api/agents/${AGENT}/channels`, {
    method: 'POST',
    token: ADMIN,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace: 'my-bot' }),
  });
  assert.equal(ok.status, 201);
  assert.equal(h.created.length, 1);
});
