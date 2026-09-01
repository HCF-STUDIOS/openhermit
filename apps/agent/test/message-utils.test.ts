import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

import {
  stripReasoningTags,
  extractAssistantText,
  newReasoningTagStream,
  reasoningStreamUnclosedTag,
  pushReasoningTagDelta,
  flushReasoningTagStream,
  normalizeMessageAlternation,
  downgradeImagesForTextModel,
} from '../src/agent-runner/message-utils.js';

const assistantMsg = (text: string): AssistantMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 1 }) as unknown as AssistantMessage;

const runReasoningStream = (chunks: string[]): string => {
  const state = newReasoningTagStream();
  let out = '';
  for (const chunk of chunks) out += pushReasoningTagDelta(state, chunk);
  out += flushReasoningTagStream(state);
  return out;
};

test('stripReasoningTags removes a leading think block, keeps the answer', () => {
  assert.equal(
    stripReasoningTags('<think>let me reason about this</think>Hello there'),
    'Hello there',
  );
});

test('stripReasoningTags removes thinking/reasoning variants anywhere', () => {
  assert.equal(stripReasoningTags('A<thinking>hmm</thinking>B'), 'AB');
  assert.equal(stripReasoningTags('<reasoning>x</reasoning>done'), 'done');
});

test('stripReasoningTags is a no-op when there are no tags', () => {
  assert.equal(stripReasoningTags('just a normal reply'), 'just a normal reply');
});

test('stripReasoningTags returns pure-reasoning interiors without wrappers', () => {
  assert.equal(
    stripReasoningTags('<think>only reasoning, no answer</think>'),
    'only reasoning, no answer',
  );
  assert.equal(
    stripReasoningTags('<thinking>a</thinking><reasoning>b</reasoning>'),
    'a\n\nb',
  );
});

test('stripReasoningTags strips multiline think blocks', () => {
  assert.equal(
    stripReasoningTags('<think>\nline1\nline2\n</think>\n\nAnswer'),
    'Answer',
  );
});

test('stripReasoningTags peels nested same-name tags without residual close markup', () => {
  assert.equal(
    stripReasoningTags('<think>outer <think>inner</think> still</think>Answer'),
    'Answer',
  );
});

test('stripReasoningTags cuts an unclosed tag to end-of-text, keeping preceding text', () => {
  assert.equal(
    stripReasoningTags('Real answer.<think>runaway reasoning that never closes'),
    'Real answer.',
  );
});

test('stripReasoningTags returns interiors for a bare unclosed reasoning-only block', () => {
  // No tool calls / structured thinking context: do not blank the only content.
  assert.equal(
    stripReasoningTags('<think>partial answer continues'),
    'partial answer continues',
  );
});

test('stripReasoningTags cuts leading reasoning through an orphan close tag', () => {
  // The opener lived in the previous tool-call message (cut there as
  // unclosed); this block starts mid-reasoning and closes it before the reply.
  assert.equal(
    stripReasoningTags('仓位还在（20 DOGE）。止损问题是参数格式</think>试试去掉 stopPx 只平仓：'),
    '试试去掉 stopPx 只平仓：',
  );
});

test('stripReasoningTags orphan-close cut is lazy: later literal close stays prose', () => {
  assert.equal(
    stripReasoningTags('mid-span</think>Reply that mentions a literal </think> tag'),
    'Reply that mentions a literal </think> tag',
  );
});

test('stripReasoningTags with allowEmpty blanks an unclosed reasoning-only block', () => {
  // The minimax-m2.7 shape: text is a lone unterminated <think> body and the
  // message continues with tool calls — nothing should reach the user.
  assert.equal(
    stripReasoningTags('<think>Still getting "NotEnoughPositionToClose". Let me try', {
      allowEmpty: true,
    }),
    '',
  );
});

test('extractAssistantText strips inline reasoning from a text block', () => {
  const msg = assistantMsg('<think>plan</think>Final answer.');
  assert.equal(extractAssistantText(msg), 'Final answer.');
});

