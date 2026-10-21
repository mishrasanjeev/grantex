// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Documentation examples import the package by name; resolve it to the
  // sources (tsconfig.json "paths" does the same for type checking).
  resolve: {
    alias: [{ find: /^@grantex\/agent-httpsig$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
