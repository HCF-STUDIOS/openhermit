/**
 * Gateway authentication layer.
 *
 * Three authentication modes:
 *
 * 1. **Admin auth** — Gateway-level management token (`GATEWAY_ADMIN_TOKEN`).
 *    Used for agent CRUD and lifecycle operations.
 *
 * 2. **User auth (JWT)** — End-users exchange credentials (device-key, etc.)
 *    for a short-lived JWT via `POST /api/auth/token` (user-global; the
 *    JWT identifies a person, not an agent). All subsequent agent API
 *    calls use `Authorization: Bearer <jwt>`.
 *
 * 3. **Channel auth** — External channels (Telegram, Discord, third-party bots)
 *    authenticate with a pre-shared API key.  The channel declares per-message
 *    user identity via `MessageSender`; the gateway trusts it but enforces
 *    namespace isolation.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomUUID, timingSafeEqual } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────────────────

/** Verified identity attached to every authenticated request. */
export interface AuthContext {
  /** Authentication mode that produced this context. */
  mode: 'user' | 'channel' | 'admin';

  /** Resolved internal userId (may be undefined for first-time users). */
  userId?: string;

  /** Channel + channelUserId for identity resolution by AgentRunner. */
  channel: string;
  channelUserId: string;

  /**
   * Only used by channel-mode auth: the agent the channel registration is
   * scoped to. User-mode JWTs are gateway-level (no agentId); per-agent
   * authorization happens via the user_agents membership lookup at the
   * route level.
   */
  agentId?: string;

  /** Display name (optional). */
  displayName?: string;

  /**
   * For channel auth: the channelId that was authenticated.
   * Channel-declared sender identities must match this namespace.
   */
  channelNamespace?: string;
}

/**
 * Pluggable user authentication provider.
 *
 * Implementations verify user-supplied credentials and return a verified
 * channel identity.  Used during token exchange, not on every request.
 */
export interface UserAuthProvider {
  /** Unique provider id, e.g. "device-key", "email-password", "google-oauth". */
  readonly id: string;

  /**
   * Verify credentials from the token exchange request body.
   * Return a verified identity or null if this provider doesn't apply.
   */
  authenticate(body: Record<string, unknown>): Promise<UserAuthResult | null>;
}

export interface UserAuthResult {
  /** Channel name for identity linking, e.g. "web", "web-email", "web-google". */
  channel: string;
  /** Channel-scoped user id, e.g. email address, OAuth sub, device fingerprint. */
  channelUserId: string;
  /** Optional display name. */
  displayName?: string;
}

/**
 * Registered external channel.
 */
export interface ChannelRegistration {
  channelId: string;
  apiKey: string;
  namespace?: string;
  /** The agent this channel token is scoped to. */
  agentId: string;
}

// ── Channel registry ───────────────────────────────────────────────────────

export class ChannelRegistry {
  private readonly byKey = new Map<string, ChannelRegistration>();
  private readonly byId = new Map<string, ChannelRegistration>();

  register(registration: ChannelRegistration): void {
    this.byKey.set(registration.apiKey, registration);
    this.byId.set(registration.channelId, registration);
  }

  unregister(channelId: string): void {
    const reg = this.byId.get(channelId);
    if (reg) {
      this.byKey.delete(reg.apiKey);
      this.byId.delete(channelId);
    }
  }

  /** Remove all channel registrations belonging to an agent. */
  unregisterByAgent(agentId: string): void {
    for (const [id, reg] of this.byId) {
      if (reg.agentId === agentId) {
        this.byKey.delete(reg.apiKey);
        this.byId.delete(id);
      }
    }
  }

  resolveByKey(apiKey: string): ChannelRegistration | undefined {
    return this.byKey.get(apiKey);
  }

  resolveById(channelId: string): ChannelRegistration | undefined {
    return this.byId.get(channelId);
  }

  getNamespace(registration: ChannelRegistration): string {
    return registration.namespace ?? registration.channelId;
  }

  validateSenderNamespace(
    registration: ChannelRegistration,
    senderChannel: string,
  ): boolean {
    return senderChannel === this.getNamespace(registration);
  }
}

// ── Device Key provider (asymmetric key auth) ────────────────────────────────

const DEVICE_KEY_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

