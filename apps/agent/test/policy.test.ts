import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPrincipal,
  canAccess,
  evaluateAccess,
  matchesGrant,
  parseMcpServerId,
  resolveExecGrants,
  resolveExecMatches,
  resolveFilePathGrants,
  resolveFilePathMatches,
  resolveMcpGrants,
  resolveMcpMatches,
  resolveToolGrants,
  resolveToolMatches,
  type Grant,
  type PolicyMatch,
  type PolicyRow,
  type Principal,
  type ToolPolicy,
} from '../src/core/index.js';

// ── matchesGrant ────────────────────────────────────────────────────────

test('matchesGrant: {type:any} matches everyone', () => {
  const grant: Grant = { type: 'any' };
  assert.ok(matchesGrant({ agentId: 'a', role: 'guest' }, grant));
  assert.ok(matchesGrant({ agentId: 'a', role: 'owner' }, grant));
  assert.ok(matchesGrant({ agentId: 'a' }, grant));
});

test('matchesGrant: {type:role} matches only that role', () => {
  const grant: Grant = { type: 'role', value: 'user' };
  assert.ok(matchesGrant({ agentId: 'a', role: 'user' }, grant));
  assert.ok(!matchesGrant({ agentId: 'a', role: 'guest' }, grant));
  assert.ok(!matchesGrant({ agentId: 'a', role: 'owner' }, grant));
  assert.ok(!matchesGrant({ agentId: 'a' }, grant));
});

test('matchesGrant: {type:user} matches only that userId', () => {
  const grant: Grant = { type: 'user', value: 'u-123' };
  assert.ok(matchesGrant({ agentId: 'a', userId: 'u-123' }, grant));
  assert.ok(!matchesGrant({ agentId: 'a', userId: 'u-456' }, grant));
  assert.ok(!matchesGrant({ agentId: 'a' }, grant));
});

// ── canAccess ───────────────────────────────────────────────────────────

test('canAccess: returns true if any grant matches', () => {
  const principal: Principal = { agentId: 'a', role: 'user' };
  const grants: Grant[] = [
    { type: 'role', value: 'owner' },
    { type: 'role', value: 'user' },
  ];
  assert.ok(canAccess(principal, grants));
});

test('canAccess: returns false if no grant matches', () => {
  const principal: Principal = { agentId: 'a', role: 'guest' };
  const grants: Grant[] = [
    { type: 'role', value: 'owner' },
    { type: 'role', value: 'user' },
  ];
  assert.ok(!canAccess(principal, grants));
});

test('canAccess: empty grants array denies everyone', () => {
  assert.ok(!canAccess({ agentId: 'a', role: 'owner' }, []));
});

// ── evaluateAccess ─────────────────────────────────────────────────────

test('evaluateAccess: deny wins over allow', () => {
  const matches: PolicyMatch[] = [
    { effect: 'allow', grants: [{ type: 'any' }] },
    { effect: 'deny', grants: [{ type: 'role', value: 'guest' }] },
  ];
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches), 'allow');
});

test('evaluateAccess: require_approval wins over allow', () => {
  const matches: PolicyMatch[] = [
    { effect: 'allow', grants: [{ type: 'any' }] },
    { effect: 'require_approval', grants: [{ type: 'role', value: 'user' }] },
  ];
  assert.equal(evaluateAccess({ agentId: 'a', role: 'user' }, matches), 'require_approval');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches), 'allow');
});

test('evaluateAccess: deny wins over require_approval', () => {
  const matches: PolicyMatch[] = [
    { effect: 'require_approval', grants: [{ type: 'any' }] },
    { effect: 'deny', grants: [{ type: 'role', value: 'guest' }] },
  ];
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'user' }, matches), 'require_approval');
});

test('evaluateAccess: returns default when no grants match', () => {
  const matches: PolicyMatch[] = [
    { effect: 'allow', grants: [{ type: 'role', value: 'owner' }] },
  ];
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches), 'allow'); // default
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches, 'deny'), 'deny');
});

