/**
 * Remote JWK Sets, fetched within fixed bounds, and the did:web issuers that
 * locate them. Grant-token and decision-grant verification both read keys
 * through here.
 */
import { createRemoteJWKSet, customFetch, type FetchImplementation, type RemoteJWKSet } from 'jose';
import { GrantexTokenError } from './errors.js';

// The key set comes from whoever the verifier was pointed at, so the fetch is
// bounded like any other untrusted response, with the same limits as the
// Python SDK. 64 KiB holds the auth service's default set many times over.
// The key cap keeps the per-token key search small when the keys are small
// (64 KiB holds some 350 EC keys). It is 128 rather than lower because the
// auth service publishes its legacy RSA key under one kid alias per month of
// JWT_LEGACY_KID_MONTHS (13 by default, up to 120) beside its signing keys,
// so a set of several dozen keys is an ordinary configuration.

/** Largest JWK Set response read, in bytes, measured after content decoding. */
export const JWKS_MAX_BYTES = 64 * 1024;
/** Most keys a JWK Set may hold. */
export const JWKS_MAX_KEYS = 128;
/** Deadline for the whole fetch, headers and body, in milliseconds. */
export const JWKS_FETCH_TIMEOUT_MS = 5_000;

// RFC 8259 §11 registers application/json; RFC 7517 §8.5.1 registers
// application/jwk-set+json.
const JWKS_MEDIA_TYPES = new Set(['application/json', 'application/jwk-set+json']);

/**
 * `application/json` or `application/jwk-set+json`, compared without case
 * (RFC 9110 §8.3.1), with at most a UTF-8 charset parameter: JSON exchanged
 * between systems is UTF-8 (RFC 8259 §8.1).
 */
