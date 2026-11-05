import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  estimateEventTokensFromPayloadSize,
  pickRetainBoundaryId,
} from '../src/impl/message-store.js';

// ── estimateEventTokensFromPayloadSize ─────────────────────────────────────

test('ASCII payload bills at ~4 chars/token', () => {
  // 400 ASCII chars => 400 bytes, no CJK => 100 tokens.
  assert.equal(estimateEventTokensFromPayloadSize(400, 400), 100);
});

test('CJK payload bills at ~1 token/char', () => {
  // 100 CJK codepoints: 100 chars, 300 bytes (3 bytes each) => cjk=100, ascii=0.
  assert.equal(estimateEventTokensFromPayloadSize(100, 300), 100);
});

test('mixed payload splits CJK and ASCII', () => {
  // 100 CJK (100 chars / 300 bytes) + 400 ASCII (400 chars / 400 bytes)
  // => chars=500, bytes=700 => cjk=100, ascii=400 => 100 + 100 = 200.
  assert.equal(estimateEventTokensFromPayloadSize(500, 700), 200);
});

test('handles null/garbage sizes without going negative', () => {
  assert.equal(estimateEventTokensFromPayloadSize(0, 0), 0);
  assert.equal(estimateEventTokensFromPayloadSize(-5, -10), 0);
});

// ── pickRetainBoundaryId ───────────────────────────────────────────────────

test('stops at the oldest event that still fits keepRecentTokens', () => {
  // Each row ~1000 ASCII tokens (4000 chars). Newest-first ids 10..1.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: 10 - i,
    payloadChars: 4000,
    payloadBytes: 4000,
  }));
  // keepRecent 2500 tokens => 3 rows (3000 >= 2500) => boundary = id 8.
  assert.equal(pickRetainBoundaryId(rows, 2500), 8);
});

test('returns undefined for non-positive budget or empty input', () => {
  assert.equal(pickRetainBoundaryId([{ id: 1, payloadChars: 10, payloadBytes: 10 }], 0), undefined);
  assert.equal(pickRetainBoundaryId([], 1000), undefined);
});

test('never walks past the oldest row when the budget is never met', () => {
  const rows = [
    { id: 3, payloadChars: 100, payloadBytes: 100 },
    { id: 2, payloadChars: 100, payloadBytes: 100 },
    { id: 1, payloadChars: 100, payloadBytes: 100 },
  ];
  // Total ~75 tokens, budget 10_000 never reached => boundary = oldest (1).
  assert.equal(pickRetainBoundaryId(rows, 10_000), 1);
});

test('regression: tool-heavy tail is NOT undercounted (payload vs content)', () => {
  // Reproduces the production bug. A tool-heavy tail: one small chat message
  // followed by many large tool_result events. The OLD code measured the
  // `content` column, which is null (→ 0 tokens) for tool_result rows, so it
  // kept walking and pinned the boundary at the oldest event. Payload-aware
  // sizing reaches the budget within the large tool results near the tail.
  const toolResult = { payloadChars: 16_000, payloadBytes: 16_000 }; // ~4000 tok each
  const rows = [
    { id: 100, ...toolResult }, // newest
    { id: 99, ...toolResult },
    { id: 98, ...toolResult },
    // ...older history that must NOT be retained verbatim:
    ...Array.from({ length: 50 }, (_, i) => ({ id: 97 - i, ...toolResult })),
  ];
  // keepRecent 32_000 tokens => 8 rows of ~4000 => boundary = id 93, i.e. only
  // the recent tail is kept verbatim, not all 53 events.
  const boundary = pickRetainBoundaryId(rows, 32_000);
  assert.equal(boundary, 93);
  assert.notEqual(boundary, rows[rows.length - 1]!.id); // not pinned at the floor

  // Contrast: the old content-based walk saw 0 tokens for every tool_result and
  // would have run to the oldest row.
  const oldWalkBoundary = (() => {
    let acc = 0;
    let b = rows[0]!.id;
    for (const r of rows) {
      acc += Math.ceil(0 / 4); // content column is null for tool_result
      b = r.id;
      if (acc >= 32_000) break;
    }
    return b;
  })();
  assert.equal(oldWalkBoundary, rows[rows.length - 1]!.id); // pinned at the floor — the bug
});
