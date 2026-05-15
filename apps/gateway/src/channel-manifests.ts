/**
 * Builds the runtime `ChannelManifestRegistry` for the gateway.
 *
 * Loads two sources, in order:
 *   1. Bundled-default channel packages (telegram/slack/discord).
 *   2. External packages listed in the `channelPackages` gateway config.
 *
 * Both paths use the same `await import(pkg)` mechanism — only the
 * source of the package list differs. External packages may override
 * a built-in by key (via `registry.replace()`); a log line records
 * each override so an operator can see what's happening.
 *
 * Failures loading any single package are logged but do not abort
 * the gateway. A missing optional channel package is a recoverable
 * config error, not a fatal one — agents with the missing channel
 * enabled will simply fail to start that channel and surface in the
 * pool's status map.
 */
import {
  ChannelManifestRegistry,
  type ChannelManifest,
} from '@openhermit/protocol';

const BUILTIN_PACKAGES: readonly string[] = [
  '@openhermit/channel-telegram',
  '@openhermit/channel-slack',
  '@openhermit/channel-discord',
];

const isManifestLike = (value: unknown): value is ChannelManifest => {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<ChannelManifest>;
  return (
    typeof m.key === 'string' &&
    typeof m.namespace === 'string' &&
    typeof m.displayName === 'string' &&
    typeof m.start === 'function' &&
    m.manifestVersion === 1
  );
};

const loadOne = async (
  registry: ChannelManifestRegistry,
  pkg: string,
  origin: 'built-in' | 'external',
  log: (msg: string) => void,
): Promise<void> => {
  let mod: { default?: unknown };
  try {
    mod = (await import(pkg)) as { default?: unknown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`channel package "${pkg}" (${origin}) failed to load: ${msg}`);
    return;
  }

  const candidate = mod.default;
  if (!isManifestLike(candidate)) {
    log(
      `channel package "${pkg}" (${origin}) has no valid default-exported ChannelManifest — skipping`,
    );
    return;
  }

  try {
    if (registry.has(candidate.key)) {
      if (origin === 'external') {
        registry.replace(candidate);
        log(`channel "${candidate.key}" overridden by external package "${pkg}"`);
      } else {
        log(`channel package "${pkg}" (built-in) duplicates key "${candidate.key}" — skipping`);
      }
    } else {
      registry.register(candidate);
      log(`registered ${origin} channel "${candidate.key}" from ${pkg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`channel package "${pkg}" (${origin}) rejected by registry: ${msg}`);
  }
};

export async function buildChannelManifestRegistry(
  externalPackages: readonly string[],
  log: (msg: string) => void,
): Promise<ChannelManifestRegistry> {
  const registry = new ChannelManifestRegistry();
  for (const pkg of BUILTIN_PACKAGES) {
    await loadOne(registry, pkg, 'built-in', log);
  }
  for (const pkg of externalPackages) {
    await loadOne(registry, pkg, 'external', log);
  }
  return registry;
}
