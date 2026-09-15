/**
 * Manifest schema 0.6 (PRD G-1): object-form tools, strict loading, JSON Schema.
 *
 * The fixtures in spec/examples/manifest-0.6 are shared with the Python SDK so
 * both loaders and the published schema agree on what is valid.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import { ToolManifest, Permission, ManifestValidationError, parseManifestJson, parseToolDeclaration } from '../src/manifest.js';
import * as allManifests from '../src/manifests/index.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Module.default;

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec');
const SCHEMA = JSON.parse(readFileSync(join(SPEC_DIR, 'manifest-0.6.schema.json'), 'utf-8')) as Record<string, unknown>;
const EXAMPLES_DIR = join(SPEC_DIR, 'examples', 'manifest-0.6');
const VALID_FILES = readdirSync(join(EXAMPLES_DIR, 'valid')).filter((f) => f.endsWith('.json')).sort();
interface InvalidCase {
  name: string;
  error: string;
  manifest: Record<string, unknown>;
}
const INVALID_CASES = (
  JSON.parse(readFileSync(join(EXAMPLES_DIR, 'invalid.json'), 'utf-8')) as { cases: InvalidCase[] }
).cases;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(SCHEMA);

function readExample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, 'valid', name), 'utf-8')) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('manifest 0.6 acceptance criteria', () => {
  it('string and object forms load from the same file', async () => {
    const m = await ToolManifest.fromFile(join(EXAMPLES_DIR, 'valid', 'acme_kyb_mixed_forms.json'));
    expect(m.getPermission('get_case')).toBe(Permission.READ);
    expect(m.getToolSpec('get_case')).toEqual({ permission: 'read', requiresDecision: false, fourEyesOn: [] });
    expect(m.getToolSpec('verify_business')).toEqual({
      permission: 'read',
      allowedPurposes: ['aml.cdd.onboarding', 'x-acme-bank.kyb_refresh'],
      caps: { perDay: 500, perCase: 3 },
      costUnits: { base: 5 },
      requiresDecision: false,
      fourEyesOn: [],
    });
  });

  it('an unknown key is rejected at load with a clear error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grantex-manifest-'));
    const file = join(dir, 'acme_kyb.json');
    writeFileSync(
      file,
      JSON.stringify({ connector: 'acme_kyb', tools: { verify_business: { permission: 'read', max_calls: 5 } } }),
    );
    await expect(ToolManifest.fromFile(file)).rejects.toThrow(
      new ManifestValidationError(
        'ToolManifest: tools.verify_business: unknown key "max_calls" (allowed: permission, allowed_purposes, caps, cost_units, requires_decision, four_eyes_on)',
      ),
    );
  });

  it('a manifest declaring requires_decision on a read tool is rejected', () => {
    expect(
      () =>
        new ToolManifest({
          connector: 'acme_kyb',
          tools: { resolve_business: { permission: 'read', requires_decision: true } },
        }),
    ).toThrow(/requires_decision is not allowed on a tool with read permission/);
  });

  it('the schema is published as JSON Schema 2020-12', () => {
    expect(SCHEMA['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(SCHEMA['$id']).toBe('https://grantex.dev/spec/manifest-0.6.schema.json');
    expect(ajv.validateSchema(SCHEMA)).toBe(true);
  });
});

describe('schema and loader agree on the shared fixtures', () => {
  it('has fixtures', () => {
    expect(VALID_FILES.length).toBeGreaterThanOrEqual(3);
    expect(INVALID_CASES.length).toBeGreaterThanOrEqual(30);
  });

  for (const file of VALID_FILES) {
    it(`${file} validates against the schema`, () => {
      expect(validate(readExample(file)), JSON.stringify(validate.errors)).toBe(true);
    });

    it(`${file} loads`, () => {
      const m = ToolManifest.fromJSON(readExample(file));
      expect(m.connector).toBe('acme_kyb');
      expect(m.toolCount).toBeGreaterThanOrEqual(1);
    });
  }

  for (const c of INVALID_CASES) {
    it(`schema rejects: ${c.name}`, () => {
      expect(validate(c.manifest)).toBe(false);
    });

    it(`loader rejects: ${c.name}`, () => {
      let message = '';
      try {
        ToolManifest.fromJSON(c.manifest);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain(c.error);
    });
  }

  it('a rendered manifest validates against the schema and round-trips', () => {
    const m = ToolManifest.fromJSON(readExample('acme_kyb.json'));
    const rendered = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
    expect(validate(rendered), JSON.stringify(validate.errors)).toBe(true);
    const again = ToolManifest.fromJSON(rendered);
    for (const name of Object.keys(m.tools)) {
      expect(again.getToolSpec(name)).toEqual(m.getToolSpec(name));
    }
  });

  it('pre-built manifests are valid 0.6 documents', () => {
    const manifests = Object.values(allManifests);
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) {
      expect(validate(JSON.parse(JSON.stringify(m))), m.connector).toBe(true);
    }
  });
});

describe('ToolSpec', () => {
  it('parses every field of the acme_kyb example', () => {
    const m = ToolManifest.fromJSON(readExample('acme_kyb.json'));
    expect(m.tools).toEqual({
      resolve_business: 'read',
      verify_business: 'read',
      screen_person: 'read',
      monitor_enroll: 'write',
      monitor_delete: 'delete',
      case_decision: 'write',
    });
    expect(m.getToolSpec('verify_business')).toEqual({
      permission: 'read',
      allowedPurposes: ['aml.cdd.*'],
      caps: { perHour: 50, perCase: 3 },
      costUnits: { base: 5, ownership: 10, web_insights: 3 },
      requiresDecision: false,
      fourEyesOn: [],
    });
    expect(m.getToolSpec('case_decision')).toEqual({
      permission: 'write',
      requiresDecision: true,
      fourEyesOn: ['decline'],
    });
    expect(m.getToolSpec('missing')).toBeUndefined();
  });

  it('accepts a cap of zero', () => {
    const m = new ToolManifest({
      connector: 'acme_kyb',
      tools: { verify_business: { permission: 'read', caps: { per_hour: 0 } } },
    });
    expect(m.getToolSpec('verify_business')?.caps).toEqual({ perHour: 0 });
  });

  it('accepts requires_decision false on a read tool', () => {
    const m = new ToolManifest({
      connector: 'acme_kyb',
      tools: { get_case: { permission: 'read', requires_decision: false } },
    });
    expect(m.getToolSpec('get_case')).toEqual({ permission: 'read', requiresDecision: false, fourEyesOn: [] });
  });

  it('addTool accepts the object form', () => {
    const m = new ToolManifest({ connector: 'acme_kyb', tools: { get_case: Permission.READ } });
    m.addTool('case_decision', { permission: 'write', requires_decision: true });
    expect(m.getPermission('case_decision')).toBe(Permission.WRITE);
    expect(m.getToolSpec('case_decision')?.requiresDecision).toBe(true);
  });

  it('addTool rejects an invalid object', () => {
    const m = new ToolManifest({ connector: 'acme_kyb', tools: { get_case: Permission.READ } });
    expect(() =>
      m.addTool('verify_business', { permission: 'read', cap: 1 } as unknown as Parameters<typeof m.addTool>[1]),
    ).toThrow(/unknown key "cap"/);
  });

  it('addTool with a string replaces the whole declaration', () => {
    const m = new ToolManifest({
      connector: 'acme_kyb',
      tools: { verify_business: { permission: 'read', caps: { per_hour: 5 } } },
    });
    m.addTool('verify_business', Permission.WRITE);
    expect(m.getToolSpec('verify_business')).toEqual({ permission: 'write', requiresDecision: false, fourEyesOn: [] });
  });

  it('editing tools directly keeps constraints', () => {
    const m = new ToolManifest({
      connector: 'acme_kyb',
      tools: { verify_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'] } },
    });
    (m.tools as Record<string, Permission>)['verify_business'] = Permission.WRITE;
    expect(m.getToolSpec('verify_business')).toMatchObject({ permission: 'write', allowedPurposes: ['aml.cdd.*'] });
  });

  it('editing tools into a forbidden combination throws', () => {
    const m = new ToolManifest({
      connector: 'acme_kyb',
      tools: { case_decision: { permission: 'write', requires_decision: true } },
    });
    (m.tools as Record<string, Permission>)['case_decision'] = Permission.READ;
    expect(() => m.getToolSpec('case_decision')).toThrow(ManifestValidationError);
  });

  it('prototype keys are not tools', () => {
    const m = new ToolManifest({ connector: 'acme_kyb', tools: { get_case: Permission.READ } });
    expect(m.getPermission('toString')).toBeUndefined();
    expect(m.getToolSpec('constructor')).toBeUndefined();
  });

  it('rejects a non-object JSON file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grantex-manifest-'));
    const file = join(dir, 'list.json');
    writeFileSync(file, '[]');
    await expect(ToolManifest.fromFile(file)).rejects.toThrow('a manifest must be a JSON object');
  });

  it('rejects a $schema of the wrong type', () => {
    expect(() => ToolManifest.fromJSON({ $schema: 1, connector: 'acme_kyb', tools: { get_case: 'read' } })).toThrow(
      '$schema: must be a string',
    );
  });

  it('$schema opts a strings-only manifest into strict loading', () => {
    expect(() =>
      ToolManifest.fromJSON({
        $schema: 'https://grantex.dev/spec/manifest-0.6.schema.json',
        connector: 'acme_kyb',
        owner: 'team',
        tools: { get_case: 'read' },
      }),
    ).toThrow('unknown top-level key "owner"');
  });

  it('parseToolDeclaration is exported for single declarations', () => {
    expect(parseToolDeclaration('get_case', 'read')).toEqual({ permission: 'read', requiresDecision: false, fourEyesOn: [] });
  });
});

describe('strings-only manifests keep pre-0.6 behaviour', () => {
  it('an unknown top-level key warns instead of failing', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const m = ToolManifest.fromJSON({ connector: 'acme_kyb', owner: 'team', tools: { get_case: 'read' } });
    expect(m.getPermission('get_case')).toBe(Permission.READ);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown top-level key "owner"'), 'DeprecationWarning');
  });

  it('unusual names still load without the object form', () => {
    const m = new ToolManifest({ connector: 'acme kyb', tools: { 'screen:person': Permission.READ } });
    expect(m.getPermission('screen:person')).toBe(Permission.READ);
  });
});

describe('duplicate keys in manifest files', () => {
  const dir = join(EXAMPLES_DIR, 'duplicate-keys');
  const expected: Record<string, string> = {
    'duplicate-tool.json': 'case_decision',
    'duplicate-nested-key.json': 'per_hour',
    'duplicate-escaped-key.json': 'connector',
  };

  it('has the shared fixtures', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [file, key] of Object.entries(expected)) {
    it(`rejects ${file}`, async () => {
      await expect(ToolManifest.fromFile(join(dir, file))).rejects.toThrow(
        new ManifestValidationError(`ToolManifest: duplicate key "${key}" in manifest file`),
      );
    });
  }

  it('loadManifestsFromDir rejects duplicate keys', async () => {
    const { Grantex } = await import('../src/client.js');
    const tmp = mkdtempSync(join(tmpdir(), 'grantex-dup-'));
    writeFileSync(join(tmp, 'dup.json'), readFileSync(join(dir, 'duplicate-tool.json'), 'utf-8'));
    await expect(new Grantex({ apiKey: 'test-key' }).loadManifestsFromDir(tmp)).rejects.toThrow('duplicate key');
  });

  it('accepts the same key in different objects and inside strings', () => {
    expect(
      parseManifestJson('{"connector": "acme_kyb", "tools": {"a": {"permission": "read"}, "b": {"permission": "read"}}, "description": "\\"tools\\": x"}'),
    ).toMatchObject({ connector: 'acme_kyb' });
  });
});

it('a tool named __proto__ round-trips through toJSON', () => {
  const m = ToolManifest.fromJSON(JSON.parse('{"connector": "acme_kyb", "tools": {"__proto__": {"permission": "read", "caps": {"per_hour": 1}}}}') as Record<string, unknown>);
  const rendered = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
  expect(Object.keys(rendered['tools'] as object)).toEqual(['__proto__']);
  const again = ToolManifest.fromJSON(rendered);
  expect(again.getToolSpec('__proto__')).toEqual(m.getToolSpec('__proto__'));
  expect(again.getToolSpec('__proto__')?.caps).toEqual({ perHour: 1 });
});

