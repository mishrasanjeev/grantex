/** Evidence package verification (spec/evidence-package.md, "Verification"). */
import { checkChain, checkPrivacy, checkSemantics, type SemanticSummary } from './checks.js';
import { DEFAULT_MAX_BYTES, parseCanonical } from './document.js';
import { PLATFORM_MARKER, auditEntryHash } from './hashing.js';
import { VerificationCode as Code, VerificationFailure, type VerificationResult } from './result.js';
import { validate } from './schema.js';
import { verifySignature } from './signature.js';

export const FORMAT = 'grantex-evidence-package';
export const SUPPORTED_VERSIONS: readonly string[] = ['1.0'];

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const AUDIT_HASH = /^[0-9a-f]{64}$/;
const ENTRY_PATH = /^entries\[([0-9]+)\]/;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface VerifyOptions {
  /** The package root obtained independently of the package. Required. */
  expectedRoot: string | null | undefined;
  /** The anchor audit entry hash obtained independently (optional). */
  expectedAnchorHash?: string;
  requireAnchor?: boolean;
  /** JSON Web Key Set used to verify the service signature. */
  jwks?: unknown;
  requireSignature?: boolean;
  /** Accept a signed package without checking the signature. */
  allowUnverifiedSignature?: boolean;
  maxBytes?: number;
}

/** Run every check that needs only the document (no trust inputs). */
export function checkDocument(pkg: unknown): SemanticSummary {
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new VerificationFailure(Code.SCHEMA_VIOLATION, 'package must be a JSON object', { fieldPath: '$' });
  }
  const doc = pkg as Json;
  if (doc['format'] !== FORMAT) {
    throw new VerificationFailure(Code.UNSUPPORTED_FORMAT, `format must be ${FORMAT}`, {
      fieldPath: 'format', expected: FORMAT, actual: typeof doc['format'] === 'string' ? doc['format'] : null,
    });
  }
  if (!SUPPORTED_VERSIONS.includes(doc['version'])) {
    throw new VerificationFailure(Code.UNSUPPORTED_VERSION, 'unsupported package version', {
      fieldPath: 'version', expected: SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1] ?? null,
      actual: typeof doc['version'] === 'string' ? doc['version'] : null,
    });
  }
  validate(doc);
  checkPrivacy(doc);
  checkChain(doc);
  return checkSemantics(doc);
}

function checkAnchor(pkg: Json, expectedAnchorHash: string | undefined, requireAnchor: boolean): string | null {
  const anchor = pkg['anchor'] as Json | undefined;
  if (anchor === undefined) {
    if (requireAnchor || expectedAnchorHash !== undefined) throw new VerificationFailure(Code.ANCHOR_MISSING, 'package has no anchor', { fieldPath: 'anchor' });
    return null;
  }
  const audit = anchor['audit_entry'] as Json;
  const computed = auditEntryHash(audit);
  if (audit['hash'] !== computed) {
    throw new VerificationFailure(Code.ANCHOR_HASH_MISMATCH, 'anchor audit entry does not match its hash', {
      fieldPath: 'anchor.audit_entry.hash', expected: computed, actual: audit['hash'],
    });
  }
  const chain = pkg['chain'] as Json;
  const kase = pkg['case'] as Json;
  const metadata = audit['metadata'] as Json;
  const comparisons: Array<[string, unknown, unknown]> = [
    ['anchor.audit_entry.developerId', kase['tenant_id'], audit['developerId']],
    ['anchor.audit_entry.metadata.case_id', kase['case_id'], metadata['case_id']],
    ['anchor.audit_entry.metadata.entry_count', chain['length'], metadata['entry_count']],
    [`anchor.audit_entry.metadata["${PLATFORM_MARKER}"]`, true, metadata[PLATFORM_MARKER]],
    ['anchor.audit_entry.metadata.package_root', chain['root'], metadata['package_root']],
  ];
  for (const [path, expected, actual] of comparisons) {
    if (expected !== actual) {
      throw new VerificationFailure(Code.ANCHOR_MISMATCH, 'anchor audit entry records a different package', {
        fieldPath: path, expected: pyString(expected), actual: pyString(actual),
      });
    }
  }
  if (expectedAnchorHash !== undefined && audit['hash'] !== expectedAnchorHash) {
    throw new VerificationFailure(Code.ANCHOR_NOT_TRUSTED, 'anchor audit entry is not the trusted one', {
      fieldPath: 'anchor.audit_entry.hash', expected: expectedAnchorHash, actual: audit['hash'],
    });
  }
  return audit['hash'] as string;
}

