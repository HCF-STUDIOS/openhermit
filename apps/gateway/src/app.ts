import crypto from 'node:crypto';
import path from 'node:path';
import { syncSkillMounts } from './skill-mounts.js';

import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';

import {
  gatewayRoutes,
  isSessionSpec,
  isSessionMessage,
  isToolApprovalRequest,
  isSessionCheckpointRequest,
  type ChannelManifest,
  type ChannelManifestRegistry,
  type ChannelSetup,
  type ChannelSetupContext,
  type CreateAgentRequest,
  type SessionListQuery,
  type SyncResponse,
  type SyncToolCall,
} from '@openhermit/protocol';
import type {
  DbAgentStore,
  DbAgentConfigStore,
  DbAttachmentStore,
  DbMcpServerStore,
  DbPolicyStore,
  DbApprovalRequestStore,
  DbScheduleStore,
  DbSkillStore,
  DbUserStore,
  DbAgentChannelStore,
  SandboxStore,
  AttachmentStorage,
} from '@openhermit/store';
import { buildInboxSessionEntry } from '@openhermit/store';
import type { SandboxPreset } from './config.js';
import { defaultGatewayConfig, parseGatewayConfig, saveGatewayConfig, META_KEY } from './config.js';
import type { ChannelRegistry } from './auth.js';
import {
  ConflictError,
  NotFoundError,
  OpenHermitError,
  UnauthorizedError,
  ValidationError,
  getErrorMessage,
  jsonError,
  resolveGatewayDir,
  resolveOpenHermitHome,
} from '@openhermit/shared';

import type { AgentRunner, SessionEventEnvelope } from '@openhermit/agent/agent-runner';
import { metricsRegistry, startDefaultMetrics } from '@openhermit/agent/metrics';
import { buildDefaultAgentConfig, listAllOpenHermitContainers } from '@openhermit/agent/core';
import { listProviderCatalog } from '@openhermit/agent/model-catalog';

import type { AgentInstanceManager } from './agent-instance.js';
import { listSessionsForCaller } from './session-listing.js';
import {
  registerAttachmentRoutes,
  DEFAULT_ATTACHMENT_MAX_BYTES,
} from './attachment-routes.js';
import type { LogBuffer } from './log-buffer.js';
import {
  type AuthContext,
  type AuthResolverOptions,
  type JwtConfig,
  type UserAuthProvider,
  resolveAuth,
  signJwt,
  tokensMatch,
  verifyAdminToken,
} from './auth.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SSE_PING_INTERVAL_MS = 15_000;
const SYNC_DEFAULT_TIMEOUT_MS = 300_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const writeEvent = async (
  stream: SSEStreamingApi,
  envelope: SessionEventEnvelope,
): Promise<void> => {
  await stream.writeSSE({
    id: String(envelope.id),
    event: envelope.event.type,
    data: JSON.stringify(envelope.event),
  });
};

const waitForAbort = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
};

const parseBooleanQuery = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`Invalid boolean query value: ${value}`);
};

const parsePositiveIntegerQuery = (
  value: string | undefined,
  fieldName: string,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`Invalid ${fieldName} query value: ${value}`);
  }
  return parsed;
};

const parseSessionListQuery = (request: Request): SessionListQuery => {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const platform = url.searchParams.get('platform');
  const query: SessionListQuery = {};
  if (kind) query.kind = kind;
  if (platform) query.platform = platform;
  if (url.searchParams.has('interactive')) {
    const interactive = parseBooleanQuery(
      url.searchParams.get('interactive') ?? undefined,
    );
    if (interactive !== undefined) query.interactive = interactive;
  }
  if (url.searchParams.has('limit')) {
    const limit = parsePositiveIntegerQuery(
      url.searchParams.get('limit') ?? undefined,
      'limit',
    );
    if (limit !== undefined) query.limit = limit;
  }
  const channel = url.searchParams.get('channel');
  if (channel) query.channel = channel;

  // Collect metadata.* query params (e.g. ?metadata.telegram_chat_id=123)
  const metadata: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('metadata.')) {
      metadata[key.slice('metadata.'.length)] = value;
    }
  }
  if (Object.keys(metadata).length > 0) query.metadata = metadata;

  if (url.searchParams.has('observe')) {
    const observe = parseBooleanQuery(
      url.searchParams.get('observe') ?? undefined,
    );
    if (observe !== undefined) query.observe = observe;
  }

  return query;
};

/**
 * Require auth context or throw 401. Optionally enforce agent scoping:
 *  - channel tokens carry a baked-in agentId; mismatch → 401.
 *  - user JWTs are gateway-level; the per-agent gate is the user_agents
 *    membership row, which is checked separately by callers that need it
 *    (helper below: requireAgentMembership).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requireAuth = (c: any, agentId?: string): AuthContext => {
  const auth = c.get('auth' as never) as AuthContext | undefined;
  if (!auth) throw new UnauthorizedError('Authentication required.');

  if (agentId && auth.mode === 'channel' && auth.agentId && auth.agentId !== agentId) {
    throw new UnauthorizedError('Channel token is not valid for this agent.');
  }

  return auth;
};

/** Enforce that channel-authenticated requests only access sessions within their namespace. */
const enforceSessionNamespace = (auth: AuthContext, sessionId: string): void => {
  if (auth.mode === 'channel' && auth.channelNamespace) {
    const prefix = `${auth.channelNamespace}:`;
    if (!sessionId.startsWith(prefix)) {
      throw new ValidationError(
        `Channel "${auth.channelNamespace}" can only access sessions with prefix "${prefix}".`,
      );
    }
  }
};

/**
 * Resolve the caller's userId and verify they are a participant of the
 * session. Branches on auth mode so the access check can't be bypassed:
 *
 *   - admin: full access; no check (resolves to undefined naturally).
 *   - user / channel: must resolve to a known userId AND be a participant
 *     of this session. A token whose subject no longer exists, or a
 *     channel webhook from a not-yet-seen sender, gets a 404 — never the
 *     legacy silent skip that let unrelated callers read every session.
 */
const requireSessionAccessHttp = async (
  auth: AuthContext,
  runtime: AgentRunner,
  sessionId: string,
): Promise<string | undefined> => {
  if (auth.mode === 'admin') return undefined;
  const userId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
  if (!userId) throw new NotFoundError(`Session not found: ${sessionId}`);
  await runtime.verifySessionAccess(sessionId, userId);
  return userId;
};

// ─── App options ──────────────────────────────────────────────────────────────

export interface GatewayAppOptions {
  instances: AgentInstanceManager;
  agentStore?: DbAgentStore | undefined;
  skillStore?: DbSkillStore | undefined;
  scheduleStore?: DbScheduleStore | undefined;
  mcpServerStore?: DbMcpServerStore | undefined;
  userStore?: DbUserStore | undefined;
  configStore?: DbAgentConfigStore | undefined;
  agentChannelStore?: DbAgentChannelStore | undefined;
  instructionStore?: import('@openhermit/store').DbInstructionStore | undefined;
  sandboxStore?: SandboxStore | undefined;
  policyStore?: DbPolicyStore | undefined;
  approvalRequestStore?: DbApprovalRequestStore | undefined;
  attachmentStore?: DbAttachmentStore | undefined;
  attachmentStorage?: AttachmentStorage | undefined;
  /** Hard cap on a single attachment upload, in bytes. */
  attachmentMaxBytes?: number | undefined;
  metaStore?: import('@openhermit/store').DbMetaStore | undefined;
  sessionStore?: import('@openhermit/store').DbSessionStore | undefined;
  /** Named sandbox presets, keyed by preset name. */
  sandboxPresets?: Record<string, SandboxPreset> | undefined;
  /** Default preset to use when an agent is created without an explicit `sandbox` field. Null disables auto-provisioning. */
  autoProvisionSandbox?: string | null | undefined;
  /** Live ChannelRegistry — handlers mutate this when channels are created/revoked. */
  channelRegistry?: ChannelRegistry | undefined;
  /** Channel manifest registry — drives builtin channel iteration in agent create. */
  manifestRegistry: ChannelManifestRegistry;
  auth?: AuthResolverOptions | undefined;
  adminToken?: string | undefined;
  logger?: ((message: string) => void) | undefined;
  logBuffer?: LogBuffer | undefined;
  /** Absolute path to the public directory for serving static UI files. */
  publicDir?: string | undefined;
  /** CORS allowed origin (default: '*'). */
  corsOrigin?: string | undefined;
}

// ─── Resolve runner helper ────────────────────────────────────────────────────

/**
 * Resolve a runner for a request handler. Lazily hydrates the agent if
 * `agents.status = 'active'` and no runner is in memory; rejects with
 * 404 if the agent doesn't exist or is disabled. Concurrent callers for
 * the same cold agent share one hydration via the manager's single-flight.
 */
const resolveRunner = async (
  instances: AgentInstanceManager,
  agentId: string,
): Promise<AgentRunner> => {
  const runner = await instances.getOrHydrate(agentId);
  if (!runner) {
    throw new NotFoundError(`Agent ${agentId} is not available.`);
  }
  return runner;
};

// ─── App factory ──────────────────────────────────────────────────────────────

