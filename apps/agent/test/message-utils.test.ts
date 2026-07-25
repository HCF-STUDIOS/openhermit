import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AssistantMessage } from '@mariozechner/pi-ai';

import {
  stripReasoningTags,
  extractAssistantText,
  newReasoningTagStream,
  pushReasoningTagDelta,
  flushReasoningTagStream,
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
});
