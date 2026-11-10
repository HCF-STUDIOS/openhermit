import { ConflictError } from '@openhermit/shared';

/** Partial unique index enforcing one owner per agent (migration 0036). */
const ONE_OWNER_INDEX = 'user_agents_one_owner';

/**
 * Translate a Postgres unique-violation on the single-owner index into a
 * domain ConflictError (HTTP 409). Any other error is rethrown untouched.
 *
 * The owner-assigning store primitives are blind upserts keyed on
 * (user_id, agent_id); the database index is what actually stops a SECOND
 * user from becoming owner. This keeps that backstop from surfacing as an
 * opaque 500 to callers (agent create, channel claim, admin set-owner).
 */
export function rethrowOwnerConflict(err: unknown, agentId: string): never {
  const e = err as { code?: string; constraint?: string } | undefined;
  if (e && e.code === '23505' && e.constraint === ONE_OWNER_INDEX) {
    throw new ConflictError(`Agent ${agentId} already has an owner.`);
  }
  throw err;
}
