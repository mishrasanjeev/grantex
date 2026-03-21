/**
 * Ed25519 cryptographic utilities for GDT signing and verification.
 *
 * Uses @noble/ed25519 for key operations and `jose` for JWT encoding.
 */

import * as ed from '@noble/ed25519';
import { importJWK, exportJWK, SignJWT, jwtVerify, type JWK, type KeyLike } from 'jose';
import { publicKeyToDID, didToPublicKey } from './did.js';
import type { Ed25519KeyPair } from './types.js';

// noble/ed25519 v2 requires sha-512; use the Web Crypto shim.
// @ts-ignore — @noble/hashes exports sha2 with .js extension in its package.json exports map
import { sha512 } from '@noble/hashes/sha2.js';
ed.etc.sha512Sync = (...m: Uint8Array[]) => {
  const h = sha512.create();
  for (const msg of m) h.update(msg);
  return h.digest();
};

/**
 * Generate a fresh Ed25519 key pair.
 */
export function generateKeyPair(): Ed25519KeyPair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  const did = publicKeyToDID(publicKey);
  return { privateKey, publicKey, did };
}

/**
 * Derive the public key and DID from a 32-byte private key seed.
 */
export function derivePublicKey(privateKey: Uint8Array): { publicKey: Uint8Array; did: string } {
  const publicKey = ed.getPublicKey(privateKey);
  return { publicKey, did: publicKeyToDID(publicKey) };
}

/**
 * Build a JWK for the Ed25519 private key (for jose SignJWT).
 */
export function privateKeyToJWK(privateKey: Uint8Array, publicKey: Uint8Array): JWK {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    d: uint8ToBase64url(privateKey),
    x: uint8ToBase64url(publicKey),
  };
}

/**
 * Build a JWK for the Ed25519 public key (for jose jwtVerify).
 */
export function publicKeyToJWK(publicKey: Uint8Array): JWK {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: uint8ToBase64url(publicKey),
  };
}

/**
 * Import a private JWK into a KeyLike for jose signing.
 */
export async function importPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array): Promise<KeyLike | Uint8Array> {
  const jwk = privateKeyToJWK(privateKey, publicKey);
  return importJWK(jwk, 'EdDSA');
}

/**
 * Import a public JWK into a KeyLike for jose verification.
 */
export async function importPublicKey(publicKey: Uint8Array): Promise<KeyLike | Uint8Array> {
  const jwk = publicKeyToJWK(publicKey);
  return importJWK(jwk, 'EdDSA');
}

/**
 * Import a public key from a DID for verification.
 */
export async function importPublicKeyFromDID(did: string): Promise<KeyLike | Uint8Array> {
  const publicKey = didToPublicKey(did);
  return importPublicKey(publicKey);
}

/**
 * Sign a JWT payload with an Ed25519 private key.
 */
export async function signJWT(
  payload: Record<string, unknown>,
  privateKey: Uint8Array,
): Promise<string> {
  const publicKey = ed.getPublicKey(privateKey);
  const key = await importPrivateKey(privateKey, publicKey);
  return new SignJWT(payload as never)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .sign(key);
}

/**
 * Verify and decode a JWT signed with EdDSA, given the issuer's public key.
 */
export async function verifyJWT(
  token: string,
  publicKey: Uint8Array,
): Promise<Record<string, unknown>> {
  const key = await importPublicKey(publicKey);
  const { payload } = await jwtVerify(token, key, { algorithms: ['EdDSA'] });
  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function uint8ToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
