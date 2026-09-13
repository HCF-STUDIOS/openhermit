import assert from 'node:assert/strict';
import test from 'node:test';

import { computeBackoffMs } from '../src/index.js';

// Deterministic jitter: random()=0.5 → factor 1.0, so the value is exactly the
// (capped) exponential term. random()=0 → 0.8×, random()=1 → 1.2×.
const noJitter = () => 0.5;

test('doubles the delay per consecutive failure', () => {
  assert.equal(computeBackoffMs(1, 2_000, 60_000, noJitter), 2_000);
  assert.equal(computeBackoffMs(2, 2_000, 60_000, noJitter), 4_000);
  assert.equal(computeBackoffMs(3, 2_000, 60_000, noJitter), 8_000);
  assert.equal(computeBackoffMs(4, 2_000, 60_000, noJitter), 16_000);
});

test('caps at maxMs no matter how long the failure streak', () => {
  assert.equal(computeBackoffMs(6, 2_000, 60_000, noJitter), 60_000);
  assert.equal(computeBackoffMs(50, 2_000, 60_000, noJitter), 60_000);
  // Huge attempt counts must not overflow past the cap.
  assert.equal(computeBackoffMs(1000, 2_000, 60_000, noJitter), 60_000);
});

test('attempt < 1 is treated as the first retry', () => {
  assert.equal(computeBackoffMs(0, 1_000, 60_000, noJitter), 1_000);
  assert.equal(computeBackoffMs(-5, 1_000, 60_000, noJitter), 1_000);
});

test('jitter stays within ±20% of the capped term', () => {
  assert.equal(computeBackoffMs(3, 1_000, 60_000, () => 0), 3_200); // 4000 * 0.8
  assert.equal(computeBackoffMs(3, 1_000, 60_000, () => 1), 4_800); // 4000 * 1.2
});