test('evaluateAccess: empty matches returns default', () => {
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, []), 'allow');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, [], 'deny'), 'deny');
});

// ── Tools without declared policy default to open ───────────────────────

test('tools without declared policy default to open', () => {
  const grants = resolveToolGrants(undefined, 'some_random_tool');
  assert.ok(canAccess({ agentId: 'a', role: 'guest' }, grants));
});

// ── resolveToolGrants with policy rows ──────────────────────────────────

test('resolveToolGrants: DB row overrides default', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a',
    resourceType: 'tool',
    scope: {},
    resourceKey: 'exec',
    effect: 'allow',
    grants: [{ type: 'any' }],
  }];
  const grants = resolveToolGrants(rows, 'exec');
  assert.ok(canAccess({ agentId: 'a', role: 'guest' }, grants));
});

test('resolveToolGrants: falls back to open when no row and no declared policy', () => {
  const rows: PolicyRow[] = [];
  const grants = resolveToolGrants(rows, 'exec');
  assert.ok(canAccess({ agentId: 'a', role: 'guest' }, grants));
});

// ── prefix matching ─────────────────────────────────────────────────────

test('resolveToolGrants: prefix pattern matches MCP tools', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a',
    resourceType: 'tool',
    scope: {},
    resourceKey: 'mcp__weather__*',
    effect: 'allow',
    grants: [{ type: 'role', value: 'owner' }],
  }];
  const grants = resolveToolGrants(rows, 'mcp__weather__get_forecast');
  assert.ok(canAccess({ agentId: 'a', role: 'owner' }, grants));
  assert.ok(!canAccess({ agentId: 'a', role: 'guest' }, grants));
});

test('resolveToolGrants: prefix pattern does not match unrelated tools', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a',
    resourceType: 'tool',
    scope: {},
    resourceKey: 'mcp__weather__*',
    effect: 'allow',
    grants: [{ type: 'role', value: 'owner' }],
  }];
  const grants = resolveToolGrants(rows, 'mcp__calendar__list');
  // No match → falls back to OPEN
  assert.ok(canAccess({ agentId: 'a', role: 'guest' }, grants));
});

test('resolveToolGrants: exact match takes priority over prefix', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'tool', scope: {},
      resourceKey: 'mcp__weather__*',
      effect: 'allow',
      grants: [{ type: 'role', value: 'owner' }],
    },
    {
      agentId: 'a', resourceType: 'tool', scope: {},
      resourceKey: 'mcp__weather__public_status',
      effect: 'allow',
      grants: [{ type: 'any' }],
    },
  ];
  const grants = resolveToolGrants(rows, 'mcp__weather__public_status');
  assert.ok(canAccess({ agentId: 'a', role: 'guest' }, grants));
  const grants2 = resolveToolGrants(rows, 'mcp__weather__get_forecast');
  assert.ok(!canAccess({ agentId: 'a', role: 'guest' }, grants2));
});

// ── buildPrincipal ──────────────────────────────────────────────────────

test('buildPrincipal omits undefined fields', () => {
  const p = buildPrincipal('agent-1');
  assert.equal(p.agentId, 'agent-1');
  assert.equal(p.userId, undefined);
  assert.equal(p.role, undefined);
});

test('buildPrincipal includes provided fields', () => {
  const p = buildPrincipal('agent-1', 'user-1', 'owner');
  assert.equal(p.agentId, 'agent-1');
  assert.equal(p.userId, 'user-1');
  assert.equal(p.role, 'owner');
});

// ── fixed vs configurable ToolPolicy ────────────────────────────────────

test('resolveToolGrants: fixed policy ignores DB rows', () => {
  const fixedPolicy: ToolPolicy = { kind: 'fixed', grants: [{ type: 'role', value: 'owner' }] };
  const rows: PolicyRow[] = [{
    agentId: 'a',
    resourceType: 'tool',
    scope: {},
    resourceKey: 'my_tool',
    effect: 'allow',
    grants: [{ type: 'any' }],
  }];
  const grants = resolveToolGrants(rows, 'my_tool', fixedPolicy);
  assert.ok(!canAccess({ agentId: 'a', role: 'guest' }, grants));
  assert.ok(canAccess({ agentId: 'a', role: 'owner' }, grants));
});

