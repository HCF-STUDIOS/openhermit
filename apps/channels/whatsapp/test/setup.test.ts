import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelSetupContext } from '@openhermit/protocol';

import {
  createWhatsAppSetup,
  type StartWhatsAppLinkSession,
  type WhatsAppLinkSnapshot,
} from '../src/setup.js';

const ctx: ChannelSetupContext = { agentId: 'agent-1', logger: () => {} };

function fakeStarter(snapshots: WhatsAppLinkSnapshot[]): StartWhatsAppLinkSession {
  return async ({ authDir }) => {
    let idx = 0;
    let cancelled = false;
    return {
      authDir,
      async read() {
        return snapshots[Math.min(idx++, snapshots.length - 1)]!;
      },
      async cancel() {
        cancelled = true;
      },
      get cancelled() {
        return cancelled;
      },
    };
  };
}

test('begin() returns awaiting_external for QR setup', async () => {
  const setup = createWhatsAppSetup({
    startLinkSession: fakeStarter([{ kind: 'awaiting', qrText: 'qr-code-text' }]),
  });
  const { sessionId, state } = await setup.begin({}, ctx);
  assert.ok(sessionId);
  assert.equal(state.kind, 'awaiting_external');
  if (state.kind !== 'awaiting_external') return;
  assert.equal(state.qrText, 'qr-code-text');
  assert.equal(state.pollIntervalMs, 1500);
});

test('poll() returns done with auth_dir when linking completes', async () => {
  const setup = createWhatsAppSetup({
    startLinkSession: fakeStarter([
      { kind: 'awaiting', qrText: 'qr-code-text' },
      { kind: 'done' },
    ]),
  });
  const { sessionId } = await setup.begin({ auth_dir: '/tmp/openhermit-wa' }, ctx);
  const state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'done');
  if (state.kind !== 'done') return;
  assert.deepEqual(state.config, { auth_dir: '/tmp/openhermit-wa' });
});

test('poll() surfaces link errors', async () => {
  const setup = createWhatsAppSetup({
    startLinkSession: fakeStarter([{ kind: 'error', message: 'boom' }]),
  });
  const { state } = await setup.begin({}, ctx);
  assert.equal(state.kind, 'error');
});

test('cancel() drops the setup session', async () => {
  const setup = createWhatsAppSetup({
    startLinkSession: fakeStarter([{ kind: 'awaiting', qrText: 'qr-code-text' }]),
  });
  const { sessionId } = await setup.begin({}, ctx);
  await setup.cancel!(sessionId, ctx);
  const state = await setup.poll(sessionId, ctx);
  assert.equal(state.kind, 'error');
});

test('abandoned sessions are swept and cancelled on next setup action', async () => {
  const cancellations: string[] = [];
  const starter: StartWhatsAppLinkSession = async ({ authDir }) => ({
    authDir,
    async read() {
      return { kind: 'awaiting', qrText: 'qr' };
    },
    async cancel() {
      cancellations.push(authDir);
    },
  });

  const setup = createWhatsAppSetup({ startLinkSession: starter });
  const originalNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;

    const { sessionId: abandoned } = await setup.begin({ auth_dir: '/tmp/abandoned' }, ctx);
    assert.equal(cancellations.length, 0);

    now += 11 * 60 * 1000;

    await setup.begin({ auth_dir: '/tmp/fresh' }, ctx);
    assert.deepEqual(cancellations, ['/tmp/abandoned']);

    const state = await setup.poll(abandoned, ctx);
    assert.equal(state.kind, 'error');
  } finally {
    Date.now = originalNow;
  }
});
