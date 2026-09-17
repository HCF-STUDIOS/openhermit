/**
 * Skill-artifact addressing helpers.
 *
 * A skill's files are stored as a single gzipped tar object in blob storage;
 * the `skills.path` column holds a `blob:`-scheme pointer to that object rather
 * than a host filesystem path. The final on-disk install location (system vs
 * per-user) is derived from the skill's `source` at sync time, so the pointer
 * only has to locate the artifact, not describe where it lands.
 *
 * These helpers are pure — no fs, no tar — so any layer (gateway, store, tools)
 * can build or parse a pointer without pulling in the archive machinery.
 */

/** Scheme prefix marking a `skills.path` value as a blob-storage pointer. */
export const SKILL_BLOB_SCHEME = 'blob:';

/** Default key prefix within the storage bucket for skill artifacts. */
export const SKILL_BLOB_PREFIX = 'skills';

export interface SkillArtifactRef {
  source: 'system' | 'user';
  slug: string;
  /** Required for user skills; identifies the owning agent. */
  ownerAgentId?: string;
}

// Blob keys are server-generated from slug/ownerAgentId, but those values can
// originate from user input, so constrain each key segment to a safe charset
// and reject `.`/`..` to keep the key inside its prefix.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const assertSafeSegment = (value: string, label: string): string => {
  if (!value || value === '.' || value === '..' || !SAFE_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} for skill artifact key: ${JSON.stringify(value)}`);
  }
  return value;
};

/**
 * Build the blob-storage key for a skill artifact. Deterministic from
 * (source, slug, ownerAgentId), so the same skill always maps to the same
 * object and publishing overwrites in place. No version lives in the key — the
 * version label, when present, is recorded in `skills.metadata`.
 *
 *   system: <prefix>/system/<slug>.tar.gz
 *   user:   <prefix>/user/<ownerAgentId>/<slug>.tar.gz
 */
export const buildSkillBlobKey = (
  ref: SkillArtifactRef,
  prefix: string = SKILL_BLOB_PREFIX,
): string => {
  const slug = assertSafeSegment(ref.slug, 'slug');
  if (ref.source === 'user') {
    const owner = assertSafeSegment(ref.ownerAgentId ?? '', 'ownerAgentId');
    return `${prefix}/user/${owner}/${slug}.tar.gz`;
  }
  return `${prefix}/system/${slug}.tar.gz`;
};

/** Wrap a blob-storage key as a `blob:`-scheme `skills.path` pointer. */
export const toSkillBlobPath = (storageKey: string): string =>
  `${SKILL_BLOB_SCHEME}${storageKey}`;

/**
 * Parse a `skills.path` value. Returns the blob-storage key when the value is a
 * `blob:` pointer, or null for legacy bare filesystem paths (pre-migration
 * rows) and any other scheme.
 */
export const parseSkillBlobPath = (path: string): string | null =>
  path.startsWith(SKILL_BLOB_SCHEME) ? path.slice(SKILL_BLOB_SCHEME.length) : null;

/** True when a `skills.path` value is a blob-storage pointer. */
export const isSkillBlobPath = (path: string): boolean =>
  path.startsWith(SKILL_BLOB_SCHEME);
