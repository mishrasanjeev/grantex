// SPDX-License-Identifier: Apache-2.0
//
// SD-JWT framing, disclosures and digests (RFC 9901), and the hash rule.

import { createHash } from 'node:crypto';
import { b64urlEncode, b64urlJson, isObject } from './base64url.ts';
import { malformed } from './errors.ts';

/** The only digest algorithm the profile uses (RFC 9901 section 4.1.1; IANA Named Information Hash Algorithm). */
export const SD_ALG = 'sha-256';

export interface SplitSdJwt {
  issuerJwt: string;
  disclosures: string[];
  /** The Key Binding JWT, or '' when there is none. */
  kbJwt: string;
}

/**
 * RFC 9901 section 4: <Issuer-signed JWT>~<Disclosure 1>~...~<Disclosure N>~<optional KB-JWT>.
 * Without a KB-JWT the last element is empty and the trailing tilde is not omitted.
 */
export function splitSdJwt(compact: string): SplitSdJwt {
  if (typeof compact !== 'string') throw malformed('not_sd_jwt', 'an SD-JWT is a string');
  const parts = compact.split('~');
  if (parts.length < 2) throw malformed('not_sd_jwt', 'an SD-JWT has at least one tilde');
  const disclosures = parts.slice(1, -1);
  if (parts[0] === '' || disclosures.some((d) => d === '')) {
    throw malformed('not_sd_jwt', 'an SD-JWT has no empty elements before the last tilde');
  }
  return { issuerJwt: parts[0] as string, disclosures, kbJwt: parts[parts.length - 1] as string };
}

/** base64url(sha-256(US-ASCII bytes)): RFC 9901 section 4.2.3 (digests) and section 4.3.1 (sd_hash). */
export function sha256b64url(ascii: string): string {
  return createHash('sha256').update(ascii, 'ascii').digest('base64url');
}

/** The digest of an encoded disclosure, over its US-ASCII bytes (RFC 9901 section 4.2.3). */
export function disclosureDigest(encoded: string): string {
  return sha256b64url(encoded);
}

/**
 * Encode a disclosure: base64url of the UTF-8 JSON array [salt, name, value]
 * for an object property (RFC 9901 section 4.2.1), or [salt, value] for an
 * array element (section 4.2.2) when name is undefined.
 */
export function encodeDisclosure(salt: string, name: string | undefined, value: unknown): string {
  const array = name === undefined ? [salt, value] : [salt, name, value];
  return b64urlEncode(JSON.stringify(array));
}

const JWS_SEGMENTS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The hash rule: 'sha-256:' + base64url(sha-256(the ASCII bytes of the
 * issuer-signed JWT)), the part before the first '~'. Disclosures and the
 * KB-JWT are never hashed, so every presentation of one passport has the same
 * hash whatever the holder disclosed.
 */
export function externalCredentialHash(compact: string): string {
  const end = typeof compact === 'string' ? compact.indexOf('~') : -1;
  if (end < 0) throw malformed('not_sd_jwt', 'the hash rule takes an SD-JWT (issuer-signed JWT followed by ~)');
  const issuerJwt = compact.slice(0, end);
  if (!JWS_SEGMENTS.test(issuerJwt)) throw malformed('not_sd_jwt', 'the issuer-signed JWT is not a compact JWS');
  return `${SD_ALG}:${sha256b64url(issuerJwt)}`;
}

export interface DecodedDisclosure {
  encoded: string;
  digest: string;
  salt: string;
  /** Absent for an array element disclosure. */
  name?: string;
  value: unknown;
}

export function decodeDisclosure(encoded: string): DecodedDisclosure {
  const array = b64urlJson(encoded)?.value;
  if (!Array.isArray(array) || (array.length !== 2 && array.length !== 3) || typeof array[0] !== 'string') {
    throw malformed('disclosure_malformed', 'a disclosure is base64url JSON [salt, name, value] or [salt, value]');
  }
  const digest = disclosureDigest(encoded);
  if (array.length === 2) return { encoded, digest, salt: array[0], value: array[1] };
  if (typeof array[1] !== 'string') throw malformed('disclosure_malformed', 'a disclosure claim name is a string');
  return { encoded, digest, salt: array[0], name: array[1], value: array[2] };
}

