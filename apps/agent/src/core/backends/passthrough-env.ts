/**
 * Live pass-through env injection for sandbox backends.
 *
 * Linux env is per-process so we can't mutate a running e2b/daytona
 * sandbox's env from outside. Instead we stage the secrets in a file
 * inside the sandbox (`$HOME/.openhermit/.env`, mode 0600) and prefix
 * every exec with a `source` line so each new shell picks up the
 * latest values. This lets pass-through toggles take effect without
 * recreating the sandbox.
 *
 * Tradeoff: long-running processes already started inside the sandbox
 * (e.g. a backgrounded server) keep their old env — they got it at
 * fork time. Only newly-spawned commands see updates.
 */

/** Path to the env file inside the sandbox (relative to $HOME). */
export const PASSTHROUGH_ENV_FILE = '$HOME/.openhermit/.env';

/** POSIX shell single-quote a value, escaping embedded single quotes. */
const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** Drop entries whose key isn't a valid POSIX env-var name. */
const isValidEnvName = (k: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

/**
 * Render an `export FOO='bar'` block. Returns an empty string when the
 * map is empty so callers can short-circuit and not write a file.
 */
export const renderEnvFile = (env: Record<string, string>): string => {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!isValidEnvName(k)) continue;
    lines.push(`export ${k}=${shellQuote(v)}`);
  }
  return lines.join('\n');
};

/**
 * Stable hash of an env map — same keys/values in any order produce the
 * same string, so a backend can skip rewrites when nothing changed.
 */
export const envFingerprint = (env: Record<string, string>): string => {
  const sorted = Object.keys(env).sort().map((k) => [k, env[k]]);
  return JSON.stringify(sorted);
};

/**
 * Build the heredoc that writes the env file inside the sandbox with
 * mode 0600. Uses a quoted heredoc tag (`<<'EOF'`) so values are not
 * shell-expanded.
 */
export const buildWriteEnvFileCommand = (env: Record<string, string>): string => {
  const body = renderEnvFile(env);
  return (
    `umask 077 && mkdir -p "$HOME/.openhermit" && cat > "${PASSTHROUGH_ENV_FILE}" <<'OPENHERMIT_ENV_EOF'\n` +
    `${body}\n` +
    `OPENHERMIT_ENV_EOF`
  );
};

/** Command that removes the env file (used when env empties). */
export const REMOVE_ENV_FILE_COMMAND = `rm -f "${PASSTHROUGH_ENV_FILE}"`;

/**
 * Wrap a user command so it sources the env file before executing.
 * The `2>/dev/null` swallows the "file not found" warning when the
 * sandbox hasn't had the file written yet.
 */
export const wrapWithEnvSource = (command: string): string =>
  `. "${PASSTHROUGH_ENV_FILE}" 2>/dev/null; ${command}`;
