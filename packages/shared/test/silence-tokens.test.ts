import assert from 'node:assert/strict';
import test from 'node:test';

import { stripSilenceTokens } from '../src/silence-tokens.js';

test('passes normal text through unchanged', () => {
  const r = stripSilenceTokens("hey, what's up");
  assert.equal(r.text, "hey, what's up");
  assert.equal(r.hadToken, false);
  assert.equal(r.isSilent, false);
});

test('detects a bare <NO_REPLY> token as silence', () => {
  const r = stripSilenceTokens('<NO_REPLY>');
  assert.equal(r.text, '');
  assert.equal(r.hadToken, true);
  assert.equal(r.isSilent, true);
});

test('detects a bare <EMPTY_RESPONSE> legacy token as silence', () => {
  const r = stripSilenceTokens('<EMPTY_RESPONSE>');
  assert.equal(r.isSilent, true);
});

test('treats whitespace around a token as silence', () => {
  const r = stripSilenceTokens('  \n<NO_REPLY>\n  ');
  assert.equal(r.isSilent, true);
});

// Regression: model emitted both a real reply AND the token in one final;
// the literal "<NO_REPLY>" leaked into the destination channel because the
// old equality check (responseText.trim() === NO_REPLY_TAG) missed it.
test('strips the token when mixed with real content (trailing)', () => {
  const r = stripSilenceTokens("ok sounds good.\n<NO_REPLY>");
  assert.equal(r.text, 'ok sounds good.');
  assert.equal(r.hadToken, true);
  assert.equal(r.isSilent, false);
});

test('strips the token when mixed with real content (leading)', () => {
  const r = stripSilenceTokens('<NO_REPLY>\nhey friend');
  assert.equal(r.text, 'hey friend');
  assert.equal(r.hadToken, true);
  assert.equal(r.isSilent, false);
});

test('strips multiple occurrences', () => {
  const r = stripSilenceTokens('<NO_REPLY>hi<NO_REPLY>there<NO_REPLY>');
  assert.equal(r.text, 'hithere');
  assert.equal(r.hadToken, true);
  assert.equal(r.isSilent, false);
});

test('strips both token variants if both appear', () => {
  const r = stripSilenceTokens('<NO_REPLY><EMPTY_RESPONSE>');
  assert.equal(r.text, '');
  assert.equal(r.hadToken, true);
  assert.equal(r.isSilent, true);
});

test('empty input with no token does not count as silent', () => {
  const r = stripSilenceTokens('');
  assert.equal(r.text, '');
  assert.equal(r.hadToken, false);
  assert.equal(r.isSilent, false);
});