/** Define an own property, so a claim named __proto__ is a claim and not the object's prototype. */
function setClaim(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Rebuild the claims from the payload and the disclosures (RFC 9901 section
 * 7.1 steps 3 to 5): each digest in _sd (or in a {"...": digest} array
 * element) is replaced by its disclosure, recursively; digests without a
 * disclosure are dropped; a digest seen twice, a disclosure presented twice or
 * never referenced, and a claim name that is reserved or already present are
 * refused.
 */
export function processDisclosures(
  payload: Record<string, unknown>,
  encodedDisclosures: readonly string[],
  reservedTopLevel: ReadonlySet<string>,
): { claims: Record<string, unknown>; disclosures: DecodedDisclosure[] } {
  const seenEncoded = new Set<string>();
  for (const encoded of encodedDisclosures) {
    if (seenEncoded.has(encoded)) throw malformed('duplicate_disclosure', 'a disclosure appears more than once');
    seenEncoded.add(encoded);
  }
  const decoded = encodedDisclosures.map(decodeDisclosure);
  const byDigest = new Map(decoded.map((d) => [d.digest, d]));
  const seenDigests = new Set<string>();
  const used = new Set<string>();

  const takeDigest = (digest: unknown): DecodedDisclosure | undefined => {
    if (typeof digest !== 'string') throw malformed('bad_claim', 'a digest is a string');
    // Step 4: a digest may appear only once, directly or through other disclosures.
    if (seenDigests.has(digest)) throw malformed('duplicate_digest', 'a digest appears more than once');
    seenDigests.add(digest);
    const disclosure = byDigest.get(digest);
    if (disclosure !== undefined) used.add(digest);
    return disclosure;
  };

  const processValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return processArray(value);
    if (isObject(value)) return processObject(value, false);
    return value;
  };

  const processArray = (array: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const element of array) {
      if (isObject(element) && Object.keys(element).length === 1 && Object.hasOwn(element, '...')) {
        // Step 3.4: an array element digest, removed when not disclosed.
        const disclosure = takeDigest(element['...']);
        if (disclosure === undefined) continue;
        if (disclosure.name !== undefined) {
          throw malformed('disclosure_malformed', 'an array element digest refers to an object property disclosure');
        }
        out.push(processValue(disclosure.value));
      } else {
        out.push(processValue(element));
      }
    }
    return out;
  };

  const processObject = (object: Record<string, unknown>, topLevel: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(object)) {
      if (name === '_sd' || (topLevel && name === '_sd_alg')) continue;
      setClaim(out, name, processValue(value));
    }
    if (!Object.hasOwn(object, '_sd')) return out;
    const sd = object._sd;
    if (!Array.isArray(sd)) throw malformed('bad_claim', '_sd is an array of digests');
    for (const digest of sd) {
      const disclosure = takeDigest(digest);
      if (disclosure === undefined) continue; // a decoy digest, or a claim the holder withheld
      if (disclosure.name === undefined) {
        throw malformed('disclosure_malformed', 'an _sd digest refers to an array element disclosure');
      }
      const name = disclosure.name;
      // Step 3.3.2.2.2 (_sd and ...) and SD-JWT VC section 2.2.2.3 (claims that must not be disclosed).
      if (name === '_sd' || name === '...' || (topLevel && reservedTopLevel.has(name))) {
        throw malformed('disclosure_name_not_allowed', `claim ${name} cannot be selectively disclosed`);
      }
      // Step 3.3.2.2.3: the claim name must not already exist at this level.
      if (Object.hasOwn(object, name) || Object.hasOwn(out, name)) {
        throw malformed('claim_name_conflict', `claim ${name} is both in the clear and disclosed`);
      }
      setClaim(out, name, processValue(disclosure.value));
    }
    return out;
  };

  const claims = processObject(payload, true);
  // Step 5: every disclosure must have been referenced.
  for (const d of decoded) {
    if (!used.has(d.digest)) {
      throw malformed('disclosure_not_referenced', 'a disclosure is not referenced by any digest');
    }
  }
  return { claims, disclosures: decoded };
}

/** Keep only the top-level disclosures of the named claims, to build a presentation. */
export function selectDisclosures(compact: string, claimNames: readonly string[]): string {
  const { issuerJwt, disclosures, kbJwt } = splitSdJwt(compact);
  if (kbJwt !== '') {
    throw malformed('unexpected_key_binding', 'select disclosures before adding a Key Binding JWT');
  }
  const wanted = new Set(claimNames);
  const kept = disclosures.filter((encoded) => {
    const d = decodeDisclosure(encoded);
    return d.name !== undefined && wanted.has(d.name);
  });
  return `${issuerJwt}~${kept.map((d) => `${d}~`).join('')}`;
}
