import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeOutboundText } from '../src/outbound-text.js';

test('passes a normal paragraph reply through unchanged', () => {
  const input = '早安！今天天气不错，记得多喝水，出门带伞哦。';
  assert.equal(sanitizeOutboundText(input), input);
});

test('leaves a genuinely formatted list/paragraph reply untouched', () => {
  const input = '今天的安排：\n- 上午写周报\n- 下午开会\n- 晚上健身\n\n加油！';
  assert.equal(sanitizeOutboundText(input), input);
});

test('reflows MiniMax word-per-line CJK corruption', () => {
  // The real chengkun leak: mid-token \n\n breaks across a CJK reply.
  const corrupted = '现在\n\n是\n\n北京时间\n\n10:21\n\nCST\n\n，早安\n\n已经\n\n发出\n\n去了\n\n哦';
  const out = sanitizeOutboundText(corrupted);
  assert.ok(!out.includes('\n'), `expected reflowed single line, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('北京时间'));
  assert.ok(out.includes('CST'));
});

test('inserts a space only across an ASCII word boundary, never across CJK', () => {
  const corrupted = 'the\n\nquick\n\nbrown\n\nfox\n\njumps\n\nover\n\nlazy\n\ndog';
  assert.equal(sanitizeOutboundText(corrupted), 'the quick brown fox jumps over lazy dog');
});

test('strips balanced and stray reasoning-tag wrappers', () => {
  assert.equal(
    sanitizeOutboundText('<think>let me plan this</think>好的，马上发！'),
    '好的，马上发！',
  );
  assert.equal(sanitizeOutboundText('<reasoning>解释</reasoning>结论'), '结论');
  assert.equal(sanitizeOutboundText('答案</think>'), '答案');
});

test('does not reflow a short multi-line reply below the fragment threshold', () => {
  const input = '好\n的\n收\n到';
  assert.equal(sanitizeOutboundText(input), input);
});

test('collapses runs of 3+ blank lines to a single blank line', () => {
  assert.equal(sanitizeOutboundText('第一段\n\n\n\n第二段'), '第一段\n\n第二段');
});