test('extractAssistantText blanks an unclosed reasoning-only block on a tool-call turn', () => {
  // minimax-m2.7 (thinking=high) opens <think> in the text, never closes it,
  // and proceeds to tool calls — the reasoning must not become user text.
  const msg = {
    role: 'assistant',
    content: [
      { type: 'text', text: '<think>The position clearly exists. Let me try the amend endpoint' },
      { type: 'toolCall', id: 'call-1', name: 'exec', arguments: {} },
    ],
    timestamp: 1,
  } as unknown as AssistantMessage;
  assert.equal(extractAssistantText(msg), '');
});

test('extractAssistantText blanks unclosed reasoning when a structured thinking block exists', () => {
  const msg = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'structured reasoning' },
      { type: 'text', text: '<think>duplicated inline reasoning, unterminated' },
    ],
    timestamp: 1,
  } as unknown as AssistantMessage;
  assert.equal(extractAssistantText(msg), '');
});

test('extractAssistantText strips across multiple text parts', () => {
  const msg = {
    role: 'assistant',
    content: [
      { type: 'text', text: '<think>step1</think>Part A' },
      { type: 'text', text: '<thinking>step2</thinking>Part B' },
    ],
    timestamp: 1,
  } as unknown as AssistantMessage;
  assert.equal(extractAssistantText(msg), 'Part A\n\nPart B');
});

describe('reasoning tag stream', () => {
  test('suppresses a think block streamed across chunks, keeps the answer', () => {
    assert.equal(
      runReasoningStream(['<think>', 'let me reason', '</think>', 'Hello there']),
      'Hello there',
    );
  });

  test('buffers a partial open tag until it resolves', () => {
    const state = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(state, '<thi'), '');
    assert.equal(pushReasoningTagDelta(state, 'nk>secret'), '');
    assert.equal(pushReasoningTagDelta(state, '</think>Visible'), 'Visible');
    assert.equal(flushReasoningTagStream(state), '');
  });

  test('passes non-tag text through immediately', () => {
    const state = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(state, 'Fair point.'), 'Fair point.');
    assert.equal(pushReasoningTagDelta(state, ' Nice.'), ' Nice.');
  });

  test('emits a non-reasoning angle bracket without stalling', () => {
    assert.equal(runReasoningStream(['a < b and <div>ok</div>']), 'a < b and <div>ok</div>');
  });

  test('flush of an unclosed tag drops the suppressed reasoning', () => {
    const state = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(state, '<think>still going'), '');
    assert.equal(flushReasoningTagStream(state), '');
  });

  test('flush keeps text emitted before an unclosed tag', () => {
    const state = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(state, 'Answer first. <think>then reasoning'), 'Answer first. ');
    assert.equal(flushReasoningTagStream(state), '');
  });

  test('handles thinking and reasoning variants mid-stream', () => {
    assert.equal(runReasoningStream(['A', '<thinking>hmm</thinking>', 'B']), 'AB');
    assert.equal(runReasoningStream(['<reasoning>x</reasoning>', 'done']), 'done');
  });

  test('char-by-char fragmentation still strips a full block', () => {
    const full = '<think>plan</think>Final.';
    assert.equal(runReasoningStream([...full]), 'Final.');
  });

  test('nested same-name tags stay suppressed until the outermost close', () => {
    const full = '<think>outer <think>inner</think> still</think>Answer';
    assert.equal(runReasoningStream([full]), 'Answer');
    assert.equal(runReasoningStream([...full]), 'Answer');
    assert.equal(
      runReasoningStream(['<think>outer <thi', 'nk>inner</think> still</thi', 'nk>Answer']),
      'Answer',
    );
  });

  test('flush of an unclosed nested tag drops the full remainder', () => {
    const state = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(state, '<think>outer <think>inner'), '');
    assert.equal(flushReasoningTagStream(state), '');
  });

  test('carry-over: next message stays suppressed until the spanning close arrives', () => {
    // Message N ends unclosed; its tag name is read before flush and threaded
    // into message N+1's stream, which then suppresses the continuation.
    const first = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(first, '<think>spanning reasoning'), '');
    const carry = reasoningStreamUnclosedTag(first);
    assert.equal(carry, 'think');
    assert.equal(flushReasoningTagStream(first), '');

    const second = newReasoningTagStream(carry);
    assert.equal(pushReasoningTagDelta(second, 'still reasoning</think>Real reply'), 'Real reply');
    assert.equal(flushReasoningTagStream(second), '');
  });

  test('carry-over with no close drops the stream but never the batch text', () => {
    const state = newReasoningTagStream('think');
    assert.equal(pushReasoningTagDelta(state, 'pure reply that never closes'), '');
    assert.equal(flushReasoningTagStream(state), '');
    // The authoritative text_final comes from stripReasoningTags, which leaves
    // untagged text alone — nothing is lost, only the typing effect.
    assert.equal(stripReasoningTags('pure reply that never closes'), 'pure reply that never closes');
  });
});

