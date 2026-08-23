import { defineConfig } from 'tsdown'

// Pure-ESM build. Two entries:
//   • src/cli.ts          → dist/cli.js   (the `npt` bin; shebang preserved)
//   • src/registry/index.ts → dist/index.js (the registry client library, `exports["."]`)
export default defineConfig({
  entry: ['src/cli.ts', 'src/registry/index.ts'],
  format: 'esm',
  target: 'node18',
  platform: 'node',
  dts: true,
  clean: true,
  outDir: 'dist',
  // Emit `.js` (the package is `"type": "module"`, so `.js` is ESM) to match the
  // `bin`/`exports` paths in package.json.
  outExtensions: () => ({ js: '.js' }),
})
