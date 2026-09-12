import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeOutboundText } from '../src/sanitize.js';

test('reflows English word-per-line corruption into one readable line', () => {
  const corrupted =
    'The user is\n\nsaying\n\nin\n\na\n\nvoice\n\nmessage\n\nthat\n\neverything\n\nI sent\n\nwas\n\nin\n\nEnglish';
  const out = sanitizeOutboundText(corrupted);
  assert.equal(out, 'The user is saying in a voice message that everything I sent was in English');
});

test('reflows CJK word-per-line corruption with no inserted spaces', () => {
  const corrupted =
    '收到\n！咱们就讲\n中文\n我是小北\n，你的\nAI 助手\n。有什么我\n可以帮你\n搞定的吗\n？尽管说';
  const out = sanitizeOutboundText(corrupted);
  assert.equal(out, '收到！咱们就讲中文我是小北，你的AI 助手。有什么我可以帮你搞定的吗？尽管说');
});

test('leaves a normal multi-paragraph reply unchanged', () => {
  const normal =
    '收到，确认三不发。\n\n老弟完全不动，这件事到这里结束。\n\n有需要随时喊我。';
  assert.equal(sanitizeOutboundText(normal), normal);
});

test('leaves a bullet / numbered list unchanged', () => {
  const list =
    '当前状态：\n- ✅ 已派单\n- ✅ 已确认\n- ❌ 未发圈\n\n1. 第一步\n2. 第二步\n3. 第三步\n4. 第四步';
  assert.equal(sanitizeOutboundText(list), list);
});

test('does not flatten a short poem / quatrain (below the fragment threshold)', () => {
  const poem = '床前明月光\n疑是地上霜\n举头望明月\n低头思故乡';
  assert.equal(sanitizeOutboundText(poem), poem);
});

test('strips leaked reasoning-tag wrappers', () => {
  assert.equal(
    sanitizeOutboundText('<think>let me reconsider</think>你好，我是小北。'),
    '你好，我是小北。',
  );
  assert.equal(
    sanitizeOutboundText('好的。</think>'),
    '好的。',
  );
});

test('collapses excessive blank lines and trims', () => {
  assert.equal(sanitizeOutboundText('第一段\n\n\n\n第二段\n\n'), '第一段\n\n第二段');
});
