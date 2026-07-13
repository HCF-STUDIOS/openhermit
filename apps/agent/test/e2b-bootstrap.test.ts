import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shellQuote, validateStagingCliUrl } from '../src/core/backends/e2b.js';

// ── validateStagingCliUrl ────────────────────────────────────────────────

test('validateStagingCliUrl returns undefined when env is unset', () => {
  assert.equal(validateStagingCliUrl(undefined), undefined);
  assert.equal(validateStagingCliUrl(''), undefined);
});

test('validateStagingCliUrl accepts http and https URLs verbatim', () => {
  const https = 'https://cli.staging.example.com/amiko-1.2.3.tgz';
  const http = 'http://10.0.0.5:4873/amiko.tgz';
  assert.equal(validateStagingCliUrl(https), https);
  assert.equal(validateStagingCliUrl(http), http);
});

test('validateStagingCliUrl rejects non-http(s) protocols', () => {
  assert.equal(validateStagingCliUrl('ftp://example.com/x.tgz'), undefined);
  assert.equal(validateStagingCliUrl('file:///etc/passwd'), undefined);
  assert.equal(validateStagingCliUrl('javascript:alert(1)'), undefined);
});

test('validateStagingCliUrl rejects garbage that is not a URL', () => {
  assert.equal(validateStagingCliUrl('not a url'), undefined);
  assert.equal(validateStagingCliUrl('@@@'), undefined);
});

test('validateStagingCliUrl passes a URL that carries shell metacharacters', () => {
  // The validator only checks the protocol; neutralizing injection is
  // shellQuote's job. A syntactically valid https URL with `;`/quotes must
  // still be accepted so the (quoted) install can proceed.
  const nasty = "https://evil.example.com/x.tgz';rm -rf /;'";
  assert.equal(validateStagingCliUrl(nasty), nasty);
});

// ── shellQuote ───────────────────────────────────────────────────────────

test('shellQuote wraps a plain value in single quotes', () => {
  assert.equal(shellQuote('https://x/y.tgz'), `'https://x/y.tgz'`);
});

test('shellQuote escapes embedded single quotes', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});

test('shellQuote neutralizes a URL that tries to break out of the command', () => {
  const nasty = "https://evil.example.com/x';rm -rf /;'";
  const quoted = shellQuote(nasty);
  // The result is a single quoted token: starts and ends with a quote, and
  // every embedded quote is escaped as '\'' so nothing runs as a command.
  assert.ok(quoted.startsWith("'"));
  assert.ok(quoted.endsWith("'"));
  // Every original single quote is rewritten to the '\'' close-escape-reopen
  // sequence, so the value survives as one literal token with no bare quote
  // that could terminate the string and start a new command.
  assert.equal(quoted, `'https://evil.example.com/x'\\'';rm -rf /;'\\'''`);
});
