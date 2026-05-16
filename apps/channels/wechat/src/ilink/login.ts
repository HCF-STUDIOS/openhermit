/**
 * QR-login state machine for iLink WeChat.
 *
 * The wizard kicks off `start()` to grab a QR URL the user scans in
 * Weixin. A background long-poll watches the server-side status; the
 * setup wizard polls `read()` for the latest snapshot. On `confirmed`,
 * the snapshot carries the bot credentials (`bot_token` + per-bot
 * `baseurl`) that the channel uses for messaging.
 *
 * Terminal-only branches from Tencent's CLI (`need_verifycode`,
 * `verify_code_blocked`) are not supported in v0; the user can re-scan
 * if they hit those. `binded_redirect` is reported as an error so the
 * wizard does not silently succeed without writable credentials.
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_BOT_TYPE,
  FIXED_BASE_URL,
  fetchQrCode,
  pollQrStatus,
} from './api.js';
import type { QrLoginStatus } from './types.js';

export interface QrLoginResult {
  botToken: string;
  baseUrl: string;
  ilinkBotId: string;
  ilinkUserId?: string;
}

export type QrLoginSnapshot =
  | {
      kind: 'pending';
      qrcodeUrl: string;
      status: QrLoginStatus;
    }
  | {
      kind: 'done';
      result: QrLoginResult;
    }
  | {
      kind: 'error';
      message: string;
    };

interface SessionState {
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  apiBaseUrl: string;
  snapshot: QrLoginSnapshot;
  stopRequested: boolean;
  poller: Promise<void>;
}

const SESSION_TTL_MS = 5 * 60_000;

export class WeixinQrLogin {
  private readonly sessions = new Map<string, SessionState>();

  /** Begin a new login session. Returns `{ sessionId, qrcodeUrl }`. */
  async start(opts: { botType?: string; log: (msg: string) => void }): Promise<{ sessionId: string; qrcodeUrl: string }> {
    const botType = opts.botType ?? DEFAULT_BOT_TYPE;
    const qr = await fetchQrCode(FIXED_BASE_URL, botType);
    const sessionId = randomUUID();

    const session: SessionState = {
      id: sessionId,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      apiBaseUrl: FIXED_BASE_URL,
      snapshot: { kind: 'pending', qrcodeUrl: qr.qrcode_img_content, status: 'wait' },
      stopRequested: false,
      poller: Promise.resolve(),
    };
    session.poller = this.runPoller(session, opts.log);
    this.sessions.set(sessionId, session);
    return { sessionId, qrcodeUrl: qr.qrcode_img_content };
  }

  read(sessionId: string): QrLoginSnapshot | undefined {
    return this.sessions.get(sessionId)?.snapshot;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stopRequested = true;
    this.sessions.delete(sessionId);
    await session.poller.catch(() => undefined);
  }

  private async runPoller(session: SessionState, log: (msg: string) => void): Promise<void> {
    try {
      while (!session.stopRequested) {
        if (Date.now() - session.startedAt > SESSION_TTL_MS) {
          session.snapshot = { kind: 'error', message: 'QR code expired. Please retry.' };
          return;
        }
        const status = await pollQrStatus(session.apiBaseUrl, session.qrcode);
        if (session.stopRequested) return;

        switch (status.status) {
          case 'wait':
          case 'scaned':
            session.snapshot = {
              kind: 'pending',
              qrcodeUrl: session.qrcodeUrl,
              status: status.status,
            };
            break;
          case 'scaned_but_redirect': {
            if (status.redirect_host) {
              session.apiBaseUrl = `https://${status.redirect_host}`;
              log(`IDC redirect to ${status.redirect_host}`);
            }
            session.snapshot = {
              kind: 'pending',
              qrcodeUrl: session.qrcodeUrl,
              status: 'scaned',
            };
            break;
          }
          case 'expired':
            session.snapshot = { kind: 'error', message: 'QR code expired. Please retry.' };
            return;
          case 'need_verifycode':
          case 'verify_code_blocked':
            session.snapshot = {
              kind: 'error',
              message:
                'Pairing code required by WeChat — please retry from the WeChat client and rescan.',
            };
            return;
          case 'binded_redirect':
            session.snapshot = {
              kind: 'error',
              message: 'This bot is already linked to another OpenHermit instance.',
            };
            return;
          case 'confirmed': {
            if (!status.bot_token || !status.baseurl || !status.ilink_bot_id) {
              session.snapshot = {
                kind: 'error',
                message: 'Login confirmed but server did not return credentials.',
              };
              return;
            }
            session.snapshot = {
              kind: 'done',
              result: {
                botToken: status.bot_token,
                baseUrl: status.baseurl,
                ilinkBotId: status.ilink_bot_id,
                ...(status.ilink_user_id ? { ilinkUserId: status.ilink_user_id } : {}),
              },
            };
            return;
          }
          default:
            // Unknown status — keep polling.
            break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      session.snapshot = { kind: 'error', message: `QR login failed: ${msg}` };
    }
  }
}
