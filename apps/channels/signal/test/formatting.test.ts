import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  markdownToSignalStyled,
  splitMessage,
  formatAgentResponse,
  SIGNAL_MAX_LENGTH,
} from '../src/formatting.js';

test('markdownToSignalStyled preserves Signal-native syntax (bold/italic/strike/code/spoiler)', () => {
  assert.equal(markdownToSignalStyled('**bold**'), '**bold**');
  assert.equal(markdownToSignalStyled('_italic_'), '_italic_');
  assert.equal(markdownToSignalStyled('`code`'), '`code`');
  assert.equal(markdownToSignalStyled('~~strike~~'), '~strike~');
  assert.equal(markdownToSignalStyled('||spoiler||'), '||spoiler||');
});

test('markdownToSignalStyled converts single-* italic to underscore italic', () => {
  assert.equal(markdownToSignalStyled('an *emphasized* word'), 'an _emphasized_ word');
});

test('markdownToSignalStyled flattens headings to bold lines', () => {
  assert.equal(markdownToSignalStyled('# Title\nbody'), '**Title**\nbody');
  assert.equal(markdownToSignalStyled('### Sub'), '**Sub**');
});

test('markdownToSignalStyled converts list markers to bullet glyphs', () => {
  assert.equal(markdownToSignalStyled('- one\n- two'), '• one\n• two');
  assert.equal(markdownToSignalStyled('1. one\n2. two'), '• one\n• two');
});

test('splitMessage returns the input unchanged when under cap', () => {
  assert.deepEqual(splitMessage('short'), ['short']);
});

test('splitMessage splits on paragraph boundary when possible', () => {
  const first = 'A'.repeat(SIGNAL_MAX_LENGTH - 100);
  const second = 'B'.repeat(200);
  const text = `${first}\n\n${second}`;
  assert.ok(text.length > SIGNAL_MAX_LENGTH);
  const chunks = splitMessage(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], first);
  assert.equal(chunks[1], second);
});

test('splitMessage falls back to newline boundary when no paragraph break', () => {
  const line = 'A'.repeat(SIGNAL_MAX_LENGTH - 10);
  const text = `${line}\nnext line that overflows`;
  const chunks = splitMessage(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0]!.length <= SIGNAL_MAX_LENGTH);
});

test('splitMessage hard-splits when no whitespace boundary exists', () => {
  const text = 'X'.repeat(SIGNAL_MAX_LENGTH * 2 + 50);
  const chunks = splitMessage(text);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.length <= SIGNAL_MAX_LENGTH);
  assert.equal(chunks.join(''), text);
});

test('formatAgentResponse converts markdown then chunks', () => {
  const result = formatAgentResponse('# Hello\n\n**world**');
  assert.deepEqual(result, ['**Hello**\n\n**world**']);
});
