// SPDX-License-Identifier: Apache-2.0
//
// Strict base64url (RFC 4648 section 5, no padding, as RFC 7515 section 2
// requires): anything else is refused rather than guessed at.

const ALPHABET = /^[A-Za-z0-9_-]*$/;

export function b64urlEncode(data: Uint8Array | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).toString('base64url');
}

/** Decode strict base64url, or return null. Non-canonical encodings (padding bits set) are refused. */
export function b64urlDecode(text: string): Buffer | null {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

// ignoreBOM keeps a byte order mark, which JSON.parse then refuses, as Python's json does.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decode base64url UTF-8 JSON, or return undefined. */
export function b64urlJson(text: string): { value: unknown } | undefined {
  const bytes = b64urlDecode(text);
  if (bytes === null) return undefined;
  try {
    return { value: JSON.parse(UTF8.decode(bytes)) as unknown };
  } catch {
    // Not UTF-8 or not JSON: the caller refuses the input with its own reason.
    return undefined;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An integer JSON number both libraries read the same way (JavaScript safe integers). */
export function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
