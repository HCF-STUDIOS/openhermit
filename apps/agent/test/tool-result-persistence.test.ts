import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

import type { AgentWorkspace } from '../src/core/index.js';
import {
  rehydrateRecentToolResults,
  toolResultPath,
  RECENT_TOOL_RESULT_PREVIEW_CHARS,
  RECENT_TOOL_RESULT_TOTAL_BUDGET_CHARS,
} from '../src/agent-runner/tool-result-persistence.js';

// Minimal workspace stub backed by an in-memory map keyed by relative path.
const makeWorkspace = (files: Record<string, string>): AgentWorkspace =>
  ({
    async readFile(relativePath: string): Promise<string> {
      const content = files[relativePath];
      if (content === undefined) {
        throw new Error(`not found: ${relativePath}`);
      }
      return content;
    },
  } as unknown as AgentWorkspace);

const makeToolResult = (toolCallId: string, text: string): AgentMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'exec',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: Date.now(),
});

const textOf = (message: AgentMessage): string =>
  (message as { content: Array<{ type: string; text?: string }> }).content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('');

test('rehydrateRecentToolResults expands a recent offloaded result from disk', async () => {
  const full = 'A'.repeat(50_000);
  const workspace = makeWorkspace({ [toolResultPath('call-1')]: full });
  const messages = [makeToolResult('call-1', 'small preview (~4.5K on disk)')];

  const { messages: out, protectedIndices } = await rehydrateRecentToolResults(workspace, messages);

  assert.ok(protectedIndices.has(0), 'expanded result should be protected');
  const text = textOf(out[0]!);
  assert.ok(text.length > 10_000, `expected a large preview, got ${text.length}`);
  assert.ok(text.length <= RECENT_TOOL_RESULT_PREVIEW_CHARS + 500, 'bounded by per-result budget');
  assert.ok(text.includes('read_file'), 'keeps a pointer to the full text');
});

test('rehydrateRecentToolResults leaves results with no disk file untouched', async () => {
  const workspace = makeWorkspace({}); // nothing offloaded
  const messages = [makeToolResult('call-1', 'already-small full content')];

  const { messages: out, protectedIndices } = await rehydrateRecentToolResults(workspace, messages);

  assert.equal(protectedIndices.size, 0);
  assert.equal(out, messages, 'returns the same array reference when nothing changed');
  assert.equal(textOf(out[0]!), 'already-small full content');
});

test('rehydrateRecentToolResults preserves non-text items (e.g. images)', async () => {
  const full = 'B'.repeat(50_000);
  const workspace = makeWorkspace({ [toolResultPath('call-1')]: full });
  const withImage: AgentMessage = {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'screenshot',
    content: [
      { type: 'text', text: 'preview' },
      { type: 'image', data: 'base64==', mimeType: 'image/png' } as unknown as { type: 'text'; text: string },
    ],
    isError: false,
    timestamp: Date.now(),
  };

  const { messages: out } = await rehydrateRecentToolResults(workspace, [withImage]);
  const content = (out[0] as { content: Array<{ type: string }> }).content;
  assert.ok(content.some((item) => item.type === 'image'), 'image item retained');
  assert.ok(content.some((item) => item.type === 'text'), 'text item present');
});

test('rehydrateRecentToolResults only expands the newest results within the total budget', async () => {
  // Each result is large on disk; the total budget only affords ~3 expansions.
  const big = 'C'.repeat(50_000);
  const files: Record<string, string> = {};
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 6; i += 1) {
    const id = `call-${i}`;
    files[toolResultPath(id)] = big;
    messages.push(makeToolResult(id, 'small'));
  }
  const workspace = makeWorkspace(files);

  const { protectedIndices } = await rehydrateRecentToolResults(workspace, messages);

  const maxExpandable = Math.ceil(RECENT_TOOL_RESULT_TOTAL_BUDGET_CHARS / RECENT_TOOL_RESULT_PREVIEW_CHARS);
  assert.ok(protectedIndices.size <= maxExpandable + 1,
    `expanded ${protectedIndices.size}, expected ≲ ${maxExpandable}`);
  assert.ok(protectedIndices.size >= 2, 'should expand at least the newest couple');
  // Expansion walks from the tail, so the newest index must be included and the
  // oldest excluded.
  assert.ok(protectedIndices.has(5), 'newest result expanded');
  assert.ok(!protectedIndices.has(0), 'oldest result not expanded');
});
