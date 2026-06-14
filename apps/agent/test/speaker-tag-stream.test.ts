import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  stripLeadingSpeakerTag,
  newSpeakerTagStream,
  pushSpeakerTagDelta,
  flushSpeakerTagStream,
} from '../src/agent-runner/message-utils.js';

const NAMES = ['Matthew Graham', 'Alice', 'Leandro Gavidia'];

// Run one text block through the guard (text_start -> deltas -> text_end) and
// return the concatenation of everything emitted.
const runStream = (chunks: string[], names: Iterable<string> = NAMES): string => {
  const state = newSpeakerTagStream();
  let out = '';
  for (const chunk of chunks) out += pushSpeakerTagDelta(state, chunk, names);
  out += flushSpeakerTagStream(state, names);
  return out;
};

// Every fragmentation of `full`: one delta, char-by-char, and every two-way split.
const fragmentations = (full: string): string[][] => {
  const variants: string[][] = [[full], [...full]];
  for (let i = 1; i < full.length; i += 1) {
    variants.push([full.slice(0, i), full.slice(i)]);
  }
  return variants;
};

describe('speaker-tag stream: emit semantics', () => {
  test('buffers a partial tag and emits nothing until it resolves', () => {
    const state = newSpeakerTagStream();
    assert.equal(pushSpeakerTagDelta(state, '[Ali', NAMES), '');
    assert.equal(pushSpeakerTagDelta(state, 'ce', NAMES), '');
    assert.equal(pushSpeakerTagDelta(state, '] hello', NAMES), 'hello');
  });

  test('passes non-tag text through immediately, with no buffering', () => {
    const state = newSpeakerTagStream();
    assert.equal(pushSpeakerTagDelta(state, 'Fair point.', NAMES), 'Fair point.');
    assert.equal(pushSpeakerTagDelta(state, ' Nice.', NAMES), ' Nice.');
  });

  test('once resolved, later deltas pass through verbatim', () => {
    const state = newSpeakerTagStream();
    pushSpeakerTagDelta(state, '[Alice] ', NAMES);
    assert.equal(pushSpeakerTagDelta(state, '[not a tag] more', NAMES), '[not a tag] more');
  });

  test('an empty delta is absorbed while buffering and passes through once resolved', () => {
    const buffering = newSpeakerTagStream();
    assert.equal(pushSpeakerTagDelta(buffering, '[Ali', NAMES), '');
    assert.equal(pushSpeakerTagDelta(buffering, '', NAMES), '');
    assert.equal(pushSpeakerTagDelta(buffering, 'ce] hi', NAMES), 'hi');

    const resolved = newSpeakerTagStream();
    assert.equal(pushSpeakerTagDelta(resolved, 'hello', NAMES), 'hello');
    assert.equal(pushSpeakerTagDelta(resolved, '', NAMES), '');
  });

  test('an unclosed bracket followed by a newline emits the whole buffer', () => {
    const state = newSpeakerTagStream();
    assert.equal(pushSpeakerTagDelta(state, '[Alice', NAMES), '');
    assert.equal(pushSpeakerTagDelta(state, '\nmore text', NAMES), '[Alice\nmore text');
  });

  test('never leaks the tag in any emitted chunk', () => {
    const state = newSpeakerTagStream();
    const emitted: string[] = [];
    for (const ch of [...'[Matthew Graham] hello world']) {
      const out = pushSpeakerTagDelta(state, ch, NAMES);
      if (out) emitted.push(out);
    }
    emitted.push(flushSpeakerTagStream(state, NAMES));
    const firstReal = emitted.find((e) => e.trim().length > 0);
    assert.ok(firstReal, 'expected at least one non-empty chunk to be emitted');
    assert.ok(!firstReal.startsWith('['), `leaked a tag: ${JSON.stringify(firstReal)}`);
    assert.equal(emitted.join(''), 'hello world');
  });
});

describe('speaker-tag stream: flush', () => {
  test('flush is idempotent', () => {
    const state = newSpeakerTagStream();
    pushSpeakerTagDelta(state, 'hello', NAMES);
    assert.equal(flushSpeakerTagStream(state, NAMES), '');
    assert.equal(flushSpeakerTagStream(state, NAMES), '');
  });

  test('flush on an untouched stream emits nothing', () => {
    assert.equal(flushSpeakerTagStream(newSpeakerTagStream(), NAMES), '');
  });

  test('a tag-only block flushes back to the original (never empty)', () => {
    assert.equal(runStream(['[Alice]']), '[Alice]');
    assert.equal(runStream(['[Alice', ']']), '[Alice]');
  });

  test('a known tag that never gets content is preserved by the backstop flush', () => {
    // Models the message_end backstop: deltas arrive but no text_end / content.
    const state = newSpeakerTagStream();
    assert.equal(pushSpeakerTagDelta(state, '[Alice]', NAMES), '');
    assert.equal(flushSpeakerTagStream(state, NAMES), '[Alice]');
  });
});

describe('speaker-tag stream: targeted cases', () => {
  test('strips a known tag split across deltas', () => {
    assert.equal(runStream(['[Matthew', ' Graham]', ' Fair,', ' fair.']), 'Fair, fair.');
  });

  test('leaves an unknown tag intact', () => {
    assert.equal(runStream(['[note]', ' remember this']), '[note] remember this');
  });

  test('preserves a leading markdown link', () => {
    assert.equal(
      runStream(['[Alice]', '(https://x.com)', ' see this']),
      '[Alice](https://x.com) see this',
    );
  });

  test('resets cleanly per block (a fresh stream does not inherit state)', () => {
    assert.equal(runStream(['[Alice] one']), 'one');
    assert.equal(runStream(['[Matthew Graham] two']), 'two');
  });
});

describe('speaker-tag stream: equivalence to the one-shot strip', () => {
  const cases = [
    '[Matthew Graham] hey there',
    'no tag here at all',
    '[note] keep me',
    '[Alice]: with a colon',
    '[Leandro Gavidia] multi\nline reply',
    '[Alice]',
    '[Alice](https://x.com) link',
    '  [alice]  spaced reply',
    `[${'x'.repeat(100)} never closes`,
    '[Alice\nbob] newline inside the tag',
    '',
    '[',
    'plain reply',
  ];

  for (const full of cases) {
    test(`stream output equals stripLeadingSpeakerTag for ${JSON.stringify(full)}`, () => {
      const expected = stripLeadingSpeakerTag(full, NAMES);
      for (const chunks of fragmentations(full)) {
        assert.equal(
          runStream(chunks),
          expected,
          `fragmentation ${JSON.stringify(chunks)} diverged`,
        );
      }
    });
  }
});
