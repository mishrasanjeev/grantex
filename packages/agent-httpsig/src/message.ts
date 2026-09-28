// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP messages as RFC 9421 sees them: field values (section 2.1), the
 * derived components this library implements (section 2.2) and the
 * signature base (section 2.5).
 */
import { AgentHttpSigError } from './errors.js';
import { parseDictionary, serializeInnerList, serializeKey } from './structured-fields.js';
import type { InnerList } from './structured-fields.js';

export type HeaderValue = string | readonly string[] | undefined;
export type HeadersInit =
  | Headers
  | Readonly<Record<string, HeaderValue>>
  | ReadonlyArray<readonly [string, string]>;

export interface AgentRequest {
  method: string;
  /** Absolute (`https://merchant.example/v1/checkout`) or, when verifying, origin-form (`/v1/checkout`). */
  url: string;
  headers?: HeadersInit;
  /** A string is sent as UTF-8. */
  body?: string | Uint8Array | null;
}

export interface AgentResponse {
  status: number;
  headers?: HeadersInit;
  body?: string | Uint8Array | null;
}

export type HttpMessage = AgentRequest | AgentResponse;

function fail(message: string): never {
  throw new AgentHttpSigError(message);
}

export function bodyBytes(body: string | Uint8Array | null | undefined): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

/**
 * The field lines named `name` (case-insensitive), in order, each trimmed of
 * leading and trailing whitespace (RFC 9421 section 2.1 step 2), or null when
 * the field is absent.
 */
export function fieldLines(headers: HeadersInit | undefined, name: string): string[] | null {
  const lower = name.toLowerCase();
  const out: string[] = [];
  if (headers === undefined) return null;
  const add = (value: HeaderValue) => {
    if (value === undefined) return;
    for (const v of typeof value === 'string' ? [value] : value) out.push(v.replace(/^[ \t]+|[ \t]+$/g, ''));
  };
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    // Headers already combines repeated lines with ", " (Fetch standard).
    const value = headers.get(lower);
    if (value !== null) add(value);
  } else if (Array.isArray(headers)) {
    for (const [n, v] of headers as ReadonlyArray<readonly [string, string]>) if (n.toLowerCase() === lower) add(v);
  } else {
    for (const [n, v] of Object.entries(headers as Record<string, HeaderValue>)) if (n.toLowerCase() === lower) add(v);
  }
  return out.length > 0 ? out : null;
}

/** The field value: its lines joined with ", " (RFC 9421 section 2.1 step 4, RFC 9110 section 5.3). */
export function fieldValue(headers: HeadersInit | undefined, name: string): string | null {
  const lines = fieldLines(headers, name);
  return lines === null ? null : lines.join(', ');
}

export interface TargetUri {
  scheme: string | null;
  /** Normalised authority (RFC 9421 section 2.2.3), or null for an origin-form target. */
  authority: string | null;
  path: string;
  query: string | null;
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };

/**
 * Splits a target with the RFC 3986 Appendix B expression, without resolving
 * or re-encoding anything: RFC 9421 takes @path and @query before
 * percent-decoding (sections 2.2.6, 2.2.7).
 */
export function parseTarget(url: string): TargetUri {
  if (url.startsWith('/')) {
    const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(url)!;
    return { scheme: null, authority: null, path: m[1]!, query: m[2] ?? null };
  }
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(url);
  if (!m) fail('request target is neither an absolute http(s) URL nor an absolute path');
  const scheme = m[1]!.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') fail(`unsupported scheme ${scheme}`);
  return { scheme, authority: normaliseAuthority(m[2]!, scheme), path: m[3]!, query: m[4] ?? null };
}

/**
 * RFC 9421 section 2.2.3 (RFC 9110 section 4.2.3): host lowercased, default
 * port omitted. Userinfo is refused (RFC 9110 section 4.2.4).
 */