export const createGatewayApp = (options: GatewayAppOptions): Hono => {
  const { instances, agentStore, adminToken, userStore, configStore } = options;
  const log = options.logger ?? ((msg: string) => console.log(msg));
  const app = new Hono();

  // Register default Node.js process metrics (heap, CPU, event loop) on
  // first app creation. The agent-runtime metrics are auto-registered when
  // their module is imported.
  startDefaultMetrics();

  // --- CORS ---

  app.use('*', cors({
    origin: options.corsOrigin ?? '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Type'],
  }));

  // --- request logging ---

  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    try {
      await next();
      log(`${c.req.method} ${c.req.path} -> ${c.res.status} ${Date.now() - startedAt}ms`);
    } catch (error) {
      const status = error instanceof OpenHermitError ? error.statusCode : 500;
      log(`${c.req.method} ${c.req.path} -> ${status} ${Date.now() - startedAt}ms`);
      throw error;
    }
  });

  // --- admin auth middleware for management routes ---

  const requireAdmin = (authorization: string | undefined): void => {
    if (!adminToken) {
      throw new UnauthorizedError('Admin API is not configured. Set GATEWAY_ADMIN_TOKEN.');
    }
    if (!verifyAdminToken(adminToken, authorization)) {
      throw new UnauthorizedError('Invalid admin token.');
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requireOwnerOrAdmin = async (c: any, agentId: string): Promise<AuthContext> => {
    const auth = requireAuth(c, agentId);
    if (auth.mode === 'admin') return auth;
    // Hydrate on demand: the agent may be persistently active but
    // currently evicted from memory. Owner role checks must still work.
    const runtime = await instances.getOrHydrate(agentId);
    if (!runtime) throw new NotFoundError(`Agent ${agentId} is not available.`);
    const role = await runtime.resolveCallerRole({ channel: auth.channel, channelUserId: auth.channelUserId });
    if (role !== 'owner') throw new UnauthorizedError('Owner role required.');
    return auth;
  };

  // --- JWT/channel auth middleware for agent routes ---

  if (options.auth) {
    const authOptions = options.auth;

    // Register the auth middleware BEFORE the route handlers so every
    // /api/* request gets an AuthContext attached (when credentials are
    // valid). Each endpoint then enforces its own policy via requireAuth /
    // requireAdmin / requireOwnerOrAdmin.
    const agentAuthMiddleware = async (c: any, next: any) => {
      if (c.req.path === '/api/auth/token' && c.req.method === 'POST') {
        await next();
        return;
      }
      const authContext = await resolveAuth(c.req.raw, authOptions);
      if (authContext) {
        c.set('auth' as never, authContext as never);
      }
      await next();
    };
    app.use('/api/*', agentAuthMiddleware);

    /**
     * Gateway-level token exchange. Identifies the user (device key auth
     * or any other registered provider) and returns a JWT that proves
     * "I am user X" — it is NOT scoped to any particular agent.
     *
     * Per-agent authorization happens later via /api/agents/:id/members
     * (which checks the agent's access_token if the agent is protected)
     * and per-request user_agents membership lookups.
     */
    app.post('/api/auth/token', async (c) => {
      const body: Record<string, unknown> = await c.req.json().catch(() => ({}));

      let authResult: import('./auth.js').UserAuthResult | null = null;
      for (const provider of authOptions.userProviders) {
        authResult = await provider.authenticate(body);
        if (authResult) break;
      }
      if (!authResult) throw new UnauthorizedError('Invalid credentials.');

      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }

      // Ensure a global user record + identity link. No agent role assigned
      // here; that comes via POST /api/agents/:id/members.
      let userId = await userStore.resolve(authResult.channel, authResult.channelUserId);
      let created = false;
      if (!userId) {
        const id = `usr-${crypto.randomBytes(6).toString('hex')}`;
        const now = new Date().toISOString();
        await userStore.upsert({
          userId: id,
          ...(authResult.displayName ? { name: authResult.displayName } : {}),
          createdAt: now,
          updatedAt: now,
        });
        await userStore.linkIdentity({
          userId: id,
          channel: authResult.channel,
          channelUserId: authResult.channelUserId,
          createdAt: now,
        });
        userId = id;
        created = true;
      } else if (authResult.displayName) {
        // Update display name on each successful auth so renames flow.
        const existing = await userStore.get(userId);
        if (existing && existing.name !== authResult.displayName) {
          await userStore.upsert({ ...existing, name: authResult.displayName });
        }
      }

      const { token, expiresAt } = await signJwt(authOptions.jwt, {
        channel: authResult.channel,
        channelUserId: authResult.channelUserId,
      });

      return c.json({
        token,
        expiresAt,
        userId,
        isNewDevice: created,
        ...(authResult.displayName ? { displayName: authResult.displayName } : {}),
      });
    });

    /**
     * Admin-only global user create. CLI calls this on startup to register
     * its OS-username identity before opening a session. Same semantics as
     * the token exchange but skips the device-key proof — admin auth is
     * the trust boundary.
     */
    app.post('/api/users', async (c) => {
      requireAdmin(c.req.header('authorization'));
      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }
      const body = await c.req.json().catch(() => ({})) as {
        channel?: string;
        channelUserId?: string;
        displayName?: string;
      };
      if (!body.channel || typeof body.channel !== 'string') {
        throw new ValidationError('channel is required.');
      }
      if (!body.channelUserId || typeof body.channelUserId !== 'string') {
        throw new ValidationError('channelUserId is required.');
      }

      let userId = await userStore.resolve(body.channel, body.channelUserId);
      let created = false;
      if (!userId) {
        const id = `usr-${crypto.randomBytes(6).toString('hex')}`;
        const now = new Date().toISOString();
        await userStore.upsert({
          userId: id,
          ...(body.displayName ? { name: body.displayName } : {}),
          createdAt: now,
          updatedAt: now,
        });
        await userStore.linkIdentity({
          userId: id,
          channel: body.channel,
          channelUserId: body.channelUserId,
          createdAt: now,
        });
        userId = id;
        created = true;
      }

      return c.json({ userId, created }, created ? 201 : 200);
    });

    /**
     * Admin-only token mint for trusted issuers. Lets a third-party platform
     * that has already authenticated its own user hand them a gateway JWT
     * without going through device-key. Body:
     *   { channel, channelUserId, displayName? }
     * The caller chooses a stable `channel` namespace for their platform
     * (e.g. "my-platform"); `channelUserId` should be the platform's own
     * user id. Same `(channel, channelUserId)` always resolves to the same
     * gateway user, so this composes with channel webhooks using the same
     * namespace.
     */
    app.post('/api/admin/auth/issue-token', async (c) => {
      requireAdmin(c.req.header('authorization'));
      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }
      const body = await c.req.json().catch(() => ({})) as {
        channel?: string;
        channelUserId?: string;
        displayName?: string;
      };
      if (!body.channel || typeof body.channel !== 'string') {
        throw new ValidationError('channel is required.');
      }
      if (body.channel === 'admin') {
        // 'admin' is reserved for the static admin token path; minting a
        // JWT with this channel would be confusing in audit views.
        throw new ValidationError('channel "admin" is reserved.');
      }
      if (!body.channelUserId || typeof body.channelUserId !== 'string') {
        throw new ValidationError('channelUserId is required.');
      }
      if (body.displayName !== undefined && typeof body.displayName !== 'string') {
        throw new ValidationError('displayName must be a string if provided.');
      }

      let userId = await userStore.resolve(body.channel, body.channelUserId);
      let created = false;
      if (!userId) {
        const id = `usr-${crypto.randomBytes(6).toString('hex')}`;
        const now = new Date().toISOString();
        await userStore.upsert({
          userId: id,
          ...(body.displayName ? { name: body.displayName } : {}),
          createdAt: now,
          updatedAt: now,
        });
        await userStore.linkIdentity({
          userId: id,
          channel: body.channel,
          channelUserId: body.channelUserId,
          createdAt: now,
        });
        userId = id;
        created = true;
      } else if (body.displayName) {
        const existing = await userStore.get(userId);
        if (existing && existing.name !== body.displayName) {
          await userStore.upsert({ ...existing, name: body.displayName });
        }
      }

      const { token, expiresAt } = await signJwt(authOptions.jwt, {
        channel: body.channel,
        channelUserId: body.channelUserId,
      });

      return c.json({
        token,
        expiresAt,
        userId,
        isNewDevice: created,
        ...(body.displayName ? { displayName: body.displayName } : {}),
      });
    });

    /**
     * Agents the JWT subject is a member of. Powers the web "pick agent"
     * screen so users can jump straight back into agents they've already
     * joined.
     */
    app.get('/api/users/me/agents', async (c) => {
      const auth = requireAuth(c);
      if (auth.mode !== 'user') throw new UnauthorizedError('User JWT required.');
      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }
      const userId = await userStore.resolve(auth.channel, auth.channelUserId);
      if (!userId) return c.json([]);
      const memberships = await userStore.listAgentRoles(userId);

      // Enrich with agent display info from agentStore.
      const records = agentStore ? await agentStore.list() : [];
      const byId = new Map(records.map((r) => [r.agentId, r]));
      // `status` reflects the agent's persistent availability, not whether
      // it currently has an in-memory runner — with lazy hydration + LRU
      // eviction, an evicted agent is still available to chat (re-hydrates
      // on demand).
      const result = memberships.map((m) => {
        const rec = byId.get(m.agentId);
        return {
          agentId: m.agentId,
          role: m.role,
          ...(rec?.name ? { name: rec.name } : {}),
          status: rec?.status ?? 'disabled',
        };
      });
      return c.json(result);
    });

    /**
     * Join an agent: assign a user_agents row.
     *
     * Body shapes:
     *   { userId, role?, accessToken? }
     *     — target an existing internal user.
     *   { channel, channelUserId, displayName?, role? }
     *     — owner / admin only. Resolves the channel identity to a user
     *       (creating the user + linking the identity if needed) and
     *       assigns membership. Useful for invite-by-handle flows.
     *
     * Auth modes & access policy:
     *   - admin: full power; can use either body shape, set any role.
     *   - JWT user with owner role on this agent: can add other users
     *     (either body shape).
     *   - JWT user (no role yet): self-join only, role defaults to guest.
     *     - access=public: allowed.
     *     - access=protected: accessToken in body must match the agent's
     *       access_token.
     *     - access=private: rejected — only owner/admin can add members.
     */
    app.post('/api/agents/:agentId/members', async (c) => {
      const agentId = c.req.param('agentId') ?? '';
      const auth = requireAuth(c);
      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }
      if (!agentStore) {
        throw new OpenHermitError('Agent store is not configured.', 'not_configured', 500);
      }
      const agentRec = await agentStore.get(agentId);
      if (!agentRec) throw new NotFoundError(`Agent not found: ${agentId}`);

      const body = await c.req.json().catch(() => ({})) as {
        userId?: string;
        channel?: string;
        channelUserId?: string;
        displayName?: string;
        role?: 'owner' | 'user' | 'guest';
        accessToken?: string;
      };

      const byChannel = typeof body.channel === 'string' && typeof body.channelUserId === 'string';
      if (byChannel && body.userId) {
        throw new ValidationError('Provide either userId or (channel, channelUserId), not both.');
      }
      if (!byChannel && !body.userId && auth.mode !== 'user') {
        throw new ValidationError('Body must include userId or (channel, channelUserId).');
      }

      const now = new Date().toISOString();

      // Helper: turn (channel, channelUserId) into an internal userId,
      // creating the user + identity link on first sight.
      const resolveOrCreateByChannel = async (channel: string, channelUserId: string, displayName?: string): Promise<string> => {
        const existing = await userStore!.resolve(channel, channelUserId);
        if (existing) {
          if (displayName) {
            const rec = await userStore!.get(existing);
            if (rec && !rec.name) {
              await userStore!.upsert({ ...rec, name: displayName });
            }
          }
          return existing;
        }
        const newId = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        await userStore!.upsert({
          userId: newId,
          ...(displayName ? { name: displayName } : {}),
          createdAt: now,
          updatedAt: now,
        });
        await userStore!.linkIdentity({ userId: newId, channel, channelUserId, createdAt: now });
        return newId;
      };

      // ── Resolve target userId ────────────────────────────────────────
      let targetUserId: string;
      let isSelfJoin = false;

      if (auth.mode === 'admin') {
        targetUserId = byChannel
          ? await resolveOrCreateByChannel(body.channel!, body.channelUserId!, body.displayName)
          : body.userId!;
      } else if (auth.mode === 'user') {
        const callerUserId = await userStore.resolve(auth.channel, auth.channelUserId);
        if (!callerUserId) throw new UnauthorizedError('JWT subject does not resolve to a known user.');
        const callerRole = await userStore.getAgentRole({ agentId }, callerUserId);

        if (byChannel) {
          // Adding-by-channel always targets someone else; require owner.
          if (callerRole !== 'owner') {
            throw new UnauthorizedError('Only owners or admins can add members by channel identity.');
          }
          targetUserId = await resolveOrCreateByChannel(body.channel!, body.channelUserId!, body.displayName);
        } else if (body.userId && body.userId !== callerUserId) {
          if (callerRole !== 'owner') {
            throw new UnauthorizedError('Only owners or admins can add other users.');
          }
          targetUserId = body.userId;
        } else {
          targetUserId = callerUserId;
          isSelfJoin = true;
        }
      } else {
        throw new UnauthorizedError('Auth mode not allowed for this endpoint.');
      }

      // ── Determine effective role ────────────────────────────────────
      const effectiveRole: 'owner' | 'user' | 'guest' =
        auth.mode === 'admin' ? (body.role ?? 'guest')
        : (body.role && body.role !== 'owner') ? body.role  // non-admins can't grant owner here
        : 'guest';

      // ── Access-policy gate (applies to JWT-user self-join only) ────
      if (isSelfJoin) {
        const securityDoc = configStore ? await configStore.getSecurity(agentId) : null;
        const accessLevel = (securityDoc?.access as string | undefined) ?? 'public';
        if (accessLevel === 'private') {
          throw new UnauthorizedError('This agent is private; only the owner can add members.');
        }
        if (accessLevel === 'protected') {
          const expectedToken = securityDoc?.access_token as string | undefined;
          if (!expectedToken || body.accessToken !== expectedToken) {
            throw new UnauthorizedError('Invalid or missing agent access token.');
          }
        }
      }

      await userStore.assignAgent({ agentId }, targetUserId, effectiveRole, now);
      return c.json({ agentId, userId: targetUserId, role: effectiveRole });
    });

    app.delete('/api/agents/:agentId/members/:userId', async (c) => {
      const agentId = c.req.param('agentId') ?? '';
      const targetUserId = c.req.param('userId') ?? '';
      await requireOwnerOrAdmin(c, agentId);
      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }
      await userStore.removeAgent({ agentId }, targetUserId);
      return c.json({ ok: true });
    });

    /**
     * List members of an agent with their channel identities. Owner /
     * admin only — owners use this to see who's in, what channels they
     * came from, and what roles they hold.
     */
    app.get('/api/agents/:agentId/members', async (c) => {
      const agentId = c.req.param('agentId') ?? '';
      await requireOwnerOrAdmin(c, agentId);
      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }
      const members = await userStore.listByAgent({ agentId });
      const memberIds = members.map((m) => m.userId);
      const [identitiesMap, userRecords] = await Promise.all([
        userStore.listIdentitiesByUserIds(memberIds),
        Promise.all(memberIds.map((id) => userStore!.get(id))),
      ]);
      const userById = new Map<string, typeof userRecords[number]>();
      memberIds.forEach((id, i) => userById.set(id, userRecords[i]));
      const enriched = members.map((m) => {
        const user = userById.get(m.userId);
        const identities = identitiesMap.get(m.userId) ?? [];
        return {
          userId: m.userId,
          role: m.role,
          createdAt: m.createdAt,
          ...(user?.name ? { displayName: user.name } : {}),
          identities: identities.map((i) => ({
            channel: i.channel,
            channelUserId: i.channelUserId,
            createdAt: i.createdAt,
          })),
        };
      });
      return c.json(enriched);
    });

  } else if (adminToken) {
    // No JWT auth configured, but admin token exists — resolve admin auth for per-agent management routes
    const adminMiddleware = async (c: any, next: any) => {
      const authorization = c.req.header('authorization');
      if (authorization?.startsWith('Bearer ') && tokensMatch(authorization.slice(7), adminToken)) {
        c.set('auth' as never, { mode: 'admin', channel: 'admin', channelUserId: 'admin' } as never);
      }
      await next();
    };
    app.use('/api/agents/*', adminMiddleware);
    app.use('/api/providers', adminMiddleware);
  }

  // --- gateway health ---

  app.get('/health', (c) =>
    c.json({ ok: true, role: 'gateway' }),
  );

  // --- prometheus metrics (no auth — bind to localhost or scrape via reverse proxy) ---

  app.get('/metrics', async (c) => {
    const body = await metricsRegistry.metrics();
    return c.text(body, 200, { 'content-type': metricsRegistry.contentType });
  });

  // Static catalog of providers + models supported by the agent runtime
  // (sourced from @mariozechner/pi-ai). Global, not per-agent — the
  // catalog is identical for every agent. Any authenticated caller
  // (admin token or user JWT) can read it.
  app.get('/api/providers', (c) => {
    requireAuth(c);
    return c.json(listProviderCatalog());
  });

  // --- agent CRUD (admin-only) ---

  app.get(gatewayRoutes.agents, async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (agentStore) {
      const records = await agentStore.list();
      const agents = records.map((record) => ({
        agentId: record.agentId,
        // Persistent availability — see /api/users/me/agents above.
        status: record.status === 'active' ? 'running' as const : 'stopped' as const,
        ...(record.name ? { name: record.name } : {}),
        workspaceDir: record.workspaceDir,
      }));
      return c.json(agents);
    }
    return c.json([]);
  });

  app.post(gatewayRoutes.agents, async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!agentStore) {
      return c.json(
        { error: { code: 'not_configured', message: 'Agent store is not configured. Set DATABASE_URL to enable agent persistence.' } },
        501,
      );
    }

    const body = await c.req.json<CreateAgentRequest>();

    if (!body.agentId || typeof body.agentId !== 'string') {
      throw new ValidationError('agentId is required and must be a string.');
    }

    const existing = await agentStore.get(body.agentId);
    if (existing) {
      return c.json(
        { error: { code: 'conflict', message: `Agent already exists: ${body.agentId}` } },
        409,
      );
    }

    const homeDir = resolveOpenHermitHome();
    const now = new Date().toISOString();
    const record = await agentStore.create({
      agentId: body.agentId,
      ...(body.name ? { name: body.name } : {}),
      workspaceDir: body.workspaceDir ?? `${homeDir}/workspaces/${body.agentId}`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Eager-create the per-agent inbox session row so web UI subscribers
    // never race against lazy hydration. See docs/inbox-design.md.
    if (options.sessionStore) {
      await options.sessionStore.upsert(
        { agentId: record.agentId },
        buildInboxSessionEntry(now),
      );
    }

    // Canonical agent config + security policy live in the DB.
    if (!configStore) {
      throw new OpenHermitError(
        'Agent config store is not configured (missing DATABASE_URL?).',
        'not_configured',
        500,
      );
    }
    const templateConfig = buildDefaultAgentConfig(record.workspaceDir);
    if (
      body.access !== undefined &&
      body.access !== 'public' &&
      body.access !== 'protected' &&
      body.access !== 'private'
    ) {
      throw new ValidationError(
        `access must be 'public', 'protected', or 'private' (got ${JSON.stringify(body.access)}).`,
      );
    }
    const templateSecurity: Record<string, unknown> = {
      ...(body.access ? { access: body.access } : {}),
    };

    // Sandboxes are now first-class DB rows. When the sandbox store is wired,
    // strip the legacy exec.backends[] block from the template config and
    // auto-provision a default sandbox row instead (when configured).
    const configToWrite = options.sandboxStore
      ? (() => {
          const { exec: _exec, ...rest } = templateConfig as unknown as Record<string, unknown>;
          void _exec;
          return rest;
        })()
      : (templateConfig as unknown as Record<string, unknown>);

    await configStore.setConfig(record.agentId, configToWrite);
    await configStore.setSecurity(record.agentId, templateSecurity);

    // Resolve which sandbox preset (if any) to provision. The body's
    // `sandbox` field selects: a named preset, null (skip), or omitted
    // (fall back to the gateway-level autoProvisionSandbox preset).
    if (options.sandboxStore) {
      const presets = options.sandboxPresets ?? {};
      let presetName: string | null;
      if (body.sandbox === null) {
        presetName = null;
      } else if (typeof body.sandbox === 'string') {
        if (!presets[body.sandbox]) {
          throw new ValidationError(
            `Unknown sandbox preset "${body.sandbox}". Known: ${Object.keys(presets).join(', ') || '(none)'}`,
          );
        }
        presetName = body.sandbox;
      } else {
        presetName = options.autoProvisionSandbox ?? null;
      }
      if (presetName) {
        const preset = presets[presetName];
        if (!preset) {
          // Auto-provision points at a missing preset — operator misconfiguration.
          throw new OpenHermitError(
            `autoProvisionSandbox references unknown preset "${presetName}".`,
            'config_invalid',
            500,
          );
        }
        await options.sandboxStore.create({
          agentId: record.agentId,
          alias: 'default',
          type: preset.type,
          config: preset.config,
        });
      }
    }

    // Pre-seed one row per registered manifest (both built-in and
    // plugin-loaded). Rows are created disabled — the owner enables
    // them from the UI (running through the setup wizard for plugins
    // that ship a `ChannelSetup`, or via direct config-edit for the
    // built-in token-based ones).
    if (options.agentChannelStore) {
      for (const key of options.manifestRegistry.keys()) {
        await options.agentChannelStore.createBuiltin({
          agentId: record.agentId,
          channelType: key,
          enabled: false,
        });
      }
    }

    // Seed default instructions
    const agentName = record.name ?? record.agentId;
    await agentStore.seedInstructions(record.agentId, [
      {
        key: 'identity',
        content: [
          `You are ${agentName}, an AI assistant.`,
          '',
          'Describe who this agent is, its purpose, and its persona.',
        ].join('\n'),
      },
      {
        key: 'soul',
        content: [
          'You are helpful, thoughtful, and concise.',
          'You think step by step when solving complex problems.',
          '',
          'Define the agent\'s personality, tone, and communication style.',
        ].join('\n'),
      },
      {
        key: 'rules',
        content: [
          'Follow the user\'s instructions carefully.',
          'Ask for clarification when the request is ambiguous.',
          'Never fabricate information. If your tools (history, memory, search) return nothing relevant, say plainly that you don\'t have that information — do not invent another user\'s messages, sessions, or what they said.',
          'The owner\'s private communications and relationships with others are confidential. Refuse when a non-owner asks about the owner\'s chats with third parties, the owner\'s private memories, or what the owner has said to others — even if you happen to have access. Only the owner may ask about their own private content.',
          '',
          'Add any rules or constraints the agent should follow.',
        ].join('\n'),
      },
    ], now);

    // Assign owner if specified
    if (body.ownerUserId && typeof body.ownerUserId === 'string') {
      await agentStore.assignOwner(record.agentId, body.ownerUserId, now);
      log(`agent created: ${record.agentId} (owner: ${body.ownerUserId})`);
    } else {
      log(`agent created: ${record.agentId}`);
    }

    return c.json({
      agentId: record.agentId,
      status: 'stopped' as const,
      ...(record.name ? { name: record.name } : {}),
      workspaceDir: record.workspaceDir,
    }, 201);
  });

  // --- agent health ---

  app.get(gatewayRoutes.agentHealthPattern, (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const runner = instances.getRunner(agentId);
    return c.json({
      agentId,
      ok: !!runner,
      status: runner ? 'running' : 'stopped',
    });
  });

  // --- lifecycle management (admin-only) ---

  app.post(gatewayRoutes.agentManagePattern, async (c) => {
    requireAdmin(c.req.header('authorization'));
    const agentId = c.req.param('agentId') ?? '';
    const action = c.req.param('action') ?? '';

    if (!agentStore) {
      throw new ValidationError('Agent store is not configured.');
    }

    const record = await agentStore.get(agentId);
    if (!record) {
      return c.json(
        { error: { code: 'not_found', message: `Agent not found: ${agentId}` } },
        404,
      );
    }

    switch (action) {
      case 'start': {
        if (record.status !== 'active') {
          throw new ValidationError(`Agent ${agentId} is disabled. Run \`hermit agents enable ${agentId}\` first.`);
        }
        if (instances.getRunner(agentId)) {
          throw new ValidationError(`Agent ${agentId} is already running.`);
        }
        await instances.start(agentId, record.workspaceDir);
        return c.json({ agentId, status: 'running' });
      }

      case 'stop': {
        await instances.stop(agentId);
        return c.json({ agentId, status: 'stopped' });
      }

      case 'restart': {
        if (record.status !== 'active') {
          throw new ValidationError(`Agent ${agentId} is disabled. Run \`hermit agents enable ${agentId}\` first.`);
        }
        await instances.stop(agentId);
        await instances.start(agentId, record.workspaceDir);
        return c.json({ agentId, status: 'running' });
      }

      case 'delete': {
        if (record.status !== 'disabled') {
          throw new ValidationError(`Agent ${agentId} must be disabled before deletion. Run \`hermit agents disable ${agentId}\` first.`);
        }
        if (instances.getRunner(agentId)) {
          await instances.stop(agentId);
        }
        await agentStore.delete(agentId);
        log(`agent deleted: ${agentId}`);
        return c.json({ agentId, status: 'deleted' });
      }

      case 'enable': {
        const updated = await agentStore.setStatus(agentId, 'active');
        log(`agent enabled: ${agentId}`);
        return c.json({ agentId, status: updated?.status ?? 'active' });
      }

      case 'disable': {
        await agentStore.setStatus(agentId, 'disabled');
        // Actively evict the runner so the change takes effect immediately.
        // No multi-gateway propagation here yet — single-gateway deployment
        // assumed for v1; LISTEN/NOTIFY can be wired later.
        if (instances.getRunner(agentId)) {
          await instances.stop(agentId);
        }
        log(`agent disabled: ${agentId}`);
        return c.json({ agentId, status: 'disabled' });
      }

      default:
        throw new ValidationError(
          `Unknown lifecycle action: ${action}. Valid actions: start, stop, restart, delete, enable, disable`,
        );
    }
  });

  // --- sessions ---

  app.post(gatewayRoutes.agentSessionsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = requireAuth(c, agentId);
    const runtime = await resolveRunner(instances, agentId);
    const payload = await c.req.json().catch(() => null);

    if (!isSessionSpec(payload)) {
      throw new ValidationError('Invalid SessionSpec payload.');
    }

    // Channel tokens can only create sessions within their namespace.
    enforceSessionNamespace(auth, payload.sessionId);

    // Pass caller identity directly to the runtime instead of injecting
    // it into session metadata — keeps "who's calling now" cleanly
    // separated from the session's persisted attributes.
    const caller = auth.mode === 'user' && auth.channelUserId
      ? { channel: auth.channel, channelUserId: auth.channelUserId }
      : undefined;
    const session = await runtime.openSession(payload, caller);
    return c.json({ sessionId: session.spec.sessionId });
  });

  app.get(gatewayRoutes.agentSessionsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = requireAuth(c, agentId);
    const runtime = await resolveRunner(instances, agentId);
    const query = parseSessionListQuery(c.req.raw);
    return c.json(await listSessionsForCaller(runtime, auth, query));
  });

  // --- messages ---

  app.post(gatewayRoutes.agentSessionMessagesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
    if (sessionId === 'inbox') {
      throw new OpenHermitError(
        'Inbox session is read-only.',
        'inbox_read_only',
        403,
      );
    }
    const runtime = await resolveRunner(instances, agentId);

    // Verify caller is a participant (user mode only; channels handle identity per-message)
    if (auth.mode === 'user') {
      await requireSessionAccessHttp(auth, runtime, sessionId);
    }

    const payload = await c.req.json().catch(() => null);

    if (!isSessionMessage(payload)) {
      throw new ValidationError('Invalid SessionMessage payload.');
    }

    // Channel namespace enforcement
    if (auth.mode === 'channel' && auth.channelNamespace && payload.sender) {
      if (payload.sender.channel !== auth.channelNamespace) {
        throw new ValidationError(
          `Channel namespace violation: channel "${auth.channelNamespace}" cannot declare sender identity for "${payload.sender.channel}".`,
        );
      }
    }

    const url = new URL(c.req.url);
    const appendMode = url.searchParams.get('append') === 'true' || url.searchParams.get('inject') === 'true';

    // Lazy-rehydrate after a gateway restart / eviction. The session may
    // still exist in DB but not in the runner's in-memory map; the runner's
    // post/append paths require an active session and would 404 otherwise.
    const httpCaller = (auth.mode === 'user' || auth.mode === 'channel') && auth.channelUserId
      ? { channel: auth.channel, channelUserId: auth.channelUserId }
      : undefined;
    await runtime.ensureSessionLoaded(sessionId, httpCaller);

    if (appendMode) {
      const result = await runtime.appendMessage(sessionId, payload);
      return c.json({ sessionId, ...result });
    }

    // `appendAs` / `occurredAt` are only meaningful for appendMessage —
    // postMessage represents a live user turn that drives a generation,
    // never a backfilled or assistant-role entry. Reject loudly so the
    // caller can pick the right method.
    if (payload.appendAs !== undefined || payload.occurredAt !== undefined) {
      throw new ValidationError(
        '`appendAs` and `occurredAt` are only supported on appendMessage (POST ?append=true).',
      );
    }

    const waitMode = url.searchParams.get('wait') === 'true';
    const streamMode = url.searchParams.get('stream') === 'true';

    // For fire-and-forget or when the server decides not to trigger (guest + not mentioned in group),
    // we can handle it early in wait/stream modes too.
    if (!waitMode && !streamMode) {
      const result = await runtime.postMessage(sessionId, payload);
      return c.json(result);
    }

    // Check if the message will actually trigger a response before setting up SSE/wait.
    // We need to post first, then check `triggered`.
    if (waitMode) {
      const timeoutMs = parsePositiveIntegerQuery(
        url.searchParams.get('timeout') ?? undefined,
        'timeout',
      ) ?? SYNC_DEFAULT_TIMEOUT_MS;

      const toolCalls: SyncToolCall[] = [];
      let text: string | null = null;
      let error: string | undefined;
      let messageId: string | undefined;
      let done = false;
      let resolvePromise: ((response: Response) => void) | undefined;

      const timer = setTimeout(() => {
        cleanup();
        const response: SyncResponse = {
          sessionId,
          ...(messageId ? { messageId } : {}),
          text,
          toolCalls,
          error: 'Timeout waiting for agent response.',
        };
        resolvePromise?.(c.json(response, 504));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribe();
      };

      const unsubscribe = runtime.events.subscribe(sessionId, (envelope) => {
        const ev = envelope.event;
        switch (ev.type) {
          case 'tool_result':
            toolCalls.push({
              tool: ev.tool,
              isError: ev.isError,
              ...(ev.text !== undefined ? { text: ev.text } : {}),
              ...(ev.details !== undefined ? { details: ev.details } : {}),
            });
            break;
          case 'text_final':
            text = ev.text;
            break;
          case 'error':
            error = ev.message;
            break;
          case 'agent_end':
            done = true;
            cleanup();
            resolvePromise?.(c.json({
              sessionId,
              ...(messageId ? { messageId } : {}),
              text,
              toolCalls,
              ...(error !== undefined ? { error } : {}),
            } satisfies SyncResponse));
            break;
        }
      });

      const result = await runtime.postMessage(sessionId, payload);
      messageId = result.messageId;

      if (!result.triggered) {
        cleanup();
        return c.json({ sessionId, ...(messageId ? { messageId } : {}), text: null, toolCalls: [], triggered: false } satisfies SyncResponse & { triggered: boolean });
      }

      if (done) {
        cleanup();
        return c.json({
          sessionId,
          ...(messageId ? { messageId } : {}),
          text,
          toolCalls,
          ...(error !== undefined ? { error } : {}),
        } satisfies SyncResponse);
      }

      return new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });
    }

    if (streamMode) {
      const buffered: SessionEventEnvelope[] = [];
      let streamReady = false;
      let streamApi: SSEStreamingApi | undefined;

      const unsubscribe = runtime.events.subscribe(sessionId, async (envelope) => {
        if (streamReady && streamApi) {
          await writeEvent(streamApi, envelope);
          if (envelope.event.type === 'agent_end') {
            unsubscribe();
            void streamApi.close();
          }
        } else {
          buffered.push(envelope);
        }
      });

      const result = await runtime.postMessage(sessionId, payload);

      if (!result.triggered) {
        unsubscribe();
        return c.json(result);
      }

      return streamSSE(c, async (stream) => {
        streamApi = stream;

        if (result.messageId) {
          await stream.writeSSE({
            event: 'message_ack',
            data: JSON.stringify({ sessionId, messageId: result.messageId }),
          });
        }

        let closed = false;
        for (const envelope of buffered) {
          await writeEvent(stream, envelope);
          if (envelope.event.type === 'agent_end') {
            unsubscribe();
            closed = true;
            break;
          }
        }
        buffered.length = 0;
        streamReady = true;

        if (!closed) {
          await waitForAbort(c.req.raw.signal);
          unsubscribe();
        }
      });
    }
  });

  app.get(gatewayRoutes.agentSessionMessagesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
    const runtime = await resolveRunner(instances, agentId);

    if (auth.mode === 'admin') {
      return c.json(await runtime.listSessionMessages(sessionId));
    }

    const callerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
    if (!callerUserId) throw new NotFoundError(`Session not found: ${sessionId}`);
    const messages = await runtime.listSessionMessages(sessionId, callerUserId);
    return c.json(messages);
  });

  // --- approve ---

  app.post(gatewayRoutes.agentSessionApprovePattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const approveAuth = requireAuth(c, agentId);
    enforceSessionNamespace(approveAuth, sessionId);
    const runtime = await resolveRunner(instances, agentId);
    await requireSessionAccessHttp(approveAuth, runtime, sessionId);
    const payload = await c.req.json().catch(() => null);

    if (!isToolApprovalRequest(payload)) {
      throw new ValidationError('Invalid ToolApprovalRequest payload.');
    }

    const resolved = runtime.respondToApproval(
      sessionId,
      payload.toolCallId,
      payload.approved,
    );

    return c.json({ resolved });
  });

  // --- interrupt ---

  app.post(gatewayRoutes.agentSessionInterruptPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const intAuth = requireAuth(c, agentId);
    enforceSessionNamespace(intAuth, sessionId);
    const runtime = await resolveRunner(instances, agentId);
    await requireSessionAccessHttp(intAuth, runtime, sessionId);
    const interrupted = runtime.interruptSession(sessionId);
    return c.json({ interrupted });
  });

  // --- attachments ---

  if (options.attachmentStore && options.attachmentStorage) {
    registerAttachmentRoutes(app, {
      instances,
      attachmentStore: options.attachmentStore,
      attachmentStorage: options.attachmentStorage,
      maxBytes: options.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
      requireAuth,
      enforceSessionNamespace,
      resolveRunner,
      requireSessionAccessHttp,
      logger: log,
    });
  }

  // --- checkpoint ---

  app.post(gatewayRoutes.agentSessionCheckpointPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const cpAuth = requireAuth(c, agentId);
    enforceSessionNamespace(cpAuth, sessionId);
    const runtime = await resolveRunner(instances, agentId);
    await requireSessionAccessHttp(cpAuth, runtime, sessionId);
    const payload = await c.req.json().catch(() => ({}));

    if (!isSessionCheckpointRequest(payload)) {
      throw new ValidationError('Invalid SessionCheckpointRequest payload.');
    }

    const checkpointed = await runtime.checkpointSession(
      sessionId,
      payload.reason ?? 'manual',
    );

    return c.json({ checkpointed });
  });

  // --- delete session ---

  app.delete('/api/agents/:agentId/sessions/:sessionId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
    const runtime = await resolveRunner(instances, agentId);
    const callerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
    await runtime.deleteSession(sessionId, callerUserId ?? undefined);
    return c.json({ deleted: true });
  });

  // --- SSE events ---

  app.get(gatewayRoutes.agentSessionEventsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
    const runtime = await resolveRunner(instances, agentId);
    // Verify caller is a participant (user mode only; channels use namespace enforcement above).
    if (auth.mode === 'user') {
      await requireSessionAccessHttp(auth, runtime, sessionId);
    }

    return streamSSE(c, async (stream) => {
      for (const envelope of runtime.events.getBacklog(sessionId)) {
        await writeEvent(stream, envelope);
      }

      const unsubscribe = runtime.events.subscribe(sessionId, async (envelope) => {
        await writeEvent(stream, envelope);
      });

      const heartbeat = setInterval(() => {
        void stream.writeSSE({
          event: 'ping',
          data: JSON.stringify({ sessionId }),
        });
      }, SSE_PING_INTERVAL_MS);

      try {
        // Include nextEventId so clients with a stored last-event cursor
        // can detect sequence resets after runner eviction (broker is
        // per-runner; new runner restarts ids at 1).
        await stream.writeSSE({
          event: 'ready',
          data: JSON.stringify({ sessionId, nextEventId: runtime.events.getNextEventId() }),
        });
        await waitForAbort(c.req.raw.signal);
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  // --- admin API ---

  app.get('/api/admin/agents/fleet', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!agentStore) return c.json([]);

    const records = await agentStore.list();
    const agentIds = records.map((r) => r.agentId);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [stats, usage] = await Promise.all([
      agentStore.fleetStats(agentIds, since),
      agentStore.fleetUsage(agentIds),
    ]);

    const emptyUsage = {
      window24h: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      window7d:  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      allTime:   { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    };

    const fleet = await Promise.all(records.map(async (record) => {
      const stat = stats.get(record.agentId) ?? {
        sessions24h: 0, errors24h: 0, skillsCount: 0, mcpCount: 0,
      };
      const u = usage.get(record.agentId) ?? emptyUsage;
      const channelStatuses = instances.getChannelPool()?.getStatuses(record.agentId) ?? [];
      const channelsEnabled = channelStatuses
        .filter((s) => s.status === 'connected')
        .map((s) => s.name);
      return {
        agentId: record.agentId,
        ...(record.name ? { name: record.name } : {}),
        status: record.status,
        sessions24h: stat.sessions24h,
        errors24h: stat.errors24h,
        ...(stat.lastActivity ? { lastActivity: stat.lastActivity } : {}),
        channels: channelsEnabled,
        skillsCount: stat.skillsCount,
        mcpCount: stat.mcpCount,
        usage: u,
      };
    }));
    return c.json(fleet);
  });

  app.get('/api/admin/agents/:agentId/usage', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!agentStore) {
      return c.json({ error: { code: 'not_configured', message: 'Agent store not configured.' } }, 500);
    }
    const detail = await agentStore.agentUsageDetail(c.req.param('agentId'));
    return c.json(detail);
  });

  app.get('/api/admin/sandboxes', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = options.sandboxStore;
    if (!store) {
      return c.json({ error: { code: 'not_configured', message: 'Sandbox store is not configured.' } }, 500);
    }
    const rows = await store.listAll();

    // Resolve agent display names.
    const nameByAgent = new Map<string, string | undefined>();
    if (agentStore) {
      const records = await agentStore.list();
      for (const r of records) nameByAgent.set(r.agentId, r.name);
    }

    // Best-effort overlay of local docker daemon state. Lets the UI show
    // "is the container actually running on this host right now" alongside
    // the DB lifecycle status. Failures are non-fatal — we still return the
    // DB rows so e2b/host sandboxes remain visible when docker is down.
    const dockerByName = new Map<string, { id: string; status: string; statusText: string; image: string }>();
    try {
      const live = await listAllOpenHermitContainers();
      for (const ct of live) {
        dockerByName.set(ct.name, {
          id: ct.id,
          status: ct.status,
          statusText: ct.statusText,
          image: ct.image,
        });
      }
    } catch {
      // docker unavailable — leave dockerByName empty
    }

    return c.json(rows.map((row) => {
      const dockerInfo = row.type === 'docker' && row.externalId
        ? dockerByName.get(row.externalId)
        : undefined;
      return {
        id: row.id,
        agentId: row.agentId,
        agentName: nameByAgent.get(row.agentId),
        alias: row.alias,
        type: row.type,
        status: row.status,
        externalId: row.externalId,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
        runtime: dockerInfo
          ? { status: dockerInfo.status, statusText: dockerInfo.statusText, image: dockerInfo.image }
          : null,
      };
    }));
  });

  app.get('/api/admin/users', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!userStore) return c.json([]);
    const list = await userStore.list();
    const userIds = list.map((u) => u.userId);
    const [identitiesMap, agentsMap] = await Promise.all([
      userStore.listIdentitiesByUserIds(userIds),
      userStore.listAgentRolesByUserIds(userIds),
    ]);
    const enriched = list.map((u) => ({
      userId: u.userId,
      name: u.name ?? null,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      identityCount: (identitiesMap.get(u.userId) ?? []).length,
      agentCount: (agentsMap.get(u.userId) ?? []).length,
    }));
    return c.json(enriched);
  });

  app.get('/api/admin/users/:userId/identities', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!userStore) return c.json([]);
    const identities = await userStore.listIdentities(c.req.param('userId'));
    return c.json(identities);
  });

  app.get('/api/admin/users/:userId/agents', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!userStore) return c.json([]);
    const records = await userStore.listAgentRoles(c.req.param('userId'));
    return c.json(records);
  });

  app.get('/api/admin/stats', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const memoryUsage = process.memoryUsage();
    const [counts, usage] = agentStore
      ? await Promise.all([agentStore.counts(), agentStore.usageTotals()])
      : [
          { users: 0, sessions: 0, sessionEvents: 0 },
          {
            window24h: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
            allTime:   { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
          },
        ];
    return c.json({
      uptime: process.uptime(),
      memory: {
        rss: memoryUsage.rss,
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
      },
      agents: {
        running: instances.listRunnerIds().length,
      },
      counts,
      usage,
    });
  });

  app.get('/api/admin/logs', (c) => {
    requireAdmin(c.req.header('authorization'));
    const lines = parsePositiveIntegerQuery(
      c.req.query('lines') ?? undefined,
      'lines',
    ) ?? 200;
    const entries = options.logBuffer?.tail(lines) ?? [];
    return c.json(entries);
  });

  // ── Gateway-level config ────────────────────────────────────────────
  // Read/write the gateway's own settings (sandbox presets, CORS, etc.).
  // Stored in the `meta` table under the key `gateway.config`. Changes
  // do not take effect until the gateway is restarted.

  app.get('/api/admin/gateway/config', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const { metaStore } = options;
    if (!metaStore) {
      // No DB — surface the in-memory config (parsed at boot from file/defaults).
      return c.json({
        config: {
          sandboxPresets: options.sandboxPresets ?? {},
          autoProvisionSandbox: options.autoProvisionSandbox ?? null,
          ...(options.corsOrigin ? { cors: { origin: options.corsOrigin } } : {}),
        },
        source: 'memory',
        persistent: false,
      });
    }
    const raw = await metaStore.getJson<Record<string, unknown>>(META_KEY);
    const config = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? parseGatewayConfig(raw as Record<string, unknown>)
      : defaultGatewayConfig();
    return c.json({ config, source: raw ? 'db' : 'defaults', persistent: true });
  });

  app.put('/api/admin/gateway/config', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const { metaStore } = options;
    if (!metaStore) {
      throw new OpenHermitError(
        'Gateway config persistence requires DATABASE_URL.',
        'not_configured',
        500,
      );
    }
    const body = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object.');
    }
    if ((body as Record<string, unknown>).ui === false) {
      throw new ValidationError(
        'Refusing to disable the admin UI from the admin API. Edit the DB directly if you really need to.',
      );
    }
    try {
      const saved = await saveGatewayConfig(metaStore, body as Record<string, unknown>);
      return c.json({ ok: true, config: saved, restart_required: true });
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/agents/:agentId/info', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    requireAuth(c, agentId);
    const record = await agentStore?.get(agentId);
    return c.json({
      agentId,
      name: record?.name ?? agentId,
      status: record?.status === 'active' ? 'running' : 'stopped',
    });
  });

  // Returns ownership info for the agent: who the owner is (if any),
  // and — when ?channel=cli&channelUserId=alice is supplied — the user
  // record for that identity. Used by the CLI to decide whether to prompt
  // for ownership claim on connection.
  app.get('/api/agents/:agentId/ownership', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    requireAuth(c, agentId);
    if (!userStore) {
      throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
    }
    const agentUsers = await userStore.listByAgent({ agentId });
    const ownerEntry = agentUsers.find((u) => u.role === 'owner');
    let owner: { userId: string; name: string | null } | null = null;
    if (ownerEntry) {
      const ownerRecord = await userStore.get(ownerEntry.userId);
      owner = { userId: ownerEntry.userId, name: ownerRecord?.name ?? null };
    }

    const channel = c.req.query('channel');
    const channelUserId = c.req.query('channelUserId');
    let me: { userId: string; role: string | null; name: string | null } | null = null;
    if (channel && channelUserId) {
      const userId = await userStore.resolve(channel, channelUserId);
      if (userId) {
        const record = await userStore.get(userId);
        const roleEntry = agentUsers.find((u) => u.userId === userId);
        me = {
          userId,
          role: roleEntry?.role ?? null,
          name: record?.name ?? null,
        };
      }
    }
    return c.json({ hasOwner: !!owner, owner, me });
  });

  // Promote a user to owner of this agent. Idempotent if the user is
  // already the owner; rejects with 409 if a different user is the owner.
  // Admin-token only — the CLI uses this after asking the user to confirm.
  app.post('/api/agents/:agentId/users/:userId/promote-to-owner', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const userId = c.req.param('userId') ?? '';
    requireAdmin(c.req.header('authorization'));
    if (!userStore) {
      throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
    }
    const scope = { agentId };
    const agentUsers = await userStore.listByAgent(scope);
    const existingOwner = agentUsers.find((u) => u.role === 'owner');
    if (existingOwner && existingOwner.userId !== userId) {
      const ownerRecord = await userStore.get(existingOwner.userId);
      throw new ConflictError(
        `Agent ${agentId} already has an owner: ${ownerRecord?.name ?? existingOwner.userId}.`,
      );
    }
    const target = await userStore.get(userId);
    if (!target) throw new NotFoundError(`User ${userId} not found.`);
    const now = new Date().toISOString();
    await userStore.assignAgent(scope, userId, 'owner', now);
    return c.json({ ok: true, userId, role: 'owner' });
  });

  app.get('/api/agents/:agentId/config', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);
    if (runner) {
      return c.json(await runner.security.readRawConfig());
    }
    // Stopped agent — read directly from the config store so admin UI can
    // inspect/edit before the agent has ever been started.
    if (!configStore) {
      throw new NotFoundError(`Agent ${agentId} is not running and no config store is available.`);
    }
    const config = await configStore.getConfig(agentId);
    if (!config) throw new NotFoundError(`Agent ${agentId} not found.`);
    return c.json(config);
  });

  app.put('/api/agents/:agentId/config', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const body = await c.req.json();
    const runner = instances.getRunner(agentId);
    if (runner) {
      await runner.security.writeConfig(body);
      return c.json({ ok: true });
    }
    if (!configStore) {
      throw new NotFoundError(`Agent ${agentId} is not running and no config store is available.`);
    }
    await configStore.setConfig(agentId, body);
    return c.json({ ok: true });
  });

  // ── Security policy ─────────────────────────────────────────────────
  // Owner/admin: read and overwrite the agent's security policy JSON.
  // The policy controls autonomy, approval requirements, the access
  // level (public/protected/private), and the access_token used for
  // protected self-join. The runtime reloads its in-memory copy after
  // a write so the change takes effect without a restart.

  app.get('/api/agents/:agentId/security', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);
    if (runner) {
      return c.json(await runner.security.readSecurityPolicy());
    }
    if (!configStore) {
      throw new NotFoundError(`Agent ${agentId} is not running and no config store is available.`);
    }
    const doc = await configStore.getSecurity(agentId);
    if (!doc) throw new NotFoundError(`Agent ${agentId} not found.`);
    return c.json(doc);
  });

  app.put('/api/agents/:agentId/security', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Security policy must be a JSON object.');
    }
    // Validate the access enum. The rest of the policy is loosely typed
    // and validated by AgentSecurity.load() on the next reload.
    const access = (body as { access?: unknown }).access;
    if (access !== undefined && access !== 'public' && access !== 'protected' && access !== 'private') {
      throw new ValidationError(`access must be 'public', 'protected', or 'private' (got ${JSON.stringify(access)}).`);
    }
    const runner = instances.getRunner(agentId);
    if (runner) {
      await runner.security.writeSecurityPolicy(body as never);
      return c.json({ ok: true });
    }
    if (!configStore) {
      throw new NotFoundError(`Agent ${agentId} is not running and no config store is available.`);
    }
    await configStore.setSecurity(agentId, body as Record<string, unknown>);
    return c.json({ ok: true });
  });

  // Mask secret values: show first 4 + last 4 (with **** in between) for
  // long values, full mask for short ones. Empty string stays empty.
  const maskSecret = (value: string): string => {
    if (!value) return '';
    if (value.length <= 8) return '*'.repeat(value.length);
    return `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-4)}`;
  };

  // Admin/owner endpoints below operate directly on the underlying stores
  // — they don't need a live runner. When a runner happens to be running,
  // we tell its security adapter to reload so its in-memory cache stays
  // consistent with what we just wrote.
  const reloadRunnerSecurity = async (agentId: string): Promise<void> => {
    const runner = instances.getRunner(agentId);
    if (runner) await runner.security.load();
  };

  app.get('/api/agents/:agentId/secrets', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const secretStore = instances.getSecretStore();
    if (!secretStore) {
      throw new OpenHermitError('Secret store is not configured.', 'not_configured', 500);
    }
    const all = await secretStore.listEntries(agentId);
    const out: Record<string, { masked: string; passThrough: boolean }> = {};
    for (const [k, entry] of Object.entries(all)) {
      out[k] = { masked: maskSecret(entry.value), passThrough: entry.passThrough };
    }
    return c.json(out);
  });

  // Bulk PUT was removed: clients sometimes echoed back the masked GET
  // response, silently overwriting other secrets with their masks. Per-key
  // PUT/DELETE below are the only supported write paths.

  app.put('/api/agents/:agentId/secrets/:name', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const name = c.req.param('name') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    if (!name) throw new ValidationError('Secret name required.');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ValidationError(
        'Secret name must be a valid POSIX env-var identifier (letters, digits, underscore; not starting with a digit).',
      );
    }
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object.');
    }
    const value = body.value;
    const passThroughRaw = body.passThrough;
    if (passThroughRaw !== undefined && typeof passThroughRaw !== 'boolean') {
      throw new ValidationError('passThrough must be a boolean if provided.');
    }
    const secretStore = instances.getSecretStore();
    if (!secretStore) {
      throw new OpenHermitError('Secret store is not configured.', 'not_configured', 500);
    }
    if (typeof value === 'string') {
      await secretStore.set(
        agentId,
        name,
        value,
        passThroughRaw !== undefined ? { passThrough: passThroughRaw } : undefined,
      );
    } else if (value === undefined && typeof passThroughRaw === 'boolean') {
      // Flag-only update: keep the existing ciphertext, flip passThrough.
      const existing = await secretStore.get(agentId, name);
      if (existing === undefined) {
        throw new ValidationError(`Secret "${name}" does not exist; cannot toggle passThrough on a non-existent secret.`);
      }
      await secretStore.set(agentId, name, existing, { passThrough: passThroughRaw });
    } else {
      throw new ValidationError('Body must be { value: string, passThrough?: boolean } or { passThrough: boolean } for an existing secret.');
    }
    await reloadRunnerSecurity(agentId);
    return c.json({ ok: true });
  });

  app.delete('/api/agents/:agentId/secrets/:name', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const name = c.req.param('name') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    if (!name) throw new ValidationError('Secret name required.');
    const secretStore = instances.getSecretStore();
    if (!secretStore) {
      throw new OpenHermitError('Secret store is not configured.', 'not_configured', 500);
    }
    await secretStore.delete(agentId, name);
    await reloadRunnerSecurity(agentId);
    return c.json({ ok: true });
  });

  // --- admin: skills management ---

  const requireSkillStore = (): DbSkillStore => {
    if (!options.skillStore) {
      throw new OpenHermitError('Skill store is not configured.', 'not_configured', 500);
    }
    return options.skillStore;
  };

  app.get('/api/admin/skills', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const skills = await store.list();
    return c.json(skills);
  });

  app.get('/api/admin/skills/scan', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const { scanSkillDirectory } = await import('@openhermit/agent/skills');
    const skillsDir = path.join(resolveGatewayDir(), 'registry', 'skills');
    const found = await scanSkillDirectory(skillsDir, skillsDir, 'system');
    return c.json(found);
  });

  app.get('/api/admin/skills/assignments', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const assignments = await store.listAssignments();
    return c.json(assignments);
  });

  app.get('/api/admin/skills/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const skill = await store.get(c.req.param('id'));
    if (!skill) throw new NotFoundError(`Skill not found: ${c.req.param('id')}`);
    return c.json(skill);
  });

  app.post('/api/admin/skills', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const body = await c.req.json() as Record<string, unknown>;
    if (!body.id || typeof body.id !== 'string') throw new ValidationError('id is required');
    if (!body.name || typeof body.name !== 'string') throw new ValidationError('name is required');
    if (!body.description || typeof body.description !== 'string') throw new ValidationError('description is required');
    if (!body.path || typeof body.path !== 'string') throw new ValidationError('path is required');
    const now = new Date().toISOString();
    await store.upsert({
      id: body.id,
      name: body.name,
      description: body.description,
      path: body.path,
      ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata as Record<string, unknown> } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/admin/skills/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    await store.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  const syncAffectedAgentSkillMounts = async (agentId: string, store: DbSkillStore): Promise<void> => {
    const ids = agentId === '*' ? instances.getRunningAgentIds() : [agentId];
    for (const id of ids) {
      const runner = instances.getRunner(id);
      if (runner) {
        await syncSkillMounts(id, runner, store);
      }
    }
  };

  app.post('/api/admin/skills/:id/enable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.enable(agentId, c.req.param('id'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  app.post('/api/admin/skills/:id/disable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.disable(agentId, c.req.param('id'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  // --- agent-level: effective skills list ---

  app.get('/api/agents/:agentId/skills', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireSkillStore();
    const runner = instances.getRunner(agentId);

    // Workspace path comes from the runner when up, otherwise from the
    // agent record. loadSkillIndex merges DB-enabled skills with what's
    // scanned from the workspace skill mounts.
    let workspaceRoot: string | undefined;
    if (runner) {
      workspaceRoot = runner.workspace.root;
    } else if (options.agentStore) {
      const record = await options.agentStore.get(agentId);
      workspaceRoot = record?.workspaceDir;
    }

    if (workspaceRoot) {
      const { loadSkillIndex } = await import('@openhermit/agent/skills');
      const skills = await loadSkillIndex(agentId, workspaceRoot, store);
      return c.json(skills);
    }

    // No workspace info available — return DB-enabled skills only.
    const dbSkills = await store.listEnabled(agentId);
    return c.json(dbSkills.map((s) => ({
      id: s.id, name: s.name, description: s.description,
      path: `/skills/${s.id}`, source: 'system' as const,
    })));
  });

  app.get('/api/agents/:agentId/mcp-servers', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    // Pure DB read — no runner needed. Lets admin inspect a stopped agent.
    const store = requireMcpServerStore();
    const servers = await store.listEnabled(agentId);
    // Strip header values — they may contain bearer tokens. Expose only the
    // key names so the UI can show that auth is configured without leaking secrets.
    return c.json(servers.map(({ headers, ...rest }) => ({
      ...rest,
      headerKeys: headers ? Object.keys(headers) : [],
    })));
  });

  // --- agent-level: owner management endpoints ---

  app.post('/api/agents/:agentId/skills/:skillId/enable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireSkillStore();
    await store.enable(agentId, c.req.param('skillId'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/skills/:skillId/disable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireSkillStore();
    await store.disable(agentId, c.req.param('skillId'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  // --- instructions (per-agent + global) ---

  const requireInstructionStore = () => {
    if (!options.instructionStore) {
      throw new ValidationError('Instruction store is not configured.');
    }
    return options.instructionStore;
  };

  app.get('/api/agents/:agentId/instructions', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireInstructionStore();
    return c.json(await store.getAll({ agentId }));
  });

  app.get('/api/agents/:agentId/instructions/:key', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const key = c.req.param('key') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireInstructionStore();
    const row = await store.get({ agentId }, key);
    if (!row) {
      return c.json({ error: { code: 'not_found', message: 'instruction not found' } }, 404);
    }
    return c.json(row);
  });

  app.put('/api/agents/:agentId/instructions/:key', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const key = c.req.param('key') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const body = await c.req.json().catch(() => ({}));
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) {
      throw new ValidationError('content (string) is required');
    }
    const store = requireInstructionStore();
    await store.set({ agentId }, key, content, new Date().toISOString());
    return c.json({ ok: true });
  });

  app.delete('/api/agents/:agentId/instructions/:key', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const key = c.req.param('key') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireInstructionStore();
    await store.delete({ agentId }, key);
    return c.json({ ok: true });
  });

  /**
   * Admin-only fan-out — apply the same instruction-mutation across every
   * registered agent. `mode` is one of:
   *   - "set":     replace each agent's row at `key` with `content`
   *   - "append":  append a newline + `content` to each agent's existing row
   *                (creates the row if missing)
   *   - "remove":  delete each agent's row at `key`
   * Returns the list of agent IDs that were touched.
   */
  app.post('/api/admin/instructions/fanout', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!agentStore) {
      throw new ValidationError('Agent store is not configured.');
    }
    const body = await c.req.json().catch(() => ({}));
    const mode = body.mode;
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!key) throw new ValidationError('key (string) is required');
    if (mode !== 'set' && mode !== 'append' && mode !== 'remove') {
      throw new ValidationError('mode must be one of: set, append, remove');
    }
    if ((mode === 'set' || mode === 'append') && !content) {
      throw new ValidationError('content (string) is required for set/append');
    }

    const store = requireInstructionStore();
    const agents = await agentStore.list();
    const now = new Date().toISOString();
    const updated: string[] = [];
    for (const agent of agents) {
      if (mode === 'remove') {
        await store.delete({ agentId: agent.agentId }, key);
      } else if (mode === 'set') {
        await store.set({ agentId: agent.agentId }, key, content, now);
      } else {
        // append
        const existing = await store.get({ agentId: agent.agentId }, key);
        const next = existing && existing.content.length > 0
          ? `${existing.content.replace(/\s+$/, '')}\n${content}`
          : content;
        await store.set({ agentId: agent.agentId }, key, next, now);
      }
      updated.push(agent.agentId);
    }
    return c.json({ ok: true, mode, key, agents: updated });
  });

  app.post('/api/agents/:agentId/mcp-servers/:serverId/enable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireMcpServerStore();
    await store.enable(agentId, c.req.param('serverId'));
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/mcp-servers/:serverId/disable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireMcpServerStore();
    await store.disable(agentId, c.req.param('serverId'));
    return c.json({ ok: true });
  });

  // ── Channels management (builtin + external, unified) ─────────────────

  /**
   * Static metadata about each builtin channel kind. Drives the secrets
   * hint shown by the UI ("you'll need TELEGRAM_BOT_TOKEN") and the
   * default config templates POSTed when toggling on.
   */
  const BUILTIN_CHANNEL_DEFS: Record<string, {
    label: string;
    secretKeys: { key: string; label: string; placeholder: string }[];
    /** Default config skeleton with ${{SECRET}} placeholders. */
    defaultConfig: Record<string, unknown>;
  }> = {
    telegram: {
      label: 'Telegram',
      secretKeys: [{ key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', placeholder: 'Enter Telegram bot token' }],
      defaultConfig: { bot_token: '${{TELEGRAM_BOT_TOKEN}}', mode: 'polling' },
    },
    discord: {
      label: 'Discord',
      secretKeys: [{ key: 'DISCORD_BOT_TOKEN', label: 'Bot Token', placeholder: 'Enter Discord bot token' }],
      defaultConfig: { bot_token: '${{DISCORD_BOT_TOKEN}}' },
    },
    slack: {
      label: 'Slack',
      secretKeys: [
        { key: 'SLACK_BOT_TOKEN', label: 'Bot Token (xoxb-...)', placeholder: 'Enter Slack bot token' },
        { key: 'SLACK_APP_TOKEN', label: 'App Token (xapp-...)', placeholder: 'Enter Slack app token' },
      ],
      defaultConfig: { bot_token: '${{SLACK_BOT_TOKEN}}', app_token: '${{SLACK_APP_TOKEN}}' },
    },
  };

  const requireAgentChannelStore = (): DbAgentChannelStore => {
    if (!options.agentChannelStore) {
      throw new OpenHermitError(
        'Channel store unavailable (DATABASE_URL or OPENHERMIT_SECRETS_KEY missing).',
        'not_configured',
        500,
      );
    }
    return options.agentChannelStore;
  };

  /**
   * Public webhook ingress. Each enabled channel can register a
   * `handleWebhook` on its bridge; this route forwards the raw POST to
   * that handler. Authentication is the adapter's responsibility (e.g.
   * Telegram secret_token, Slack signing secret, Discord ed25519).
   */
  app.post('/api/agents/:agentId/channels/:namespace/webhook', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const namespace = c.req.param('namespace') ?? '';
    const store = requireAgentChannelStore();
    const rows = await store.listForAgent(agentId);
    const row = rows.find((r) => r.namespace === namespace && !r.revokedAt);
    if (!row || !row.enabled) {
      return c.json({ error: { code: 'not_found', message: 'channel not found' } }, 404);
    }

    // Collect headers as a flat lowercase-keyed map for the adapter.
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const rawBody = await c.req.text();

    // Hydrate the runner first so the bridge's downstream HTTP callbacks
    // hit a hot agent (rather than paying cold-start latency on every
    // inbound message).
    const runner = await instances.getOrHydrate(agentId);
    if (!runner) {
      return new Response('agent not available', { status: 404 });
    }
    const pool = instances.getChannelPool();
    if (!pool) {
      return new Response('channel pool not available', { status: 503 });
    }
    const result = await pool.dispatchWebhook(agentId, row.channelType, { headers, rawBody });
    return new Response(result.body ?? '', {
      status: result.status,
      headers: result.headers ?? {},
    });
  });

  app.get('/api/agents/:agentId/channels', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireAgentChannelStore();
    const rows = await store.listForAgent(agentId);
    const runtimeStatuses = instances.getChannelPool()?.getStatuses(agentId) ?? [];

    // Secret presence — needed by the UI to indicate whether a channel
    // can actually start. Only available when agent is running.
    const runner = instances.getRunner(agentId);
    let secretNames: string[] = [];
    if (runner) {
      try { secretNames = await runner.security.listSecretNames(); } catch { /* ignore */ }
    }

    const result = rows.map((row) => {
      const def = row.kind === 'builtin' ? BUILTIN_CHANNEL_DEFS[row.channelType] : undefined;
      const secretsSet = def
        ? def.secretKeys.every((sk) => secretNames.includes(sk.key))
        : true;
      const runtime = runtimeStatuses.find((s) => s.name === row.channelType);
      // Prefer the live in-memory status (always current within this
      // gateway process), but fall back to the persisted error so a
      // failed-start that happened before the user's first GET (e.g. on
      // a fresh gateway boot) is still visible.
      const status = !row.enabled
        ? 'disabled'
        : runtime?.status ?? (row.lastError ? 'error' : 'unknown');
      const error = runtime
        ? runtime.status === 'error' ? runtime.error : undefined
        : row.lastError ?? undefined;
      return {
        ...row,
        ...(def ? { label: row.label ?? def.label, secretKeys: def.secretKeys } : {}),
        secretsSet,
        runtimeStatus: status,
        ...(error ? { error } : {}),
      };
    });
    return c.json(result);
  });

  /**
   * Catalog of channels the gateway knows about. The UI's "Add channel"
   * picker queries this to render a dropdown of manifest-backed options
   * (telegram/slack/discord/wechat/...) plus the "Custom external" fallback.
   *
   * - `origin: 'built-in'` rows come from the gateway's bundled defaults.
   * - `origin: 'external'` rows come from `channelPackages` plugins.
   * - `supportsSetup: true` means the manifest exposes `ChannelSetup` and
   *   the UI should route the user through the interactive wizard.
   *
   * Returned to any authenticated owner/admin scope — manifest metadata
   * isn't agent-specific, but we gate behind owner-or-admin to keep parity
   * with the rest of the channels API surface.
   */
  app.get('/api/channel-manifests', async (c) => {
    requireAuth(c);
    const out = options.manifestRegistry.all().map((m) => {
      const origin = options.manifestRegistry.originOf(m.key) ?? 'external';
      const def = BUILTIN_CHANNEL_DEFS[m.key];
      return {
        key: m.key,
        namespace: m.namespace,
        displayName: m.displayName,
        origin,
        supportsSetup: !!m.setup,
        ...(def ? { secretKeys: def.secretKeys, defaultConfig: def.defaultConfig } : {}),
      };
    });
    return c.json(out);
  });

  /**
   * Create a new channel. Two modes:
   *
   * 1. `channelType` set → manifest-backed builtin row. Used by the
   *    "Add channel" picker when the user selects e.g. WeChat. The
   *    channel must be a registered manifest. Caller may pass a `config`
   *    if the manifest doesn't need an interactive setup flow.
   * 2. `namespace` only → raw external row (current behavior). The
   *    response carries the plaintext token the caller must store.
   *
   * Builtin slots for the three bundled channels (telegram/slack/discord)
   * are still auto-seeded on agent create, so the UI shouldn't POST
   * those — but if it does, we reject as a duplicate.
   */
  app.post('/api/agents/:agentId/channels', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = await requireOwnerOrAdmin(c, agentId);
    const store = requireAgentChannelStore();
    const body = await c.req.json().catch(() => ({})) as {
      channelType?: string;
      namespace?: string;
      label?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    };

    let createdBy: string | undefined;
    if (auth.mode === 'user' && options.userStore) {
      const userId = await options.userStore.resolve(auth.channel, auth.channelUserId);
      if (userId) createdBy = userId;
    }

    if (body.channelType && typeof body.channelType === 'string') {
      const channelType = body.channelType.trim();
      const manifest = options.manifestRegistry.get(channelType);
      if (!manifest) {
        throw new ValidationError(`Channel "${channelType}" is not a registered manifest.`);
      }
      const existing = await store.listForAgent(agentId);
      if (existing.some((ch) => ch.channelType === channelType && !ch.revokedAt)) {
        throw new ValidationError(
          `A channel of type "${channelType}" already exists on this agent.`,
        );
      }
      const created = await store.createBuiltin({
        agentId,
        channelType,
        ...(body.label ? { label: body.label } : {}),
        ...(body.config ? { config: body.config } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      });

      // Auto-start the bridge so the user doesn't need a separate enable
      // call. If start fails (e.g. webhook mode but no public URL),
      // surface the error in the response — the row stays in DB so the
      // user can fix config via PATCH.
      if (created.enabled) {
        const pool = instances.getChannelPool();
        if (pool) {
          const status = await pool.enableChannel(agentId, channelType);
          return c.json(
            { ...created, runtimeStatus: status.status, ...(status.error ? { error: status.error } : {}) },
            201,
          );
        }
      }
      return c.json(created, 201);
    }

    if (!body.namespace || typeof body.namespace !== 'string') {
      throw new ValidationError('channelType or namespace is required.');
    }
    const namespace = body.namespace.trim();
    if (!namespace) {
      throw new ValidationError('namespace is required.');
    }
    const existing = await store.listForAgent(agentId);
    if (existing.some((ch) => ch.namespace === namespace && !ch.revokedAt)) {
      throw new ValidationError(
        `A channel with namespace "${namespace}" already exists on this agent.`,
      );
    }
    const created = await store.createExternal({
      agentId,
      namespace,
      ...(body.label ? { label: body.label } : {}),
      ...(body.config ? { config: body.config } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(createdBy ? { createdBy } : {}),
    });
    options.channelRegistry?.register({
      channelId: created.id,
      apiKey: created.token,
      namespace: created.namespace,
      agentId,
    });
    return c.json(created, 201);
  });

  /**
   * Patch an existing channel (builtin or external). Body may include
   * `enabled`, `label`, and `config`. Toggling enabled on a builtin row
   * boots / stops the in-process bridge.
   */
  app.patch('/api/agents/:agentId/channels/:channelId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelId = c.req.param('channelId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireAgentChannelStore();
    const existing = await store.get(channelId);
    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`Channel ${channelId} not found on agent ${agentId}.`);
    }
    const body = await c.req.json().catch(() => ({})) as {
      enabled?: boolean;
      label?: string | null;
      config?: Record<string, unknown>;
    };

    // For builtin channels, when first enabling we apply the default
    // config skeleton so the user doesn't have to know the field names.
    let effectiveConfig: Record<string, unknown> | undefined = body.config;
    if (
      existing.kind === 'builtin'
      && body.enabled === true
      && Object.keys(existing.config).length === 0
      && !body.config
    ) {
      const def = BUILTIN_CHANNEL_DEFS[existing.channelType];
      if (def) effectiveConfig = { ...def.defaultConfig };
    }

    const updated = await store.update(channelId, {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(effectiveConfig !== undefined ? { config: effectiveConfig } : {}),
    });
    if (!updated) throw new NotFoundError(`Channel ${channelId} not found.`);

    // Builtin runtime side-effects:
    //   enable=true              → start (or restart if already running)
    //   enable=false             → stop
    //   config changed, enabled  → restart so the new config takes effect
    //                              (e.g. polling↔webhook mode switch)
    if (existing.kind === 'builtin') {
      const pool = instances.getChannelPool();
      if (!pool) {
        throw new Error('channel pool not available');
      }
      const shouldDisable = body.enabled === false;
      const shouldEnable =
        body.enabled === true ||
        (effectiveConfig !== undefined && updated.enabled);
      if (shouldDisable) {
        await pool.disableChannel(agentId, existing.channelType);
      } else if (shouldEnable) {
        const status = await pool.enableChannel(agentId, existing.channelType);
        return c.json({
          ...updated,
          runtimeStatus: status.status,
          ...(status.error ? { error: status.error } : {}),
        });
      }
    }

    return c.json(updated);
  });

  /**
   * Delete a channel. External rows are soft-deleted (revoked). Builtin
   * rows cannot be deleted — they must be disabled instead, since the
   * row is part of the agent's fixed channel inventory.
   */
  app.delete('/api/agents/:agentId/channels/:channelId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelId = c.req.param('channelId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireAgentChannelStore();
    const existing = await store.get(channelId);
    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`Channel ${channelId} not found on agent ${agentId}.`);
    }
    if (existing.kind === 'builtin') {
      throw new ValidationError(
        `Built-in channel ${existing.channelType} cannot be deleted; disable it instead.`,
      );
    }
    await store.revoke(channelId);
    options.channelRegistry?.unregister(channelId);
    return c.json({ ok: true });
  });

  // ─── Channel setup (interactive auth) ──────────────────────────────────
  //
  // Drives `ChannelManifest.setup` over HTTP for channels with a
  // multi-step auth flow (Signal QR-link, OAuth, etc.). The plugin owns
  // session state keyed by an opaque `sessionId`; these routes just
  // shuttle bytes between the UI and `manifest.setup.{begin,poll,submit,cancel}`.
  //
  // On `state.kind === 'done'`, the UI takes `state.config` and POSTs
  // it to `/api/agents/:id/channels` (or PATCHes an existing row) — the
  // setup contract itself does not persist to the DB.

  const lookupChannelSetup = (
    channelType: string,
  ): { manifest: ChannelManifest; setup: ChannelSetup } => {
    const manifest = options.manifestRegistry.get(channelType);
    if (!manifest) {
      throw new NotFoundError(`Channel "${channelType}" is not registered.`);
    }
    if (!manifest.setup) {
      throw new ValidationError(
        `Channel "${channelType}" does not support interactive setup.`,
      );
    }
    return { manifest, setup: manifest.setup };
  };

  const setupContext = (
    agentId: string,
    channelType: string,
  ): ChannelSetupContext => ({
    agentId,
    logger: (msg) => log(`[${agentId}] [${channelType}/setup] ${msg}`),
  });

  app.post('/api/agents/:agentId/channels/:channelType/setup/begin', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelType = c.req.param('channelType') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const { setup } = lookupChannelSetup(channelType);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = await setup.begin(body, setupContext(agentId, channelType));
    return c.json(result);
  });

  app.get('/api/agents/:agentId/channels/:channelType/setup/:sessionId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelType = c.req.param('channelType') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const { setup } = lookupChannelSetup(channelType);
    const state = await setup.poll(sessionId, setupContext(agentId, channelType));
    return c.json({ sessionId, state });
  });

  app.post('/api/agents/:agentId/channels/:channelType/setup/:sessionId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelType = c.req.param('channelType') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const { setup } = lookupChannelSetup(channelType);
    if (!setup.submit) {
      throw new ValidationError(
        `Channel "${channelType}" setup does not accept additional input; poll instead.`,
      );
    }
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const state = await setup.submit(sessionId, body, setupContext(agentId, channelType));
    return c.json({ sessionId, state });
  });

  app.delete('/api/agents/:agentId/channels/:channelType/setup/:sessionId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelType = c.req.param('channelType') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const { setup } = lookupChannelSetup(channelType);
    if (setup.cancel) {
      await setup.cancel(sessionId, setupContext(agentId, channelType));
    }
    return c.json({ ok: true });
  });

  app.get('/api/agents/:agentId/schedules', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const status = c.req.query('status') ?? undefined;
    const schedules = await store.list({ agentId }, status ? { status } : undefined);
    return c.json(schedules);
  });

  app.post('/api/agents/:agentId/schedules', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const body = await c.req.json() as Record<string, unknown>;
    if (!body.type || (body.type !== 'cron' && body.type !== 'once')) {
      throw new ValidationError('type must be "cron" or "once"');
    }
    if (!body.prompt || typeof body.prompt !== 'string') {
      throw new ValidationError('prompt is required');
    }
    if (body.type === 'cron' && (!body.cronExpression || typeof body.cronExpression !== 'string')) {
      throw new ValidationError('cronExpression is required for cron schedules');
    }
    if (body.type === 'once' && (!body.runAt || typeof body.runAt !== 'string')) {
      throw new ValidationError('runAt is required for once schedules');
    }

    // Resolve creator identity. Owner-mode requests use auth.userId.
    // Admin-mode has no userId, so default to the agent's earliest owner
    // (deterministic) — otherwise scheduled runs fall through to guest.
    // Callers may override via body.createdBy; we validate the override
    // has a role on this agent so it can't be used to impersonate.
    let createdBy: string | undefined;
    if (typeof body.createdBy === 'string' && body.createdBy.length > 0) {
      if (!userStore) {
        throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
      }
      const role = await userStore.getAgentRole({ agentId }, body.createdBy);
      if (!role) {
        throw new ValidationError(`createdBy user ${body.createdBy} has no role on agent ${agentId}`);
      }
      createdBy = body.createdBy;
    } else if (auth.userId) {
      createdBy = auth.userId;
    } else if (userStore) {
      const members = await userStore.listByAgent({ agentId });
      const owners = members
        .filter((m) => m.role === 'owner')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      createdBy = owners[0]?.userId;
    }
    if (!createdBy) {
      throw new ValidationError(
        `Cannot determine schedule owner for agent ${agentId}: no owner found. Pass createdBy in the request body.`,
      );
    }

    const schedule = await store.create({ agentId }, {
      ...(typeof body.id === 'string' ? { scheduleId: body.id } : {}),
      type: body.type as 'cron' | 'once',
      ...(typeof body.cronExpression === 'string' ? { cronExpression: body.cronExpression } : {}),
      ...(typeof body.runAt === 'string' ? { runAt: body.runAt } : {}),
      prompt: body.prompt,
      ...(body.delivery ? { delivery: body.delivery as any } : {}),
      ...(body.policy ? { policy: body.policy as any } : {}),
      createdBy,
    });
    return c.json(schedule, 201);
  });

  app.put('/api/agents/:agentId/schedules/:scheduleId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    const body = await c.req.json() as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.status === 'string') patch.status = body.status;
    if (typeof body.prompt === 'string') patch.prompt = body.prompt;
    if (typeof body.cronExpression === 'string') patch.cronExpression = body.cronExpression;
    if (typeof body.runAt === 'string') patch.runAt = body.runAt;
    if (body.delivery !== undefined) patch.delivery = body.delivery;
    const updated = await store.update({ agentId }, scheduleId, patch as any);
    return c.json(updated);
  });

  app.delete('/api/agents/:agentId/schedules/:scheduleId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    await store.delete({ agentId }, scheduleId);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/schedules/:scheduleId/trigger', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    // "Trigger now" — flip to active and force next_run_at to now so
    // the central scheduler fires it on the next tick.
    await store.update({ agentId }, scheduleId, { status: 'active' } as any);
    await store.setNextRun({ agentId }, scheduleId, new Date().toISOString());
    return c.json({ ok: true, triggered: scheduleId });
  });

  app.get('/api/agents/:agentId/schedules/:scheduleId/runs', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    const limit = Number(c.req.query('limit')) || 20;
    const runs = await store.listRuns({ agentId }, scheduleId, limit);
    return c.json(runs);
  });

  // --- per-agent policy management ---

  const requirePolicyStore = (): DbPolicyStore => {
    if (!options.policyStore) {
      throw new OpenHermitError('Policy store is not configured.', 'not_configured', 500);
    }
    return options.policyStore;
  };

  app.get('/api/agents/:agentId/policies', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requirePolicyStore();
    const resourceType = c.req.query('resourceType') ?? undefined;
    const policies = await store.list(agentId, resourceType);
    return c.json(policies);
  });

  app.post('/api/agents/:agentId/policies', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requirePolicyStore();
    const body = await c.req.json() as Record<string, unknown>;
    if (!body.resourceType || typeof body.resourceType !== 'string') {
      throw new ValidationError('resourceType is required');
    }
    if (!body.resourceKey || typeof body.resourceKey !== 'string') {
      throw new ValidationError('resourceKey is required');
    }
    if (!Array.isArray(body.grants)) {
      throw new ValidationError('grants must be an array');
    }
    const effect = typeof body.effect === 'string' ? body.effect : 'allow';

    let scope: Record<string, unknown> =
      (typeof body.scope === 'object' && body.scope !== null && !Array.isArray(body.scope))
        ? body.scope as Record<string, unknown>
        : {};

    // Auto-populate scope for file policies when not explicitly provided
    if (body.resourceType === 'file' && (!scope.path || !scope.mode)) {
      scope = {
        sandbox: typeof scope.sandbox === 'string' ? scope.sandbox : '*',
        mode: typeof scope.mode === 'string' ? scope.mode : '*',
        path: typeof scope.path === 'string' ? scope.path : body.resourceKey,
      };
    }

    // Auto-populate scope for exec policies when not explicitly provided
    if (body.resourceType === 'exec' && (!scope.command)) {
      scope = {
        sandbox: typeof scope.sandbox === 'string' ? scope.sandbox : '*',
        command: typeof scope.command === 'string' ? scope.command : body.resourceKey,
        ...(typeof scope.cwd === 'string' ? { cwd: scope.cwd } : {}),
      };
    }

    const record = await store.upsert({
      agentId,
      resourceType: body.resourceType,
      resourceKey: body.resourceKey,
      effect: effect as import('@openhermit/store').PolicyEffect,
      grants: body.grants,
      scope,
    });
    return c.json(record, 201);
  });

  app.delete('/api/agents/:agentId/policies/:resourceType/:resourceKey', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const resourceType = c.req.param('resourceType') ?? '';
    const resourceKey = c.req.param('resourceKey') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requirePolicyStore();
    const effect = c.req.query('effect') ?? undefined;
    const existing = await store.get(agentId, resourceType, resourceKey, effect);
    if (!existing) throw new NotFoundError(`Policy not found: ${resourceType}/${resourceKey}`);
    await store.delete(agentId, resourceType, resourceKey, effect);
    return c.json({ ok: true });
  });

  // --- per-agent approval request management ---

  const requireApprovalStore = (): DbApprovalRequestStore => {
    if (!options.approvalRequestStore) {
      throw new OpenHermitError('Approval request store is not configured.', 'not_configured', 500);
    }
    return options.approvalRequestStore;
  };

  app.get('/api/agents/:agentId/approvals', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireApprovalStore();
    const status = (c.req.query('status') ?? undefined) as import('@openhermit/store').ApprovalStatus | undefined;
    const requests = await store.list(agentId, status);
    return c.json(requests);
  });

  app.get('/api/agents/:agentId/approvals/:id', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireApprovalStore();
    const id = c.req.param('id') ?? '';
    const request = await store.get(id);
    if (!request || request.agentId !== agentId) {
      throw new NotFoundError(`Approval request not found: ${id}`);
    }
    return c.json(request);
  });

  const resolveApprovalReview = async (
    c: any,
    agentId: string,
    request: import('@openhermit/store').ApprovalRequestRecord,
  ) => {
    const store = requireApprovalStore();
    const body = await c.req.json() as Record<string, unknown>;
    const decision = body.decision as string;
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new ValidationError('decision must be "approved" or "rejected"');
    }
    if (request.agentId !== agentId) {
      throw new NotFoundError(`Approval request not found: ${request.id}`);
    }
    if (request.status !== 'pending') {
      throw new ValidationError(`Request is already ${request.status}`);
    }
    const resolvedBy = (c as any).get?.('userId') ?? 'owner';
    const resolution = typeof body.resolution === 'string' ? body.resolution as 'once' | 'persistent' : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const updated = await store.resolve(request.id, decision, resolvedBy, resolution, reason);

    if (decision === 'approved' && resolution === 'persistent' && options.policyStore) {
      await options.policyStore.upsert({
        agentId: request.agentId,
        resourceType: request.resourceType,
        resourceKey: request.resourceKey,
        effect: 'allow' as import('@openhermit/store').PolicyEffect,
        grants: [{ type: 'user', value: request.requesterId }],
        scope: request.scope,
      });
    }

    // Fan out approval_resolved to the requester's session (so the
    // agent can unblock / retry) and the inbox (so the owner UI marks
    // the card done). Without this, telegram callbacks and the web
    // inbox would resolve the DB row but the agent would never see
    // the decision, leading to repeated approval prompts.
    try {
      const runtime = await instances.getOrHydrate(agentId);
      if (runtime) {
        await runtime.publishApprovalResolved({
          requestId: request.id,
          resourceType: request.resourceType,
          resourceKey: request.resourceKey,
          requesterSessionId: request.sessionId,
          decision,
          ...(resolution ? { resolution } : {}),
          reviewerId: resolvedBy,
        });
      }
    } catch (err) {
      log(`approval review fan-out failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return updated;
  };

  app.post('/api/agents/:agentId/approvals/:id/review', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireApprovalStore();
    const id = c.req.param('id') ?? '';
    const request = await store.get(id);
    if (!request || request.agentId !== agentId) {
      throw new NotFoundError(`Approval request not found: ${id}`);
    }
    return c.json(await resolveApprovalReview(c, agentId, request));
  });

  app.post('/api/agents/:agentId/approvals/by-short/:shortId/review', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireApprovalStore();
    const shortIdParam = c.req.param('shortId') ?? '';
    const shortId = Number.parseInt(shortIdParam, 10);
    if (!Number.isFinite(shortId)) {
      throw new ValidationError(`Invalid short_id: ${shortIdParam}`);
    }
    const request = await store.getByShortId(shortId);
    if (!request || request.agentId !== agentId) {
      throw new NotFoundError(`Approval request not found: short_id=${shortId}`);
    }
    return c.json(await resolveApprovalReview(c, agentId, request));
  });

  // --- admin: MCP servers management ---

  const requireMcpServerStore = (): DbMcpServerStore => {
    if (!options.mcpServerStore) {
      throw new OpenHermitError('MCP server store is not configured.', 'not_configured', 500);
    }
    return options.mcpServerStore;
  };

  app.get('/api/admin/mcp-servers', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    return c.json(await store.list());
  });

  app.get('/api/admin/mcp-servers/assignments', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    return c.json(await store.listAssignments());
  });

  app.get('/api/admin/mcp-servers/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const server = await store.get(c.req.param('id'));
    if (!server) throw new NotFoundError(`MCP server not found: ${c.req.param('id')}`);
    return c.json(server);
  });

  app.post('/api/admin/mcp-servers', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const body = await c.req.json() as Record<string, unknown>;
    if (!body.id || typeof body.id !== 'string') throw new ValidationError('id is required');
    if (!body.name || typeof body.name !== 'string') throw new ValidationError('name is required');
    if (!body.description || typeof body.description !== 'string') throw new ValidationError('description is required');
    if (!body.url || typeof body.url !== 'string') throw new ValidationError('url is required');
    const now = new Date().toISOString();
    await store.upsert({
      id: body.id,
      name: body.name,
      description: body.description,
      url: body.url,
      ...(body.headers && typeof body.headers === 'object' ? { headers: body.headers as Record<string, string> } : {}),
      ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata as Record<string, unknown> } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/admin/mcp-servers/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    await store.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  const syncAffectedAgentMcp = async (agentId: string): Promise<void> => {
    const ids = agentId === '*' ? instances.getRunningAgentIds() : [agentId];
    for (const id of ids) {
      const runner = instances.getRunner(id);
      if (runner) {
        await runner.reloadMcpServers();
      }
    }
  };

  app.post('/api/admin/mcp-servers/:id/enable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.enable(agentId, c.req.param('id'));
    await syncAffectedAgentMcp(agentId);
    return c.json({ ok: true });
  });

  app.post('/api/admin/mcp-servers/:id/disable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.disable(agentId, c.req.param('id'));
    await syncAffectedAgentMcp(agentId);
    return c.json({ ok: true });
  });

  // --- admin: schedule management ---

  const requireScheduleStore = (): DbScheduleStore => {
    if (!options.scheduleStore) {
      throw new OpenHermitError('Schedule store is not configured.', 'not_configured', 500);
    }
    return options.scheduleStore;
  };

  // List all schedules across all agents
  app.get('/api/admin/schedules', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireScheduleStore();
    const status = c.req.query('status') ?? undefined;
    const all = await store.listAll(status ? { status } : undefined);
    return c.json(all);
  });

  // Per-agent schedule management is at /api/agents/:agentId/schedules (owner or admin auth)

  // --- sandbox presets (read-only, available to any authenticated caller) ---

  app.get('/api/sandbox-presets', async (c) => {
    requireAuth(c);
    const presets = options.sandboxPresets ?? {};
    return c.json({
      presets,
      autoProvisionSandbox: options.autoProvisionSandbox ?? null,
    });
  });

  // --- per-agent sandbox management ---

  const requireSandboxStore = (): SandboxStore => {
    if (!options.sandboxStore) {
      throw new OpenHermitError('Sandbox store is not configured.', 'not_configured', 500);
    }
    return options.sandboxStore;
  };

  app.get(gatewayRoutes.agentSandboxesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const rows = await requireSandboxStore().listByAgent(agentId);
    return c.json(rows);
  });

  app.post(gatewayRoutes.agentSandboxesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const body = await c.req.json<{
      alias?: string;
      preset?: string;
      type?: string;
      config?: Record<string, unknown>;
    }>();
    const alias = body.alias ?? 'default';
    let type: string | undefined;
    let config: Record<string, unknown> | undefined;
    if (typeof body.preset === 'string') {
      const presets = options.sandboxPresets ?? {};
      const preset = presets[body.preset];
      if (!preset) {
        throw new ValidationError(
          `Unknown sandbox preset "${body.preset}". Known: ${Object.keys(presets).join(', ') || '(none)'}`,
        );
      }
      type = preset.type;
      config = preset.config;
    } else {
      type = body.type;
      config = body.config;
    }
    if (type !== 'host' && type !== 'docker' && type !== 'e2b' && type !== 'daytona') {
      throw new ValidationError(`Invalid sandbox type: ${type}`);
    }
    const store = requireSandboxStore();
    const existing = await store.getByAlias(agentId, alias);
    if (existing) {
      throw new ConflictError(`Sandbox alias "${alias}" already exists for this agent.`);
    }
    if (type === 'host') {
      const owner = await store.findAgentByType('host', agentId);
      if (owner) {
        throw new ConflictError(`Host backend is already in use by agent ${owner}.`);
      }
    }
    const row = await store.create({
      agentId,
      alias,
      type,
      ...(config ? { config } : {}),
    });
    return c.json(row, 201);
  });

  app.delete(gatewayRoutes.agentSandboxByAliasPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const alias = c.req.param('alias') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireSandboxStore();
    const row = await store.getByAlias(agentId, alias);
    if (!row) throw new NotFoundError(`Sandbox not found: ${alias}`);
    await store.delete(row.id);
    return c.json({ ok: true });
  });

  // --- admin UI: static files ---

  if (options.publicDir) {
    app.get('/admin', (c) => c.redirect('/admin/'));
    app.use('/admin/*', serveStatic({
      root: options.publicDir,
      rewriteRequestPath: (p) => p.replace(/^\/admin/, ''),
    }));
    // SPA fallback: serve index.html for unmatched /admin/* paths
    app.get('/admin/*', serveStatic({
      root: options.publicDir,
      rewriteRequestPath: () => '/index.html',
    }));
  }

  // --- error handler ---

  app.onError((error, c) => {
    if (error instanceof OpenHermitError) {
      return c.json(jsonError(error), error.statusCode);
    }
    // Drizzle/pg wrap the underlying driver error on `.cause`. Without
    // dumping it the only thing we see is "Failed query: select ...",
    // which makes runtime/pool issues (connection eviction, terminated
    // backend, prepared-statement conflicts) effectively unfixable from
    // production logs alone.
    const cause = (error as { cause?: unknown }).cause;
    const code = (error as { code?: unknown }).code
      ?? (cause as { code?: unknown } | undefined)?.code;
    console.error('[openhermit-gateway] unhandled error', error, {
      ...(code !== undefined ? { code } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
    return c.json(jsonError(getErrorMessage(error), 'internal_error'), 500);
  });

  return app;
};
