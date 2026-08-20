import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractionOutputSchema } from '../src/research/contracts.js';
import {
  EVIDENCE_EXCERPT_MAX_CHARS,
  assignIndependenceClusters,
  contentHash,
  detectContradictions,
  evidenceHash,
  independentClusterCount,
  normalizeWhitespace,
  registrableDomain,
  verifyExcerpt,
} from '../src/research/evidence-ledger.js';

const SNAPSHOT = `ACME Corporation reported total revenue of $4.2 billion for fiscal year 2025,
an increase of 12% over the prior year.   Operating margin was
18.3 percent. The company attributed growth to its cloud division.`;

// ─── Excerpt verification and locators ──────────────────────────────────────

test('verifyExcerpt: whitespace-normalized match produces stable offsets', () => {
  const excerpt = 'total revenue of  $4.2 billion for fiscal   year 2025';
  const v = verifyExcerpt(SNAPSHOT, excerpt);
  assert.equal(v.verified, true);
  assert.ok(v.locator);
  assert.equal(v.locator!.kind, 'web_snapshot');
  const normalizedSnapshot = normalizeWhitespace(SNAPSHOT);
  assert.equal(
    normalizedSnapshot.slice(v.locator!.startChar, v.locator!.endChar),
    v.normalizedExcerpt,
  );
  assert.equal(v.normalizedExcerpt, 'total revenue of $4.2 billion for fiscal year 2025');
});

test('verifyExcerpt: fabricated excerpt is rejected', () => {
  const v = verifyExcerpt(SNAPSHOT, 'revenue of $9.9 trillion for 2031');
  assert.equal(v.verified, false);
  assert.equal(v.locator, undefined);
});

test('verifyExcerpt: case drift tolerated, offsets index real content', () => {
  const v = verifyExcerpt(SNAPSHOT, 'operating margin was 18.3 PERCENT');
  assert.equal(v.verified, true);
  assert.equal(v.normalizedExcerpt, 'Operating margin was 18.3 percent');
});

test('verifyExcerpt: empty and oversized excerpts handled', () => {
  assert.equal(verifyExcerpt(SNAPSHOT, '   ').verified, false);
  const long = 'x'.repeat(EVIDENCE_EXCERPT_MAX_CHARS + 500);
  const v = verifyExcerpt(long, long);
  assert.equal(v.verified, true);
  assert.equal(v.normalizedExcerpt.length, EVIDENCE_EXCERPT_MAX_CHARS);
});

test('verifyExcerpt: locator hash matches the normalized snapshot content hash', () => {
  const v = verifyExcerpt(SNAPSHOT, 'The company attributed growth to its cloud division.');
  assert.equal(v.locator!.snapshotSha256, contentHash(SNAPSHOT));
});

// ─── Evidence hashing ───────────────────────────────────────────────────────

test('evidenceHash: idempotent across whitespace/case drift, distinct otherwise', () => {
  const a = evidenceHash({
    sourceId: 'rsrc_1',
    excerpt: 'Total revenue of $4.2 billion',
    claimKey: 'acme-2025-revenue',
    stance: 'supports',
  });
  const b = evidenceHash({
    sourceId: 'rsrc_1',
    excerpt: '  total   revenue of $4.2 BILLION ',
    claimKey: 'ACME-2025-REVENUE',
    stance: 'supports',
  });
  assert.equal(a, b);
  assert.notEqual(
    a,
    evidenceHash({
      sourceId: 'rsrc_2',
      excerpt: 'Total revenue of $4.2 billion',
      claimKey: 'acme-2025-revenue',
      stance: 'supports',
    }),
  );
  assert.notEqual(
    a,
    evidenceHash({
      sourceId: 'rsrc_1',
      excerpt: 'Total revenue of $4.2 billion',
      claimKey: 'acme-2025-revenue',
      stance: 'contradicts',
    }),
  );
});

// ─── Content dedupe ─────────────────────────────────────────────────────────

test('contentHash: mirrors with whitespace differences collide; real edits do not', () => {
  assert.equal(contentHash('a  b\n\nc'), contentHash('a b c'));
  assert.notEqual(contentHash('a b c'), contentHash('a b d'));
});

// ─── Independence clustering ────────────────────────────────────────────────

