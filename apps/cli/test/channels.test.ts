import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { Command } from 'commander';

import { registerChannelsCommand } from '../src/commands/channels.js';

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Fake gateway server exercising the real request/response shapes the SDK
 * expects, so this test proves the actual HTTP wiring of `channels enable`
 * (endpoint, method, body, and call order) — not just that it typechecks.
 */
async function startFakeGateway(agentId: string): Promise<{
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });

      res.setHeader('content-type', 'application/json');

      if (req.method === 'GET' && req.url === `/api/agents/${agentId}/channels`) {
        res.end(JSON.stringify([
          {
            id: 'ch1',
            agentId,
            kind: 'builtin',
            channelType: 'telegram',
            namespace: 'ns1',
            label: null,
            enabled: false,
            config: {},
            tokenPrefix: '',
            createdBy: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            lastUsedAt: null,
            revokedAt: null,
            secretsSet: false,
            runtimeStatus: 'stopped',
            secretKeys: [{ key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', placeholder: '${{TELEGRAM_BOT_TOKEN}}' }],
          },
        ]));
        return;
      }

      if (req.method === 'PUT' && req.url === `/api/agents/${agentId}/secrets/TELEGRAM_BOT_TOKEN`) {
        res.end(JSON.stringify({}));
        return;
      }

      if (req.method === 'PATCH' && req.url === `/api/agents/${agentId}/channels/ch1`) {
        res.end(JSON.stringify({
          id: 'ch1',
          agentId,
          kind: 'builtin',
          channelType: 'telegram',
          namespace: 'ns1',
          label: null,
          enabled: true,
          config: {},
          tokenPrefix: 'abc***',
          createdBy: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          lastUsedAt: null,
          revokedAt: null,
          runtimeStatus: 'running',
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: `no handler for ${req.method} ${req.url}` }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake gateway');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('`channels enable` sets the secret then enables the channel, in order', async () => {
  const agentId = 'agent-1';
  const { url, requests, close } = await startFakeGateway(agentId);
  const prevGatewayUrl = process.env.OPENHERMIT_GATEWAY_URL;
  const prevToken = process.env.OPENHERMIT_TOKEN;
  const prevExit = process.exit;
  const logs: string[] = [];
  const prevLog = console.log;

  process.env.OPENHERMIT_GATEWAY_URL = url;
  process.env.OPENHERMIT_TOKEN = 'test-token';
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  // Guard: if the command hits an error path it calls process.exit(1), which
  // would kill the test runner. Fail loudly instead so the assertion below
  // (rather than the whole process) reports what went wrong.
  process.exit = ((code?: number) => {
    throw new Error(`command called process.exit(${code}) — see console output above`);
  }) as typeof process.exit;

  try {
    const program = new Command();
    program.exitOverride();
    registerChannelsCommand(program);
    await program.parseAsync(
      ['channel', 'enable', 'telegram', '--agent', agentId, '--token', 'shh-secret'],
      { from: 'user' },
    );

    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.path}`),
      [
        `GET /api/agents/${agentId}/channels`,
        `PUT /api/agents/${agentId}/secrets/TELEGRAM_BOT_TOKEN`,
        `PATCH /api/agents/${agentId}/channels/ch1`,
      ],
      'expected: look up the channel, THEN write the secret, THEN enable it — in that order',
    );

    assert.deepEqual(requests[1]?.body, { value: 'shh-secret' });
    assert.deepEqual(requests[2]?.body, { enabled: true });
    assert.ok(
      logs.some((l) => l.includes('is live on agent')),
      `expected success output, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    console.log = prevLog;
    process.exit = prevExit;
    process.env.OPENHERMIT_GATEWAY_URL = prevGatewayUrl;
    process.env.OPENHERMIT_TOKEN = prevToken;
    await close();
  }
});
