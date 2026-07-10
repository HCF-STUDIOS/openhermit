import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentRuntimeConfig } from '../src/core/security.js';

test('two_step config block validates and defaults to off when absent', () => {
  const on = parseAgentRuntimeConfig({ experiments: { two_step: { enabled: true, reply_timeout_ms: 8000 } } });
  assert.equal(on.experiments?.two_step?.enabled, true);
  assert.equal(on.experiments?.two_step?.reply_timeout_ms, 8000);

  const off = parseAgentRuntimeConfig({});
  assert.equal(off.experiments?.two_step, undefined);
});
