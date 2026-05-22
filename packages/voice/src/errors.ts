import { OpenHermitError } from '@openhermit/shared';

// Normalized error taxonomy for voice providers. Channel adapters react
// to these classes; provider-specific HTTP error shapes are mapped to one
// of them at the adapter boundary.

/** Network-level failure (DNS, TCP, timeout, 5xx). Retryable. */
export class VoiceTransportError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'voice_transport_error', 500);
  }
}

/** Auth failure (missing/invalid API key, 401/403). Not retryable. */
export class VoiceAuthError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'voice_auth_error', 401);
  }
}

/** Caller-side input problem (4xx other than auth). Not retryable. */
export class VoiceValidationError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'voice_validation_error', 400);
  }
}

/**
 * Requested `outputMimeType` is not in the provider's supported set.
 * Distinct from `VoiceValidationError` because a chain fallback (when we
 * eventually add one) should try the next provider on this error rather
 * than surface it.
 */
export class VoiceUnsupportedFormatError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'voice_unsupported_format', 400);
  }
}