function isJwksMediaType(contentType: string): boolean {
  const [mediaType = '', ...parameters] = contentType.split(';');
  if (!JWKS_MEDIA_TYPES.has(mediaType.trim().toLowerCase())) return false;
  return parameters.every((parameter) => {
    if (parameter.trim() === '') return true;
    const separator = parameter.indexOf('=');
    const name = (separator < 0 ? parameter : parameter.slice(0, separator)).trim().toLowerCase();
    const value = separator < 0 ? '' : parameter.slice(separator + 1).trim().replace(/^"|"$/g, '').toLowerCase();
    return name === 'charset' && value === 'utf-8';
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JOSE's fetch step with the bounds applied. JOSE starts
 * `AbortSignal.timeout(timeoutDuration)` before calling it and passes that
 * signal in, so the one deadline covers the body as well as the headers. Every
 * refusal is thrown: JOSE then has no keys, and a verifier without keys
 * refuses the token.
 */
const boundedFetch: FetchImplementation = async (url, init) => {
  const refuse = (reason: string) => new GrantexTokenError(`Failed to fetch JWKS from ${url}: ${reason}`);
  const timedOut = () => refuse(`no complete response within ${JWKS_FETCH_TIMEOUT_MS} ms`);
  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const tooLarge = `the response is larger than ${JWKS_MAX_BYTES} bytes`;

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw init.signal.aborted ? timedOut() : refuse(describe(err));
  }
  const body = response.body;
  const discard = () => {
    // Nothing more is read from a refused response; release its connection.
    body?.cancel().catch(() => undefined);
  };
  // Only a 200 carries the key set. JOSE asks fetch not to follow redirects,
  // so the URL the caller configured is the one trusted.
  if (response.status !== 200) {
    discard();
    throw refuse(`HTTP ${response.status}; expected 200`);
  }
  const contentType = response.headers.get('content-type');
  if (contentType === null || !isJwksMediaType(contentType)) {
    discard();
    throw refuse(`Content-Type ${JSON.stringify(contentType)} is not application/json or application/jwk-set+json`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > JWKS_MAX_BYTES) {
    discard();
    throw refuse(tooLarge);
  }
  if (body === null) throw refuse('the response has no body');

  // A fetch implementation that ignores the signal once the headers are in
  // must not hold the verifier past the deadline either, so every read races
  // the signal.
  const reader = body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(timedOut());
    if (init.signal.aborted) onAbort();
    else init.signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      // Counted as it arrives, so a response without a Content-Length, or
      // one that decodes to more than it declared, stops at the cap.
      if (size > JWKS_MAX_BYTES) throw refuse(tooLarge);
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof GrantexTokenError) throw err;
    throw init.signal.aborted ? timedOut() : refuse(describe(err));
  } finally {
    if (onAbort !== undefined) init.signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  let jwks: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    jwks = JSON.parse(text);
  } catch (err) {
    throw refuse(`the response is not UTF-8 JSON: ${describe(err)}`);
  }
  // RFC 7517 §5: a JWK Set is a JSON object whose "keys" member is an array.
  if (!isPlainObject(jwks) || !Array.isArray(jwks['keys'])) {
    throw refuse('the response is not a JWK Set');
  }
  if (jwks['keys'].length > JWKS_MAX_KEYS) {
    throw refuse(`the key set has ${jwks['keys'].length} keys; the limit is ${JWKS_MAX_KEYS}`);
  }
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
};

/**
 * A JOSE remote key set for `url`, fetched within `JWKS_MAX_BYTES`,
 * `JWKS_MAX_KEYS` and `JWKS_FETCH_TIMEOUT_MS`. JOSE's cache, cooldown and
 * unknown-`kid` refresh are unchanged (10 minutes, 30 seconds).
 */
export function createBoundedRemoteJWKSet(url: URL): RemoteJWKSet {
  return createRemoteJWKSet(url, {
    timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
    [customFetch]: boundedFetch,
  });
}

const DID_WEB_PREFIX = 'did:web:';
// DID Core allows no Unicode in a method-specific identifier (did:web §3.5).
const NON_ASCII = /[^\x00-\x7f]/;
// ASCII letters, digits and hyphens, spelled out rather than matched without
// case, so the rule does not depend on a regular expression engine's case
// folding and reads the same as the Python SDK's.
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// A last label a URL parser reads as a number makes the host an IPv4 address
// (WHATWG URL, "ends in a number"): 127.1, 0x7f.0.0.1, 2130706433.
const NUMERIC_LABEL = /^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;
// DID Core idchar without pct-encoded: an encoded "/" or "." could turn a
// segment into a separator or a traversal once the URL is built.
const DID_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PORT = /^[1-9][0-9]{0,4}$/;
// Names that only mean something on this host or this network: localhost
// (RFC 6761 §6.3), .local (RFC 6762 §3), .home.arpa (RFC 8375 §3) and
// .internal (reserved by ICANN for private use in 2024).
const LOCAL_ONLY_DOMAINS = ['localhost', 'local', 'home.arpa', 'internal'];

/**
 * The JWKS URL and expected issuer for a `did:web` issuer.
 *
 * did:web Method Specification §2.3 (Method-specific identifier): a fully
 * qualified domain name that MUST NOT include IP addresses, an optional port
 * whose colon MUST be percent-encoded, and optional path segments delimited
 * by colons. §2.5.2 (Read): replace ":" with "/", then percent-decode the
 * port's colon. The key set is read from `/.well-known/jwks.json` under that
 * location, as before, rather than from its `did.json`.
 *
 * §3.5 (International Domain Names): DID Core syntax allows no Unicode in a
 * method-specific identifier, so an internationalized domain appears in its
 * IDNA A-label (`xn--`) form (RFC 5890 §2.3.2.1). Any other non-ASCII
 * character is refused rather than mapped: UTS #46 mapping would fetch keys
 * from a host the DID does not spell (the Kelvin sign becomes "k", "。"
 * becomes "."), while the expected issuer keeps the original spelling.
 *
 * The DID decides whose keys are trusted, so anything the method does not
 * allow, and any host that names this machine or a private network, is
 * refused before a request is made. The Python SDK applies the same checks in
 * the same order.
 *
 * @throws {GrantexTokenError} if `issuerDid` is not such an identifier.
 */
export function resolveDidWebIssuer(issuerDid: string): { jwksUri: string; issuer: string } {
  const refuse = (reason: string) =>
    new GrantexTokenError(`issuerDid ${JSON.stringify(issuerDid)} cannot be used: ${reason}`);

  if (typeof issuerDid !== 'string' || !issuerDid.startsWith(DID_WEB_PREFIX)) {
    throw refuse('it must be a did:web identifier');
  }
  const identifier = issuerDid.slice(DID_WEB_PREFIX.length);
  if (NON_ASCII.test(identifier)) {
    throw refuse('a DID is written in ASCII; give an internationalized domain name in its A-label (xn--) form');
  }
  if (identifier.includes('@') || identifier.toLowerCase().includes('%40')) {
    throw refuse('a did:web identifier carries no user information');
  }
  const [hostPart = '', ...path] = identifier.split(':');
  if (hostPart.startsWith('[') || hostPart.toLowerCase().startsWith('%5b')) {
    throw refuse('the host must be a domain name, not an IP address');
  }
  let host = hostPart;
  let port: string | undefined;
  const encodedColon = hostPart.toLowerCase().indexOf('%3a');
  if (encodedColon >= 0) {
    host = hostPart.slice(0, encodedColon);
    port = hostPart.slice(encodedColon + 3);
    if (!PORT.test(port) || Number(port) > 65535) {
      throw refuse(`the port ${JSON.stringify(port)} must be a number from 1 to 65535`);
    }
  }
  const labels = host.split('.');
  if (host.length > 253 || !labels.every((label) => DNS_LABEL.test(label))) {
    throw refuse(`the host ${JSON.stringify(host)} is not a valid domain name`);
  }
  if (NUMERIC_LABEL.test(labels[labels.length - 1] ?? '')) {
    throw refuse('the host must be a domain name, not an IP address');
  }
  const lowered = host.toLowerCase();
  if (LOCAL_ONLY_DOMAINS.some((name) => lowered === name || lowered.endsWith(`.${name}`))) {
    throw refuse(`the host ${JSON.stringify(host)} is local to a machine or private network`);
  }
  if (labels.length < 2) {
    throw refuse(`the host ${JSON.stringify(host)} must be a fully qualified domain name`);
  }
  for (const segment of path) {
    if (segment === '.' || segment === '..' || !DID_PATH_SEGMENT.test(segment)) {
      throw refuse(`the path segment ${JSON.stringify(segment)} is not allowed`);
    }
  }

  const issuer = `https://${host}${port !== undefined ? `:${port}` : ''}${path.map((segment) => `/${segment}`).join('')}`;
  return { jwksUri: `${issuer}/.well-known/jwks.json`, issuer };
}
