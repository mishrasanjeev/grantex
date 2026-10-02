// SPDX-License-Identifier: Apache-2.0
/**
 * The grant data region check, with the same semantics as `enforce()` in the
 * Grantex SDKs: a `urn:grantex:tools:v1` entry that carries `data_region` names
 * the region the grant's data may be processed in, so a request is refused when
 * that region is not the gateway's (`REGION_MISMATCH`), and refused outright
 * when the gateway has no region configured (`REGION_UNCONFIGURED`). Entries
 * without a region are unrestricted. Regions are compared after trimming and
 * lowercasing. `dataRegionCheck: 'off'` (the default in this release) skips the
 * check.
 */

export type DataRegionCheck = 'on' | 'off';

export type RegionDenial = {
  code: 'REGION_UNCONFIGURED' | 'REGION_MISMATCH';
  message: string;
  details: Record<string, unknown>;
};

const TOOLS_DETAIL_TYPE = 'urn:grantex:tools:v1';

export function normaliseRegion(value: string): string {
  return value.trim().toLowerCase();
}

export function checkDataRegionCheck(value: unknown): DataRegionCheck {
  if (value !== 'on' && value !== 'off') {
    throw new Error(`dataRegionCheck must be one of on, off, not ${JSON.stringify(value)}`);
  }
  return value;
}

export function checkExpectedDataRegion(value: unknown, dataRegionCheck: DataRegionCheck): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || normaliseRegion(value) === '') {
    throw new Error(`dataRegion must be a non-empty string, not ${JSON.stringify(value)}`);
  }
  // With the check off the region would be ignored and tokens bound to another
  // region accepted: refuse the contradiction instead.
  if (dataRegionCheck === 'off') throw new Error("dataRegion cannot be set with dataRegionCheck: 'off'");
  return normaliseRegion(value);
}

/**
 * The data regions named by the tools entries of a grant token that has
 * already been verified, by connector. Entries without a region are left out.
 *
 * The payload is read from the token whose signature was just checked. A
 * payload that cannot be read, or an `authorization_details` claim whose tools
 * entries cannot be read unambiguously, throws: the caller then denies.
 */
export function readTokenDataRegions(token: string): Map<string, string> {
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
  const claim = (payload as Record<string, unknown>)['authorization_details'];
  const regions = new Map<string, string>();
  if (claim === undefined || claim === null) return regions;
  if (!Array.isArray(claim)) throw new Error('authorization_details must be an array');
  claim.forEach((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`authorization_details[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (record['type'] !== TOOLS_DETAIL_TYPE) return;
    const connector = record['connector'];
    if (typeof connector !== 'string' || connector === '') {
      throw new Error(`authorization_details[${index}].connector must be a connector name`);
    }
    const region = record['data_region'];
    if (region === undefined || region === null) return;
    if (typeof region !== 'string') throw new Error(`authorization_details[${index}].data_region must be a string`);
    regions.set(connector, region);
  });
  return regions;
}

/**
 * The region denial for a verified token, if any. Every tools entry that names
 * a region must name the expected one.
 */
export function regionDenial(tokenRegions: Map<string, string>, expected: string | undefined): RegionDenial | undefined {
  if (tokenRegions.size === 0) return undefined;
  const named = Object.fromEntries([...tokenRegions.entries()].map(([connector, region]) => [connector, normaliseRegion(region)]));
  if (expected === undefined) {
    return {
      code: 'REGION_UNCONFIGURED',
      message: "The grant is bound to a data region and this gateway has no expected region; set dataRegion (or dataRegionCheck: 'off').",
      details: { token_data_regions: named },
    };
  }
  const mismatched = Object.entries(named).filter(([, region]) => region !== expected);
  if (mismatched.length === 0) return undefined;
  return {
    code: 'REGION_MISMATCH',
    message: `The grant's data region does not match ${JSON.stringify(expected)}.`,
    details: { expected_data_region: expected, token_data_regions: Object.fromEntries(mismatched) },
  };
}
