import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveMemberRole } from '../src/member-role.js';

test('SECURITY: a self-join cannot elevate itself to user', () => {
  // The core bug: a logged-in JWT user POSTing to its own membership with
  // {"role":"user"} on a public agent must still land as guest.
  assert.equal(
    resolveMemberRole({ authMode: 'user', isSelfJoin: true, requestedRole: 'user' }),
    'guest',
  );
});

test('SECURITY: a self-join cannot elevate itself to owner', () => {
  assert.equal(
    resolveMemberRole({ authMode: 'user', isSelfJoin: true, requestedRole: 'owner' }),
    'guest',
  );
});

test('self-join with no requested role is guest', () => {
  assert.equal(
    resolveMemberRole({ authMode: 'user', isSelfJoin: true, requestedRole: undefined }),
    'guest',
  );
});

test('owner adding another user may grant user', () => {
  // Not a self-join; the route has already verified the caller is an owner.
  assert.equal(
    resolveMemberRole({ authMode: 'user', isSelfJoin: false, requestedRole: 'user' }),
    'user',
  );
});

test('owner adding another user may grant guest', () => {
  assert.equal(
    resolveMemberRole({ authMode: 'user', isSelfJoin: false, requestedRole: 'guest' }),
    'guest',
  );
});

test('a non-admin can never grant owner, even when adding someone else', () => {
  assert.equal(
    resolveMemberRole({ authMode: 'user', isSelfJoin: false, requestedRole: 'owner' }),
    'guest',
  );
});

test('admin may grant any role, including owner', () => {
  assert.equal(
    resolveMemberRole({ authMode: 'admin', isSelfJoin: false, requestedRole: 'owner' }),
    'owner',
  );
  assert.equal(
    resolveMemberRole({ authMode: 'admin', isSelfJoin: true, requestedRole: 'user' }),
    'user',
  );
});

test('admin with no requested role defaults to guest', () => {
  assert.equal(
    resolveMemberRole({ authMode: 'admin', isSelfJoin: false, requestedRole: undefined }),
    'guest',
  );
});
