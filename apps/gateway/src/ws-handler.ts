import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  isSessionSpec,
  isSessionMessage,
  isToolApprovalRequest,
  isSessionCheckpointRequest,
  isCreateResearchRunRequest,
  isResearchRunActionRequest,
  isUpdateResearchPlanRequest,
  isWsRequest,
  type WsRequest,
  type WsResponseOk,
  type WsResponseError,
  type WsErrorCode,
  type WsEvent,
  type WsServerMessage,
  type SessionListQuery,
} from '@openhermit/protocol';

import type { AgentRunner, SessionEventEnvelope } from '@openhermit/agent/agent-runner';

import type { AgentInstanceManager } from './agent-instance.js';
import { UnauthorizedError } from '@openhermit/shared';

import type { AuthContext, AuthResolverOptions } from './auth.js';
import { enforceSenderIdentity, resolveAuth } from './auth.js';
import { listSessionsForCaller } from './session-listing.js';
import {
  researchEvidenceToWire,
  researchRunToWire,
  researchSourceToWire,
  researchStepToWire,
} from './research-routes.js';

const WS_PING_INTERVAL_MS = 30_000;

interface WsConnection {
  ws: WebSocket;
  subscriptions: Map<string, () => void>; // sessionId → unsubscribe
  pingTimer: ReturnType<typeof setInterval>;
  auth?: AuthContext;
}

const sendJson = (ws: WebSocket, message: WsServerMessage): void => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

const sendResult = (ws: WebSocket, id: string, result: unknown): void => {
  sendJson(ws, { kind: 'response', id, result } as WsResponseOk);
};

const sendError = (
  ws: WebSocket,
  id: string,
  code: WsErrorCode,
  message: string,
): void => {
  sendJson(ws, { kind: 'response', id, error: { code, message } } as WsResponseError);
};

const sendEvent = (ws: WebSocket, envelope: SessionEventEnvelope): void => {
  sendJson(ws, {
    kind: 'event',
    eventId: envelope.id,
    sessionId: envelope.event.sessionId,
    event: envelope.event,
  } as WsEvent);
};

/** Require auth on the connection, returning callerUserId. */
const requireWsAuth = async (
  conn: WsConnection,
  runtime: AgentRunner,
): Promise<string | undefined> => {
  if (!conn.auth) return undefined;
  return runtime.resolveCallerUserId({
    channel: conn.auth.channel,
    channelUserId: conn.auth.channelUserId,
  });
};

/**
 * Enforce session access on the WS connection.
 *
 * Three modes coexist on these endpoints:
 *
 *   - `admin` auth: full access; no per-session check.
 *   - `user` / `channel` auth resolved to an internal userId: must be a
 *     participant of the session. `verifySessionAccess` throws otherwise.
 *   - `user` / `channel` auth that did NOT resolve (token references a
 *     deleted user, channel webhook from a not-yet-seen sender, etc.):
 *     historically the check was silently skipped because `if
 *     (callerUserId) ...` was false. That was an IDOR — anyone with a
 *     stale token could read every session in the agent. Reject with the
 *     same 'session not found' shape the HTTP path uses.
 */
const requireSessionAccess = async (
  conn: WsConnection,
  runtime: AgentRunner,
  callerUserId: string | undefined,
  sessionId: string,
): Promise<void> => {
  if (conn.auth?.mode === 'admin') return;
  if (!callerUserId) {
    throw new SessionAccessDeniedError(`Session not found: ${sessionId}`);
  }
  await runtime.verifySessionAccess(sessionId, callerUserId);
};

class SessionAccessDeniedError extends Error {
  readonly wsCode: WsErrorCode = 'SESSION_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'SessionAccessDeniedError';
  }
}

