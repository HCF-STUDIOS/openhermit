import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveModel } from '../src/agent-runner/model-utils.js';
import type { AgentConfig } from '../src/core/index.js';

const makeConfig = (model: Record<string, unknown>): AgentConfig =>
  ({ model } as unknown as AgentConfig);

describe('resolveModel reasoning derivation', () => {
  test('MiniMax-M3 resolves with reasoning off (its factory suppresses thinking)', () => {
    const resolved = resolveModel(
      makeConfig({ provider: 'minimax', model: 'MiniMax-M3', max_tokens: 131072, thinking: 'medium' }),
    );
    // MiniMax's /anthropic rejects pi-ai's {type:"enabled",...} thinking param
    // with 400 (2013); reasoning:false makes pi-ai emit no thinking param.
    assert.equal(resolved.reasoning, false);
    assert.equal(resolved.api, 'anthropic-messages');
    assert.equal(resolved.id, 'MiniMax-M3');
  });

  test('real Anthropic registry model keeps its reasoning flag (unaffected)', () => {
    const resolved = resolveModel(
      makeConfig({ provider: 'anthropic', model: 'claude-opus-4-5', max_tokens: 8192, thinking: 'high' }),
    );
    assert.equal(resolved.reasoning, true);
  });

  test('synthesized openai-completions model derives reasoning from thinking', () => {
    const resolved = resolveModel(
      makeConfig({ provider: 'some-oai-compat', model: 'thinky-1', api: 'openai-completions', base_url: 'https://example.com/v1', max_tokens: 8192, thinking: 'medium' }),
    );
    assert.equal(resolved.reasoning, true);
  });

  test('synthesized anthropic-compat model never flags reasoning, even with thinking on', () => {
    const resolved = resolveModel(
      makeConfig({ provider: 'custom-anthropic-compat', model: 'some-model', api: 'anthropic-messages', base_url: 'https://example.com/anthropic', max_tokens: 8192, thinking: 'high' }),
    );
    assert.equal(resolved.reasoning, false);
  });
});