test('resolveToolGrants: configurable policy uses DB row when present', () => {
  const configurablePolicy: ToolPolicy = {
    kind: 'configurable',
    defaultGrants: [{ type: 'role', value: 'owner' }],
  };
  const rows: PolicyRow[] = [{
    agentId: 'a',
    resourceType: 'tool',
    scope: {},
    resourceKey: 'my_tool',
    effect: 'allow',
    grants: [{ type: 'any' }],
  }];
  const grants = resolveToolGrants(rows, 'my_tool', configurablePolicy);
  assert.ok(canAccess({ agentId: 'a', role: 'guest' }, grants));
});

test('resolveToolGrants: configurable policy falls back to defaultGrants', () => {
  const configurablePolicy: ToolPolicy = {
    kind: 'configurable',
    defaultGrants: [{ type: 'role', value: 'owner' }],
  };
  const grants = resolveToolGrants([], 'my_tool', configurablePolicy);
  assert.ok(!canAccess({ agentId: 'a', role: 'guest' }, grants));
  assert.ok(canAccess({ agentId: 'a', role: 'owner' }, grants));
});

// ── resolveToolMatches with effects ────────────────────────────────────

test('resolveToolMatches: deny row blocks even with allow', () => {
  const rows: PolicyRow[] = [
    { agentId: 'a', resourceType: 'tool', scope: {}, resourceKey: 'exec', effect: 'allow', grants: [{ type: 'any' }] },
    { agentId: 'a', resourceType: 'tool', scope: {}, resourceKey: 'exec', effect: 'deny', grants: [{ type: 'role', value: 'guest' }] },
  ];
  const matches = resolveToolMatches(rows, 'exec');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches), 'allow');
});

test('resolveToolMatches: require_approval effect', () => {
  const rows: PolicyRow[] = [
    { agentId: 'a', resourceType: 'tool', scope: {}, resourceKey: 'exec', effect: 'require_approval', grants: [{ type: 'role', value: 'user' }] },
    { agentId: 'a', resourceType: 'tool', scope: {}, resourceKey: 'exec', effect: 'allow', grants: [{ type: 'role', value: 'owner' }] },
  ];
  const matches = resolveToolMatches(rows, 'exec');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'user' }, matches), 'require_approval');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches), 'allow');
});

// ── resolveFilePathGrants ─────────────────────────────────────────────

test('resolveFilePathGrants: returns undefined when no file rows', () => {
  assert.equal(resolveFilePathGrants([], 'primary', 'read', '/workspace/foo.txt'), undefined);
});

test('resolveFilePathGrants: matches path prefix', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'file', resourceKey: 'primary:read:/workspace/',
    effect: 'allow',
    grants: [{ type: 'role', value: 'user' }],
    scope: { sandbox: 'primary', mode: 'read', path: '/workspace/' },
  }];
  const grants = resolveFilePathGrants(rows, 'primary', 'read', '/workspace/foo.txt');
  assert.deepEqual(grants, [{ type: 'role', value: 'user' }]);
});

test('resolveFilePathGrants: longest prefix wins', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'file', resourceKey: 'primary:read:/workspace/',
      effect: 'allow',
      grants: [{ type: 'any' }],
      scope: { sandbox: 'primary', mode: 'read', path: '/workspace/' },
    },
    {
      agentId: 'a', resourceType: 'file', resourceKey: 'primary:read:/workspace/private/',
      effect: 'allow',
      grants: [{ type: 'role', value: 'owner' }],
      scope: { sandbox: 'primary', mode: 'read', path: '/workspace/private/' },
    },
  ];
  const g1 = resolveFilePathGrants(rows, 'primary', 'read', '/workspace/public/x');
  assert.deepEqual(g1, [{ type: 'any' }]);
  const g2 = resolveFilePathGrants(rows, 'primary', 'read', '/workspace/private/secret.txt');
  assert.deepEqual(g2, [{ type: 'role', value: 'owner' }]);
});