const user = (text: string): UserMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as UserMessage;
const assistantText = (text: string): AssistantMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'minimax',
    model: 'MiniMax-M3',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1,
  }) as AssistantMessage;
const assistantCall = (id: string, name: string): AssistantMessage =>
  ({
    ...assistantText(''),
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    stopReason: 'toolUse',
  }) as AssistantMessage;
const toolResult = (id: string, name: string): ToolResultMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 1,
  }) as ToolResultMessage;

const roles = (messages: AgentMessage[]): string =>
  messages.map((m) => (m as { role: string }).role[0]!.toUpperCase()).join('');

describe('normalizeMessageAlternation', () => {
  test('collapses the trailing run of consecutive user turns (the wedge)', () => {
    // Mirrors the production wedge: a session where every failed turn left an
    // orphan user message behind, producing 7 users in a row that MiniMax 400s.
    const wedged: AgentMessage[] = [
      assistantText('reply'),
      user('最近一个文档发我'),
      user('hi'),
      user('hi'),
      user('hi'),
      user('hello'),
      user('hi'),
    ] as AgentMessage[];
    const out = normalizeMessageAlternation(wedged);
    assert.equal(roles(out), 'AU');
    const merged = out[1] as UserMessage;
    assert.ok(Array.isArray(merged.content));
    // Six user turns coalesce into one text block joined by blank lines.
    const text = (merged.content as { type: string; text: string }[])
      .map((b) => b.text)
      .join('');
    assert.match(text, /最近一个文档发我\n\nhi\n\nhi\n\nhi\n\nhello\n\nhi/);
  });

  test('merges assistant(toolCall) + assistant(text) so the toolResult stays adjacent', () => {
    // assistant(toolCall) → assistant(text) → toolResult is the other observed
    // corruption; merging the two assistants restores a valid tool pairing.
    const broken: AgentMessage[] = [
      assistantCall('call_1', 'attachment_send'),
      assistantText('发你 👇'),
      toolResult('call_1', 'attachment_send'),
    ] as AgentMessage[];
    const out = normalizeMessageAlternation(broken);
    assert.equal(roles(out), 'AT');
    const merged = out[0] as AssistantMessage;
    const types = merged.content.map((b) => b.type);
    assert.deepEqual(types, ['toolCall', 'text']);
    // Still a tool-use turn so the following toolResult is valid.
    assert.equal(merged.stopReason, 'toolUse');
  });

  test('leaves consecutive toolResults (parallel results) untouched', () => {
    const parallel: AgentMessage[] = [
      assistantCall('call_a', 'x'),
      toolResult('call_a', 'x'),
      toolResult('call_b', 'y'),
      assistantText('done'),
    ] as AgentMessage[];
    const out = normalizeMessageAlternation(parallel);
    // toolResults are NOT merged; nothing collapses here.
    assert.equal(roles(out), 'ATTA');
    assert.equal(out.length, 4);
  });

  test('is a no-op on an already-alternating transcript', () => {
    const clean: AgentMessage[] = [
      user('hi'),
      assistantText('hello'),
      user('bye'),
      assistantText('cya'),
    ] as AgentMessage[];
    const out = normalizeMessageAlternation(clean);
    assert.equal(roles(out), 'UAUA');
    assert.equal(out.length, 4);
  });

  test('does not mutate the input messages', () => {
    const input: AgentMessage[] = [user('a'), user('b')] as AgentMessage[];
    const before = JSON.stringify(input);
    normalizeMessageAlternation(input);
    assert.equal(JSON.stringify(input), before);
  });
});

