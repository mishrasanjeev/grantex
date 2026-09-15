/**
 * A small, deterministic interpreter for the evidence package JSON Schema.
 *
 * Structure is validated directly against the published schema
 * (`spec/evidence-package-1.0.schema.json`, embedded in `schema-1.0.ts`), so
 * the schema is the single source of structural rules. Only the keywords that
 * file uses are supported; any other keyword makes the schema itself invalid.
 *
 * Evaluation order matches the Python SDK so both report the same first
 * violation: for objects, unknown members (RFC 8785 member order), then
 * missing required members (same order), then `maxProperties`, then each
 * present member (same order), then `allOf`; for arrays, size limits, then
 * items in index order, then `uniqueItems`.
 */
import { canonicalize } from './canonical.js';
import { formatPath } from './document.js';
import { VerificationCode, VerificationFailure } from './result.js';
import { EVIDENCE_SCHEMA_1_0 } from './schema-1.0.js';

export type SchemaNode = Record<string, unknown>;
type Path = ReadonlyArray<string | number>;

export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'const', 'enum',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems',
  'items', 'uniqueItems', 'properties', 'required', 'additionalProperties',
  'propertyNames', 'maxProperties', 'allOf', 'if', 'then',
]);

const patterns = new Map<string, RegExp>();
let checked = false;

function checkKeywords(node: unknown, where: string): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`unsupported schema keyword ${key} at ${where}`);
    if (key === 'properties' || key === '$defs') {
      for (const [name, child] of Object.entries(value as SchemaNode)) checkKeywords(child, `${where}/${key}/${name}`);
    } else if (['items', 'additionalProperties', 'propertyNames', 'if', 'then'].includes(key)) {
      checkKeywords(value, `${where}/${key}`);
    } else if (key === 'allOf') {
      (value as unknown[]).forEach((child, index) => checkKeywords(child, `${where}/allOf/${index}`));
    }
  }
}

/** The embedded evidence package 1.0 schema. */
export function loadSchema(): SchemaNode {
  if (!checked) {
    checkKeywords(EVIDENCE_SCHEMA_1_0, '#');
    checked = true;
  }
  return EVIDENCE_SCHEMA_1_0 as SchemaNode;
}

function pattern(source: string): RegExp {
  let compiled = patterns.get(source);
  if (!compiled) {
    compiled = new RegExp(source, 'u');
    patterns.set(source, compiled);
  }
  return compiled;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    case 'string': return 'string';
    default: return 'object';
  }
}

function hasType(value: unknown, expected: string): boolean {
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeOf(value) === expected;
}

function same(a: unknown, b: unknown): boolean {
  const kind = typeOf(a);
  if (kind !== typeOf(b)) return false;
  if (kind === 'array' || kind === 'object') return canonicalize(a) === canonicalize(b);
  return a === b;
}

function join(path: Path): string {
  let text = '';
  for (const part of path) text = formatPath(text, part);
  return text || '$';
}

function fail(path: Path, message: string): VerificationFailure {
  return new VerificationFailure(VerificationCode.SCHEMA_VIOLATION, message, { fieldPath: join(path) });
}