test('resolveFilePathGrants: wildcard sandbox matches any', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'file', resourceKey: '*:read:/workspace/',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: '*', mode: 'read', path: '/workspace/' },
  }];
  const grants = resolveFilePathGrants(rows, 'whatever', 'read', '/workspace/foo.txt');
  assert.deepEqual(grants, [{ type: 'any' }]);
});

test('resolveFilePathGrants: mode must match', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'file', resourceKey: 'primary:read:/workspace/',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', mode: 'read', path: '/workspace/' },
  }];
  const grants = resolveFilePathGrants(rows, 'primary', 'write', '/workspace/foo.txt');
  assert.deepEqual(grants, []);
});

test('resolveFilePathGrants: no matching path denies', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'file', resourceKey: 'primary:read:/workspace/public/',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', mode: 'read', path: '/workspace/public/' },
  }];
  const grants = resolveFilePathGrants(rows, 'primary', 'read', '/workspace/private/foo.txt');
  assert.deepEqual(grants, []);
});

// ── resolveFilePathMatches with effects ─────────────────────────────────

test('resolveFilePathMatches: deny effect on file path', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'file', resourceKey: 'primary:read:/workspace/',
      effect: 'allow', grants: [{ type: 'any' }],
      scope: { sandbox: 'primary', mode: 'read', path: '/workspace/' },
    },
    {
      agentId: 'a', resourceType: 'file', resourceKey: 'primary:read:/workspace/secret/',
      effect: 'deny', grants: [{ type: 'role', value: 'guest' }],
      scope: { sandbox: 'primary', mode: 'read', path: '/workspace/secret/' },
    },
  ];
  const matches = resolveFilePathMatches(rows, 'primary', 'read', '/workspace/secret/key.txt')!;
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches, 'deny'), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches, 'deny'), 'allow');
});

test('resolveFilePathMatches: unrelated file rule falls through to tool-level', () => {
  // A rule scoped to /root/notes.md must not block reads on /root or /etc.
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'file', resourceKey: '*:*:/root/notes.md',
    effect: 'require_approval', grants: [{ type: 'any' }],
    scope: { sandbox: '*', mode: '*', path: '/root/notes.md' },
  }];
  assert.equal(resolveFilePathMatches(rows, 'primary', 'read', '/root'), undefined);
  assert.equal(resolveFilePathMatches(rows, 'primary', 'read', '/etc/passwd'), undefined);
});

// ── resolveExecGrants ─────────────────────────────────────────────────

test('resolveExecGrants: returns undefined when no exec rows', () => {
  assert.equal(resolveExecGrants([], 'primary', 'git status'), undefined);
});

test('resolveExecGrants: wildcard command allows anything', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:*',
    effect: 'allow',
    grants: [{ type: 'role', value: 'owner' }],
    scope: { sandbox: 'primary', command: '*' },
  }];
  const grants = resolveExecGrants(rows, 'primary', 'rm -rf /');
  assert.deepEqual(grants, [{ type: 'role', value: 'owner' }]);
});

test('resolveExecGrants: exact command match', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:git status',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', command: 'git status' },
  }];
  const grants = resolveExecGrants(rows, 'primary', 'git status');
  assert.deepEqual(grants, [{ type: 'any' }]);
});

test('resolveExecGrants: normalizes whitespace', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:git status',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', command: 'git status' },
  }];
  const grants = resolveExecGrants(rows, 'primary', '  git  status  ');
  assert.deepEqual(grants, [{ type: 'any' }]);
});

test('resolveExecGrants: different command denied', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:git status',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', command: 'git status' },
  }];
  const grants = resolveExecGrants(rows, 'primary', 'git push');
  assert.deepEqual(grants, []);
});

test('resolveExecGrants: wildcard sandbox matches any', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: '*:*',
    effect: 'allow',
    grants: [{ type: 'role', value: 'owner' }],
    scope: { sandbox: '*', command: '*' },
  }];
  const grants = resolveExecGrants(rows, 'any-sandbox', 'ls');
  assert.deepEqual(grants, [{ type: 'role', value: 'owner' }]);
});

