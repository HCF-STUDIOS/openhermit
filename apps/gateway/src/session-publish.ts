/**
 * Publish-into-session gateway route.
 *
 * Lets a trusted server push a standard outbound event into a live agent
 * session out of band so channel bridges deliver it even with no active turn.
 * Allowed types: `attachment` `pending_media` `error`. Auth is the gateway
 * admin token like the other internal-only routes.
 *
 * A pushed `error` may carry a `correlationId` to resolve an earlier
 * `pending_media` placeholder to a failed state. It publishes as-is with no
 * asset ingest.
 *
 * An `attachment` push may carry an external `assetUrl` instead of a stored
 * `attachmentId`. Channels only fetch bytes from the `attachmentId` bytes
 * route so a bare URL never reaches the user. When `assetUrl` is present the
 * handler first ingests it into a `session_attachments` row via
 * `ingestAttachment`. That is the same fetch-and-persist path
 * `attachment_send` and inbound postMessage use. Only then does it publish
 * the real `attachment` event with the returned `attachmentId`. If ingest
 * fails nothing is published and the route returns 502.
 */
import type { Hono } from 'hono';

import {
  gatewayRoutes,
  isPublishableOutboundEvent,
  type OutboundEventBody,
} from '@openhermit/protocol';
import { ValidationError } from '@openhermit/shared';
import { inferAttachmentKind } from '@openhermit/agent/attachments';

import type { AgentRunner } from '@openhermit/agent/agent-runner';
import type { AgentInstanceManager } from './agent-instance.js';

/** Rendering-hint literal shared with `OutboundEventBody`'s attachment kind. */
type AttachmentKind = 'image' | 'audio' | 'video' | 'document';

export interface AttachmentIngestInput {
  agentId: string;
  sessionId: string;
  /** External URL to fetch and persist as a session attachment. */
  url: string;
  /** Optional MIME hint; the ingest path sniffs the real type regardless. */
  mimeType?: string | undefined;
  /** Optional display name hint. */
  name?: string | undefined;
  /** Runner for the target session. Already resolved by the route. */
  runner: AgentRunner;
}

export interface AttachmentIngestResult {
  attachmentId: string;
  mimeType: string;
  size?: number | undefined;
  sha256?: string | undefined;
}

export interface SessionPublishDeps {
  instances: AgentInstanceManager;
  requireAdmin: (authorization: string | undefined) => void;
  resolveRunner: (
    instances: AgentInstanceManager,
    agentId: string,
  ) => Promise<AgentRunner>;
  logger?: (message: string) => void;
  /**
   * Ingests an external asset URL into a `session_attachments` row.
   * Omit to disable asset-ingest pushes. An `assetUrl` event then 502s.
   */
  ingestAttachment?:
    | ((input: AttachmentIngestInput) => Promise<AttachmentIngestResult>)
    | undefined;
}

const ALLOWED_TYPES = new Set(['attachment', 'pending_media', 'error']);

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document']);

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

/**
 * Shape of a pushed attachment not yet stored. It carries `assetUrl` instead
 * of `attachmentId` so it is deliberately not a valid `OutboundEventBody`. It
 * never satisfies `isPublishableOutboundEvent` and cannot leak through to
 * publish unresolved.
 */
interface AttachmentIngestRequestBody {
  type: 'attachment';
  sessionId: string;
  assetUrl: string;
  mimeType?: string | undefined;
  kind?: AttachmentKind | undefined;
  correlationId?: string | undefined;
  caption?: string | undefined;
  name?: string | undefined;
}

const parseAttachmentIngestRequest = (
  value: Record<string, unknown>,
  sessionId: string,
): AttachmentIngestRequestBody | null => {
  if (typeof value.assetUrl !== 'string' || value.assetUrl.length === 0) return null;
  if (typeof value.sessionId !== 'string' || value.sessionId !== sessionId) return null;
  // mimeType stays optional. An explicit empty string would survive ingest
  // then fail the published event's !mimeType check and orphan the persisted
  // row. Reject it up front so nothing is ingested.
  if (!isOptionalString(value.mimeType)) return null;
  if (typeof value.mimeType === 'string' && value.mimeType.length === 0) return null;
  if (value.kind !== undefined && (typeof value.kind !== 'string' || !MEDIA_KINDS.has(value.kind))) {
    return null;
  }
  if (!isOptionalString(value.correlationId)) return null;
  if (!isOptionalString(value.caption)) return null;
  if (!isOptionalString(value.name)) return null;

  return {
    type: 'attachment',
    sessionId: value.sessionId,
    assetUrl: value.assetUrl,
    mimeType: value.mimeType,
    kind: value.kind as AttachmentKind | undefined,
    correlationId: value.correlationId,
    caption: value.caption,
    name: value.name,
  };
};

