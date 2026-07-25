import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserFacingModelError,
  classifyModelError,
  detectUserLanguage,
} from '../src/agent-runner/user-facing-error.js';

// ── classifyModelError ─────────────────────────────────────────────────

test('classifies the OpenRouter key-limit 403 as quota, not auth', () => {
  assert.equal(
    classifyModelError(
      '403 Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/abc123',
    ),
    'quota',
  );
});

test('classifies insufficient credits and 402 as quota', () => {
  assert.equal(classifyModelError('402 Payment Required'), 'quota');
  assert.equal(classifyModelError('Insufficient credits to complete request'), 'quota');
});

test('classifies 429 and rate limits', () => {
  assert.equal(classifyModelError('429 Too Many Requests'), 'rate_limit');
  assert.equal(classifyModelError('rate-limited, retry after 30s'), 'rate_limit');
});

test('classifies auth failures', () => {
  assert.equal(classifyModelError('401 Unauthorized'), 'auth');
  assert.equal(classifyModelError('Invalid API key provided'), 'auth');
});

test('classifies context overflow before quota-ish words', () => {
  assert.equal(
    classifyModelError('This model\'s maximum context length is 128000 tokens'),
    'context_too_long',
  );
  assert.equal(classifyModelError('prompt is too long: 210000 tokens'), 'context_too_long');
});

test('classifies provider outages as unavailable', () => {
  assert.equal(classifyModelError('502 Bad Gateway'), 'unavailable');
  assert.equal(classifyModelError('Request timed out'), 'unavailable');
  assert.equal(classifyModelError('upstream overloaded'), 'unavailable');
});

test('falls back to generic for unknown errors', () => {
  assert.equal(classifyModelError('Model returned an error.'), 'generic');
});

// ── detectUserLanguage ─────────────────────────────────────────────────

test('any Han character marks the message as Chinese', () => {
  assert.equal(detectUserLanguage('帮我总结一下'), 'zh');
  // Platform prompt-injection appends English boilerplate longer than the
  // user's own text — must still detect Chinese.
  assert.equal(
    detectUserLanguage(
      '用中文回复\n\n[Background knowledge about the twin\'s owner. If it already contains the answer, ANSWER DIRECTLY from it.]',
    ),
    'zh',
  );
});

test('defaults to English otherwise', () => {
  assert.equal(detectUserLanguage('summarize this for me'), 'en');
  assert.equal(detectUserLanguage(''), 'en');
  assert.equal(detectUserLanguage(undefined), 'en');
});

// ── buildUserFacingModelError ──────────────────────────────────────────

test('quota error for a Chinese user is a Chinese notice with no provider internals', () => {
  const raw =
    '403 Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/abc';
  const msg = buildUserFacingModelError(raw, '杨磊哥，你给我回复的用中文，不要用英文');
  assert.match(msg, /额度/);
  assert.doesNotMatch(msg, /openrouter|403|Key limit/i);
});

test('same error for an English user is the English notice', () => {
  const msg = buildUserFacingModelError('403 Key limit exceeded (total limit)', 'hello there');
  assert.match(msg, /credits/);
  assert.doesNotMatch(msg, /openrouter|403/i);
});

test('missing trigger text falls back to English', () => {
  const msg = buildUserFacingModelError('Model returned an error.', undefined);
  assert.match(msg, /technical problem/);
});