const toolResultWithImage = (id: string, name: string): ToolResultMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [
      { type: 'text', text: 'fetched attachment' },
      { type: 'image', data: '/9j/4AAQSkZJRgABAQ==', mimeType: 'image/jpeg' },
    ],
    isError: false,
    timestamp: 1,
  }) as ToolResultMessage;

const userWithImage = (text: string): UserMessage =>
  ({
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ],
    timestamp: 1,
  }) as UserMessage;

describe('downgradeImagesForTextModel', () => {
  test('replaces an image block in a tool result with a text placeholder for a text-only model', () => {
    // Mirrors the production wedge: attachment_fetch inlined a JPEG image block
    // that text-only MiniMax-M3 rejects with `invalid params (2013)`.
    const messages: AgentMessage[] = [
      user('给我看那张图'),
      toolResultWithImage('call_1', 'attachment_fetch'),
    ] as AgentMessage[];
    const out = downgradeImagesForTextModel(messages, false);

    const tr = out[1] as ToolResultMessage;
    const types = tr.content.map((b) => b.type);
    assert.deepEqual(types, ['text', 'text']);
    // Original mime surfaces in the placeholder so the model knows what was there.
    const placeholder = (tr.content[1] as { text: string }).text;
    assert.match(placeholder, /image omitted \(image\/jpeg\)/);
    assert.match(placeholder, /text-only/);
    // No base64 payload survives into the wire message.
    assert.ok(!JSON.stringify(out).includes('/9j/4AAQSkZJRg'));
  });

  test('downgrades image blocks in an array-form user message too', () => {
    const messages: AgentMessage[] = [userWithImage('hi')] as AgentMessage[];
    const out = downgradeImagesForTextModel(messages, false);
    const u = out[0] as UserMessage;
    const types = (u.content as { type: string }[]).map((b) => b.type);
    assert.deepEqual(types, ['text', 'text']);
    assert.ok(!JSON.stringify(out).includes('iVBORw0KGgo'));
  });

  test('is a no-op (same reference) when the model supports image input', () => {
    const messages: AgentMessage[] = [
      toolResultWithImage('call_1', 'attachment_fetch'),
    ] as AgentMessage[];
    const out = downgradeImagesForTextModel(messages, true);
    assert.equal(out, messages);
  });

  test('returns the same reference when there is no image block to downgrade', () => {
    const messages: AgentMessage[] = [
      user('plain text'),
      toolResult('call_1', 'x'),
    ] as AgentMessage[];
    const out = downgradeImagesForTextModel(messages, false);
    assert.equal(out, messages);
  });

  test('leaves a string-content user message untouched', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'plain string', timestamp: 1 } as unknown as UserMessage,
      toolResultWithImage('call_1', 'attachment_fetch'),
    ] as AgentMessage[];
    const out = downgradeImagesForTextModel(messages, false);
    assert.equal((out[0] as UserMessage).content, 'plain string');
    // But the tool-result image is still downgraded.
    const tr = out[1] as ToolResultMessage;
    assert.deepEqual(tr.content.map((b) => b.type), ['text', 'text']);
  });

  test('does not mutate the input messages', () => {
    const input: AgentMessage[] = [toolResultWithImage('call_1', 'attachment_fetch')] as AgentMessage[];
    const before = JSON.stringify(input);
    downgradeImagesForTextModel(input, false);
    assert.equal(JSON.stringify(input), before);
  });
});