test('registrableDomain: handles subdomains and two-level TLDs', () => {
  assert.equal(registrableDomain('docs.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('a.b.c.example.org'), 'example.org');
});

test('independence clusters: same content, publisher, or domain cluster together', () => {
  const clusters = assignIndependenceClusters([
    { sourceId: 's1', domain: 'reuters.com', contentHash: 'hashA' },
    { sourceId: 's2', domain: 'mirror.net', contentHash: 'hashA' }, // syndicated copy
    { sourceId: 's3', domain: 'blog.reuters.com' }, // same registrable domain as s1
    { sourceId: 's4', domain: 'ft.com', publisher: 'Financial Times' },
    { sourceId: 's5', domain: 'markets.ft.example', publisher: 'financial times' },
    { sourceId: 's6', domain: 'sec.gov' },
  ]);
  assert.equal(clusters.get('s1'), clusters.get('s2'));
  assert.equal(clusters.get('s1'), clusters.get('s3'));
  assert.equal(clusters.get('s4'), clusters.get('s5'));
  assert.notEqual(clusters.get('s1'), clusters.get('s4'));
  assert.notEqual(clusters.get('s6'), clusters.get('s1'));
  // duplicates never count as independent corroboration
  assert.equal(independentClusterCount(['s1', 's2', 's3'], clusters), 1);
  assert.equal(independentClusterCount(['s1', 's4', 's6'], clusters), 3);
});

// ─── Contradiction grouping ─────────────────────────────────────────────────

test('detectContradictions: opposing stances on one claim key', () => {
  const candidates = detectContradictions([
    { evidenceId: 'e1', sourceId: 's1', claimKey: 'acme-revenue', stance: 'supports' },
    { evidenceId: 'e2', sourceId: 's2', claimKey: 'ACME-Revenue', stance: 'contradicts' },
    { evidenceId: 'e3', sourceId: 's3', claimKey: 'other', stance: 'supports' },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.kind, 'stance');
  assert.deepEqual(candidates[0]!.evidenceIds.sort(), ['e1', 'e2']);
});

test('detectContradictions: differing supporting values surface as value conflicts', () => {
  const candidates = detectContradictions([
    { evidenceId: 'e1', sourceId: 's1', claimKey: 'market-size', stance: 'supports', normalizedValue: '$10B' },
    { evidenceId: 'e2', sourceId: 's2', claimKey: 'market-size', stance: 'supports', normalizedValue: '$14B' },
    { evidenceId: 'e3', sourceId: 's3', claimKey: 'market-size', stance: 'supports', normalizedValue: ' $10b ' },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.kind, 'value');
  assert.equal(candidates[0]!.evidenceIds.length, 3);
});

test('detectContradictions: agreeing evidence and keyless evidence produce nothing', () => {
  assert.deepEqual(
    detectContradictions([
      { evidenceId: 'e1', sourceId: 's1', claimKey: 'k', stance: 'supports', normalizedValue: 'x' },
      { evidenceId: 'e2', sourceId: 's2', claimKey: 'k', stance: 'supports', normalizedValue: 'x' },
      { evidenceId: 'e3', sourceId: 's3', stance: 'contradicts' },
    ]),
    [],
  );
});

// ─── Extraction schema ──────────────────────────────────────────────────────

test('extraction schema: validates evidence payloads and caps counts', () => {
  const out = extractionOutputSchema.parse({
    evidence: [
      {
        questionIds: ['q1'],
        excerpt: 'Total revenue of $4.2 billion',
        claimKey: 'acme-2025-revenue',
        stance: 'supports',
        relevanceBasisPoints: 9000,
        confidenceBasisPoints: 8000,
      },
    ],
    quality: { sourceClass: 'official', authority: 'high' },
  });
  assert.equal(out.evidence.length, 1);
  assert.equal(out.quality.sourceClass, 'official');
  assert.equal(out.quality.recency, 'unknown');

  assert.equal(
    extractionOutputSchema.safeParse({
      evidence: [{ questionIds: [], excerpt: 'x' }],
    }).success,
    false,
  );
  // Out-of-range advisory scores are clamped to the fallback, not fatal.
  const clamped = extractionOutputSchema.parse({
    evidence: [{ questionIds: ['q1'], excerpt: 'x', relevanceBasisPoints: 99_999 }],
  });
  assert.equal(clamped.evidence[0]!.relevanceBasisPoints, 5000);
});

test('extraction schema: advisory enum drift falls back instead of failing', () => {
  const out = extractionOutputSchema.parse({
    evidence: [
      {
        questionIds: ['q1'],
        excerpt: 'Total revenue was $4.2 billion',
        stance: 'confirms', // invalid → context
        relevanceBasisPoints: 12_000, // out of range → 5000
      },
    ],
    quality: {
      sourceClass: 'official',
      proximityToClaim: 'exact', // invalid → unknown (observed with gemini-flash)
      authority: 'very-high', // invalid → unknown
    },
  });
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0]!.stance, 'context');
  assert.equal(out.evidence[0]!.relevanceBasisPoints, 5000);
  assert.equal(out.quality.sourceClass, 'official');
  assert.equal(out.quality.proximityToClaim, 'unknown');
  assert.equal(out.quality.authority, 'unknown');

  // Provenance fields stay strict: a missing/empty excerpt still fails.
  assert.equal(
    extractionOutputSchema.safeParse({ evidence: [{ questionIds: ['q1'], excerpt: '' }] }).success,
    false,
  );
});
