// SPDX-License-Identifier: Apache-2.0
/**
 * The examples in spec/verification.md and this package's README cannot
 * drift: each code example is a file under tests/docs/examples, embedded
 * verbatim (without its SPDX line) and run here, and each HTTP or header
 * example is rebuilt from the shared vectors.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COVERED_COMPONENTS } from '../src/index.js';
import { signAndVerify } from './docs/examples/sign-and-verify.js';
import { repoRoot, vectors } from './helpers.js';

// Compare with LF line endings whatever the checkout's autocrlf setting.
const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8').split('\r').join('');
const withoutSpdx = (code: string) => code.replace(/^(\/\/|#) SPDX-License-Identifier: [^\n]*\n/, '').replace(/\n+$/, '');
const spec = read('spec/verification.md');
const readme = read('packages/agent-httpsig/README.md');

function snippets(doc: string) {
  return [...doc.matchAll(/<!-- snippet: (\S+) -->\n```\w+\n([\s\S]*?)\n```/g)].map((m) => ({ path: m[1]!, code: m[2]! }));
}

function header(v: (typeof vectors.sign)[number], name: string) {
  return v.headers.find(([n]) => n === name)![1];
}

function expectedVectorBlock(ref: string): string {
  const [kind, index, ...rest] = ref.split(' ');
  if (kind === 'content_digest') return `Content-Digest: ${vectors.content_digest[Number(index)]!.field}`;
  const v = vectors.sign[Number(index)]!;
  const what = rest.join(' ');
  if (what === 'signature_base') return v.signature_base;
  if (what === 'Agent-Passport') return `Agent-Passport: ${header(v, 'Agent-Passport')}`;
  if (what === 'body abridged') {
    const cut = v.request.body.indexOf('~disclosure-0002');
    return `${v.request.body.slice(0, cut)}~..."}}`;
  }
  if (what === '') {
    const url = new URL(v.request.url);
    return [
      `${v.request.method} ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      ...v.headers.map(([n, value]) => `${n}: ${value}`),
      '',
      v.request.body,
    ].join('\n');
  }
  throw new Error(`unknown vector reference ${ref}`);
}

describe('spec/verification.md', () => {
  it('embeds the example files verbatim', () => {
    const found = snippets(spec);
    expect(found.map((s) => s.path).sort()).toEqual([
      'packages/agent-httpsig-py/tests/docs/examples/sign_and_verify.py',
      'packages/agent-httpsig/tests/docs/examples/sign-and-verify.ts',
    ]);
    for (const { path, code } of found) expect(code, path).toBe(withoutSpdx(read(path)));
  });

  it('rebuilds every header and message example from the vectors', () => {
    const blocks = [...spec.matchAll(/<!-- vector: ([^>]+?) -->\n```\w*\n([\s\S]*?)\n```/g)];
    expect(blocks.length).toBe(6);
    for (const [, ref, body] of blocks) expect(body, ref).toBe(expectedVectorBlock(ref!));
  });

  it('lists the covered components of the library', () => {
    const block = spec.match(/<!-- profile: covered components -->\n```\n([^\n]*)\n```/)![1];
    expect(block).toBe(`(${COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ')})`);
  });

  it('has no code block that is not checked', () => {
    const fences = spec.match(/^```/gm)!.length / 2;
    const checked = spec.match(/<!-- (?:snippet|vector|profile): [^>]+ -->\n```/g)!.length;
    expect(fences).toBe(checked);
    // The digest of empty content is quoted in prose.
    expect(spec).toContain(`\`${vectors.content_digest[1]!.field}\``);
  });
});

describe('README.md', () => {
  it('embeds the example file verbatim', () => {
    const found = snippets(readme);
    expect(found.map((s) => s.path)).toEqual(['packages/agent-httpsig/tests/docs/examples/sign-and-verify.ts']);
    expect(found[0]!.code).toBe(withoutSpdx(read(found[0]!.path)));
    expect(readme.match(/^```typescript/gm)!.length).toBe(1);
  });

  it('says the package is not published', () => {
    expect(readme).toMatch(/not yet published/i);
  });
});

describe('the example', () => {
  it('signs and verifies', async () => {
    const result = await signAndVerify('passport-placeholder.shopper-01', 'grant-placeholder.shopper-01');
    expect(result).toMatchObject({ ok: true, agentPassport: 'passport-placeholder.shopper-01' });
  });
});
