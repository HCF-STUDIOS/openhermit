/**
 * Normalise agent text before it goes out over WeChat (a plain-text channel).
 *
 * The reflow/strip logic is shared with the gateway's external (amiko) outbound
 * path — see `@openhermit/shared`'s `sanitizeOutboundText`. It reflows the
 * MiniMax word-per-line corruption back into normal text and strips reasoning
 * wrappers, while leaving genuinely paragraph-/list-formatted replies untouched.
 */
export { sanitizeOutboundText } from '@openhermit/shared';
