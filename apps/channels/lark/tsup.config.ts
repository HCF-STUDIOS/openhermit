import { defineConfig } from 'tsup';

// Workspace packages that are `private: true` and therefore unreachable
// for an external `npm install`. Bundle them into the published artifact
// so consumers don't need to resolve them at runtime or compile time.
const internalPackages = [
  '@openhermit/protocol',
  '@openhermit/shared',
];

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  tsconfig: 'tsconfig.build.json',
  dts: { resolve: true },
  sourcemap: true,
  noExternal: internalPackages,
  esbuildOptions(options) {
    options.conditions = ['development'];
  },
});
