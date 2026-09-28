// SPDX-License-Identifier: Apache-2.0
import { createHash, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentJwk } from '../src/index.js';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface VectorRequest {
  method: string;
  url: string;
  body: string;
  headers?: [string, string][];
}

export interface SignVector {
  name: string;
  key: string;
  request: VectorRequest;
  presentations: { agent_passport: string; agent_grant: string; agent_trust?: string };
  params: { created: number; expires: number; nonce: string; label: string };
  signature_base: string;
  headers: [string, string][];
}

export interface VerifyVector {
  name: string;
  key: string;
  key_known: boolean;
  request: Required<VectorRequest>;
  expected_authority: string;
  now: number;
  seen_nonces: [string, string][];
  expected: { ok: true } | { ok: false; code: string; reason: string };
}

export interface RfcVector {
  section: string;
  message:
    | { kind: 'request'; method: string; url: string; headers: [string, string][]; body: string }
    | { kind: 'response'; status: number; headers: [string, string][]; body: string };
  signature_input: string;
  signature: string;
  label: string;
  signature_base: string;
  verify?: { alg: string; public_jwk: AgentJwk };
}

export interface Vectors {
  profile: {
    tag: string;
    covered_components: string[];
    parameters: string[];
    max_window_seconds: number;
    default_clock_skew_seconds: number;
    inline_presentation_max_octets: number;
  };
  keys: Record<string, { seed_label?: string; public_jwk: AgentJwk; thumbprint: string }>;
  thumbprints: { jwk: AgentJwk; thumbprint: string }[];
  content_digest: { body: string; field: string }[];
  sign: SignVector[];
  ecdsa: SignVector[];
  verify: VerifyVector[];
  rfc9421: RfcVector[];
}

export const vectors: Vectors = JSON.parse(
  readFileSync(`${repoRoot}spec/examples/agent-httpsig-vectors.json`, 'utf8'),
) as Vectors;

// Ed25519 test key of the vectors: seed = SHA-256(UTF-8(seed_label)),
// imported as PKCS #8 (RFC 8410 section 7) and exported as a JWK.
export function vectorPrivateKey(name: string): AgentJwk {
  const label = vectors.keys[name]?.seed_label;
  if (!label) throw new Error(`vector key ${name} has no seed`);
  const seed = createHash('sha256').update(label, 'utf8').digest();
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
}