const base64urlDecode = (s: string): Uint8Array => {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const bufferToHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Auth provider using client-generated ECDSA P-256 keypair.
 *
 * Token exchange body:
 * ```json
 * {
 *   "grant_type": "device-key",
 *   "device_key": "<base64url(rawPublicKey)>.<unixSeconds>.<base64url(signature)>"
 * }
 * ```
 */
export class DeviceKeyAuthProvider implements UserAuthProvider {
  readonly id = 'device-key';

  async authenticate(body: Record<string, unknown>): Promise<UserAuthResult | null> {
    if (body.grant_type !== 'device-key') return null;

    const deviceKey = body.device_key;
    if (typeof deviceKey !== 'string') return null;

    const parts = deviceKey.split('.');
    if (parts.length !== 3) return null;

    const [pubKeyB64, timestampStr, signatureB64] = parts as [string, string, string];

    // Validate timestamp freshness
    const timestamp = Number.parseInt(timestampStr, 10);
    if (Number.isNaN(timestamp)) return null;
    const age = Math.abs(Date.now() - timestamp * 1000);
    if (age > DEVICE_KEY_MAX_AGE_MS) return null;

    // Decode key and signature
    const rawPublicKey = base64urlDecode(pubKeyB64).buffer as ArrayBuffer;
    const signatureBytes = base64urlDecode(signatureB64).buffer as ArrayBuffer;

    // Import the public key
    let publicKey: CryptoKey;
    try {
      publicKey = await crypto.subtle.importKey(
        'raw',
        rawPublicKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch {
      return null;
    }

    // Verify signature over the timestamp bytes
    const payload = new TextEncoder().encode(timestampStr);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signatureBytes,
      payload,
    );
    if (!valid) return null;

    // Derive stable device identifier from public key fingerprint
    const fingerprint = bufferToHex(await crypto.subtle.digest('SHA-256', rawPublicKey));

    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : undefined;

    return {
      channel: 'web',
      channelUserId: fingerprint,
      ...(displayName ? { displayName } : {}),
    };
  }
}

// ── JWT token management ──────────────────────────────────────────────────

const JWT_DEFAULT_EXPIRY = '24h';

export interface JwtConfig {
  /** HMAC-SHA256 secret. Auto-generated if not provided. */
  secret: Uint8Array;
  /** Token expiry (jose duration string). Default: '24h'. */
  expiry?: string;
}

/**
 * What a JWT is allowed to do.
 *
 * - `'session'` — normal API access (default for all routes that take a JWT).
 *   Issued by device-key flow or by the admin-issued path.
 * - `'exchange'` — single-use bearer for the web `/connect` deep-link flow.
 *   Cannot access any API; only `POST /api/auth/exchange` accepts it, and
 *   the gateway records its `jti` so each token is usable exactly once.
 */
export type JwtPurpose = 'session' | 'exchange';

/**
 * Where a JWT was minted from, for audit only.
 *
 * - `'device-key'` — the browser proved possession of an ECDSA key via
 *   `POST /api/auth/token`.
 * - `'admin-issued'` — the gateway's admin token requested it on behalf
 *   of an external identity (`POST /api/admin/auth/issue-token`).
 */
export type JwtIssuer = 'device-key' | 'admin-issued';

export interface JwtTokenPayload extends JWTPayload {
  /** Subject: "channel:channelUserId". */
  sub: string;
  /** Channel name. */
  channel: string;
  /** Channel user ID. */
  channelUserId: string;
  /** What the token is allowed to do. Missing on legacy tokens = 'session'. */
  purpose?: JwtPurpose;
  /** Where the token was minted from. Missing on legacy tokens. */
  issuer?: JwtIssuer;
  /** Unique token id (set on every signed token; used for one-shot revocation). */
  jti?: string;
  // NOTE: agentId is no longer in the JWT — tokens are gateway-level
  // identity now. Agent access is gated per-request via the user_agents
  // membership table.
}

export const createJwtConfig = (secretEnv?: string): JwtConfig => {
  let secret: Uint8Array;
  if (secretEnv) {
    secret = new TextEncoder().encode(secretEnv);
  } else {
    // Auto-generate a random secret (ephemeral — tokens won't survive restarts)
    secret = crypto.getRandomValues(new Uint8Array(32));
  }
  return { secret };
};

export const signJwt = async (
  config: JwtConfig,
  payload: {
    channel: string;
    channelUserId: string;
    /** Default 'session'. */
    purpose?: JwtPurpose;
    /** Default 'device-key'. Audit-only. */
    issuer?: JwtIssuer;
    /** Override `config.expiry` (jose duration string, e.g. "60s", "24h"). */
    expiry?: string;
  },
): Promise<{ token: string; expiresAt: number; jti: string }> => {
  const expiry = payload.expiry ?? config.expiry ?? JWT_DEFAULT_EXPIRY;
  const purpose: JwtPurpose = payload.purpose ?? 'session';
  const issuer: JwtIssuer = payload.issuer ?? 'device-key';
  const jti = randomUUID();
  const jwt = await new SignJWT({
    channel: payload.channel,
    channelUserId: payload.channelUserId,
    purpose,
    issuer,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`${payload.channel}:${payload.channelUserId}`)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(config.secret);

  // Decode exp from the JWT to return it
  const [, payloadB64] = jwt.split('.');
  const decoded = JSON.parse(atob(payloadB64!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp: number };

  return { token: jwt, expiresAt: decoded.exp, jti };
};

export const verifyJwt = async (
  config: JwtConfig,
  token: string,
  /**
   * Restrict accepted purposes. Defaults to `['session']` so callers don't
   * accidentally honor exchange tokens for normal API access; the exchange
   * endpoint passes `{ allowPurpose: 'exchange' }` to flip that.
   *
   * Legacy tokens without a `purpose` claim are treated as `'session'`.
   */
  opts?: { allowPurpose?: JwtPurpose | JwtPurpose[] },
): Promise<JwtTokenPayload | null> => {
  try {
    // Pin algorithm to prevent `alg:none` and algorithm-confusion attacks.
    const { payload } = await jwtVerify(token, config.secret, { algorithms: ['HS256'] });
    if (!payload.sub || !payload.channel || !payload.channelUserId) {
      return null;
    }
    const allowed: readonly JwtPurpose[] = opts?.allowPurpose
      ? Array.isArray(opts.allowPurpose) ? opts.allowPurpose : [opts.allowPurpose]
      : ['session'];
    const purpose: JwtPurpose = (payload.purpose as JwtPurpose | undefined) ?? 'session';
    if (!allowed.includes(purpose)) return null;
    return payload as JwtTokenPayload;
  } catch (err) {
    if (process.env.OPENHERMIT_LOG_AUTH === '1') {
      console.debug('[auth] JWT verify failed:', (err as Error).message);
    }
    return null;
  }
};

// ── Admin token ───────────────────────────────────────────────────────────

/**
 * Constant-time comparison of two strings. Returns false on length mismatch
 * without leaking length info via timing.
 */
export const tokensMatch = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still run a comparison against itself to keep timing roughly constant.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
};

export const verifyAdminToken = (
  adminToken: string | undefined,
  authorization: string | undefined,
): boolean => {
  if (!adminToken) return false;
  if (!authorization?.startsWith('Bearer ')) return false;
  return tokensMatch(authorization.slice(7), adminToken);
};

// ── Auth resolution ────────────────────────────────────────────────────────

export interface AuthResolverOptions {
  /** User auth providers, tried in order during token exchange. */
  userProviders: UserAuthProvider[];
  /** Channel registry for API key auth. */
  channels: ChannelRegistry;
  /** JWT configuration. */
  jwt: JwtConfig;
  /** Admin token — grants full access when used as Bearer token. */
  adminToken?: string | undefined;
}

/**
 * Resolve authentication from a request.
 *
 * Order:
 * 1. Try JWT verification (Bearer token is a valid JWT)
 * 2. Try channel auth (Bearer token matches a registered channel key)
 * 3. Return null (unauthenticated)
 */
/**
 * Resolve authentication from a request.
 *
 * Order:
 * 1. Extract Bearer token from Authorization header (or `token` query param for SSE)
 * 2. Try JWT verification
 * 3. Try channel auth (pre-shared key)
 * 4. Return null (unauthenticated)
 */
export const resolveAuth = async (
  request: Request,
  options: AuthResolverOptions,
): Promise<AuthContext | null> => {
  const authorization = request.headers.get('authorization');

  // Extract token from header or query param (EventSource can't set headers)
  let bearerToken: string | undefined;
  if (authorization?.startsWith('Bearer ')) {
    bearerToken = authorization.slice(7);
  } else {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token');
    if (queryToken) bearerToken = queryToken;
  }

  if (bearerToken) {
    // 0. Admin token — full access (timing-safe comparison)
    if (options.adminToken && tokensMatch(bearerToken, options.adminToken)) {
      return { mode: 'admin' as const, channel: 'admin', channelUserId: 'admin' };
    }

    // 1. Try JWT (gateway-level identity; agent access is gated downstream
    //    via per-request user_agents lookup).
    const jwtPayload = await verifyJwt(options.jwt, bearerToken);
    if (jwtPayload) {
      return {
        mode: 'user',
        channel: jwtPayload.channel as string,
        channelUserId: jwtPayload.channelUserId as string,
      };
    }

    // 2. Channel auth: Bearer token matches a registered channel key
    const channel = options.channels.resolveByKey(bearerToken);
    if (channel) {
      const namespace = options.channels.getNamespace(channel);
      const headerUserId = request.headers.get('x-channel-user-id') ?? '';
      return {
        mode: 'channel',
        channel: namespace,
        channelUserId: headerUserId,
        channelNamespace: namespace,
        agentId: channel.agentId,
      };
    }
  }

  return null;
};
