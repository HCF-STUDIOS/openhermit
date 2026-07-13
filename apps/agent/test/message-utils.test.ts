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

test('stripReasoningTags leaves an unclosed tag as-is', () => {
  const open = '<think>partial answer continues';
  assert.equal(stripReasoningTags(open), open);
});

test('extractAssistantText strips inline reasoning from a text block', () => {
  const msg = assistantMsg('<think>plan</think>Final answer.');
  assert.equal(extractAssistantText(msg), 'Final answer.');
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

  test('flush of an unclosed tag surfaces the remainder (no blanking)', () => {
    const state = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(state, '<think>still going'), '');
    assert.equal(flushReasoningTagStream(state), '<think>still going');
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

  test('flush of an unclosed nested tag surfaces the full remainder', () => {
    const state = newReasoningTagStream();
    assert.equal(pushReasoningTagDelta(state, '<think>outer <think>inner'), '');
    assert.equal(flushReasoningTagStream(state), '<think>outer <think>inner');
  });
});
