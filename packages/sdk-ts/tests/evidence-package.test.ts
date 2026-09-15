/**
 * Evidence package and verifier (PRD G-5; test matrix rows "evidence hash
 * chain" and "canonicalisation stability"; end-to-end step 8). Cross-language
 * parity: every case in spec/examples/evidence/ must give exactly the result
 * the Python SDK recorded.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { evidence } from '../src/index.js';
import { EVIDENCE_SCHEMA_1_0 } from '../src/evidence/schema-1.0.js';
import { SCHEMA_KEYWORDS } from '../src/evidence/schema.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Module.default;

const I_EVAL = 10;
const I_REC = 11;
const I_DEC1 = 13;
const I_REVOKE = 17;

const {
  IDENTIFIER_CLASSES,
  actionReference,
  caseKey,
  isActionReference,
  keyedContentDigest,
  VerificationCode,
  anchorAuditEntry,
  attachAnchor,
  attachSignature,
  auditEntryHash,
  buildPackage,
  canonicalize,
  chainRoot,
  decisionActionHash,
  entryHash,
  headerHash,
  isPseudonym,
  pseudonymise,
  serializePackage,
  signRoot,
  upstreamRecordsFor,
  verificationResultToJson,
  verifyPackage,
} = evidence;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', '..', 'spec', 'examples', 'evidence');
const SPEC_SCHEMA = join(FIXTURES, '..', '..', 'evidence-package-1.0.schema.json');

const read = (name: string): Buffer => readFileSync(join(FIXTURES, name));
const readJson = (name: string): Json => JSON.parse(read(name).toString('utf8')) as Json;
const files = (): Record<string, Buffer> =>
  Object.fromEntries(readdirSync(FIXTURES).filter((n) => n.endsWith('.json')).map((n) => [n, read(n)]));
const expected = readJson('expected.json');
const keyFromSeed = (seed: string): Buffer => createHash('sha256').update(seed, 'utf8').digest();

function parent(document: Json, path: Array<string | number>): Json {
  let node: Json = document;
  for (const key of path.slice(0, -1)) node = node[key as string];
  return node;
}

function rehashChain(document: Json): void {
  let previous = headerHash(document);
  document['chain']['genesis'] = previous;
  (document['entries'] as Json[]).forEach((entry, seq) => {
    entry['seq'] = seq;
    entry['prev'] = previous;
    entry['hash'] = entryHash(entry);
    previous = entry['hash'];
  });
  const chain = document['chain'];
  chain['head'] = previous;
  chain['length'] = document['entries'].length;
  chain['root'] = chainRoot(chain);
}

/** Same semantics as tests/evidence_fixtures.py apply_case. */
function applyCase(testCase: Json, fixtureFiles: Record<string, Buffer>): Uint8Array {
  const document = JSON.parse(fixtureFiles[testCase['package']]!.toString('utf8')) as Json;
  let raw: Buffer | null = null;
  for (const mutation of (testCase['mutations'] ?? []) as Json[]) {
    const op = mutation['op'];
    if (op === 'set') parent(document, mutation['path'])[mutation['path'].at(-1)] = structuredClone(mutation['value']);
    else if (op === 'delete') delete parent(document, mutation['path'])[mutation['path'].at(-1)];
    else if (op === 'insert') (parent(document, mutation['path']) as unknown as unknown[]).splice(mutation['path'].at(-1), 0, structuredClone(mutation['value']));
    else if (op === 'copy_entry') document['entries'].splice(mutation['to'], 0, structuredClone(document['entries'][mutation['from']]));
    else if (op === 'rehash_entry') {
      const entry = document['entries'][mutation['index']];
      entry['hash'] = entryHash(entry);
    } else if (op === 'rehash_chain') rehashChain(document);
    else if (op === 'rehash_anchor') {
      const audit = document['anchor']['audit_entry'];
      audit['hash'] = auditEntryHash(audit);
    } else {
      const text: Buffer = raw ?? Buffer.from(serializePackage(document));
      if (op === 'raw_replace') {
        const find = Buffer.from(mutation['find'], 'utf8');
        const at = text.indexOf(find);
        if (at < 0) throw new Error(`${testCase['name']}: find not found`);
        raw = Buffer.concat([text.subarray(0, at), Buffer.from(mutation['replace'], 'utf8'), text.subarray(at + find.length)]);
      } else if (op === 'raw_prefix') raw = Buffer.concat([Buffer.from(mutation['hex'], 'hex'), text]);
      else if (op === 'raw_truncate') raw = text.subarray(0, mutation['length']);
      else throw new Error(`unknown op ${op}`);
    }
  }
  return raw ?? serializePackage(document);
}