const handleRequest = async (
  conn: WsConnection,
  request: WsRequest,
  runtime: AgentRunner,
): Promise<void> => {
  const { ws } = conn;
  const { id, method, params } = request;
  const p = (params ?? {}) as Record<string, unknown>;

  try {
    // All methods require authentication
    if (!conn.auth) {
      sendError(ws, id, 'INVALID_PARAMS', 'Authentication required.');
      return;
    }

    const callerUserId = await requireWsAuth(conn, runtime);

    switch (method) {
      case 'session.open': {
        if (!isSessionSpec(p)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid SessionSpec params.');
          return;
        }
        // Pass the caller's channel identity directly so the runtime can
        // pin the current speaker without round-tripping through session
        // metadata (which historically caused cross-channel pollution).
        const caller = conn.auth.mode === 'user' && conn.auth.channelUserId
          ? { channel: conn.auth.channel, channelUserId: conn.auth.channelUserId }
          : undefined;
        const session = await runtime.openSession(p, caller);
        sendResult(ws, id, { sessionId: session.spec.sessionId });
        return;
      }

      case 'session.message': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        if (sessionId === 'inbox') {
          sendError(ws, id, 'INBOX_READ_ONLY', 'Inbox session is read-only.');
          return;
        }
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        // Security: `sender` drives the runtime's per-message identity/role
        // resolution, so a caller may only assert a sender it is entitled to
        // (see enforceSenderIdentity). Blocks owner impersonation via a
        // forged `cli:root` sender.
        enforceSenderIdentity(conn.auth, p.sender as { channel?: string; channelUserId?: string } | undefined);
        const message = {
          text: p.text,
          ...(p.messageId !== undefined ? { messageId: p.messageId } : {}),
          ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
          ...(p.sender !== undefined ? { sender: p.sender } : {}),
          ...(p.participants !== undefined ? { participants: p.participants } : {}),
          ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
        };
        if (!isSessionMessage(message)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid message params.');
          return;
        }
        // Lazy-rehydrate after a gateway restart / eviction so a client that
        // skipped session.open (e.g. auto-reconnect after idle) doesn't 404.
        const messageCaller = conn.auth.mode === 'user' && conn.auth.channelUserId
          ? { channel: conn.auth.channel, channelUserId: conn.auth.channelUserId }
          : undefined;
        await runtime.ensureSessionLoaded(sessionId, messageCaller);
        const result = await runtime.postMessage(sessionId, message);
        sendResult(ws, id, result);
        return;
      }

      case 'session.approve': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        const approval = { toolCallId: p.toolCallId, approved: p.approved };
        if (!isToolApprovalRequest(approval)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid approval params.');
          return;
        }
        const resolved = runtime.respondToApproval(
          sessionId,
          approval.toolCallId,
          approval.approved,
        );
        sendResult(ws, id, { resolved });
        return;
      }

      case 'session.interrupt': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        const interrupted = runtime.interruptSession(sessionId);
        sendResult(ws, id, { interrupted });
        return;
      }

      case 'session.checkpoint': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        const body = { reason: p.reason };
        if (!isSessionCheckpointRequest(body)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid checkpoint params.');
          return;
        }
        const checkpointed = await runtime.checkpointSession(
          sessionId,
          (body.reason as 'manual' | 'new_session' | 'turn_limit' | 'idle') ?? 'manual',
        );
        sendResult(ws, id, { checkpointed });
        return;
      }

      case 'session.list': {
        const query: SessionListQuery = {};
        if (typeof p.kind === 'string') query.kind = p.kind;
        if (typeof p.platform === 'string') query.platform = p.platform;
        if (typeof p.interactive === 'boolean') query.interactive = p.interactive;
        if (typeof p.limit === 'number') query.limit = p.limit;
        if (typeof p.channel === 'string') query.channel = p.channel;
        if (p.metadata && typeof p.metadata === 'object') query.metadata = p.metadata as Record<string, string>;
        if (typeof p.observe === 'boolean') query.observe = p.observe;
        // Routes through the same helper as the HTTP endpoint so any
        // future change to the auth-mode → visibility rules takes
        // effect on both transports at once.
        sendResult(ws, id, await listSessionsForCaller(runtime, conn.auth, query));
        return;
      }

      case 'session.history': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        // Same admin/user/channel branching as the HTTP equivalent.
        // listSessionMessages does its own access check when given a userId.
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        sendResult(ws, id, await runtime.listSessionMessages(sessionId, callerUserId));
        return;
      }

      case 'session.delete': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        await runtime.deleteSession(sessionId, callerUserId);
        sendResult(ws, id, { deleted: true });
        return;
      }

      case 'session.subscribe': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        // Verify caller is a participant before subscribing to events
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        conn.subscriptions.get(sessionId)?.();
        const afterEventId = typeof p.lastEventId === 'number' ? p.lastEventId : 0;
        const unsubscribe = runtime.events.subscribeFrom(
          sessionId,
          afterEventId,
          (envelope) => sendEvent(ws, envelope),
        );
        conn.subscriptions.set(sessionId, unsubscribe);
        sendResult(ws, id, { subscribed: true });
        return;
      }

      case 'session.unsubscribe': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        const unsub = conn.subscriptions.get(sessionId);
        if (!unsub) {
          sendError(ws, id, 'NOT_SUBSCRIBED', `Not subscribed to session: ${sessionId}`);
          return;
        }
        unsub();
        conn.subscriptions.delete(sessionId);
        sendResult(ws, id, { unsubscribed: true });
        return;
      }

      // ─── Deep Research (parity with the nested HTTP routes) ─────────────
      case 'research.start':
      case 'research.list':
      case 'research.get':
      case 'research.plan.update':
      case 'research.action':
      case 'research.steps':
      case 'research.sources': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        await requireSessionAccess(conn, runtime, callerUserId, sessionId);
        if (typeof runtime.research !== 'function') {
          sendError(ws, id, 'INTERNAL_ERROR', 'Deep Research is not available on this runtime.');
          return;
        }
        const orchestrator = await runtime.research();

        if (method === 'research.start') {
          if (!isCreateResearchRunRequest(p)) {
            sendError(ws, id, 'INVALID_PARAMS', 'Invalid research.start params (objective required).');
            return;
          }
          const run = await orchestrator.createRun({
            sessionId,
            objective: p.objective,
            depth: p.depth,
            sourcePolicy: p.sourcePolicy as never,
            clientRequestId: p.clientRequestId,
            requestedByUserId: callerUserId,
          });
          sendResult(ws, id, { run: researchRunToWire(run) });
          return;
        }

        if (method === 'research.list') {
          const runs = await orchestrator.listRuns(sessionId);
          sendResult(ws, id, { runs: runs.map(researchRunToWire) });
          return;
        }

        // Remaining methods target one run in this session.
        const runId = p.runId;
        if (typeof runId !== 'string' || runId.length === 0) {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing runId.');
          return;
        }
        const target = await orchestrator.getRun(runId);
        if (target.sessionId !== sessionId) {
          sendError(ws, id, 'INVALID_PARAMS', `Research run ${runId} does not belong to this session.`);
          return;
        }

        if (method === 'research.get') {
          sendResult(ws, id, { run: researchRunToWire(target) });
          return;
        }
        if (method === 'research.plan.update') {
          const body = { expectedVersion: p.expectedVersion, plan: p.plan, sourcePolicy: p.sourcePolicy };
          if (!isUpdateResearchPlanRequest(body)) {
            sendError(ws, id, 'INVALID_PARAMS', 'Invalid plan update params.');
            return;
          }
          const run = await orchestrator.updatePlan(
            runId,
            body.expectedVersion,
            body.plan,
            body.sourcePolicy as never,
          );
          sendResult(ws, id, { run: researchRunToWire(run) });
          return;
        }
        if (method === 'research.action') {
          if (!isResearchRunActionRequest(p)) {
            sendError(ws, id, 'INVALID_PARAMS', 'Invalid research action params.');
            return;
          }
          const run = await (() => {
            switch (p.action) {
              case 'approve_plan':
                return orchestrator.approvePlan(runId, p.expectedPlanVersion as number);
              case 'pause':
                return orchestrator.pause(runId);
              case 'resume':
                return orchestrator.resume(runId);
              case 'cancel':
                return orchestrator.cancel(runId);
              case 'refine':
                return orchestrator.refine(runId, p.instruction as string);
              case 'retry':
                return orchestrator.retry(runId);
              default:
                return orchestrator.increaseBudget(runId, p.limits as Record<string, number>);
            }
          })();
          sendResult(ws, id, { run: researchRunToWire(run) });
          return;
        }
        if (method === 'research.steps') {
          const steps = await orchestrator.listSteps(runId);
          sendResult(ws, id, { steps: steps.map(researchStepToWire) });
          return;
        }
        // research.sources
        if (typeof p.sourceId === 'string' && p.sourceId.length > 0) {
          const detail = await orchestrator.getSourceDetail(runId, p.sourceId);
          sendResult(ws, id, {
            source: researchSourceToWire(detail.source),
            evidence: detail.evidence.map(researchEvidenceToWire),
          });
          return;
        }
        const sources = await orchestrator.listSources(runId);
        sendResult(ws, id, { sources: sources.map(researchSourceToWire) });
        return;
      }

      default:
        sendError(ws, id, 'INVALID_PARAMS', `Unknown method: ${method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SessionAccessDeniedError) {
      sendError(ws, id, error.wsCode, message);
      return;
    }
    if (error instanceof UnauthorizedError) {
      sendError(ws, id, 'UNAUTHORIZED', message);
      return;
    }
    sendError(ws, id, 'INTERNAL_ERROR', message);
  }
};

export interface GatewayWsOptions {
  instances: AgentInstanceManager;
  auth?: AuthResolverOptions;
  logger?: (message: string) => void;
}

/**
 * Attach a WebSocket handler to the gateway HTTP server.
 *
 * Handles `upgrade` requests on `/api/agents/:agentId/ws`. Resolves the
 * AgentRunner from AgentInstanceManager and runs the WS RPC protocol
 * directly in-process (no proxy).
 */
export const attachGatewayWs = (
  httpServer: HttpServer,
  options: GatewayWsOptions,
): WebSocketServer => {
  const { instances } = options;
  const log = options.logger ?? (() => {});
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    // Match /api/agents/:agentId/ws
    const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/ws$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const agentId = decodeURIComponent(match[1]!);

    // Resolve auth BEFORE hydration so unauthenticated upgrades cannot
    // trigger expensive cold-starts.
    let auth: AuthContext | undefined;
    if (options.auth) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const fakeRequest = new Request(`http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`, { headers });
      const resolved = await resolveAuth(fakeRequest, options.auth);
      if (resolved) auth = resolved;
    }

    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let runner;
    try {
      runner = await instances.getOrHydrate(agentId);
    } catch (err) {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!runner) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      log(`[ws] client connected for agent ${agentId} (${auth!.mode}:${auth!.channelUserId || 'channel'})`);
      instances.wsConnect(agentId);

      const conn: WsConnection = {
        ws,
        subscriptions: new Map(),
        pingTimer: setInterval(() => {
          if (ws.readyState === ws.OPEN) {
            ws.ping();
          }
        }, WS_PING_INTERVAL_MS),
        auth,
      };

      ws.on('message', (data) => {
        instances.touch(agentId);
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          sendError(ws, '', 'INVALID_PARAMS', 'Invalid JSON.');
          return;
        }

        if (!isWsRequest(parsed)) {
          sendError(ws, '', 'INVALID_PARAMS', 'Invalid WsRequest envelope.');
          return;
        }

        void handleRequest(conn, parsed, runner);
      });

      ws.on('close', () => {
        clearInterval(conn.pingTimer);
        for (const unsub of conn.subscriptions.values()) {
          unsub();
        }
        conn.subscriptions.clear();
        instances.wsDisconnect(agentId);
      });

      ws.on('error', () => {
        ws.close();
      });
    });
  });

  return wss;
};
