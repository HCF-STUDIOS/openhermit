/**
 * `ChannelSetup` adapter for Signal's QR-link flow.
 *
 * Two-step wizard: collect (http_url, phone_number) from the user, then
 * stream a daemon-rendered QR code until the device links and poll
 * succeeds. Owns its session map for the gateway lifetime.
 */
import { randomUUID } from 'node:crypto';

import type {
  ChannelSetup,
  ChannelSetupContext,
  ChannelSetupState,
} from '@openhermit/protocol';

import { QrLinkSession } from './qr-link.js';
import { redactId } from './redact.js';

const SESSION_TTL_MS = 10 * 60 * 1000;
const E164 = /^\+[1-9]\d{6,14}$/;

interface PendingSession {
  createdAt: number;
  http_url?: string;
  phone_number?: string;
  qr?: QrLinkSession;
}

export interface CreateSignalSetupOptions {
  fetch?: typeof fetch;
}

export const createSignalSetup = (
  opts: CreateSignalSetupOptions = {},
): ChannelSetup => {
  const sessions = new Map<string, PendingSession>();
  const customFetch = opts.fetch;

  const isExpired = (s: PendingSession): boolean =>
    Date.now() - s.createdAt > SESSION_TTL_MS;

  const userInputState = (): ChannelSetupState => ({
    kind: 'awaiting_user_input',
    instructions:
      'Enter the URL of your signal-cli-rest-api daemon and the bot phone number. The daemon must run with MODE=normal for the QR-link step (you can switch to MODE=json-rpc after linking).',
    fields: [
      {
        key: 'http_url',
        label: 'signal-cli-rest-api URL',
        type: 'text',
        placeholder: 'http://localhost:8080',
      },
      {
        key: 'phone_number',
        label: 'Bot phone number (E.164)',
        type: 'phone',
        placeholder: '+15551234567',
      },
    ],
  });

  return {
    begin: async (_input, _ctx) => {
      const sessionId = randomUUID();
      sessions.set(sessionId, { createdAt: Date.now() });
      return { sessionId, state: userInputState() };
    },

    submit: async (sessionId, input, ctx) => {
      const session = sessions.get(sessionId);
      if (!session || isExpired(session)) {
        sessions.delete(sessionId);
        return { kind: 'error', message: 'Setup session not found or expired.' };
      }
      const httpUrlRaw = String(input.http_url ?? '').trim();
      const phone = String(input.phone_number ?? '').trim();
      if (!httpUrlRaw) {
        return { kind: 'error', message: 'http_url is required.' };
      }
      let httpUrl: string;
      try {
        const parsed = new URL(httpUrlRaw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { kind: 'error', message: 'http_url must be a valid http(s) URL.' };
        }
        parsed.hash = '';
        httpUrl = parsed.toString().replace(/\/+$/, '');
      } catch {
        return { kind: 'error', message: 'http_url must be a valid http(s) URL.' };
      }
      if (!E164.test(phone)) {
        return {
          kind: 'error',
          message: 'phone_number must be E.164 (e.g. +15551234567).',
        };
      }
      try {
        const qrOpts: Parameters<typeof QrLinkSession.begin>[0] = {
          httpUrl,
          account: phone,
        };
        if (customFetch) qrOpts.fetch = customFetch;
        const qr = await QrLinkSession.begin(qrOpts);
        session.http_url = httpUrl;
        session.phone_number = phone;
        session.qr = qr;
        ctx.logger(`QR generated for ${redactId(phone)}`);
        return {
          kind: 'awaiting_external',
          instructions:
            'Scan this QR in Signal → Settings → Linked Devices → Link New Device.',
          qrText: qr.qrUri,
          pollIntervalMs: 1500,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'error', message };
      }
    },

    poll: async (sessionId, _ctx) => {
      const session = sessions.get(sessionId);
      if (!session || isExpired(session)) {
        sessions.delete(sessionId);
        return { kind: 'error', message: 'Setup session not found or expired.' };
      }
      if (!session.qr) {
        return userInputState();
      }
      try {
        const status = await session.qr.poll();
        if (status === 'awaiting') {
          return {
            kind: 'awaiting_external',
            instructions: 'Waiting for the device to link…',
            qrText: session.qr.qrUri,
            pollIntervalMs: 1500,
          };
        }
        sessions.delete(sessionId);
        return {
          kind: 'done',
          config: {
            http_url: session.http_url!,
            account: session.phone_number!,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'error', message };
      }
    },

    cancel: async (sessionId, _ctx) => {
      sessions.delete(sessionId);
    },
  };
};
