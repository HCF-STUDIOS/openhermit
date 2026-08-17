import type {
  ResearchLocator,
  ResearchReport,
  ResearchSourceClass,
  ResearchStatement,
} from './contracts.js';

/**
 * Deterministic synthesis primitives: server-side claim→evidence→source
 * validation, unsupported-finding downgrade, citation numbering, and the
 * Markdown renderer. The synthesis model only ever references evidence IDs;
 * every visible citation is resolved here from durable records — the model
 * cannot invent a URL or cite another run's evidence.
 */

export interface ReportEvidenceRecord {
  evidenceId: string;
  runId: string;
  sourceId: string;
  excerpt: string;
  locator: ResearchLocator;
}

export interface ReportSourceRecord {
  sourceId: string;
  title?: string | undefined;
  url?: string | undefined;
  canonicalUrl?: string | undefined;
  domain?: string | undefined;
  publisher?: string | undefined;
  publishedAt?: string | undefined;
  sourceClass?: ResearchSourceClass | undefined;
}

// ─── Validation (§11) ───────────────────────────────────────────────────────

export type ReportViolationReason =
  | 'finding_without_evidence'
  | 'unknown_evidence_id'
  | 'evidence_from_other_run';

export interface ReportValidationViolation {
  claimId: string;
  reason: ReportViolationReason;
  evidenceIds: string[];
}

export const allStatements = (report: ResearchReport): ResearchStatement[] => [
  ...report.executiveSummary,
  ...report.sections.flatMap((s) => s.statements),
];

/**
 * Server-side rules: every `finding` cites at least one evidence ID; every
 * cited ID exists; every cited ID belongs to this run. Returns violations for
 * the repair loop — an empty array means the report's provenance is sound.
 */
export const validateReportEvidence = (
  report: ResearchReport,
  runId: string,
  evidenceById: ReadonlyMap<string, ReportEvidenceRecord>,
): ReportValidationViolation[] => {
  const violations: ReportValidationViolation[] = [];
  for (const statement of allStatements(report)) {
    const unknown: string[] = [];
    const wrongRun: string[] = [];
    for (const id of statement.evidenceIds) {
      const record = evidenceById.get(id);
      if (!record) unknown.push(id);
      else if (record.runId !== runId) wrongRun.push(id);
    }
    if (unknown.length > 0) {
      violations.push({
        claimId: statement.claimId,
        reason: 'unknown_evidence_id',
        evidenceIds: unknown,
      });
    }
    if (wrongRun.length > 0) {
      violations.push({
        claimId: statement.claimId,
        reason: 'evidence_from_other_run',
        evidenceIds: wrongRun,
      });
    }
    const validCount = statement.evidenceIds.filter((id) => {
      const record = evidenceById.get(id);
      return record !== undefined && record.runId === runId;
    }).length;
    if (statement.kind === 'finding' && validCount === 0) {
      violations.push({
        claimId: statement.claimId,
        reason: 'finding_without_evidence',
        evidenceIds: [],
      });
    }
  }
  return violations;
};

/**
 * Final fallback after the one repair attempt (§11): still-unsupported
 * findings become labeled caveats instead of silently shipping, and invalid
 * evidence references are stripped everywhere.
 */
export const downgradeUnsupportedFindings = (
  report: ResearchReport,
  runId: string,
  evidenceById: ReadonlyMap<string, ReportEvidenceRecord>,
): ResearchReport => {
  const isValid = (id: string): boolean => {
    const record = evidenceById.get(id);
    return record !== undefined && record.runId === runId;
  };
  const fix = (statement: ResearchStatement): ResearchStatement => {
    const evidenceIds = statement.evidenceIds.filter(isValid);
    if (statement.kind === 'finding' && evidenceIds.length === 0) {
      return {
        ...statement,
        kind: 'caveat',
        confidence: 'low',
        evidenceIds,
        text: statement.text.startsWith('Unverified:')
          ? statement.text
          : `Unverified: ${statement.text}`,
      };
    }
    return { ...statement, evidenceIds };
  };
  return {
    ...report,
    executiveSummary: report.executiveSummary.map(fix),
    sections: report.sections.map((s) => ({
      ...s,
      statements: s.statements.map(fix),
    })),
    contradictions: report.contradictions.map((c) => ({
      ...c,
      evidenceIds: c.evidenceIds.filter(isValid),
    })),
  };
};

// ─── Citation numbering (§11) ───────────────────────────────────────────────

export interface CitationEntry {
  number: number;
  sourceId: string;
  locator: ResearchLocator;
  evidenceIds: string[];
}

export interface CitationIndex {
  numberByEvidenceId: Map<string, number>;
  entries: CitationEntry[];
}

const locatorKey = (sourceId: string, locator: ResearchLocator): string =>
  `${sourceId}:${locator.snapshotSha256}:${locator.startChar}-${locator.endChar}`;

/**
 * Number citations in document order, deduplicated by source + locator: the
 * same excerpt cited twice shares one number; distinct excerpts from one
 * source get their own numbers.
 */
