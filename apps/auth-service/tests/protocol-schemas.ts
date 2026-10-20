/**
 * Loads the saved UCP and ACP JSON Schemas (tests/fixtures/protocol-schemas)
 * into one Ajv 2020-12 instance per protocol release, keyed by each file's $id.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Module.default;
type AjvInstance = InstanceType<typeof Ajv2020>;

export const PROTOCOL_SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol-schemas');

export type ProtocolRelease = 'ucp-2026-04-08' | 'ucp-2026-08-25' | 'acp-2026-04-17';

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsonFiles(path);
    return name.endsWith('.json') ? [path] : [];
  });
}

const instances = new Map<ProtocolRelease, AjvInstance>();

export function protocolAjv(release: ProtocolRelease): AjvInstance {
  const existing = instances.get(release);
  if (existing) return existing;
  // Formats are annotations here (uri, date-time); shape is what is checked.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  for (const file of jsonFiles(join(PROTOCOL_SCHEMA_DIR, release))) {
    ajv.addSchema(JSON.parse(readFileSync(file, 'utf8')) as object);
  }
  instances.set(release, ajv);
  return ajv;
}

/** Validates `value` against the schema at `ref` (an $id with an optional JSON pointer); returns the errors. */
export function schemaErrors(release: ProtocolRelease, ref: string, value: unknown): string[] {
  const validate = protocolAjv(release).getSchema(ref);
  if (!validate) throw new Error(`no schema ${ref} in ${release}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`);
}
