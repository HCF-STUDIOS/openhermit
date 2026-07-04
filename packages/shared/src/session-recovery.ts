/**
 * Shared session-recovery helpers for channel bridges.
 *
 * Lives in @openhermit/shared (not @openhermit/sdk) on purpose: channel
 * packages pin `@openhermit/shared` to an exact workspace version, so it is
 * always resolved to the workspace copy — whereas `@openhermit/sdk` is a
 * caret range that npm may satisfy with a nested published copy, which would
 * not carry newly-added exports.
 */

/**
 * True when an agent-local API error means the target session can't be
 * (re)opened for the current caller — either it no longer exists, or the
 * resolved sender isn't a participant. Channel bridges hit this when
 * `getSessionId` recovers a persisted session id from a previous
 * deployment / migration (or one belonging to a different identity): the
 * runner rejects the reopen with `404 Session not found`.
 */
export const isSessionNotFoundError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('404') && msg.includes('Session not found');
};

/**
 * Open a channel session, falling back to a fresh one when the recovered id
 * can't be reopened (`404 Session not found`). Channel bridges recover a
 * chat's most-recent session via `listSessions`, but that session may be
 * stale (previous deployment) or belong to a different resolved identity —
 * reopening it then 404s and, historically, surfaced to the user as
 * "something went wrong". This retries once against a fresh session so the
 * message still gets through.
 *
 * `open(id)` must open/create the session (i.e. call `openSession`).
 * `freshSessionId()` must mint a new id AND update the bridge's per-chat
 * cache so subsequent messages reuse it. Returns the id actually opened.
 *
 * Only the open/reopen step needs wrapping: once a session is open in the
 * runner, the follow-up `postMessage` finds it in memory and won't 404.
 * Errors other than a stale-session 404 propagate unchanged.
 */
export const openSessionWithFreshFallback = async (
  sessionId: string,
  open: (id: string) => Promise<unknown>,
  freshSessionId: () => string,
): Promise<string> => {
  try {
    await open(sessionId);
    return sessionId;
  } catch (err) {
    if (!isSessionNotFoundError(err)) throw err;
    const fresh = freshSessionId();
    await open(fresh);
    return fresh;
  }
};