function verifyOptions(testCase: Json, fixtureFiles: Record<string, Buffer>): evidence.VerifyOptions {
  const options = (testCase['options'] ?? {}) as Json;
  const out: evidence.VerifyOptions = { expectedRoot: expected[testCase['package']]['root'] };
  if ('expected_root' in options) out.expectedRoot = options['expected_root'];
  if ('jwks' in options) {
    out.jwks = typeof options['jwks'] === 'string' ? JSON.parse(fixtureFiles[options['jwks']]!.toString('utf8')) : options['jwks'];
  }
  if ('expected_anchor_hash' in options) out.expectedAnchorHash = options['expected_anchor_hash'];
  if ('require_anchor' in options) out.requireAnchor = options['require_anchor'];
  if ('require_signature' in options) out.requireSignature = options['require_signature'];
  if ('allow_unverified_signature' in options) out.allowUnverifiedSignature = options['allow_unverified_signature'];
  if ('max_bytes' in options) out.maxBytes = options['max_bytes'];
  return out;
}

function fixtureBuild(disclosedAll: boolean): evidence.BuiltPackage {
  const input = readJson('case-input.json');
  return buildPackage({
    case: input['case'],
    entries: input['entries'],
    privacy: disclosedAll
      ? { disclosed: [...IDENTIFIER_CLASSES] }
      : { key: keyFromSeed(input['privacy']['key_seed']), keyId: input['privacy']['key_id'], disclosed: input['privacy']['disclosed'] },
  });
}

describe('fixtures and schema', () => {
  it('embedded schema is the published schema', () => {
    expect(EVIDENCE_SCHEMA_1_0).toEqual(JSON.parse(readFileSync(SPEC_SCHEMA, 'utf8')));
  });

  it('published schema uses only interpreted keywords', () => {
    const found = new Set<string>();
    const walk = (node: unknown, key = ''): void => {
      if (Array.isArray(node)) {
        if (key === 'allOf') node.forEach((child) => walk(child));
      } else if (node !== null && typeof node === 'object') {
        for (const [name, child] of Object.entries(node)) {
          if (key !== 'properties' && key !== '$defs') found.add(name);
          walk(child, name);
        }
      }
    };
    walk(EVIDENCE_SCHEMA_1_0);
    expect([...found].filter((k) => !SCHEMA_KEYWORDS.has(k))).toEqual([]);
  });

  it('fixture packages validate against the JSON Schema with a stock validator', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(JSON.parse(readFileSync(SPEC_SCHEMA, 'utf8')) as object);
    for (const name of ['evidence-package.json', 'evidence-package-disclosed.json', 'evidence-package-signed.json']) {
      expect(validateSchema(readJson(name)), name).toBe(true);
    }
  });
});

describe('canonicalisation stability', () => {
  it('reordering and whitespace never change the canonical form', () => {
    const document = readJson('evidence-package.json');
    const reference = canonicalize(document);
    let seed = 8785;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const shuffle = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(shuffle);
      if (node !== null && typeof node === 'object') {
        const entries = Object.entries(node).sort(() => random() - 0.5);
        return Object.fromEntries(entries.map(([k, v]) => [k, shuffle(v)]));
      }
      return node;
    };
    for (let i = 0; i < 50; i++) {
      const text = JSON.stringify(shuffle(document), null, [undefined, 1, 4][i % 3]);
      expect(canonicalize(JSON.parse(text))).toBe(reference);
    }
  });
});

