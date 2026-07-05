/**
 * Publish-into-session gateway route.
 *
 * Lets a trusted server push a standard outbound event (`attachment` or
 * `pending_media`) into a live agent session out of band, so channel
 * bridges deliver it even when there is no active turn. Auth is the
 * gateway admin token, same as the other internal-only routes.
 */
import type { Hono } from 'hono';

import {
  gatewayRoutes,
  isPublishableOutboundEvent,
  type OutboundEventBody,
} from '@openhermit/protocol';
import { ValidationError } from '@openhermit/shared';

import type { AgentRunner } from '@openhermit/agent/agent-runner';
import type { AgentInstanceManager } from './agent-instance.js';

export interface SessionPublishDeps {
  instances: AgentInstanceManager;
  requireAdmin: (authorization: string | undefined) => void;
  resolveRunner: (
    instances: AgentInstanceManager,
    agentId: string,
  ) => Promise<AgentRunner>;
  logger?: (message: string) => void;
}

const ALLOWED_TYPES = new Set(['attachment', 'pending_media']);

export const registerSessionPublishRoute = (
  app: Hono,
  deps: SessionPublishDeps,
): void => {
  const { instances, requireAdmin, resolveRunner, logger } = deps;
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

    if (!isPublishableOutboundEvent(eventBody) || eventBody.sessionId !== sessionId) {
      throw new ValidationError('Invalid event body.');
    }

    const runner = await resolveRunner(instances, agentId);
    await runner.events.publish(eventBody as OutboundEventBody);

    log(`published ${eventType} event into session ${sessionId}`);
    return c.json({ published: true }, 202);
  });
};
