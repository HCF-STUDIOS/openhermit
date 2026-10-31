import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';

import {
  classifyToolCallRisk,
  recoverInterruptedToolCalls,
} from '../src/agent-runner/tool-call-recovery.js';

const user = (text: string): UserMessage => ({ role: 'user', content: text, timestamp: 1 });

const assistantWithCalls = (
  calls: { id: string; name: string }[],
  text?: string,
): AssistantMessage => ({
  role: 'assistant',
  content: [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...calls.map((c) => ({ type: 'toolCall' as const, id: c.id, name: c.name, arguments: {} })),
  ],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'toolUse',
  timestamp: 2,
});

const result = (id: string, name: string): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  timestamp: 3,
});

const isResult = (m: AgentMessage): m is ToolResultMessage =>
  (m as ToolResultMessage).role === 'toolResult';

describe('classifyToolCallRisk', () => {
  test('known read-only tools are TOOL_NOT_STARTED', () => {
    for (const name of ['file_read', 'attachment_fetch', 'web_search', 'memory_recall', 'session_list']) {
      assert.equal(classifyToolCallRisk(name), 'TOOL_NOT_STARTED', name);
    }
  });

  test('known mutating tools are TOOL_OUTCOME_UNKNOWN', () => {
    for (const name of ['exec', 'file_write', 'attachment_send', 'schedule_create', 'session_send', 'memory_add']) {
      assert.equal(classifyToolCallRisk(name), 'TOOL_OUTCOME_UNKNOWN', name);
    }
  });

  test('unknown / MCP tools default to the conservative TOOL_OUTCOME_UNKNOWN', () => {
    assert.equal(classifyToolCallRisk('some_mcp__do_thing'), 'TOOL_OUTCOME_UNKNOWN');
    assert.equal(classifyToolCallRisk('totally_unknown'), 'TOOL_OUTCOME_UNKNOWN');
  });

  test('read-only name shapes are graded safe without an explicit entry', () => {
    assert.equal(classifyToolCallRisk('widget_list'), 'TOOL_NOT_STARTED');
    assert.equal(classifyToolCallRisk('get_widget'), 'TOOL_NOT_STARTED');
    assert.equal(classifyToolCallRisk('thing_status'), 'TOOL_NOT_STARTED');
  });
});

describe('recoverInterruptedToolCalls', () => {
  test('returns the same reference when every call is answered', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistantWithCalls([{ id: 'a', name: 'file_read' }]),
      result('a', 'file_read'),
    ];
    assert.equal(recoverInterruptedToolCalls(messages), messages);
  });

  test('synthesizes an error result for a fully interrupted call', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistantWithCalls([{ id: 'a', name: 'exec' }]),
      user('you there?'),
    ];
    const out = recoverInterruptedToolCalls(messages);
    assert.equal(out.length, 4);
    const synth = out[2] as ToolResultMessage;
    assert.equal(synth.role, 'toolResult');
    assert.equal(synth.toolCallId, 'a');
    assert.equal(synth.isError, true);
    assert.match((synth.content[0] as { text: string }).text, /TOOL_OUTCOME_UNKNOWN/);
    // Inserted immediately after its owning assistant, before the next user turn.
    assert.equal((out[3] as UserMessage).role, 'user');
  });

  test('synthesizes only the missing result in a partially interrupted parallel turn', () => {
    const messages: AgentMessage[] = [
      assistantWithCalls([
        { id: 'a', name: 'file_read' },
        { id: 'b', name: 'attachment_send' },
      ]),
      result('a', 'file_read'),
    ];
    const out = recoverInterruptedToolCalls(messages);
    const synths = out.filter(isResult).filter((r) => (r.details as { recovery?: string } | undefined)?.recovery === 'interrupted-tool-call');
    assert.equal(synths.length, 1);
    assert.equal(synths[0]!.toolCallId, 'b');
    // All results for the assistant remain contiguous right after it.
    assert.equal(out[0]!.role, 'assistant');
    assert.ok(isResult(out[1]!));
    assert.ok(isResult(out[2]!));
    assert.notEqual(out.findIndex((m) => m.role === 'assistant' || m.role === 'user'), 3);
  });

  test('grades a read-only interrupted call as safe to retry', () => {
    const messages: AgentMessage[] = [
      assistantWithCalls([{ id: 'r', name: 'file_read' }]),
    ];
    const out = recoverInterruptedToolCalls(messages);
    const synth = out[1] as ToolResultMessage;
    assert.match((synth.content[0] as { text: string }).text, /TOOL_NOT_STARTED/);
    assert.match((synth.content[0] as { text: string }).text, /safe/i);
  });

  test('handles multiple interrupted turns across the transcript', () => {
    const messages: AgentMessage[] = [
      assistantWithCalls([{ id: 'a', name: 'exec' }]),
      user('next'),
      assistantWithCalls([{ id: 'b', name: 'file_write' }]),
    ];
    const out = recoverInterruptedToolCalls(messages);
    const synths = out.filter(isResult);
    assert.deepEqual(synths.map((r) => r.toolCallId).sort(), ['a', 'b']);
  });

  test('leaves a transcript with no tool calls untouched', () => {
    const messages: AgentMessage[] = [user('hi'), { ...assistantWithCalls([]), content: [{ type: 'text', text: 'hello' }], stopReason: 'stop' }];
    assert.equal(recoverInterruptedToolCalls(messages), messages);
  });
});