describe('build', () => {
  it('builds the shared fixture bytes, identical to the Python SDK', () => {
    const pseudonymised = fixtureBuild(false);
    const anchor = readJson('evidence-package.json')['anchor']['audit_entry'];
    const anchored = attachAnchor(
      pseudonymised.document,
      anchorAuditEntry(pseudonymised.document, { auditEntryId: anchor['id'], timestamp: anchor['timestamp'], prevHash: anchor['prevHash'] }),
    );
    expect(Buffer.from(serializePackage(anchored)).equals(read('evidence-package.json'))).toBe(true);
    expect(Buffer.from(fixtureBuild(true).data).equals(read('evidence-package-disclosed.json'))).toBe(true);
    expect(pseudonymised.root).toBe(expected['evidence-package.json']['root']);
  });

  it('pseudonymises identifiers by default', () => {
    const raw = read('evidence-package.json').toString('utf8');
    for (const secret of ['user:approver-a', 'user:approver-b', 'user:underwriting-team', 'gb:00000001', 'mock:registry:00000001']) {
      expect(raw.includes(secret)).toBe(false);
    }
    const decision = readJson('evidence-package.json')['entries'][I_DEC1]['data'];
    expect(isPseudonym(decision['approver']) && isPseudonym(decision['action']['subject'])).toBe(true);
    expect('action_hash' in decision).toBe(false);
    expect(isActionReference(decision['action_ref'])).toBe(true);
    for (const entry of readJson('case-input.json')['entries'] as Json[]) {
      for (const name of ['action_hash', 'input_hash', 'output_hash']) {
        if (typeof entry['data'][name] === 'string') expect(raw.includes(entry['data'][name]), name).toBe(false);
      }
    }
    const guess = decisionActionHash({ action: 'case_decision', case_id: 'case_demo_0001', decision: 'decline', subject: 'gb:00000001' });
    expect(raw.includes(guess)).toBe(false);
  });

  it('discloses only the classes the case owner opted out of', () => {
    const input = readJson('case-input.json');
    const built = buildPackage({
      case: input['case'],
      entries: input['entries'],
      privacy: { key: keyFromSeed(input['privacy']['key_seed']), keyId: 'k1', disclosed: ['approver'] },
    });
    expect(built.document['entries'][I_DEC1]['data']['approver']).toBe('user:approver-a');
    expect(isPseudonym(built.document['entries'][I_DEC1]['data']['action']['subject'])).toBe(true);
    expect(verifyPackage(built.data, { expectedRoot: built.root }).ok).toBe(true);
  });

  it('matches the shared pseudonym vectors', () => {
    const vectors = readJson('pseudonyms.json');
    const key = keyFromSeed(vectors['key_seed']);
    const content = vectors['content'] as Json;
    expect(keyedContentDigest(caseKey(key, content['tenant_id'], content['case_id']), content['digest'])).toBe(content['keyed']);
    const action = vectors['action'] as Json;
    expect(actionReference(caseKey(key, action['tenant_id'], action['case_id']), action['action_hash'])).toBe(action['action_ref']);
    for (const item of vectors['identifiers'] as Json[]) {
      expect(pseudonymise(key, item['tenant_id'], item['case_id'], item['class'], item['value'])).toBe(item['pseudonym']);
    }
  });

  it('refuses invalid records with the verifier rules', () => {
    const input = readJson('case-input.json');
    const entries = structuredClone(input['entries']) as Json[];
    entries[3]!['data']['notes'] = 'free text is not part of the format';
    expect(() => buildPackage({ case: input['case'], entries, privacy: { disclosed: [...IDENTIFIER_CLASSES] } }))
      .toThrowError(expect.objectContaining({ code: 'schema_violation', fieldPath: 'entries[3].data.notes' }) as Error);
    expect(() => buildPackage({ case: input['case'], entries: input['entries'], privacy: {} }))
      .toThrowError(expect.objectContaining({ code: 'privacy_violation' }) as Error);
  });
});