function resolve(schema: SchemaNode, root: SchemaNode): SchemaNode {
  let node = schema;
  while (typeof node['$ref'] === 'string') {
    const ref = node['$ref'];
    if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported $ref ${ref}`);
    node = (root['$defs'] as Record<string, SchemaNode>)[ref.slice('#/$defs/'.length)]!;
  }
  return node;
}

/** Whether `value` satisfies `schema` (used for `if`). */
export function matches(value: unknown, schema: SchemaNode, root: SchemaNode): boolean {
  try {
    validateNode(value, schema, root, []);
    return true;
  } catch (err) {
    if (err instanceof VerificationFailure) return false;
    throw err;
  }
}

/** Throw `VerificationFailure(schema_violation)` at the first violation. */
export function validate(value: unknown, schema?: SchemaNode): void {
  const root = schema ?? loadSchema();
  validateNode(value, root, root, []);
}

function has(schema: SchemaNode, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(schema, key);
}

function validateNode(value: unknown, input: SchemaNode, root: SchemaNode, path: Path): void {
  const schema = resolve(input, root);

  if (has(schema, 'type')) {
    const types = schema['type'];
    const allowed = Array.isArray(types) ? (types as string[]) : [types as string];
    if (!allowed.some((t) => hasType(value, t))) {
      throw fail(path, `expected ${allowed.join(' or ')}, found ${typeOf(value)}`);
    }
  }
  if (has(schema, 'const') && !same(value, schema['const'])) {
    throw fail(path, `must be ${canonicalize(schema['const'])}`);
  }
  if (has(schema, 'enum')) {
    const options = schema['enum'] as unknown[];
    if (!options.some((option) => same(value, option))) {
      throw fail(path, `must be one of ${options.map((o) => canonicalize(o)).join(', ')}`);
    }
  }

  const kind = typeOf(value);
  if (kind === 'string') {
    const text = value as string;
    const length = Array.from(text).length;
    if (has(schema, 'minLength') && length < (schema['minLength'] as number)) {
      throw fail(path, `shorter than ${String(schema['minLength'])} characters`);
    }
    if (has(schema, 'maxLength') && length > (schema['maxLength'] as number)) {
      throw fail(path, `longer than ${String(schema['maxLength'])} characters`);
    }
    if (has(schema, 'pattern') && !pattern(schema['pattern'] as string).test(text)) {
      throw fail(path, `does not match ${String(schema['pattern'])}`);
    }
  } else if (kind === 'number') {
    const number = value as number;
    if (has(schema, 'minimum') && number < (schema['minimum'] as number)) {
      throw fail(path, `less than ${String(schema['minimum'])}`);
    }
    if (has(schema, 'maximum') && number > (schema['maximum'] as number)) {
      throw fail(path, `greater than ${String(schema['maximum'])}`);
    }
  } else if (kind === 'array') {
    validateArray(value as unknown[], schema, root, path);
  } else if (kind === 'object') {
    validateObject(value as Record<string, unknown>, schema, root, path);
  }
}

function validateArray(value: unknown[], schema: SchemaNode, root: SchemaNode, path: Path): void {
  if (has(schema, 'minItems') && value.length < (schema['minItems'] as number)) {
    throw fail(path, `fewer than ${String(schema['minItems'])} items`);
  }
  if (has(schema, 'maxItems') && value.length > (schema['maxItems'] as number)) {
    throw fail(path, `more than ${String(schema['maxItems'])} items`);
  }
  if (has(schema, 'items')) {
    value.forEach((item, index) => validateNode(item, schema['items'] as SchemaNode, root, [...path, index]));
  }
  if (schema['uniqueItems'] === true) {
    const seen = new Set<string>();
    value.forEach((item, index) => {
      const key = typeOf(item) + canonicalize(item);
      if (seen.has(key)) throw fail([...path, index], 'duplicate item');
      seen.add(key);
    });
  }
}

function validateObject(value: Record<string, unknown>, schema: SchemaNode, root: SchemaNode, path: Path): void {
  const properties = (schema['properties'] ?? {}) as Record<string, SchemaNode>;
  const names = Object.keys(value).sort();
  const additional = has(schema, 'additionalProperties') ? schema['additionalProperties'] : true;

  for (const name of names) {
    if (!has(properties, name) && additional === false) throw fail([...path, name], 'unknown member');
  }
  if (has(schema, 'propertyNames')) {
    for (const name of names) {
      if (!matches(name, schema['propertyNames'] as SchemaNode, root)) throw fail([...path, name], 'member name not allowed');
    }
  }
  for (const name of [...((schema['required'] ?? []) as string[])].sort()) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) throw fail([...path, name], 'required member is missing');
  }
  if (has(schema, 'maxProperties') && names.length > (schema['maxProperties'] as number)) {
    throw fail(path, `more than ${String(schema['maxProperties'])} members`);
  }
  for (const name of names) {
    const child = [...path, name];
    if (has(properties, name)) validateNode(value[name], properties[name]!, root, child);
    else if (additional !== null && typeof additional === 'object') validateNode(value[name], additional as SchemaNode, root, child);
  }
  for (const clause of (schema['allOf'] ?? []) as SchemaNode[]) {
    const condition = clause['if'] as SchemaNode | undefined;
    if ((condition === undefined || matches(value, condition, root)) && has(clause, 'then')) {
      validateNode(value, clause['then'] as SchemaNode, root, path);
    }
  }
}