export function normaliseAuthority(authority: string, scheme: string | null): string {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~%!$&'()*+,;=-]+)(?::(\d*))?$/.exec(authority);
  if (!m) fail('invalid authority');
  const host = m[1]!.toLowerCase();
  const port = m[2];
  if (port === undefined || port === '' || (scheme !== null && DEFAULT_PORTS[scheme] === port)) return host;
  return `${host}:${port}`;
}

function derivedValue(message: HttpMessage, name: string): string {
  const isRequest = 'method' in message;
  if (name === '@status') {
    // Section 2.2.9: responses only.
    if (isRequest) fail('@status is not defined for a request');
    const status = (message as AgentResponse).status;
    if (!Number.isInteger(status) || status < 100 || status > 999) fail('invalid status');
    return String(status);
  }
  if (!isRequest) fail(`${name} is not implemented for a response`);
  const request = message as AgentRequest;
  const target = parseTarget(request.url);
  switch (name) {
    case '@method':
      // Section 2.2.1: as sent, case preserved.
      return request.method;
    case '@authority':
      // Section 2.2.3.
      if (target.authority === null) fail('@authority needs an absolute target');
      return target.authority;
    case '@scheme':
      // Section 2.2.4.
      if (target.scheme === null) fail('@scheme needs an absolute target');
      return target.scheme;
    case '@path':
      // Section 2.2.6: an empty path is "/".
      return target.path === '' ? '/' : target.path;
    case '@query':
      // Section 2.2.7: with the leading "?", and "?" alone when absent.
      return target.query ?? '?';
    default:
      return fail(`derived component ${name} is not implemented`);
  }
}

/** Component values are ASCII (RFC 9421 section 2.5 step 4) with no line breaks (section 2.2). */
function checkValue(value: string, name: string) {
  if (!/^[\x20-\x7e]*$/.test(value)) fail(`component ${name} has a value outside printable ASCII`);
}

export interface ComponentOverrides {
  /** Values used in place of the message's own for derived components (the verifier's @authority). */
  [name: string]: string;
}

/**
 * RFC 9421 section 2.5: the signature base for the covered components and
 * signature parameters of `signatureParams`. Components with parameters
 * (`sf`, `key`, `bs`, `req`, `tr`, `name`) are not implemented and fail, as
 * step 2.5 requires for a parameter that is not understood.
 */
export function createSignatureBase(
  message: HttpMessage,
  signatureParams: InnerList,
  overrides: ComponentOverrides = {},
): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const component of signatureParams.items) {
    if (component.value.type !== 'string') fail('a component identifier is not a String');
    const name = component.value.value;
    if (component.params.size > 0) fail(`component parameters are not implemented (${name})`);
    // Step 2.1: no component twice.
    if (seen.has(name)) fail(`component ${name} is covered twice`);
    seen.add(name);
    if (name === '@signature-params') fail('@signature-params cannot be a covered component');
    let value: string;
    if (name.startsWith('@')) {
      value = overrides[name] ?? derivedValue(message, name);
    } else {
      // Section 2.1: lowercased field names only.
      if (name !== name.toLowerCase() || name === '') fail(`invalid field name ${JSON.stringify(name)}`);
      const v = fieldValue(message.headers, name);
      if (v === null) fail(`covered field ${name} is not in the message`);
      value = v;
    }
    checkValue(value, name);
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(signatureParams)}`);
  const base = lines.join('\n');
  checkValue(base.replace(/\n/g, ' '), '@signature-params');
  return base;
}

/**
 * The signature base of the signature labelled `label` in the message's
 * Signature-Input field (RFC 9421 section 3.2 steps 2 and 7).
 */
export function signatureBaseFor(message: HttpMessage, label: string): string {
  serializeKey(label);
  const input = fieldValue(message.headers, 'signature-input');
  if (input === null) fail('the message has no Signature-Input field');
  const member = parseDictionary(input).get(label);
  if (member === undefined) fail(`Signature-Input has no signature labelled ${label}`);
  if (!('items' in member)) fail(`Signature-Input member ${label} is not an Inner List`);
  return createSignatureBase(message, member);
}