test('resolveExecGrants: sandbox mismatch denied', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:git status',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', command: 'git status' },
  }];
  const grants = resolveExecGrants(rows, 'other', 'git status');
  assert.deepEqual(grants, []);
});

// ── resolveExecGrants: cwd scoping ──────────────────────────────────

test('resolveExecGrants: rows without cwd match any cwd', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:*',
    effect: 'allow',
    grants: [{ type: 'role', value: 'owner' }],
    scope: { sandbox: 'primary', command: '*' },
  }];
  const grants = resolveExecGrants(rows, 'primary', 'ls', '/workspace/project');
  assert.deepEqual(grants, [{ type: 'role', value: 'owner' }]);
});

test('resolveExecGrants: cwd prefix match', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:/workspace/:*',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', command: '*', cwd: '/workspace/' },
  }];
  const grants = resolveExecGrants(rows, 'primary', 'npm test', '/workspace/project');
  assert.deepEqual(grants, [{ type: 'any' }]);
});

test('resolveExecGrants: cwd mismatch denied', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:/workspace/:*',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', command: '*', cwd: '/workspace/' },
  }];
  const grants = resolveExecGrants(rows, 'primary', 'ls', '/etc');
  assert.deepEqual(grants, []);
});

test('resolveExecGrants: cwd-scoped row wins over no-cwd row', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:*',
      effect: 'allow',
      grants: [{ type: 'role', value: 'owner' }],
      scope: { sandbox: 'primary', command: '*' },
    },
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:/workspace/:*',
      effect: 'allow',
      grants: [{ type: 'any' }],
      scope: { sandbox: 'primary', command: '*', cwd: '/workspace/' },
    },
  ];
  const g1 = resolveExecGrants(rows, 'primary', 'ls', '/workspace/project');
  assert.deepEqual(g1, [{ type: 'any' }]);
  const g2 = resolveExecGrants(rows, 'primary', 'ls', '/etc');
  assert.deepEqual(g2, [{ type: 'role', value: 'owner' }]);
});

test('resolveExecGrants: exact command + cwd beats wildcard command + cwd', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:/workspace/:*',
      effect: 'allow',
      grants: [{ type: 'role', value: 'owner' }],
      scope: { sandbox: 'primary', command: '*', cwd: '/workspace/' },
    },
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:/workspace/:npm test',
      effect: 'allow',
      grants: [{ type: 'any' }],
      scope: { sandbox: 'primary', command: 'npm test', cwd: '/workspace/' },
    },
  ];
  const g1 = resolveExecGrants(rows, 'primary', 'npm test', '/workspace/project');
  assert.deepEqual(g1, [{ type: 'any' }]);
  const g2 = resolveExecGrants(rows, 'primary', 'rm -rf /', '/workspace/project');
  assert.deepEqual(g2, [{ type: 'role', value: 'owner' }]);
});

test('resolveExecGrants: cwd scope skipped when no cwd provided', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:*',
      effect: 'allow',
      grants: [{ type: 'role', value: 'owner' }],
      scope: { sandbox: 'primary', command: '*' },
    },
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:/workspace/:*',
      effect: 'allow',
      grants: [{ type: 'any' }],
      scope: { sandbox: 'primary', command: '*', cwd: '/workspace/' },
    },
  ];
  const grants = resolveExecGrants(rows, 'primary', 'ls');
  assert.deepEqual(grants, [{ type: 'role', value: 'owner' }]);
});

// ── resolveExecMatches with effects ────────────────────────────────────

test('resolveExecMatches: deny effect on exec command', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:*',
      effect: 'allow', grants: [{ type: 'role', value: 'owner' }],
      scope: { sandbox: 'primary', command: '*' },
    },
    {
      agentId: 'a', resourceType: 'exec', resourceKey: 'primary:*',
      effect: 'deny', grants: [{ type: 'role', value: 'guest' }],
      scope: { sandbox: 'primary', command: '*' },
    },
  ];
  const matches = resolveExecMatches(rows, 'primary', 'ls')!;
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches, 'deny'), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches, 'deny'), 'allow');
});

