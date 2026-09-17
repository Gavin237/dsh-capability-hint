import { defineConfig } from 'tsdown'

// tsdown bundles src/index.ts into lib/index.js (ESM) and emits lib/index.d.ts.
// It is also the self-contained `prepare` script for git installs: no project
// references, no type checking (see guide §7.1 "build-script catch").
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: 'lib',
  // `platform: 'node'` defaults `fixedExtension` to true, which forces `.mjs`
  // / `.d.mts` even though this package is already `"type": "module"`. That
  // would leave package.json#main (`lib/index.js`) and #types
  // (`lib/index.d.ts`) pointing at files that are never emitted, so the
  // loader could not resolve the plugin. Emit the declared names instead.
  fixedExtension: false,
})