export const registerSessionPublishRoute = (
  app: Hono,
  deps: SessionPublishDeps,
): void => {
  const { instances, requireAdmin, resolveRunner, logger, ingestAttachment } = deps;
  const log = logger ?? (() => {});

  app.post(gatewayRoutes.agentSessionEventsPattern, async (c) => {
    requireAdmin(c.req.header('authorization'));

    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';

    const payload = await c.req.json().catch(() => null) as
      | { event?: unknown }
      | null;

    const eventBody = payload?.event;
    if (!eventBody || typeof (eventBody as { type?: unknown }).type !== 'string') {
      throw new ValidationError('Body must be { event: OutboundEventBody }.');
    }

    const eventType = (eventBody as { type: string }).type;
    if (!ALLOWED_TYPES.has(eventType)) {
      throw new ValidationError(
        `Event type "${eventType}" cannot be published via this route. Allowed: attachment, pending_media, error.`,
      );
    }

    const record = eventBody as Record<string, unknown>;
    const isAssetIngest = eventType === 'attachment' && typeof record.assetUrl === 'string';

    if (isAssetIngest) {
      const ingestReq = parseAttachmentIngestRequest(record, sessionId);
      if (!ingestReq) {
        throw new ValidationError(
          'Invalid attachment ingest request. Expected { type:"attachment", sessionId, assetUrl, mimeType?, kind?, correlationId?, caption?, name? }.',
        );
      }

      if (!ingestAttachment) {
        return c.json(
          { error: 'Attachment asset ingest is not configured on this gateway.', code: 'attachment_ingest_unavailable' },
          502,
        );
      }

      const runner = await resolveRunner(instances, agentId);

      let ingested: AttachmentIngestResult;
      try {
        ingested = await ingestAttachment({
          agentId,
          sessionId,
          url: ingestReq.assetUrl,
          mimeType: ingestReq.mimeType,
          name: ingestReq.name,
          runner,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`attachment asset ingest failed for session ${sessionId}: ${message}`);
        return c.json({ error: message, code: 'attachment_ingest_failed' }, 502);
      }

      // The ingest path sniffs the real type regardless of the caller hint so
      // the published event must reflect what was persisted. Ingest only falls
      // back to the hint when the fetch has no declared content-type.
      const finalMimeType = ingested.mimeType;
      const finalEvent: OutboundEventBody = {
        type: 'attachment',
        sessionId,
        attachmentId: ingested.attachmentId,
        mimeType: finalMimeType,
        kind: inferAttachmentKind(finalMimeType),
        ...(ingestReq.name !== undefined ? { name: ingestReq.name } : {}),
        ...(ingested.size !== undefined ? { size: ingested.size } : {}),
        ...(ingested.sha256 !== undefined ? { sha256: ingested.sha256 } : {}),
        ...(ingestReq.caption !== undefined ? { caption: ingestReq.caption } : {}),
        ...(ingestReq.correlationId !== undefined ? { correlationId: ingestReq.correlationId } : {}),
      };

      if (!isPublishableOutboundEvent(finalEvent)) {
        throw new ValidationError('Constructed attachment event failed validation.');
      }

      await runner.events.publish(finalEvent);
      log(`ingested asset and published attachment event into session ${sessionId}`);
      return c.json({ published: true, attachmentId: ingested.attachmentId }, 202);
    }

    if (!isPublishableOutboundEvent(eventBody) || eventBody.sessionId !== sessionId) {
      throw new ValidationError('Invalid event body.');
    }

    const runner = await resolveRunner(instances, agentId);
    await runner.events.publish(eventBody as OutboundEventBody);

    log(`published ${eventType} event into session ${sessionId}`);
    return c.json({ published: true }, 202);
  });
};