/** `str()` as Python writes the scalars an anchor comparison can hold. */
function pyString(value: unknown): string {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  return String(value);
}

/**
 * Verify evidence package bytes against a trusted root. Fails closed: `ok`
 * only if every check passes; otherwise the result names the first failed
 * check and where. A matching root and anchor prove internal consistency;
 * only a verified service signature (`jwks`) proves the auth service exported
 * the package. A string is taken as the package's UTF-8 text.
 */
export function verifyPackage(data: Uint8Array | string, options: VerifyOptions): VerificationResult {
  let root: string | null = null;
  let count: number | null = null;
  let anchorStatus: VerificationResult['anchorStatus'] = 'absent';
  let signatureStatus: VerificationResult['signatureStatus'] = 'absent';
  let signatureKid: string | null = null;
  let summary: SemanticSummary;
  try {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const expectedRoot = options.expectedRoot;
    if (typeof expectedRoot !== 'string' || !DIGEST.test(expectedRoot)) {
      throw new VerificationFailure(Code.MISSING_ROOT, 'a trusted root (sha256:<64 hex>) is required to verify a package', {
        expected: 'sha256:<64 lower-case hex digits>', actual: typeof expectedRoot === 'string' ? expectedRoot : null,
      });
    }
    if (options.expectedAnchorHash !== undefined && !AUDIT_HASH.test(options.expectedAnchorHash)) {
      throw new VerificationFailure(Code.ANCHOR_NOT_TRUSTED, 'trusted anchor hash must be 64 lower-case hex digits', { actual: options.expectedAnchorHash });
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
    const pkg = parseCanonical(bytes, maxBytes);
    summary = checkDocument(pkg);
    const doc = pkg as Json;
    root = doc['chain']['root'] as string;
    count = doc['chain']['length'] as number;
    if (root !== expectedRoot) {
      throw new VerificationFailure(Code.ROOT_NOT_TRUSTED, 'package root is not the trusted root', { fieldPath: 'chain.root', expected: expectedRoot, actual: root });
    }
    const anchorHash = checkAnchor(doc, options.expectedAnchorHash, options.requireAnchor ?? false);
    if (anchorHash !== null) anchorStatus = options.expectedAnchorHash !== undefined ? 'pinned' : 'internal-consistency-only';
    const signature = doc['signature'] as Json | undefined;
    if (signature === undefined) {
      if (options.requireSignature) throw new VerificationFailure(Code.SIGNATURE_MISSING, 'package is not signed', { fieldPath: 'signature' });
    } else if (options.jwks === undefined || options.jwks === null) {
      if (!options.allowUnverifiedSignature) {
        throw new VerificationFailure(Code.SIGNATURE_UNVERIFIED, 'package is signed but no key set was given to verify it', { fieldPath: 'signature' });
      }
      signatureStatus = 'unchecked';
    } else {
      verifySignature(signature, root, anchorHash, options.jwks);
      signatureStatus = 'verified';
      signatureKid = signature['kid'] as string;
      if (anchorHash !== null) anchorStatus = 'signed';
    }
  } catch (err) {
    if (!(err instanceof VerificationFailure)) throw err;
    let entryIndex = err.entryIndex;
    if (entryIndex === null && err.fieldPath !== null) {
      const located = ENTRY_PATH.exec(err.fieldPath);
      if (located) entryIndex = Number(located[1]);
    }
    return {
      ok: false, code: err.code, message: err.message, entryIndex, fieldPath: err.fieldPath,
      expected: err.expected, actual: err.actual, root, entryCount: count,
      anchorStatus: 'absent', signatureStatus: 'absent', signatureKid: null,
      unsourcedInputs: 0, lateEntries: 0, tenantAssertedEntries: 0,
    };
  }
  return {
    ok: true, code: null, message: 'package verified', entryIndex: null, fieldPath: null, expected: null, actual: null,
    root, entryCount: count, anchorStatus, signatureStatus, signatureKid,
    unsourcedInputs: summary.unsourcedInputs, lateEntries: summary.lateEntries, tenantAssertedEntries: summary.tenantAssertedEntries,
  };
}
