/**
 * Purpose-bound grants: vocabulary and the `urn:grantex:tools:v1`
 * authorization_details entries that carry a grant's purpose in its tokens.
 *
 * The vocabulary and syntax mirror the SDKs (`grantex.purpose`,
 * `@grantex/sdk` `purpose.ts`); `enforce()` in the SDKs matches the purpose in
 * these entries against a tool's `allowed_purposes`.
 */

export const TOOLS_DETAIL_TYPE = 'urn:grantex:tools:v1';

/** The controlled purpose vocabulary. Private terms use `x-<org>.<term>`. */
export const PURPOSE_VOCABULARY: ReadonlyMap<string, string> = new Map([
  ['aml.cdd.onboarding', 'Customer due diligence at onboarding'],
  ['aml.cdd.ongoing', 'Ongoing customer due diligence'],
  ['aml.screening', 'Screening against watch lists'],
  ['procurement.vendor_onboarding', 'Vendor onboarding'],
  ['payments.payout', 'Payouts'],
]);

const SEG = '[a-z][a-z0-9_]*';
const ORG = 'x-[a-z0-9]+(?:-[a-z0-9]+)*';
const PURPOSE_RE = new RegExp(`^(?:${SEG}(?:\\.${SEG})*|${ORG}(?:\\.${SEG})+)$`);
const CONNECTOR_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_PURPOSE_LENGTH = 128;

/** Whether `value` is a vocabulary term or a well-formed private `x-<org>.<term>`. */
export function isKnownPurpose(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_PURPOSE_LENGTH
    && PURPOSE_RE.test(value)
    && (PURPOSE_VOCABULARY.has(value) || value.startsWith('x-'));
}

/** Human-readable label for the consent page. */
export function describePurpose(purpose: string): string {
  const label = PURPOSE_VOCABULARY.get(purpose);
  return label === undefined ? purpose : `${label} (${purpose})`;
}

/**
 * Connectors named by connector-scoped scopes (`tool:<connector>:...` and
 * `agenticorg:<connector>:...`), in first-seen order. Scopes whose connector
 * segment is not a valid connector name are skipped.
 */
export function connectorsInScopes(scopes: readonly string[]): string[] {
  const connectors: string[] = [];
  for (const scope of scopes) {
    const parts = scope.split(':');
    if (parts.length < 3 || (parts[0] !== 'tool' && parts[0] !== 'agenticorg')) continue;
    const connector = parts[1] as string;
    if (CONNECTOR_RE.test(connector) && !connectors.includes(connector)) connectors.push(connector);
  }
  return connectors;
}

export type ToolsAuthorizationDetail = {
  type: typeof TOOLS_DETAIL_TYPE;
  connector: string;
  purpose: string;
};

/**
 * One `urn:grantex:tools:v1` entry per connector in `scopes`, each carrying
 * `purpose`. Returns an empty array when no scope names a connector.
 */
export function buildToolsAuthorizationDetails(purpose: string, scopes: readonly string[]): ToolsAuthorizationDetail[] {
  return connectorsInScopes(scopes).map((connector) => ({ type: TOOLS_DETAIL_TYPE, connector, purpose }));
}

/**
 * The tools entries of a stored `authorization_details` value that apply to
 * `scopes`, for a delegated grant. Throws when the stored value is not an
 * array, so a corrupt parent never yields an unconstrained child.
 */
export function narrowToolsAuthorizationDetails(
  stored: unknown,
  scopes: readonly string[],
): Array<Record<string, unknown>> {
  if (stored === undefined || stored === null) return [];
  if (!Array.isArray(stored)) throw new Error('authorization_details must be an array');
  const connectors = new Set(connectorsInScopes(scopes));
  return stored.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object'
    && entry !== null
    && (entry as Record<string, unknown>)['type'] === TOOLS_DETAIL_TYPE
    && connectors.has((entry as Record<string, unknown>)['connector'] as string));
}

/**
 * The single purpose carried by tools entries, or undefined when none carries
 * one. Throws when entries disagree, which issuance never produces.
 */
export function purposeOfToolsAuthorizationDetails(entries: ReadonlyArray<Record<string, unknown>>): string | undefined {
  let purpose: string | undefined;
  for (const entry of entries) {
    const value = entry['purpose'];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new Error('authorization_details purpose must be a string');
    if (purpose !== undefined && purpose !== value) {
      throw new Error('authorization_details entries carry different purposes');
    }
    purpose = value;
  }
  return purpose;
}