describe('verification', () => {
  it.each(['evidence-package.json', 'evidence-package-disclosed.json'])('%s verifies against its root', (name) => {
    const result = verifyPackage(read(name), { expectedRoot: expected[name]['root'] });
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(expected[name]['entry_count']);
  });

  it('checks and pins the anchor, and verifies the signature with the key set', () => {
    const pinned = verifyPackage(read('evidence-package.json'), {
      expectedRoot: expected['evidence-package.json']['root'],
      expectedAnchorHash: expected['evidence-package.json']['anchor_hash'],
      requireAnchor: true,
    });
    expect(pinned.ok && pinned.anchorStatus === 'pinned').toBe(true);
    const unpinned = verifyPackage(read('evidence-package.json'), { expectedRoot: expected['evidence-package.json']['root'] });
    expect([unpinned.anchorStatus, unpinned.unsourcedInputs, unpinned.lateEntries, unpinned.tenantAssertedEntries]).toEqual(['internal-consistency-only', 1, 1, 12]);
    const signed = verifyPackage(read('evidence-package-signed.json'), {
      expectedRoot: expected['evidence-package-signed.json']['root'],
      jwks: readJson('jwks.json'),
      requireSignature: true,
    });
    expect([signed.ok, signed.signatureStatus, signed.anchorStatus, signed.signatureKid]).toEqual([true, 'verified', 'signed', 'evidence-example-es256']);
  });

  const cases = (readJson('invalid-cases.json')['cases'] as Json[]);
  it.each(cases.map((c) => [c['name'] as string, c]))('reports the exact failing link: %s', (_name, testCase) => {
    const fixtureFiles = files();
    const result = verifyPackage(applyCase(testCase, fixtureFiles), verifyOptions(testCase, fixtureFiles));
    const json = verificationResultToJson(result);
    expect({
      code: json['code'], entry_index: json['entry_index'], field_path: json['field_path'], expected: json['expected'], actual: json['actual'],
    }).toEqual(testCase['expect']);
  });

  it('exercises every failure code in the shared cases', () => {
    const codes = new Set(cases.map((c) => c['expect']['code']));
    expect(Object.values(VerificationCode).filter((code) => !codes.has(code))).toEqual([]);
  });

  it('tampering with any field fails verification, with or without rehashing', () => {
    for (const name of ['evidence-package.json', 'evidence-package-signed.json']) {
      const document = readJson(name);
      const root = expected[name]['root'];
      const jwks = readJson('jwks.json');
      const leaves: Array<[Array<string | number>, unknown]> = [];
      const walk = (node: unknown, path: Array<string | number>): void => {
        if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
        else if (node !== null && typeof node === 'object') Object.entries(node).forEach(([k, v]) => walk(v, [...path, k]));
        else leaves.push([path, node]);
      };
      walk(document, []);
      expect(leaves.length).toBeGreaterThan(150);
      for (const [path, value] of leaves) {
        const mutated = structuredClone(document);
        let changed: unknown;
        if (typeof value === 'boolean') changed = !value;
        else if (typeof value === 'number') changed = Number.isInteger(value) ? value + 1 : value + 0.5;
        else if (typeof value === 'string') changed = value ? value.slice(0, -1) + (value.endsWith('0') ? '1' : '0') : 'x';
        else changed = 'x';
        parent(mutated, path)[path.at(-1)!] = changed;
        expect(verifyPackage(serializePackage(mutated), { expectedRoot: root, jwks }).ok, `${name} ${path.join('.')}`).toBe(false);
        const last = path.at(-1);
        if (path[0] === 'entries' && last !== 'hash' && last !== 'prev' && last !== 'seq') {
          rehashChain(mutated);
          expect(verifyPackage(serializePackage(mutated), { expectedRoot: root, jwks }).ok, `${name} ${path.join('.')} rehashed`).toBe(false);
        }
      }
    }
  }, 300_000);

  it('changing any byte of a package fails verification', () => {
    // The same sample as the Python SDK: root and leaf grant, run context, one
    // allowed call, the final decision call and the revocation.
    const input = readJson('case-input.json');
    const sample = buildPackage({
      case: input['case'],
      entries: [0, 1, 2, 3, 4, I_REVOKE].map((i) => input['entries'][i]),
      privacy: { key: keyFromSeed(input['privacy']['key_seed']), keyId: input['privacy']['key_id'], disclosed: [] },
    });
    const data = Buffer.from(sample.data);
    const root = sample.root;
    expect(verifyPackage(data, { expectedRoot: root }).ok).toBe(true);
    for (let position = 0; position < data.length; position++) {
      for (const mask of [0x01, 0x20]) {
        const mutated = Buffer.from(data);
        mutated[position] = mutated[position]! ^ mask;
        expect(verifyPackage(mutated, { expectedRoot: root }).ok, `byte ${position} mask ${mask}`).toBe(false);
      }
    }
  }, 300_000);

  it('e2e step 8: export, verify, corrupt one byte, verification fails', () => {
    const data = read('evidence-package.json');
    const root = expected['evidence-package.json']['root'];
    expect(verifyPackage(data, { expectedRoot: root }).ok).toBe(true);
    const corrupted = Buffer.from(data);
    corrupted[Math.floor(data.length / 2)] = corrupted[Math.floor(data.length / 2)]! ^ 0x04;
    const result = verifyPackage(corrupted, { expectedRoot: root });
    expect(result.ok).toBe(false);
    expect(result.code).not.toBeNull();
  });
});

