import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against TypeScript source, not build output, so a failing test
    // points at the line you edited rather than at compiled JavaScript.
    alias: {
      '@careerforge/domain': pkg('domain'),
      '@careerforge/protocol': pkg('protocol'),
      '@careerforge/store': pkg('store'),
      '@careerforge/policy': pkg('policy'),
      '@careerforge/collect': pkg('collect'),
      '@careerforge/enrich': pkg('enrich'),
      '@careerforge/generate': pkg('generate'),
      '@careerforge/ui': pkg('ui'),
      '@careerforge/cli': pkg('cli'),
      '@careerforge/collector-git': fileURLToPath(
        new URL('./collectors/git/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'collectors/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Boundary tests write fixture files into package sources and lint them.
    // Running those in parallel with each other would be fine; running them in
    // parallel with a lint of the same tree would not.
    fileParallelism: true,
    testTimeout: 30_000,
  },
});
