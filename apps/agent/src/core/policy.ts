import type { UserRole } from '@openhermit/store';

// ── Grant ───────────────────────────────────────────────────────────────

export type Grant =
  | { type: 'any' }
  | { type: 'role'; value: UserRole }
  | { type: 'user'; value: string };

// ── Principal ───────────────────────────────────────────────────────────

export interface Principal {
  userId?: string;
  role?: UserRole;
  agentId: string;
}

// ── Effect & decision ──────────────────────────────────────────────────

export type PolicyEffect = 'allow' | 'deny' | 'require_approval';
export type AccessDecision = 'allow' | 'deny' | 'require_approval';

// ── PolicyRow (matches DB shape) ────────────────────────────────────────

export interface PolicyRow {
  agentId: string;
  resourceType: string;
  resourceKey: string;
  effect: PolicyEffect;
  grants: unknown[];
  scope: Record<string, unknown>;
}

// ── PolicyMatch (resolved from rows) ───────────────────────────────────

export interface PolicyMatch {
  effect: PolicyEffect;
  grants: Grant[];
}

// ── Tool policy ─────────────────────────────────────────────────────────

export interface ToolPolicy {
  defaultGrants: Grant[];
}

// ── Core evaluation ─────────────────────────────────────────────────────

export const matchesGrant = (principal: Principal, grant: Grant): boolean => {
  switch (grant.type) {
    case 'any':
      return true;
    case 'role':
      return principal.role === grant.value;
    case 'user':
      return !!principal.userId && principal.userId === grant.value;
  }
};

export const canAccess = (principal: Principal, grants: Grant[]): boolean =>
  grants.some((g) => matchesGrant(principal, g));

/**
 * Evaluate access given a principal and a set of matched policy rows.
 * Priority: deny > require_approval > allow.
 * When matches exist but none apply to the principal, deny access
 * (the policy explicitly restricts who can use the resource).
 * Returns the default decision only when there are no matches at all.
 */
export const evaluateAccess = (
  principal: Principal,
  matches: PolicyMatch[],
  defaultDecision: AccessDecision = 'allow',
): AccessDecision => {
  if (matches.length === 0) return defaultDecision;

  let hasAllow = false;
  let hasRequireApproval = false;

  for (const m of matches) {
    if (!canAccess(principal, m.grants)) continue;
    if (m.effect === 'deny') return 'deny';
    if (m.effect === 'require_approval') hasRequireApproval = true;
    if (m.effect === 'allow') hasAllow = true;
  }

  if (hasRequireApproval) return 'require_approval';
  if (hasAllow) return 'allow';
  return 'deny';
};

const OPEN: Grant[] = [{ type: 'any' }];

// ── Resolution helpers ──────────────────────────────────────────────────

const findPolicyRows = (
  rows: PolicyRow[],
  resourceType: string,
  key: string,
): PolicyRow[] => {
  // Exact matches
  const exact = rows.filter(
    (r) => r.resourceType === resourceType && r.resourceKey === key,
  );
  // Prefix matches (resource_key ending with '*')
  const prefix = rows.filter(
    (r) =>
      r.resourceType === resourceType &&
      r.resourceKey.endsWith('*') &&
      key.startsWith(r.resourceKey.slice(0, -1)) &&
      !exact.some((e) => e.effect === r.effect),
  );
  // Exact takes priority per-effect; include prefix only for effects not covered by exact
  return [...exact, ...prefix];
};

export const resolveToolMatches = (
  policyRows: PolicyRow[] | undefined,
  toolName: string,
  declaredPolicy?: ToolPolicy,
): PolicyMatch[] => {
  if (policyRows) {
    const matched = findPolicyRows(policyRows, 'tool', toolName);
    if (matched.length > 0) {
      return matched.map((r) => ({ effect: r.effect, grants: r.grants as Grant[] }));
    }
  }

  if (declaredPolicy) {
    return [{ effect: 'allow', grants: declaredPolicy.defaultGrants }];
  }

  return [{ effect: 'allow', grants: OPEN }];
};

/** @deprecated Use resolveToolMatches + evaluateAccess instead. */
export const resolveToolGrants = (
  policyRows: PolicyRow[] | undefined,
  toolName: string,
  declaredPolicy?: ToolPolicy,
): Grant[] => {
  if (policyRows) {
    const rows = policyRows.filter(
      (r) => r.resourceType === 'tool' && r.effect === 'allow',
    );
    const row = rows.find((r) => r.resourceKey === toolName)
      ?? rows.find(
        (r) => r.resourceKey.endsWith('*') && toolName.startsWith(r.resourceKey.slice(0, -1)),
      );
    if (row) return row.grants as Grant[];
  }
  if (declaredPolicy) return declaredPolicy.defaultGrants;
  return OPEN;
};

