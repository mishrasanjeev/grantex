// SPDX-License-Identifier: Apache-2.0
/**
 * The grant token audience check (RFC 7519 section 4.1.3), with the same
 * semantics as `enforce()` in the Grantex SDKs: a token that carries `aud` is
 * only for the relying parties it names, so it is refused unless the expected
 * audience is one of them (exact string comparison), and refused outright when
 * no audience is configured. A token without `aud` is refused only when an
 * audience is configured. `audienceCheck: 'off'` skips the check.
 */

export type AudienceCheck = 'on' | 'off';

export type AudienceDenial = 'AUDIENCE_UNCONFIGURED' | 'AUDIENCE_MISMATCH';

export function checkAudienceCheck(value: unknown): AudienceCheck {
  if (value !== 'on' && value !== 'off') {
    throw new Error(`audienceCheck must be one of on, off, not ${JSON.stringify(value)}`);
  }
  return value;
}

export function checkExpectedAudience(value: unknown, audienceCheck: AudienceCheck): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`audience must be a non-empty string, not ${JSON.stringify(value)}`);
  }
  // With the check off the audience would be ignored and tokens for other
  // relying parties accepted: refuse the contradiction instead.
  if (audienceCheck === 'off') throw new Error("audience cannot be set with audienceCheck: 'off'");
  return value;
}

/**
 * The `aud` claim of a grant token that has already been verified: undefined
 * when the token has none, otherwise its values.
 *
 * The published SDK's `verifyGrantToken` does not return `aud`, so it is read
 * from the payload whose signature was just checked. A payload that cannot be
 * read, or an `aud` that is neither a string nor an array of strings, throws:
 * the caller then denies, because it cannot tell who the token is for.
 */
export function readTokenAudience(token: string): string[] | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('grant token payload cannot be read');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('grant token payload cannot be read');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('grant token payload cannot be read');
  }
  const aud = (payload as Record<string, unknown>)['aud'];
  if (aud === undefined) return undefined;
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud) && aud.every((value) => typeof value === 'string')) return aud as string[];
  throw new Error('grant token claim aud must be a string or an array of strings');
}

/** Why a verified token's audience is refused, or undefined when it is accepted. */
export function audienceDenial(
  tokenAudience: string[] | undefined,
  expected: string | undefined,
): AudienceDenial | undefined {
  if (expected === undefined) return tokenAudience === undefined ? undefined : 'AUDIENCE_UNCONFIGURED';
  return tokenAudience !== undefined && tokenAudience.includes(expected) ? undefined : 'AUDIENCE_MISMATCH';
}
