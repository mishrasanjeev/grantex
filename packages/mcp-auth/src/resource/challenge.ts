/**
 * `WWW-Authenticate` challenges for the MCP server (resource server) side,
 * per RFC 6750 §3, RFC 9728 §5.1 and the MCP authorization specification.
 *
 * The `decision_required` challenge is a Grantex extension; its exact format
 * is specified in `spec/mcp-auth-challenges.md`.
 */

export interface ChallengeParams {
  error?: string;
  error_description?: string;
  scope?: string;
  resource_metadata?: string;
  [param: string]: string | undefined;
}

// auth-param names are RFC 7230 tokens.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** RFC 7230 quoted-string: escape `\` and `"`, drop control characters. */
function quote(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return `"${cleaned.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Serialises a `Bearer` challenge; parameters with undefined values are omitted. */
export function formatBearerChallenge(params: ChallengeParams = {}): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!TOKEN.test(name)) throw new Error(`Invalid WWW-Authenticate parameter name: ${name}`);
    parts.push(`${name}=${quote(value)}`);
  }
  return parts.length === 0 ? 'Bearer' : `Bearer ${parts.join(', ')}`;
}

/** 401 without credentials: no error code (RFC 6750 §3.1), just where to discover authorization. */
export function missingTokenChallenge(resourceMetadataUrl?: string, scopes?: readonly string[]): string {
  return formatBearerChallenge({
    ...(resourceMetadataUrl !== undefined ? { resource_metadata: resourceMetadataUrl } : {}),
    ...(scopes !== undefined && scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
  });
}

/** 401 for a token that is malformed, expired, revoked or for another audience. */
export function invalidTokenChallenge(description: string, resourceMetadataUrl?: string): string {
  return formatBearerChallenge({
    error: 'invalid_token',
    error_description: description,
    ...(resourceMetadataUrl !== undefined ? { resource_metadata: resourceMetadataUrl } : {}),
  });
}

/** 403 when the token lacks scopes: carries every scope the operation needs, in one challenge. */
export function insufficientScopeChallenge(options: {
  scopes: readonly string[];
  description: string;
  resourceMetadataUrl?: string;
}): string {
  return formatBearerChallenge({
    error: 'insufficient_scope',
    ...(options.scopes.length > 0 ? { scope: options.scopes.join(' ') } : {}),
    ...(options.resourceMetadataUrl !== undefined ? { resource_metadata: options.resourceMetadataUrl } : {}),
    error_description: options.description,
  });
}

/**
 * 403 when a tool needs a decision grant (PRD G-3) that the request does not
 * carry, or carries one that is not valid for this call:
 *
 *     WWW-Authenticate: Bearer error="insufficient_authorization",
 *       decision_required="<connector>:<tool>",
 *       resource_metadata="<RFC 9728 metadata URL>",
 *       error_description="<human-readable text>"
 *
 * `decision_required` names the action a human must approve, as
 * `<connector>:<tool>` (or just `<tool>` when no connector is known). An
 * optional `decision_uri` tells the client where a decision can be requested.
 */
export function decisionRequiredChallenge(options: {
  tool: string;
  connector?: string;
  description?: string;
  resourceMetadataUrl?: string;
  decisionUri?: string;
}): string {
  const action = options.connector !== undefined ? `${options.connector}:${options.tool}` : options.tool;
  return formatBearerChallenge({
    error: 'insufficient_authorization',
    decision_required: action,
    ...(options.resourceMetadataUrl !== undefined ? { resource_metadata: options.resourceMetadataUrl } : {}),
    ...(options.decisionUri !== undefined ? { decision_uri: options.decisionUri } : {}),
    error_description: options.description ?? `A decision grant approved by a person is required for ${action}`,
  });
}
