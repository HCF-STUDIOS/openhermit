import assert from 'node:assert/strict';
import { test } from 'node:test';

import { researchReportSchema, type ResearchReport } from '../src/research/contracts.js';
import {
  buildCitationIndex,
  downgradeUnsupportedFindings,
  renderReportMarkdown,
  safeCitationUrl,
  sanitizeInline,
  validateReportEvidence,
  type ReportEvidenceRecord,
  type ReportSourceRecord,
} from '../src/research/synthesis.js';

const RUN = 'rr_test';

const locator = (start: number, hash = 'snaphash') => ({
  kind: 'web_snapshot' as const,
  snapshotSha256: hash,
  startChar: start,
  endChar: start + 10,
});

const evidence = new Map<string, ReportEvidenceRecord>([
  ['ev1', { evidenceId: 'ev1', runId: RUN, sourceId: 'src1', excerpt: 'revenue was $4.2B', locator: locator(0) }],
  ['ev2', { evidenceId: 'ev2', runId: RUN, sourceId: 'src2', excerpt: 'margin was 18.3%', locator: locator(50, 'hash2') }],
  ['ev3', { evidenceId: 'ev3', runId: RUN, sourceId: 'src1', excerpt: 'cloud drove growth', locator: locator(120) }],
  ['ev_other_run', { evidenceId: 'ev_other_run', runId: 'rr_other', sourceId: 'srcX', excerpt: 'x', locator: locator(0) }],
]);

const sources = new Map<string, ReportSourceRecord>([
  ['src1', { sourceId: 'src1', title: 'ACME 2025 Annual Report', url: 'https://acme.example/ir/2025', publisher: 'ACME Corp' }],
  ['src2', { sourceId: 'src2', title: 'Market analysis', canonicalUrl: 'https://analyst.example/acme', domain: 'analyst.example' }],
]);

const makeReport = (overrides?: Partial<ResearchReport>): ResearchReport =>
  researchReportSchema.parse({
    title: 'ACME 2025 performance',
    executiveSummary: [
      { claimId: 'c1', kind: 'finding', text: 'Revenue reached $4.2B.', evidenceIds: ['ev1'], confidence: 'high' },
    ],
    sections: [
      {
        id: 's1',
        title: 'Financials',
        statements: [
          { claimId: 'c2', kind: 'finding', text: 'Operating margin was 18.3%.', evidenceIds: ['ev2'], confidence: 'medium' },
          { claimId: 'c3', kind: 'analysis', text: 'Growth is cloud-led.', evidenceIds: ['ev3', 'ev1'], confidence: 'medium' },
        ],
      },
    ],
    contradictions: [],
    gaps: [{ description: 'No regional split available.' }],
    methodology: ['Searched official filings first.'],
    ...overrides,
  });

// ─── Validation ─────────────────────────────────────────────────────────────

test('validateReportEvidence: sound report has no violations', () => {
  assert.deepEqual(validateReportEvidence(makeReport(), RUN, evidence), []);
});

test('validateReportEvidence: catches findings without evidence', () => {
  const report = makeReport({
    executiveSummary: [
      { claimId: 'c1', kind: 'finding', text: 'Unsupported claim.', evidenceIds: [], confidence: 'high' },
    ],
  });
  const violations = validateReportEvidence(report, RUN, evidence);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.reason, 'finding_without_evidence');
});

test('validateReportEvidence: catches invented and cross-run evidence ids', () => {
  const report = makeReport({
    executiveSummary: [
      { claimId: 'c1', kind: 'finding', text: 'Fabricated.', evidenceIds: ['ev_invented'], confidence: 'high' },
      { claimId: 'c2', kind: 'finding', text: 'Cross-run.', evidenceIds: ['ev_other_run'], confidence: 'high' },
    ],
  });
  const reasons = validateReportEvidence(report, RUN, evidence).map((v) => v.reason).sort();
  // each bad statement yields both the bad-id violation and finding-without-valid-evidence
  assert.deepEqual(reasons, [
    'evidence_from_other_run',
    'finding_without_evidence',
    'finding_without_evidence',
    'unknown_evidence_id',
  ]);
});

test('analysis/caveat statements may cite nothing', () => {
  const report = makeReport({
    executiveSummary: [
      { claimId: 'c1', kind: 'analysis', text: 'Interpretation.', evidenceIds: [], confidence: 'low' },
      { claimId: 'c2', kind: 'caveat', text: 'Limitation.', evidenceIds: [], confidence: 'low' },
    ],
  });
  assert.deepEqual(validateReportEvidence(report, RUN, evidence), []);
});

// ─── Downgrade ──────────────────────────────────────────────────────────────

test('downgradeUnsupportedFindings: converts to labeled caveats and strips bad ids', () => {
  const report = makeReport({
    executiveSummary: [
      { claimId: 'c1', kind: 'finding', text: 'Fabricated claim.', evidenceIds: ['ev_invented'], confidence: 'high' },
      { claimId: 'c2', kind: 'finding', text: 'Real claim.', evidenceIds: ['ev1', 'ev_other_run'], confidence: 'high' },
    ],
  });
  const fixed = downgradeUnsupportedFindings(report, RUN, evidence);
  const [bad, good] = fixed.executiveSummary;
  assert.equal(bad!.kind, 'caveat');
  assert.match(bad!.text, /^Unverified:/);
  assert.deepEqual(bad!.evidenceIds, []);
  assert.equal(good!.kind, 'finding');
  assert.deepEqual(good!.evidenceIds, ['ev1']); // cross-run id stripped
  assert.deepEqual(validateReportEvidence(fixed, RUN, evidence), []);
});

// ─── Citation numbering ─────────────────────────────────────────────────────