describe('auditor, anchors and signatures', () => {
  it('an auditor identifies every upstream record behind a recommendation from the package alone', () => {
    expect(verifyPackage(read('evidence-package-disclosed.json'), { expectedRoot: expected['evidence-package-disclosed.json']['root'] }).ok).toBe(true);
    const records = upstreamRecordsFor(readJson('evidence-package-disclosed.json'), 'rec_0001');
    expect(records.map((r) => [r.call_id, r.tool, r.provider, r.record_id])).toEqual([
      ['call_0001', 'resolve_business', 'mock', 'mock:registry:00000001'],
      ['call_0002', 'verify_business', 'mock', 'mock:verification:v-0001'],
      ['call_0002', 'verify_business', 'mock', 'mock:officers:00000001'],
      ['call_0003', 'ownership', 'mock', 'mock:ownership:g-0001'],
      ['call_0004', 'screen_person', 'mock', 'mock:screening:hit-0001'],
    ]);
    expect(records[3]!.cited_by).toEqual([`entries[${I_REC}].data.sections[2].evidence[0]`, `entries[${I_EVAL}].data.inputs[1].evidence[0]`]);
    const input = readJson('case-input.json');
    const pseudonymised = upstreamRecordsFor(readJson('evidence-package.json'), 'rec_0001');
    expect(pseudonymised.map((r) => r.record_id)).toEqual(records.map((r) => pseudonymise(keyFromSeed(input['privacy']['key_seed']), 'dev_demo_0001', 'case_demo_0001', 'record', r.record_id)));
  });

  it('anchor hash uses the auth-service audit layout', () => {
    const text = '{"id":"alog_TEST01","agentId":"ag_01","agentDid":"did:grantex:ag_01","grantId":"grnt_01",'
      + '"principalId":"user_01","developerId":"dev_TEST","action":"tool.run",'
      + '"metadata":{"alpha":{"bravo":[3,2],"yankee":true},"zebra":1},'
      + '"timestamp":"2026-08-14T00:00:00.000Z","prevHash":null,"status":"success"}';
    expect(auditEntryHash({
      id: 'alog_TEST01', agentId: 'ag_01', agentDid: 'did:grantex:ag_01', grantId: 'grnt_01', principalId: 'user_01',
      developerId: 'dev_TEST', action: 'tool.run', metadata: { zebra: 1, alpha: { yankee: true, bravo: [3, 2] } },
      timestamp: '2026-08-14T00:00:00.000Z', prevHash: null, status: 'success',
    })).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('decision action hash matches the decision-grant profile', () => {
    const action = { case_id: 'case_8841', action: 'case_decision', decision: 'approve', subject: 'gb:12345678' };
    const raw = createHash('sha256').update('{"action":"case_decision","case_id":"case_8841","decision":"approve","subject":"gb:12345678"}').digest('base64url');
    expect(decisionActionHash(action)).toBe(`sha256:${raw}`);
  });

  it.each(['ES256', 'RS256'] as const)('detached %s signature round trip', (alg) => {
    const document = readJson('evidence-package-disclosed.json');
    const root = expected['evidence-package-disclosed.json']['root'];
    const pair = (): { privateKey: KeyObject; publicKey: KeyObject } => (alg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 }));
    const { privateKey, publicKey } = pair();
    const signature = signRoot(root, privateKey, 'kid-1');
    expect(signature.alg).toBe(alg);
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1' };
    const signed = serializePackage(attachSignature(document, signature));
    expect(verifyPackage(signed, { expectedRoot: root, jwks: { keys: [jwk] } }).ok).toBe(true);
    const forged = serializePackage(attachSignature(document, signRoot(root, pair().privateKey, 'kid-1')));
    expect(verifyPackage(forged, { expectedRoot: root, jwks: { keys: [jwk] } }).code).toBe('signature_invalid');
    // A package signed by the Python SDK verifies here too.
    expect(verifyPackage(read('evidence-package-signed.json'), { expectedRoot: expected['evidence-package-signed.json']['root'], jwks: readJson('jwks.json') }).ok).toBe(true);
  });

  it('refuses non-canonical base64 in a signature', () => {
    const document = readJson('evidence-package-signed.json');
    const [head, sig] = (document['signature']['jws'] as string).split('..') as [string, string];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig.at(-1)!);
    const sibling = alphabet[Math.floor(last / 4) * 4 + ((last % 4) + 1) % 4]!;
    expect(Buffer.from(sig.slice(0, -1) + sibling, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    document['signature']['jws'] = `${head}..${sig.slice(0, -1)}${sibling}`;
    const result = verifyPackage(serializePackage(document), { expectedRoot: expected['evidence-package-signed.json']['root'], jwks: readJson('jwks.json') });
    expect(result.code).toBe('signature_invalid');
  });
});
