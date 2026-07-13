import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseMessageContent,
  isBotMentioned,
  stripMentionPlaceholders,
  chunkText,
  type LarkMention,
} from '../src/parse.js';

describe('parseMessageContent', () => {
  test('text message: unwraps the double-encoded content', () => {
    const p = parseMessageContent('text', JSON.stringify({ text: 'hello world' }));
    assert.equal(p.text, 'hello world');
    assert.equal(p.unsupported, undefined);
  });

  test('post message: flattens title + rich-text runs into lines', () => {
    const content = JSON.stringify({
      title: 'Weekly report',
      content: [
        [{ tag: 'text', text: 'First ' }, { tag: 'a', text: 'link', href: 'https://x.dev' }],
        [{ tag: 'at', user_id: 'ou_1', user_name: 'Alice' }, { tag: 'text', text: ' please review' }],
      ],
    });
    const p = parseMessageContent('post', content);
    assert.equal(p.text, 'Weekly report\nFirst https://x.dev\n@Alice please review');
  });

  test('image message: extracts image_key', () => {
    const p = parseMessageContent('image', JSON.stringify({ image_key: 'img_v3_abc' }));
    assert.equal(p.imageKey, 'img_v3_abc');
    assert.equal(p.text, '');
  });

  test('file message: extracts file_key and file_name', () => {
    const p = parseMessageContent('file', JSON.stringify({ file_key: 'file_v3_x', file_name: 'report.pdf' }));
    assert.equal(p.fileKey, 'file_v3_x');
    assert.equal(p.fileName, 'report.pdf');
  });

  test('audio message: extracts file_key (delivered as a file attachment)', () => {
    const p = parseMessageContent('audio', JSON.stringify({ file_key: 'file_v3_a' }));
    assert.equal(p.fileKey, 'file_v3_a');
  });

  test('sticker: flagged unsupported', () => {
    const p = parseMessageContent('sticker', JSON.stringify({ file_key: 'sticker_x' }));
    assert.equal(p.unsupported, true);
  });

  test('malformed content JSON: flagged unsupported, does not throw', () => {
    const p = parseMessageContent('text', 'not-json');
    assert.equal(p.unsupported, true);
  });
});

describe('isBotMentioned', () => {
  const mentions: LarkMention[] = [
    { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Hermit' },
    { key: '@_user_2', id: { open_id: 'ou_alice' }, name: 'Alice' },
  ];

  test('p2p always counts as mentioned', () => {
    assert.equal(isBotMentioned('p2p', undefined, 'ou_bot'), true);
  });

  test('group with bot in mentions', () => {
    assert.equal(isBotMentioned('group', mentions, 'ou_bot'), true);
  });

  test('group without bot in mentions', () => {
    assert.equal(isBotMentioned('group', [mentions[1]!], 'ou_bot'), false);
  });

  test('group with no mentions at all', () => {
    assert.equal(isBotMentioned('group', undefined, 'ou_bot'), false);
  });

  test('unknown bot open_id never matches', () => {
    assert.equal(isBotMentioned('group', mentions, undefined), false);
  });
});

describe('stripMentionPlaceholders', () => {
  const mentions: LarkMention[] = [
    { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Hermit' },
    { key: '@_user_2', id: { open_id: 'ou_alice' }, name: 'Alice' },
  ];

  test('removes the bot mention, keeps other users as @Name', () => {
    const out = stripMentionPlaceholders('@_user_1 ping @_user_2 about the doc', mentions, 'ou_bot');
    assert.equal(out, 'ping @Alice about the doc');
  });

  test('no mentions: trims and passes through', () => {
    assert.equal(stripMentionPlaceholders('  hello  ', undefined, 'ou_bot'), 'hello');
  });

  test('mention without a name falls back to @user', () => {
    const out = stripMentionPlaceholders('@_user_9 hi', [{ key: '@_user_9', id: { open_id: 'ou_z' } }], 'ou_bot');
    assert.equal(out, '@user hi');
  });
});

describe('chunkText', () => {
  test('short text is one chunk', () => {
    assert.deepEqual(chunkText('hi'), ['hi']);
  });

  test('empty text yields no chunks', () => {
    assert.deepEqual(chunkText('   '), []);
  });

  test('long text splits on newline boundaries under the cap', () => {
    const para = 'x'.repeat(1500);
    const text = [para, para, para].join('\n');
    const chunks = chunkText(text, 2000);
    assert.equal(chunks.length, 3);
    for (const c of chunks) assert.ok(c.length <= 2000);
    assert.equal(chunks.join(''), para + para + para);
  });

  test('unbroken text hard-splits at the cap', () => {
    const chunks = chunkText('y'.repeat(4500), 2000);
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join('').length, 4500);
  });
});
