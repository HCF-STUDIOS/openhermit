import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPrincipal,
  canAccess,
  evaluateAccess,
  matchesGrant,
  parseMcpServerId,
  resolveExecMatches,
  resolveFilePathMatches,
  resolveMcpMatches,
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

test('evaluateAccess: denies when policies exist but none grant the principal', () => {
  // Fail closed: a matching policy restricts who may use the resource, so a
  // principal outside its grants is denied regardless of the default.
  const matches: PolicyMatch[] = [
    { effect: 'allow', grants: [{ type: 'role', value: 'owner' }] },
  ];
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'guest' }, matches, 'allow'), 'deny');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, matches), 'allow');
});

test('evaluateAccess: empty matches returns default', () => {
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, []), 'allow');
  assert.equal(evaluateAccess({ agentId: 'a', role: 'owner' }, [], 'deny'), 'deny');
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
