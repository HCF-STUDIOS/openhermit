import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const internalPackages = [
  '@openhermit/sdk',
  '@openhermit/shared',
  '@openhermit/protocol',
  '@openhermit/store',
  '@openhermit/agent',
  '@openhermit/agent/*',
  '@openhermit/web',
  '@openhermit/channel-telegram',
  '@openhermit/channel-slack',
  '@openhermit/channel-discord',
  '@openhermit/gateway',
];

// Every runtime dependency listed in package.json should stay external — both
// to keep the bundle small and to avoid bundling CJS-heavy modules (e.g.
// prom-client, jsdom) whose dynamic require() calls don't survive ESM
// bundling. tsup's noExternal recursively bundles transitive deps of internal
// packages by default; listing these explicitly here overrides that.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const runtimeExternals = Object.keys(pkg.dependencies ?? {});

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    gateway: '../../apps/gateway/src/index.ts',
    web: '../../apps/web/src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: true,
  noExternal: internalPackages,
  external: runtimeExternals,
  esbuildOptions(options) {
    options.conditions = ['development'];
  },
  // Shebang on every entry — harmless on gateway.js / web.js (they're never
  // exec'd directly), required for cli.js when invoked as the `openhermit` bin.
  // The per-entry callback didn't fire under `splitting: true`.
  banner: { js: '#!/usr/bin/env node' },
});