// ── File path policy ───────────────────────────────────────────────────

export type FileMode = 'read' | 'write';

interface FileScope {
  sandbox: string;
  mode: string;
  path: string;
}

const parseFileScope = (row: PolicyRow): FileScope | undefined => {
  const s = row.scope;
  if (typeof s.sandbox !== 'string' || typeof s.mode !== 'string' || typeof s.path !== 'string') {
    return undefined;
  }
  return { sandbox: s.sandbox, mode: s.mode, path: s.path };
};

/**
 * Resolve file path-level matches. Returns `undefined` when no file row
 * applies to this (sandbox, mode, path) — caller falls back to tool-level
 * policy. An unrelated file rule (e.g. one targeting `/root/notes.md`)
 * must not silently deny reads/writes on other paths.
 */
export const resolveFilePathMatches = (
  fileRows: PolicyRow[],
  sandbox: string,
  mode: FileMode,
  path: string,
): PolicyMatch[] | undefined => {
  if (fileRows.length === 0) return undefined;

  // Group by effect, find best (longest prefix) per effect
  const bestByEffect = new Map<PolicyEffect, { row: PolicyRow; len: number }>();

  for (const row of fileRows) {
    const scope = parseFileScope(row);
    if (!scope) continue;
    if (scope.mode !== '*' && scope.mode !== mode) continue;
    if (scope.sandbox !== '*' && scope.sandbox !== sandbox) continue;
    if (!path.startsWith(scope.path)) continue;
    const effect = (row.effect ?? 'allow') as PolicyEffect;
    const existing = bestByEffect.get(effect);
    if (!existing || scope.path.length > existing.len) {
      bestByEffect.set(effect, { row, len: scope.path.length });
    }
  }

  if (bestByEffect.size === 0) return undefined;
  return [...bestByEffect.values()].map(({ row }) => ({
    effect: (row.effect ?? 'allow') as PolicyEffect,
    grants: row.grants as Grant[],
  }));
};

/** @deprecated Use resolveFilePathMatches + evaluateAccess instead. */
export const resolveFilePathGrants = (
  fileRows: PolicyRow[],
  sandbox: string,
  mode: FileMode,
  path: string,
): Grant[] | undefined => {
  if (fileRows.length === 0) return undefined;

  let bestMatch: PolicyRow | undefined;
  let bestLen = -1;

  for (const row of fileRows) {
    if (row.effect !== 'allow') continue;
    const scope = parseFileScope(row);
    if (!scope) continue;
    if (scope.mode !== mode) continue;
    if (scope.sandbox !== '*' && scope.sandbox !== sandbox) continue;
    if (!path.startsWith(scope.path)) continue;
    if (scope.path.length > bestLen) {
      bestLen = scope.path.length;
      bestMatch = row;
    }
  }

  if (bestMatch) return bestMatch.grants as Grant[];
  return [];
};

// ── Exec command policy ────────────────────────────────────────────────

const normalizeCommand = (cmd: string): string =>
  cmd.trim().replace(/\s+/g, ' ');

/**
 * Resolve exec command-level matches. Returns `undefined` when no exec row
 * applies to this (sandbox, command, cwd) — caller falls back to tool-level
 * policy. An unrelated command rule must not silently deny other commands.
 */
export const resolveExecMatches = (
  execRows: PolicyRow[],
  sandbox: string,
  command: string,
  cwd?: string,
): PolicyMatch[] | undefined => {
  if (execRows.length === 0) return undefined;

  const normalized = normalizeCommand(command);
  const bestByEffect = new Map<PolicyEffect, { row: PolicyRow; specificity: number }>();

  for (const row of execRows) {
    const s = row.scope;
    if (typeof s.sandbox !== 'string' || typeof s.command !== 'string') continue;
    if (s.sandbox !== '*' && s.sandbox !== sandbox) continue;

    const cwdScope = typeof s.cwd === 'string' ? s.cwd : undefined;
    if (cwdScope && cwdScope !== '*' && cwd) {
      if (!cwd.startsWith(cwdScope)) continue;
    } else if (cwdScope && cwdScope !== '*' && !cwd) {
      continue;
    }

    const commandMatch = s.command === '*' || normalizeCommand(s.command) === normalized;
    if (!commandMatch) continue;

    let specificity = 0;
    if (s.command !== '*') specificity += 2;
    if (cwdScope && cwdScope !== '*') specificity += 1;

    const effect = (row.effect ?? 'allow') as PolicyEffect;
    const existing = bestByEffect.get(effect);
    if (!existing || specificity > existing.specificity) {
      bestByEffect.set(effect, { row, specificity });
    }
  }

  if (bestByEffect.size === 0) return undefined;
  return [...bestByEffect.values()].map(({ row }) => ({
    effect: (row.effect ?? 'allow') as PolicyEffect,
    grants: row.grants as Grant[],
  }));
};