test('buildCitationIndex: document order, deduped by source+locator', () => {
  const index = buildCitationIndex(makeReport(), evidence);
  assert.equal(index.numberByEvidenceId.get('ev1'), 1);
  assert.equal(index.numberByEvidenceId.get('ev2'), 2);
  assert.equal(index.numberByEvidenceId.get('ev3'), 3);
  assert.equal(index.entries.length, 3);
  // ev1 cited twice (c1 and c3) → still number 1, single entry
  assert.equal(index.entries[0]!.evidenceIds.length, 1);
});

test('buildCitationIndex: same source+locator shares one number', () => {
  const dupEvidence = new Map(evidence);
  dupEvidence.set('ev1b', {
    evidenceId: 'ev1b',
    runId: RUN,
    sourceId: 'src1',
    excerpt: 'revenue was $4.2B',
    locator: locator(0),
  });
  const report = makeReport({
    executiveSummary: [
      { claimId: 'c1', kind: 'finding', text: 'A.', evidenceIds: ['ev1'], confidence: 'high' },
      { claimId: 'c2', kind: 'finding', text: 'B.', evidenceIds: ['ev1b'], confidence: 'high' },
    ],
  });
  const index = buildCitationIndex(report, dupEvidence);
  assert.equal(index.numberByEvidenceId.get('ev1'), index.numberByEvidenceId.get('ev1b'));
});

// ─── Sanitization ───────────────────────────────────────────────────────────

test('sanitizeInline: neutralizes markdown/html injection in titles', () => {
  assert.equal(
    sanitizeInline('[Click me](https://evil.example) <script>alert(1)</script>'),
    'Click me(https://evil.example) scriptalert(1)/script',
  );
  assert.equal(sanitizeInline('Multi\nline\r\ntitle'), 'Multi line title');
  assert.equal(sanitizeInline('**bold** attack'), 'bold attack');
});

test('safeCitationUrl: http(s) only', () => {
  assert.equal(safeCitationUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeCitationUrl('javascript:alert(1)'), undefined);
  assert.equal(safeCitationUrl('data:text/html,x'), undefined);
  assert.equal(safeCitationUrl('not a url'), undefined);
  assert.equal(safeCitationUrl(undefined), undefined);
});

// ─── Rendering ──────────────────────────────────────────────────────────────

test('renderReportMarkdown: numbered citations, sources section, gaps', () => {
  const md = renderReportMarkdown(makeReport(), evidence, sources);
  assert.match(md, /# ACME 2025 performance/);
  assert.match(md, /Revenue reached \$4\.2B\. \[1\]/);
  assert.match(md, /Operating margin was 18\.3%\. \[2\]/);
  assert.match(md, /Growth is cloud-led\. \[1\]\[3\]/);
  assert.match(md, /## Sources/);
  assert.match(md, /1\. ACME 2025 Annual Report — ACME Corp \(https:\/\/acme\.example\/ir\/2025\)/);
  assert.match(md, /## Gaps/);
  assert.match(md, /No regional split available\./);
});

test('renderReportMarkdown: partial banner and unresolved contradictions', () => {
  const report = makeReport({
    contradictions: [
      { summary: 'Estimates differ on market size.', evidenceIds: ['ev1', 'ev2'], resolution: null },
    ],
  });
  const md = renderReportMarkdown(report, evidence, sources, { partial: true });
  assert.match(md, /Partial report/);
  assert.match(md, /## Conflicting evidence/);
  assert.match(md, /Estimates differ on market size\. \[1\]\[2\] Unresolved/);
});

test('renderReportMarkdown: malicious titles cannot inject markdown or links', () => {
  const evilSources = new Map<string, ReportSourceRecord>([
    ['src1', { sourceId: 'src1', title: '[evil](javascript:alert(1)) <img src=x>', url: 'javascript:alert(1)' }],
    ['src2', sources.get('src2')!],
  ]);
  const md = renderReportMarkdown(makeReport(), evidence, evilSources);
  assert.doesNotMatch(md, /\[evil\]\(/);
  assert.doesNotMatch(md, /<img/);
  assert.doesNotMatch(md, /javascript:/);
});

test('renderReportMarkdown: model-authored body text cannot inject links or HTML', () => {
  // Statement/contradiction/gap/methodology text is synthesis-model output
  // derived from untrusted web excerpts and lands in the main session — the
  // renderer must neutralize markdown/HTML so the model cannot smuggle in a
  // clickable URL the citation resolver didn't vouch for.
  const report = makeReport({
    executiveSummary: [
      {
        claimId: 'c1',
        kind: 'finding',
        text: 'Revenue [details](https://evil.example/x) <img src=x onerror=alert(1)> javascript:alert(1)',
        evidenceIds: ['ev1'],
        confidence: 'high',
      },
    ],
    contradictions: [
      {
        summary: 'A says [1B](https://evil.example) — B says 2B',
        evidenceIds: ['ev1'],
        resolution: 'trust <script>alert(1)</script>',
      },
    ],
    gaps: [{ description: 'gap with ![beacon](https://evil.example/p.png)' }],
    methodology: ['ran `curl` | [notes](https://evil.example)'],
  });
  const md = renderReportMarkdown(report, evidence, sources);
  assert.ok(!md.includes(']('), 'no markdown links outside the citation resolver');
  assert.ok(!md.includes('<'), 'no raw HTML');
  assert.doesNotMatch(md, /javascript:/i);
  // Citation marks are appended after sanitization and survive.
  assert.ok(md.includes('[1]'));
});

test('renderReportMarkdown: report schema round-trips defaults', () => {
  const parsed = researchReportSchema.parse({ title: 'T' });
  const md = renderReportMarkdown(parsed, new Map(), new Map());
  assert.equal(md.trim(), '# T');
});
