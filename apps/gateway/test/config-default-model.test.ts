import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGatewayConfig } from '../src/config.js';

test('parseGatewayConfig omits defaultModel when not set', () => {
  const cfg = parseGatewayConfig({});
  assert.equal(cfg.defaultModel, undefined);
});

test('parseGatewayConfig parses defaultModel with provider + model', () => {
  const cfg = parseGatewayConfig({
    defaultModel: { provider: 'amiko', model: 'deepseek/deepseek-v4.1-flash' },
  });
  assert.deepEqual(cfg.defaultModel, {
    provider: 'amiko',
    model: 'deepseek/deepseek-v4.1-flash',
  });
});

test('parseGatewayConfig carries optional max_tokens', () => {
  const cfg = parseGatewayConfig({
    defaultModel: { provider: 'amiko', model: 'x/y', max_tokens: 16384 },
  });
  assert.deepEqual(cfg.defaultModel, { provider: 'amiko', model: 'x/y', max_tokens: 16384 });
});

test('parseGatewayConfig parses defaultModel.thinking', () => {
  const cfg = parseGatewayConfig({
    defaultModel: { provider: 'amiko', model: 'x/y', thinking: 'medium' },
  });
  assert.deepEqual(cfg.defaultModel, { provider: 'amiko', model: 'x/y', thinking: 'medium' });
});

test('parseGatewayConfig rejects invalid defaultModel.thinking', () => {
  assert.throws(
    () => parseGatewayConfig({ defaultModel: { provider: 'a', model: 'b', thinking: 'ultra' } }),
    /thinking must be one of/,
  );
});

test('parseGatewayConfig rejects defaultModel missing required fields', () => {
  assert.throws(() => parseGatewayConfig({ defaultModel: { provider: 'amiko' } }), /model is required/);
  assert.throws(() => parseGatewayConfig({ defaultModel: { model: 'x/y' } }), /provider is required/);
  assert.throws(() => parseGatewayConfig({ defaultModel: 'nope' }), /must be an object/);
  assert.throws(
    () => parseGatewayConfig({ defaultModel: { provider: 'a', model: 'b', max_tokens: -1 } }),
    /max_tokens must be a positive integer/,
  );
});