/** @deprecated Use resolveExecMatches + evaluateAccess instead. */
export const resolveExecGrants = (
  execRows: PolicyRow[],
  sandbox: string,
  command: string,
  cwd?: string,
): Grant[] | undefined => {
  if (execRows.length === 0) return undefined;

  const normalized = normalizeCommand(command);
  let bestMatch: PolicyRow | undefined;
  let bestSpecificity = -1;

  for (const row of execRows) {
    if (row.effect !== 'allow') continue;
    const s = row.scope;
    if (typeof s.sandbox !== 'string' || typeof s.command !== 'string') continue;
    if (s.sandbox !== '*' && s.sandbox !== sandbox) continue;

    const cwdScope = typeof s.cwd === 'string' ? s.cwd : undefined;
    if (cwdScope && cwdScope !== '*' && cwd) {
      if (!cwd.startsWith(cwdScope)) continue;
    } else if (cwdScope && cwdScope !== '*' && !cwd) {
      continue;
    }

    const commandMatch = s.command === '*' || normalizeCommand(s.command) === normalized;
    if (!commandMatch) continue;

    let specificity = 0;
    if (s.command !== '*') specificity += 2;
    if (cwdScope && cwdScope !== '*') specificity += 1;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestMatch = row;
    }
  }

  if (bestMatch) return bestMatch.grants as Grant[];
  return [];
};

// ── MCP server policy ─────────────────────────────────────────────────

/**
 * Resolve MCP server-level matches. Returns undefined if no mcp rows
 * exist (caller should fall back to tool-level policy). Returns PolicyMatch[]
 * with all matching rows for the server (across effects).
 */
export const resolveMcpMatches = (
  mcpRows: PolicyRow[],
  serverId: string,
): PolicyMatch[] | undefined => {
  if (mcpRows.length === 0) return undefined;

  const matches: PolicyMatch[] = [];
  const seenEffects = new Set<PolicyEffect>();

  // Exact match first (per effect)
  for (const row of mcpRows) {
    if (row.resourceKey === serverId) {
      const effect = (row.effect ?? 'allow') as PolicyEffect;
      if (!seenEffects.has(effect)) {
        seenEffects.add(effect);
        matches.push({ effect, grants: row.grants as Grant[] });
      }
    }
  }
  // Wildcard (only for effects not covered by exact)
  for (const row of mcpRows) {
    if (row.resourceKey === '*') {
      const effect = (row.effect ?? 'allow') as PolicyEffect;
      if (!seenEffects.has(effect)) {
        seenEffects.add(effect);
        matches.push({ effect, grants: row.grants as Grant[] });
      }
    }
  }

  if (matches.length === 0) return [];
  return matches;
};

/** @deprecated Use resolveMcpMatches + evaluateAccess instead. */
export const resolveMcpGrants = (
  mcpRows: PolicyRow[],
  serverId: string,
): Grant[] | undefined => {
  if (mcpRows.length === 0) return undefined;

  for (const row of mcpRows) {
    if (row.resourceKey === serverId && row.effect === 'allow') return row.grants as Grant[];
  }
  for (const row of mcpRows) {
    if (row.resourceKey === '*' && row.effect === 'allow') return row.grants as Grant[];
  }

  return [];
};

/**
 * Extract the MCP server ID from a tool name following the
 * `mcp__serverId__toolName` naming convention. Returns undefined
 * if the name does not match.
 */
export const parseMcpServerId = (toolName: string): string | undefined => {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice(5);
  const sep = rest.indexOf('__');
  if (sep === -1) return undefined;
  return rest.slice(0, sep);
};

export const buildPrincipal = (
  agentId: string,
  userId?: string,
  role?: UserRole,
): Principal => ({
  agentId,
  ...(userId ? { userId } : {}),
  ...(role ? { role } : {}),
});
