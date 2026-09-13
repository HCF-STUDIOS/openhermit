export {
  loadEnv,
  migrateLegacyGatewayLayout,
  resolveAgentDataDir,
  resolveGatewayDir,
  resolveOpenHermitHome,
} from './env.js';

export {
  readPath,
  writePath,
  parseScalar,
  formatScalar,
} from './json-path.js';

export {
  SILENCE_TOKENS,
  stripSilenceTokens,
} from './silence-tokens.js';
export type { StripSilenceResult } from './silence-tokens.js';

export interface JsonErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export type OpenHermitStatusCode = 400 | 401 | 403 | 404 | 409 | 500 | 503;

export class OpenHermitError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: OpenHermitStatusCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConflictError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'conflict', 409);
  }
}

export class ValidationError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'validation_error', 400);
  }
}

export class NotFoundError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'not_found', 404);
  }
}

export class UnauthorizedError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'unauthorized', 401);
  }
}

/**
 * A dependency the handler needed (DB, hot runner, downstream service) did
 * not respond in time. Maps to 503 so callers fail fast and retry instead of
 * hanging — used by request-level timeouts that must not leave a socket open
 * while the event loop is saturated.
 */
export class ServiceUnavailableError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'service_unavailable', 503);
  }
}

/**
 * Exponential backoff with jitter for a retry loop.
 *
 * `attempt` is the 1-based consecutive-failure count (1 on the first retry).
 * Returns `baseMs * 2^(attempt-1)` capped at `maxMs`, then multiplied by a
 * ±20% jitter so many loops failing at once don't retry in lockstep and storm
 * a shared dependency. The exponent is clamped so a long failure streak can't
 * overflow. `random` is injectable for deterministic tests.
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = baseMs * 2 ** Math.min(n - 1, 20);
  const capped = Math.min(exp, maxMs);
  return Math.round(capped * (0.8 + random() * 0.4));
}

export const internalStateFiles = {
  config: 'config.json',
} as const;

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
};

export const jsonError = (
  error: unknown,
  fallbackCode = 'internal_error',
): JsonErrorBody => {
  if (error instanceof OpenHermitError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: fallbackCode,
      message: getErrorMessage(error),
    },
  };
};

export const joinUrl = (baseUrl: string, path: string): string => {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

export {
  isSessionNotFoundError,
  openSessionWithFreshFallback,
} from './session-recovery.js';
