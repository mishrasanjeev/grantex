import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkManifestsDir = path.resolve(__dirname, 'node_modules/@grantex/sdk/src/manifests');

export default defineConfig({
  resolve: {
    alias: [
      {
        // The enforce command does `import('@grantex/sdk/manifests/<connector>.js')`
        // which requires subpath resolution not declared in the SDK package exports.
        // Map it to the SDK source for tests, rewriting .js → .ts.
        find: /^@grantex\/sdk\/manifests\/(.+)\.js$/,
        replacement: `${sdkManifestsDir}/$1.ts`,
      },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
  },
});
