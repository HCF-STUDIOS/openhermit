import type { SessionListQuery, SessionSummary } from '@openhermit/protocol';

export const matchesSessionListQuery = (
  summary: SessionSummary,
  query: SessionListQuery,
): boolean => {
  if (query.kind && summary.source.kind !== query.kind) {
    return false;
  }

  if (query.platform && summary.source.platform !== query.platform) {
    return false;
  }

  if (
    query.interactive !== undefined &&
    summary.source.interactive !== query.interactive
  ) {
    return false;
  }

  if (query.channel && !summary.sessionId.startsWith(`${query.channel}:`)) {
    return false;
  }

  if (query.metadata) {
    const meta = summary.metadata;
    if (!meta) return false;
    for (const [key, value] of Object.entries(query.metadata)) {
      if (String(meta[key] ?? '') !== value) {
        return false;
      }
    }
  }

  return true;
};

export const sortSessionSummaries = (
  left: SessionSummary,
  right: SessionSummary,
): number => right.lastActivityAt.localeCompare(left.lastActivityAt);

const toSingleLine = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

export const createFallbackDescription = (text: string): string | undefined => {
  const normalized = toSingleLine(text);

  if (!normalized) {
    return undefined;
  }

  return normalized.length <= 80
    ? normalized
    : `${normalized.slice(0, 77)}...`;
};
