/**
 * Publish-into-session gateway route.
 *
 * Lets a trusted server push a standard outbound event (`attachment` or
 * `pending_media`) into a live agent session out of band, so channel
 * bridges deliver it even when there is no active turn. Auth is the
 * gateway admin token, same as the other internal-only routes.
 *
 * An `attachment` push may carry an external `assetUrl` instead of an
 * already-stored `attachmentId`. Channels only know how to fetch bytes
 * from `GET .../attachments/:attachmentId/bytes`, so a bare URL would never
 * reach the user. When `assetUrl` is present the handler ingests it into a
 * `session_attachments` row first (via the injected `ingestAttachment`,
 * the same fetch+persist path `attachment_send`/inbound postMessage use)
 * and only then publishes the real `attachment` event with the resulting
 * `attachmentId`. If ingest fails, nothing is published and the route
 * returns 502.
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
  /** Runner for the target session, already resolved by the route. */
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
   * Omit to disable asset-ingest pushes (an `assetUrl` event then 502s).
   */
  ingestAttachment?:
    | ((input: AttachmentIngestInput) => Promise<AttachmentIngestResult>)
    | undefined;
}

const ALLOWED_TYPES = new Set(['attachment', 'pending_media']);

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document']);

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

/**
 * The ingest-request shape for a pushed attachment that has not been stored
 * yet: `{ type:"attachment", sessionId, assetUrl, mimeType?, kind?,
 * correlationId?, caption?, name? }`. This is deliberately not a valid
 * `OutboundEventBody`, since it carries `assetUrl` instead of `attachmentId`,
 * so it never satisfies `isPublishableOutboundEvent` and can't leak through
 * to `publish()` unresolved.
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
  if (!isOptionalString(value.mimeType)) return null;
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
        `Event type "${eventType}" cannot be published via this route. Allowed: attachment, pending_media.`,
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

      const finalMimeType = ingestReq.mimeType ?? ingested.mimeType;
      const finalEvent: OutboundEventBody = {
        type: 'attachment',
        sessionId,
        attachmentId: ingested.attachmentId,
        mimeType: finalMimeType,
        kind: ingestReq.kind ?? inferAttachmentKind(finalMimeType),
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
