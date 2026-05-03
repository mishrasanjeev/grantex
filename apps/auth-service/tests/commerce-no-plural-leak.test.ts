/**
 * Architecture rule (SKILL §"Architecture Rules"): "Do not put Plural-specific
 * fields into core tables except under namespaced provider metadata or explicit
 * neutral provider reference fields."
 *
 * This test scans every commerce-domain SQL migration and lib module and
 * fails if "plural" appears as a column name, table name, identifier, or
 * literal value. Plural references are allowed only in (a) inline comments
 * (per the architecture-rules narrative) or (b) provider-adapter modules
 * once they exist (M4).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', 'src');

function gather(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...gather(full, ext));
    } else if (ext.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function stripSqlComments(src: string): string {
  // Remove `-- ...` line comments and `/* ... */` block comments. The
  // SQL comment regex uses `[^\r\n]*` (not `.*$`) because `.` doesn't
  // cross `\r` and CRLF-checkout files would otherwise leave the
  // comment text intact.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/--[^\r\n]*/, ''))
    .join('\n');
}

function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/[^\r\n]*/, ''))
    .join('\n');
}

describe('Plural neutrality — core commerce models carry no Plural-specific identifiers', () => {
  it('commerce migration files have no "plural" outside of comments', () => {
    const files = gather(join(root, 'db', 'migrations'), ['.sql'])
      .filter((f) => /\d{3}_commerce_/.test(f.split(/[\\/]/).pop()!));
    expect(files.length, 'expected commerce-* migration files to exist').toBeGreaterThan(0);
    for (const f of files) {
      const content = stripSqlComments(readFileSync(f, 'utf8'));
      expect(content.toLowerCase(), `file ${f} mentions "plural" outside comments`).not.toMatch(/plural/);
    }
  });

  it('lib/commerce/* modules have no "plural" outside of comments', () => {
    const files = gather(join(root, 'lib', 'commerce'), ['.ts']);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = stripTsComments(readFileSync(f, 'utf8'));
      expect(content.toLowerCase(), `module ${f} mentions "plural" outside comments`).not.toMatch(/plural/);
    }
  });

  it('routes/commerce.ts has no "plural" outside of comments', () => {
    const f = join(root, 'routes', 'commerce.ts');
    const content = stripTsComments(readFileSync(f, 'utf8'));
    expect(content.toLowerCase()).not.toMatch(/plural/);
  });
});
