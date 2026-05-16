/**
 * PII redaction helpers for log lines. Signal identifiers (E.164 numbers,
 * UUIDs) and conversation targets must never be logged in plaintext.
 */

/**
 * Mask all but the last 4 characters of an identifier. Empty/short
 * inputs return a fully-masked placeholder so callers don't accidentally
 * leak short tokens.
 */
export const redactId = (value: string | undefined | null): string => {
  if (!value) return '****';
  const s = String(value);
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
};

/**
 * Best-effort redaction for an outbound conversation target like
 * `signal:+15551234567`, `signal:uuid:abc-...`, `signal:group:base64=`,
 * or a raw recipient. Preserves the routing prefix so logs stay useful.
 */
export const redactTarget = (target: string | undefined | null): string => {
  if (!target) return '****';
  const s = String(target);
  const idx = s.lastIndexOf(':');
  if (idx === -1) return redactId(s);
  return `${s.slice(0, idx + 1)}${redactId(s.slice(idx + 1))}`;
};
