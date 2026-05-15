import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ChannelManifest,
  ChannelSetup,
  ChannelSetupContext,
  ChannelSetupState,
} from '@openhermit/protocol';

// A worked example: a stub Signal-like flow that exercises the full
// state machine. Plugin authors can use this as a reference shape.
//
// Steps:
//   1. begin({ phone_number }) -> awaiting_external with a fake QR
//   2. poll(sessionId) until the test "scans" -> done with config
//   3. cancel drops the session
class StubSignalSetup implements ChannelSetup {
  private sessions = new Map<string, { phone: string; scanned: boolean }>();

  async begin(
    input: Record<string, unknown>,
    _ctx: ChannelSetupContext,
  ): Promise<{ sessionId: string; state: ChannelSetupState }> {
    const phone = String(input.phone_number ?? '').trim();
    if (!phone) {
      return {
        sessionId: 'rejected',
        state: { kind: 'error', message: 'phone_number is required' },
      };
    }
    const sessionId = `sess-${this.sessions.size + 1}`;
    this.sessions.set(sessionId, { phone, scanned: false });
    return {
      sessionId,
      state: {
        kind: 'awaiting_external',
        instructions: 'Scan this QR in Signal',
        qrText: 'sgnl://linkdevice?uuid=stub&pub_key=stub',
        pollIntervalMs: 1000,
      },
    };
  }

  async poll(
    sessionId: string,
    _ctx: ChannelSetupContext,
  ): Promise<ChannelSetupState> {
    const sess = this.sessions.get(sessionId);
    if (!sess) return { kind: 'error', message: 'unknown session' };
    if (!sess.scanned) {
      return {
        kind: 'awaiting_external',
        instructions: 'Waiting for scan…',
        pollIntervalMs: 1000,
      };
    }
    return {
      kind: 'done',
      config: { phone_number: sess.phone, signal_cli_url: 'http://localhost:8080' },
    };
  }

  async cancel(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** Test helper — simulate the user finishing the QR scan. */
  __markScanned(sessionId: string): void {
    const sess = this.sessions.get(sessionId);
    if (sess) sess.scanned = true;
  }
}

const ctx: ChannelSetupContext = {
  agentId: 'agent-1',
  logger: () => {},
};

test('ChannelSetup: begin rejects invalid input with error state', async () => {
  const setup = new StubSignalSetup();
  const result = await setup.begin({}, ctx);
  assert.equal(result.state.kind, 'error');
});

test('ChannelSetup: begin -> poll -> done happy path', async () => {
  const setup = new StubSignalSetup();
  const { sessionId, state: first } = await setup.begin({ phone_number: '+1' }, ctx);
  assert.equal(first.kind, 'awaiting_external');
  if (first.kind === 'awaiting_external') {
    assert.ok(first.qrText);
    assert.ok(first.pollIntervalMs > 0);
  }

  const pending = await setup.poll(sessionId, ctx);
  assert.equal(pending.kind, 'awaiting_external');

  setup.__markScanned(sessionId);
  const done = await setup.poll(sessionId, ctx);
  assert.equal(done.kind, 'done');
  if (done.kind === 'done') {
    assert.equal(done.config.phone_number, '+1');
  }
});

test('ChannelSetup: cancel drops session, subsequent poll errors', async () => {
  const setup = new StubSignalSetup();
  const { sessionId } = await setup.begin({ phone_number: '+1' }, ctx);
  await setup.cancel!(sessionId, ctx);
  const after = await setup.poll(sessionId, ctx);
  assert.equal(after.kind, 'error');
});

test('ChannelManifest: setup is optional', () => {
  const tokenOnly: ChannelManifest = {
    manifestVersion: 1,
    key: 'telegram',
    namespace: 'telegram',
    displayName: 'Telegram',
    start: async () => undefined,
  };
  assert.equal(tokenOnly.setup, undefined);

  const interactive: ChannelManifest = {
    manifestVersion: 1,
    key: 'signal',
    namespace: 'signal',
    displayName: 'Signal',
    start: async () => undefined,
    setup: new StubSignalSetup(),
  };
  assert.ok(interactive.setup);
  assert.equal(typeof interactive.setup.begin, 'function');
  assert.equal(typeof interactive.setup.poll, 'function');
});
