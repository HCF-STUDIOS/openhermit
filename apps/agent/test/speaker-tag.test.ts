import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  stripLeadingSpeakerTag,
  normalizeSpeakerName,
} from '../src/agent-runner/message-utils.js';

const NAMES = ['Matthew Graham', 'Alice', 'Leandro Gavidia'];

// "Jose" with the accent as a single codepoint (NFC) vs e + combining mark (NFD).
const JOSE_NFC = 'Jos\u00e9';
const JOSE_NFD = 'Jose\u0301';

describe('normalizeSpeakerName', () => {
  test('lowercases and trims', () => {
    assert.equal(normalizeSpeakerName('  Alice  '), 'alice');
    assert.equal(normalizeSpeakerName('MiXeD CaSe'), 'mixed case');
  });

  test('collapses NFC and NFD unicode forms to the same value', () => {
    assert.notEqual(JOSE_NFC, JOSE_NFD); // genuinely different strings
    assert.equal(normalizeSpeakerName(JOSE_NFC), normalizeSpeakerName(JOSE_NFD));
  });

  test('blank input normalizes to empty string', () => {
    assert.equal(normalizeSpeakerName(''), '');
    assert.equal(normalizeSpeakerName('   '), '');
    assert.equal(normalizeSpeakerName('\t\n'), '');
  });

  test('leaves an already-normalized name unchanged', () => {
    assert.equal(normalizeSpeakerName('matthew graham'), 'matthew graham');
  });
});

describe('stripLeadingSpeakerTag: matching', () => {
  test('strips a known tag and the following whitespace', () => {
    assert.equal(stripLeadingSpeakerTag('[Matthew Graham] Fair, fair.', NAMES), 'Fair, fair.');
  });

  test('strips regardless of the tag name case', () => {
    assert.equal(stripLeadingSpeakerTag('[alice] hi', NAMES), 'hi');
    assert.equal(stripLeadingSpeakerTag('[ALICE] hi', NAMES), 'hi');
  });

  test('tolerates leading and inner whitespace around the tag', () => {
    assert.equal(stripLeadingSpeakerTag('  [alice]   hello', NAMES), 'hello');
  });

  test('strips a tag followed by a colon', () => {
    assert.equal(stripLeadingSpeakerTag('[Alice]: hi there', NAMES), 'hi there');
    assert.equal(stripLeadingSpeakerTag('[Alice] : hi there', NAMES), 'hi there');
  });

  test('matches a known name whose stored form differs in case or whitespace', () => {
    assert.equal(stripLeadingSpeakerTag('[alice] hi', ['  ALICE  ']), 'hi');
  });

  test('matches across NFC/NFD unicode forms in both directions', () => {
    assert.equal(stripLeadingSpeakerTag(`[${JOSE_NFC}] hi`, [JOSE_NFD]), 'hi');
    assert.equal(stripLeadingSpeakerTag(`[${JOSE_NFD}] hi`, [JOSE_NFC]), 'hi');
  });

  test('matches a name that contains spaces and punctuation but no brackets', () => {
    assert.equal(stripLeadingSpeakerTag("[O'Brien (work)] hey", ["O'Brien (work)"]), 'hey');
  });

  test('matches a name at the 80-character length cap', () => {
    const name = 'a'.repeat(80);
    assert.equal(stripLeadingSpeakerTag(`[${name}] hi`, [name]), 'hi');
  });

  test('accepts any iterable of known names (Set, generator)', () => {
    assert.equal(stripLeadingSpeakerTag('[Alice] hi', new Set(['Alice'])), 'hi');
    const gen = function* () {
      yield 'Alice';
    };
    assert.equal(stripLeadingSpeakerTag('[Alice] hi', gen()), 'hi');
  });
});

describe('stripLeadingSpeakerTag: left alone', () => {
  test('an unknown bracketed name', () => {
    const input = '[note] remember to follow up';
    assert.equal(stripLeadingSpeakerTag(input, NAMES), input);
  });

  test('a leading markdown link', () => {
    const input = '[Alice](https://example.com) is the link';
    assert.equal(stripLeadingSpeakerTag(input, NAMES), input);
  });

  test('a reply with no leading tag', () => {
    const input = 'Fair point. They have the talent to capitalize.';
    assert.equal(stripLeadingSpeakerTag(input, NAMES), input);
  });

  test('a bracketed name that appears mid-sentence, not at the start', () => {
    const input = 'I think [Alice] said that earlier.';
    assert.equal(stripLeadingSpeakerTag(input, NAMES), input);
  });

  test('no known names supplied', () => {
    assert.equal(stripLeadingSpeakerTag('[Alice] hello', []), '[Alice] hello');
  });

  test('a name longer than the cap is not recognized', () => {
    const name = 'a'.repeat(81);
    assert.equal(stripLeadingSpeakerTag(`[${name}] hi`, [name]), `[${name}] hi`);
  });

  test('a name containing brackets cannot match (regex excludes brackets)', () => {
    const input = '[Bot [v2]] hi';
    assert.equal(stripLeadingSpeakerTag(input, ['Bot [v2]']), input);
  });

  test('a tag spanning a newline is not a single-line tag', () => {
    const input = '[Alice\nbob] hi';
    assert.equal(stripLeadingSpeakerTag(input, ['Alice\nbob']), input);
  });

  test('blank entries in knownNames are ignored and never match a blank tag', () => {
    const known = ['Alice', '   ', 'Bob', '\t\n'];
    assert.equal(stripLeadingSpeakerTag('[   ] text', known), '[   ] text');
    assert.equal(stripLeadingSpeakerTag('[\t] text', known), '[\t] text');
  });
});

describe('stripLeadingSpeakerTag: conservative behavior', () => {
  test('strips only the first tag, leaving a second bracketed token', () => {
    assert.equal(
      stripLeadingSpeakerTag('[Alice] [Matthew Graham] said hi', NAMES),
      '[Matthew Graham] said hi',
    );
  });

  test('keeps the original when stripping would leave nothing (tag-only message)', () => {
    assert.equal(stripLeadingSpeakerTag('[Alice]', NAMES), '[Alice]');
    assert.equal(stripLeadingSpeakerTag('[Alice]:', NAMES), '[Alice]:');
    assert.equal(stripLeadingSpeakerTag('  [Matthew Graham]  ', NAMES), '  [Matthew Graham]  ');
  });

  test('an empty string is returned unchanged', () => {
    assert.equal(stripLeadingSpeakerTag('', NAMES), '');
  });
});
