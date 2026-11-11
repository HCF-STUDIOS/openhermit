import type { UserRole } from '@openhermit/store';

/**
 * Decide the role a `POST /api/agents/:agentId/members` call may actually
 * grant. This is a security boundary, extracted as a pure function so the
 * escalation rules are unit-testable in isolation from the HTTP route.
 *
 * The rules:
 *
 * - **admin** callers may grant any role, including `owner` (full trust).
 * - A **self-join** — a JWT user adding THEMSELVES to an agent — can NEVER
 *   elevate its own role. It is always `guest`, whatever `role` the request
 *   body asks for. Promotion to `user`/`owner` is an owner/admin action, not
 *   something a stranger does to itself by joining a public twin. (Without
 *   this, any logged-in user could `POST .../members {"role":"user"}` on any
 *   public agent and self-assign the exec-eligible `user` role — the role
 *   that sits ABOVE the guest-exec hard block.)
 * - Adding ANOTHER user (not self): the route has already verified the caller
 *   is an owner, so an owner may grant `user`/`guest` but not `owner` here.
 */
export function resolveMemberRole(input: {
  authMode: 'admin' | 'user';
  isSelfJoin: boolean;
  requestedRole?: UserRole | undefined;
}): UserRole {
  const { authMode, isSelfJoin, requestedRole } = input;

  if (authMode === 'admin') return requestedRole ?? 'guest';

  // Non-admin (JWT user) path.
  if (isSelfJoin) return 'guest';

  // Caller is an owner adding someone else (enforced upstream): may grant any
  // non-owner role.
  if (requestedRole && requestedRole !== 'owner') return requestedRole;
  return 'guest';
}
