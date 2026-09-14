import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Cross-package test imports resolve to package sources so `npm test` does
// not depend on build order or stale dist output.
const packageSrc = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@fourpoints/protocol': packageSrc('protocol'),
      '@fourpoints/language-core': packageSrc('language-core'),
      '@fourpoints/provider-interfaces': packageSrc('provider-interfaces'),
      '@fourpoints/evaluation': packageSrc('evaluation'),
      '@fourpoints/quality': packageSrc('quality'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'tests/**/*.test.ts',
      'infrastructure/cdk/test/**/*.test.ts',
    ],
    environment: 'node',
  },
});
