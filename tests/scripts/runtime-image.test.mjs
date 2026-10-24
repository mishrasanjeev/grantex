import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the auth runtime excludes optional native TypeScript compiler peers', () => {
  const dockerfile = readFileSync(new URL('../../apps/auth-service/Dockerfile', import.meta.url), 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(runtime, /npm ci --omit=dev/);
  assert.match(runtime, /rm -rf node_modules\/typescript node_modules\/@typescript/);
  assert.match(runtime, /COPY --from=builder \/app\/dist/);
  assert.match(runtime, /USER node/);
});

test('Go validation and release workflows use the patched toolchain', () => {
  for (const filename of ['ci.yml', 'security-scan.yml', 'publish-primary-sdks.yml']) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${filename}`, import.meta.url), 'utf8');
    const versions = [...workflow.matchAll(/go-version: '([^']+)'/g)].map((match) => match[1]);
    assert.ok(versions.length > 0, filename);
    assert.ok(versions.every((version) => version === '1.26.10'), filename);
  }
  const authority = readFileSync(new URL('../../.github/workflows/sdk-authority.yml', import.meta.url), 'utf8');
  assert.match(authority, /golang:1\.26\.10@sha256:[a-f0-9]{64}/);
  for (const module of ['packages/go-sdk', 'packages/terraform-provider-grantex', 'examples/quickstart-go']) {
    const goMod = readFileSync(new URL(`../../${module}/go.mod`, import.meta.url), 'utf8');
    assert.match(goMod, /^toolchain go1\.26\.10\r?$/m, module);
  }
});

test('both auth image stages pin the reviewed Node security release', () => {
  const dockerfile = readFileSync(new URL('../../apps/auth-service/Dockerfile', import.meta.url), 'utf8');
  const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(images, Array(2).fill('node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797'));
});

test('CI checks native fetch in the actual isolated production image', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/security-scan.yml', import.meta.url), 'utf8');
  assert.match(workflow, /docker run --rm --network none --entrypoint node/);
  assert.match(workflow, /grantex-auth-service:scan --test \/tmp\/runtime-fetch\.test\.mjs/);
});
