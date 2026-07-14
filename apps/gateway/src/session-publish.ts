/**
 * Gateway route to push an outbound event (`attachment`|`pending_media`|`error`)
 * into a live session out of band, so bridges deliver it with no active turn.
 * Admin-token auth. An `attachment` carrying an external `assetUrl` is first
 * ingested to a session_attachments row (same SSRF-guarded path as
 * attachment_send) and published by attachmentId; ingest failure -> 502.
 */
import type { Hono } from 'hono';

import {
  gatewayRoutes,
  isPublishableOutboundEvent,
  type OutboundEventBody,
} from '@openhermit/protocol';
import { NotFoundError, ValidationError } from '@openhermit/shared';
import { inferAttachmentKind } from '@openhermit/agent/attachments';

import type { AgentRunner } from '@openhermit/agent/agent-runner';
import type { AgentInstanceManager } from './agent-instance.js';

/** Rendering-hint literal, mirrors `OutboundEventBody`'s attachment kind. */
type AttachmentKind = 'image' | 'audio' | 'video' | 'document';

export interface AttachmentIngestInput {
  agentId: string;
  sessionId: string;
  /** External URL to fetch and persist as a session attachment. */
  url: string;
  /** MIME hint; ingest sniffs the real type regardless. */
  mimeType?: string | undefined;
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
  /** Ingests an asset URL into a session_attachments row. Omit to 502 `assetUrl` pushes. */
  ingestAttachment?:
    | ((input: AttachmentIngestInput) => Promise<AttachmentIngestResult>)
    | undefined;
  /**
   * Look up an attachment row by id, returning its owning agent and session.
   * Used to reject a direct `attachment` publish that references a row from
   * another agent/session. Omit only where no attachment store exists.
   */
  verifyAttachment?:
    | ((attachmentId: string) => Promise<{ agentId: string; sessionId: string } | undefined>)
    | undefined;
}

const ALLOWED_TYPES = new Set(['attachment', 'pending_media', 'error']);

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document']);

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

/**
 * A pushed attachment not yet stored: carries `assetUrl`, not `attachmentId`,
 * so it is deliberately not a valid `OutboundEventBody` and can never satisfy
 * `isPublishableOutboundEvent` to leak through unresolved.
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
  // Reject an explicit empty mimeType: it ingests, then fails the published !mimeType check and orphans the row.
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
  const { instances, requireAdmin, resolveRunner, logger, ingestAttachment, verifyAttachment } = deps;
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

      // Publish the persisted type: ingest sniffs it and only falls back to the hint when the fetch declares none.
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

    // A direct attachment publish carries an attachmentId, not bytes: verify
    // the row exists and belongs to this agent and session, else every
    // consumer's byte fetch 404s on a foreign id. pending_media/error carry
    // no attachment row and skip this.
    if (eventType === 'attachment') {
      if (!verifyAttachment) {
        // Fail closed: with no ownership verifier wired (e.g. gateway started
        // without a store) we cannot confirm the row belongs here, so refuse
        // rather than publish a possibly-foreign attachmentId.
        return c.json(
          {
            error: 'Attachment ownership cannot be verified on this gateway.',
            code: 'attachment_verification_unavailable',
          },
          403,
        );
      }
      const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId : '';
      const owner = attachmentId ? await verifyAttachment(attachmentId) : undefined;
      if (!owner || owner.agentId !== agentId || owner.sessionId !== sessionId) {
        throw new NotFoundError(`Attachment ${attachmentId || '(missing id)'} not found for this session.`);
      }
    }

    const runner = await resolveRunner(instances, agentId);
    // An error injected through this out-of-band route names a media/job id, not
    // a turn trigger. Stamp a reliable out-of-band marker so a consumer never
    // has to infer it from a collision-prone set of seen media ids (and so a
    // turn id colliding with the job id cannot make a turn error read as media).
    let outboundEvent = eventBody as OutboundEventBody;
    if (
      outboundEvent.type === 'error'
      && outboundEvent.correlationId !== undefined
      && outboundEvent.reason !== 'reconcile_cancel'
      && outboundEvent.reason !== 'media_error'
    ) {
      // Any correlationId-bearing error that isn't already a valid out-of-band
      // reason is a media-job failure on this route: stamp it so a null/absent
      // reason can't later be misclassified as a turn error.
      outboundEvent = { ...outboundEvent, reason: 'media_error' };
    }
    await runner.events.publish(outboundEvent);

    log(`published ${eventType} event into session ${sessionId}`);
    return c.json({ published: true }, 202);
  });
};
