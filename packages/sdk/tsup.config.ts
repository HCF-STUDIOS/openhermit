import { defineConfig } from 'tsup';

// Bundle the workspace-only dependencies into the published artifact so
// consumers don't need (and can't reach) @openhermit/protocol or
// @openhermit/shared on npm.
const internalPackages = [
  '@openhermit/protocol',
  '@openhermit/shared',
];

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.build.json',
  dts: { resolve: true },
  sourcemap: true,
  noExternal: internalPackages,
  esbuildOptions(options) {
    options.conditions = ['development'];
  },
});