export const buildCitationIndex = (
  report: ResearchReport,
  evidenceById: ReadonlyMap<string, ReportEvidenceRecord>,
): CitationIndex => {
  const numberByKey = new Map<string, number>();
  const numberByEvidenceId = new Map<string, number>();
  const entries: CitationEntry[] = [];

  for (const statement of allStatements(report)) {
    for (const id of statement.evidenceIds) {
      const record = evidenceById.get(id);
      if (!record) continue;
      const key = locatorKey(record.sourceId, record.locator);
      let n = numberByKey.get(key);
      if (n === undefined) {
        n = entries.length + 1;
        numberByKey.set(key, n);
        entries.push({
          number: n,
          sourceId: record.sourceId,
          locator: record.locator,
          evidenceIds: [id],
        });
      } else {
        const entry = entries[n - 1]!;
        if (!entry.evidenceIds.includes(id)) entry.evidenceIds.push(id);
      }
      numberByEvidenceId.set(id, n);
    }
  }
  return { numberByEvidenceId, entries };
};

// ─── Markdown rendering (§11) ───────────────────────────────────────────────

/**
 * Neutralize markdown/HTML control characters in untrusted single-line text
 * (source titles, publishers) so a malicious page title cannot inject links,
 * images, or HTML into the rendered report.
 */
export const sanitizeInline = (text: string): string =>
  text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>[\]`|]/g, '')
    .replace(/[*_~#]{2,}/g, '')
    .replace(/(javascript|data|vbscript):/gi, '')
    .trim();

/** Citation links must be plain http(s); anything else renders without a link. */
export const safeCitationUrl = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // fall through
  }
  return undefined;
};

const citationMarks = (
  evidenceIds: readonly string[],
  index: CitationIndex,
): string => {
  const numbers = [
    ...new Set(
      evidenceIds
        .map((id) => index.numberByEvidenceId.get(id))
        .filter((n): n is number => n !== undefined),
    ),
  ].sort((a, b) => a - b);
  return numbers.map((n) => `[${n}]`).join('');
};

const renderStatement = (
  statement: ResearchStatement,
  index: CitationIndex,
): string => {
  const marks = citationMarks(statement.evidenceIds, index);
  const text = statement.text.trim();
  return marks.length > 0 ? `${text} ${marks}` : text;
};

/**
 * Render the validated report object as the chat-facing Markdown entry.
 * Callers must validate (and if needed downgrade) the report first; this
 * renderer resolves citations purely from durable records.
 */
export const renderReportMarkdown = (
  report: ResearchReport,
  evidenceById: ReadonlyMap<string, ReportEvidenceRecord>,
  sourceById: ReadonlyMap<string, ReportSourceRecord>,
  options?: { partial?: boolean | undefined },
): string => {
  const index = buildCitationIndex(report, evidenceById);
  const lines: string[] = [];

  lines.push(`# ${sanitizeInline(report.title)}`);
  if (options?.partial) {
    lines.push(
      '',
      '> **Partial report.** Research stopped before full coverage; unanswered questions are listed under Gaps.',
    );
  }

  if (report.executiveSummary.length > 0) {
    lines.push('', '## Summary', '');
    for (const s of report.executiveSummary) {
      lines.push(`- ${renderStatement(s, index)}`);
    }
  }

  for (const section of report.sections) {
    lines.push('', `## ${sanitizeInline(section.title)}`, '');
    for (const s of section.statements) {
      lines.push(`${renderStatement(s, index)}`, '');
    }
  }

  if (report.contradictions.length > 0) {
    lines.push('', '## Conflicting evidence', '');
    for (const c of report.contradictions) {
      const marks = citationMarks(c.evidenceIds, index);
      const resolution = c.resolution
        ? `Resolution: ${c.resolution.trim()}`
        : 'Unresolved — both sides are cited.';
      lines.push(`- ${c.summary.trim()} ${marks} ${resolution}`.trim());
    }
  }

  if (report.gaps.length > 0) {
    lines.push('', '## Gaps', '');
    for (const g of report.gaps) {
      lines.push(`- ${g.description.trim()}`);
    }
  }

  if (report.methodology.length > 0) {
    lines.push('', '## Methodology', '');
    for (const m of report.methodology) {
      lines.push(`- ${m.trim()}`);
    }
  }

  if (index.entries.length > 0) {
    lines.push('', '## Sources', '');
    for (const entry of index.entries) {
      const source = sourceById.get(entry.sourceId);
      const title = sanitizeInline(source?.title || source?.domain || entry.sourceId);
      const url = safeCitationUrl(source?.canonicalUrl ?? source?.url);
      const publisher =
        source?.publisher && sanitizeInline(source.publisher) !== title
          ? ` — ${sanitizeInline(source.publisher)}`
          : '';
      const link = url ? ` (${url})` : '';
      lines.push(`${entry.number}. ${title}${publisher}${link}`);
    }
  }

  return `${lines.join('\n').trim()}\n`;
};