test('resolveExecMatches: unrelated exec rule falls through to tool-level', () => {
  // A rule scoped to `rm -rf /` must not block `ls` or `git status`.
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'exec', resourceKey: 'primary:rm -rf /',
    effect: 'deny', grants: [{ type: 'any' }],
    scope: { sandbox: 'primary', command: 'rm -rf /' },
  }];
  assert.equal(resolveExecMatches(rows, 'primary', 'ls'), undefined);
  assert.equal(resolveExecMatches(rows, 'primary', 'git status'), undefined);
});

// ── parseMcpServerId ─────────────────────────────────────────────────

test('parseMcpServerId: extracts server ID from mcp tool name', () => {
  assert.equal(parseMcpServerId('mcp__weather__get_forecast'), 'weather');
  assert.equal(parseMcpServerId('mcp__my-server__tool'), 'my-server');
});

test('parseMcpServerId: returns undefined for non-MCP tools', () => {
  assert.equal(parseMcpServerId('exec'), undefined);
  assert.equal(parseMcpServerId('file_read'), undefined);
  assert.equal(parseMcpServerId('mcp_status'), undefined);
});

test('parseMcpServerId: returns undefined for malformed MCP names', () => {
  assert.equal(parseMcpServerId('mcp__noseparator'), undefined);
});

// ── resolveMcpGrants ─────────────────────────────────────────────────

test('resolveMcpGrants: returns undefined when no mcp rows', () => {
  assert.equal(resolveMcpGrants([], 'weather'), undefined);
});

test('resolveMcpGrants: exact server match', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'mcp', resourceKey: 'weather',
    effect: 'allow',
    grants: [{ type: 'role', value: 'owner' }],
    scope: {},
  }];
  assert.deepEqual(resolveMcpGrants(rows, 'weather'), [{ type: 'role', value: 'owner' }]);
});

test('resolveMcpGrants: wildcard matches any server', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'mcp', resourceKey: '*',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: {},
  }];
  assert.deepEqual(resolveMcpGrants(rows, 'anything'), [{ type: 'any' }]);
});

test('resolveMcpGrants: exact match takes priority over wildcard', () => {
  const rows: PolicyRow[] = [
    {
      agentId: 'a', resourceType: 'mcp', resourceKey: '*',
      effect: 'allow',
      grants: [{ type: 'any' }],
      scope: {},
    },
    {
      agentId: 'a', resourceType: 'mcp', resourceKey: 'secret-server',
      effect: 'allow',
      grants: [{ type: 'role', value: 'owner' }],
      scope: {},
    },
  ];
  assert.deepEqual(resolveMcpGrants(rows, 'secret-server'), [{ type: 'role', value: 'owner' }]);
  assert.deepEqual(resolveMcpGrants(rows, 'other-server'), [{ type: 'any' }]);
});

test('resolveMcpGrants: no matching server denied', () => {
  const rows: PolicyRow[] = [{
    agentId: 'a', resourceType: 'mcp', resourceKey: 'weather',
    effect: 'allow',
    grants: [{ type: 'any' }],
    scope: {},
  }];
  assert.deepEqual(resolveMcpGrants(rows, 'calendar'), []);
});

// ── resolveMcpMatches with effects ──────────────────────────────────

test('resolveMcpMatches: deny effect on mcp server', () => {
  const rows: PolicyRow[] = [
    { agentId: 'a', resourceType: 'mcp', resourceKey: '*', effect: 'allow', grants: [{ type: 'any' }], scope: {} },
    { agentId: 'a', resourceType: 'mcp', resourceKey: 'secret', effect: 'deny', grants: [{ type: 'role', value: 'guest' }], scope: {} },
  ];
  const matches = resolveMcpMatches(rows, 'secret')!;
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches, 'deny'), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches, 'deny'), 'allow');
});
