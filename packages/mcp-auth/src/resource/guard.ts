import * as jose from 'jose';
import type { RevocationChecker } from '../storage/types.js';
import { canonicalResource, protectedResourceMetadataUrl } from '../lib/resource.js';
import {
  decisionRequiredChallenge,
  insufficientScopeChallenge,
  invalidTokenChallenge,
  missingTokenChallenge,
} from './challenge.js';
import type { ToolPolicy, ToolRequirement } from './tool-policy.js';
import { DecisionReferenceError, withGrantDecisionReference } from './decision-references.js';

/**
 * Framework-neutral authorization for an MCP server (the resource server):
 * validates the bearer token, then refuses any `tools/call` the grant does
 * not cover — at the server, with a 403, not just by hiding the tool from
 * `tools/list`. The Express and Hono middleware are thin adapters over this.
 */

/** Decoded Grantex grant claims attached to an authorized request. */
export interface McpGrant {
  sub: string;
  iss: string;
  jti: string;
  scopes: string[];
  agentDid?: string;
  developerId?: string;
  grantId?: string;
  delegationDepth?: number;
  exp: number;
  iat: number;
  raw: jose.JWTPayload;
}

/** What a decision verifier is told about the call it must judge. */
export interface DecisionCheck {
  grant: McpGrant;
  requirement: ToolRequirement;
  /** `params.arguments` of the `tools/call`, untrusted. */
  arguments: unknown;
  /** Reads a request header (case-insensitive), e.g. for a decision grant carried in a header. */
  header(name: string): string | undefined;
}

export type DecisionOutcome =
  | { status: 'valid' }
  | { status: 'absent' }
  | { status: 'invalid'; subReason: 'action_mismatch' | 'expired' | 'consumed' | 'same_approver' | string };

/**
 * Extension point for decision grants (PRD G-3). Called for every
 * `tools/call` of a tool whose requirement has `requiresDecision`. Without a
 * verifier such calls are always refused with `decision_required`.
 *
 * A verifier that returns `valid` MUST consume the decision grant (mark its
 * `jti` used, atomically) before returning, so one decision grant can never
 * authorise two calls — whether they arrive as separate requests or in one
 * JSON-RPC batch. The guard additionally refuses a batch containing more
 * than one call that needs a decision.
 */
export interface DecisionVerifier {
  verify(check: DecisionCheck): Promise<DecisionOutcome>;
}

export interface McpResourceGuardOptions {
  /** Expected `iss` — the Grantex issuer that signs grant tokens. */
  issuer: string;
  /** Explicit JWKS URL (defaults to `{issuer}/.well-known/jwks.json`). */
  jwksUri?: string;
  /**
   * This MCP server's canonical resource URI(s). Required: tokens whose `aud`
   * does not name this server are rejected (RFC 8707; MCP authorization,
   * "Token Handling").
   */
  audience: string | string[];
  /**
   * RFC 9728 metadata URL advertised in every challenge. Defaults to the
   * well-known URL derived from `audience` when it is a single URI.
   */
  resourceMetadataUrl?: string;
  /** Scopes every request must carry (all of them). */
  scopes?: string[];
  /** Allowed JWT algorithms (default RS256, ES256, PS256, EdDSA). */
  algorithms?: string[];
  /** Revocation state, e.g. the `storage` given to the authorization server. */
  revocations?: RevocationChecker;
  /**
   * Tool requirements. When set, every JSON-RPC `tools/call` (single or
   * batched) must name a known tool the grant covers; anything else is
   * refused with 403.
   */
  tools?: ToolPolicy;
  /** Decides tools that require a decision grant. See {@link DecisionVerifier}. */
  decisions?: DecisionVerifier;
  /** Advertised as `decision_uri` in `decision_required` challenges: where a decision can be requested. */
  decisionUri?: string;
  /**
   * Called for every refusal with a low-cardinality event (for metrics and
   * logs): the reason, the HTTP status and, for tools the policy declares,
   * the connector and tool. Never includes tokens, subjects or undeclared
   * tool names. A throwing hook does not change the refusal.
   */
  onDenial?: (event: GuardDenialEvent) => void;
  /** Receives start-up warnings (default `console.warn`). */
  warn?: (message: string) => void;
}

export interface GuardDenialEvent {
  reason: GuardDenialReason;
  status: number;
  connector?: string;
  tool?: string;
}

export interface GuardRequest {
  /** Reads a request header, case-insensitively. */
  header(name: string): string | undefined;
  method: string;
  /**
   * The parsed JSON body. With a `tools` policy, a request that may carry
   * messages must have an object or array of JSON-RPC 2.0 messages here;
   * a string, Buffer, empty object or anything else is refused.
   */
  body?: unknown;
  /** Whether the host read a body at all. */
  bodyParsed: boolean;
}

export type GuardDenialReason =
  | 'missing_token'
  | 'invalid_token'
  | 'grant_revoked'
  | 'revocation_unavailable'
  | 'insufficient_scope'
  | 'tool_not_granted'
  | 'manifest_unknown_tool'
  | 'invalid_tool_call'
  | 'body_not_parsed'
  | 'decision_required'
  | 'decision_invalid';

export type GuardResult =
  | { ok: true; grant: McpGrant }
  | {
    ok: false;
    status: number;
    reason: GuardDenialReason;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };

const DEFAULT_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'EdDSA'];
const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function jwksFor(issuer: string, jwksUri: string | undefined): ReturnType<typeof jose.createRemoteJWKSet> {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const url = jwksUri ?? `${base}/.well-known/jwks.json`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

interface ToolCall {
  name: unknown;
  arguments: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value) && !ArrayBuffer.isView(value);
}

/**
 * A JSON-RPC 2.0 request or notification (string `method`) or a response to
 * a server-initiated request (`id` with `result` or `error`, no `method`).
 */
function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || value['jsonrpc'] !== '2.0') return false;
  if (typeof value['method'] === 'string') return true;
  return value['method'] === undefined && 'id' in value && ('result' in value || 'error' in value);
}

/** Methods that carry no JSON-RPC messages in the MCP HTTP transport (SSE stream, session end). */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null || body === '') return true;
  if (Buffer.isBuffer(body)) return body.length === 0;
  return isPlainObject(body) && Object.keys(body).length === 0;
}

/**
 * The JSON-RPC messages of a request, or undefined when the body cannot be
 * trusted to be what the MCP handler will process. Fails closed: with a
 * tools policy, only an object or a non-empty array of JSON-RPC messages
 * passes. Bodyless methods may have no body (Express 4 sets `{}` when it
 * skips parsing).
 */
function jsonRpcMessages(method: string, body: unknown): Array<Record<string, unknown>> | undefined {
  if (BODYLESS_METHODS.has(method.toUpperCase()) && isEmptyBody(body)) return [];
  if (Array.isArray(body)) {
    return body.length > 0 && body.every(isJsonRpcMessage) ? body : undefined;
  }
  return isJsonRpcMessage(body) ? [body] : undefined;
}

/** Extracts every `tools/call` from validated JSON-RPC messages. */
function toolCalls(messages: Array<Record<string, unknown>>): ToolCall[] | 'malformed' {
  const calls: ToolCall[] = [];
  for (const message of messages) {
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== 'tools/call') continue;
    if (params === null || typeof params !== 'object') return 'malformed';
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    calls.push({ name, arguments: args });
  }
  return calls;
}

export function createMcpResourceGuard(options: McpResourceGuardOptions): (request: GuardRequest) => Promise<GuardResult> {
  const audience = options.audience;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (audience === undefined || audiences.length === 0 || audiences.some((a) => typeof a !== 'string' || a.length === 0)) {
    throw new Error(
      'requireMcpAuth: `audience` is required — this MCP server\'s canonical resource URI. '
      + 'Tokens not issued for it must be rejected (MCP authorization, Token Handling).',
    );
  }
  let resourceMetadataUrl = options.resourceMetadataUrl;
  if (resourceMetadataUrl === undefined && audiences.length === 1 && canonicalResource(audiences[0]) !== undefined) {
    resourceMetadataUrl = protectedResourceMetadataUrl(audiences[0]!);
  }
  if (!options.revocations) {
    (options.warn ?? console.warn)(
      'requireMcpAuth: `revocations` is not configured, so a revoked token stays usable here until it expires. '
      + 'Pass the authorization server\'s storage as `revocations`.',
    );
  }
  const algorithms = options.algorithms ?? DEFAULT_ALGORITHMS;
  const requiredScopes = options.scopes ?? [];
  const tools = options.tools;

  const deny = (
    status: number,
    reason: GuardDenialReason,
    challenge: string | undefined,
    body: Record<string, unknown>,
    requirement?: ToolRequirement,
  ): GuardResult => {
    if (options.onDenial) {
      try {
        options.onDenial({
          reason,
          status,
          ...(requirement?.connector !== undefined ? { connector: requirement.connector } : {}),
          ...(requirement !== undefined ? { tool: requirement.tool } : {}),
        });
      } catch {
        // Observability only: the request is refused either way.
      }
    }
    return {
      ok: false,
      status,
      reason,
      headers: challenge !== undefined ? { 'www-authenticate': challenge } : {},
      body,
    };
  };

  return async (request) => {
    const header = request.header('authorization');
    if (!header) {
      return deny(401, 'missing_token', missingTokenChallenge(resourceMetadataUrl), {
        error: 'unauthorized',
        error_description: 'Missing Authorization header',
      });
    }
    if (!header.toLowerCase().startsWith('bearer ') || header.slice(7).trim().length === 0) {
      return deny(401, 'invalid_token', invalidTokenChallenge('Invalid Authorization header format', resourceMetadataUrl), {
        error: 'unauthorized',
        error_description: 'Invalid Authorization header format',
      });
    }
    const token = header.slice(7).trim();

    let payload: jose.JWTPayload;
    try {
      if (!options.issuer) throw new Error('issuer is required');
      const issuer = options.issuer;
      ({ payload } = await jose.jwtVerify(token, jwksFor(issuer, options.jwksUri), {
        algorithms,
        issuer: issuer.endsWith('/') ? [issuer, issuer.slice(0, -1)] : [issuer, `${issuer}/`],
        audience: audiences,
      }));
    } catch {
      return deny(401, 'invalid_token', invalidTokenChallenge('Invalid or expired token', resourceMetadataUrl), {
        error: 'unauthorized',
        error_description: 'Invalid or expired token',
      });
    }

    // `scp` must be a string array, matching @grantex/sdk: a string or a
    // missing claim marks a foreign token from the same issuer.
    const scp = payload['scp'];
    if (!Array.isArray(scp) || !scp.every((s) => typeof s === 'string')) {
      return deny(401, 'invalid_token', invalidTokenChallenge('Token scp claim must be an array of strings', resourceMetadataUrl), {
        error: 'unauthorized',
        error_description: 'Token scp claim must be an array of strings',
      });
    }
    const grantedScopes = scp as string[];

    if (options.revocations) {
      if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
        return deny(401, 'invalid_token', invalidTokenChallenge('Token has no jti, so its revocation state is unknown', resourceMetadataUrl), {
          error: 'unauthorized',
          error_description: 'Token has no jti, so its revocation state is unknown',
        });
      }
      let revoked: boolean;
      try {
        revoked = await options.revocations.isTokenRevoked(payload.jti);
      } catch {
        return deny(503, 'revocation_unavailable', undefined, {
          error: 'temporarily_unavailable',
          error_description: 'Revocation state could not be checked; the request was refused',
        });
      }
      if (revoked) {
        return deny(401, 'grant_revoked', invalidTokenChallenge('Token has been revoked', resourceMetadataUrl), {
          error: 'unauthorized',
          error_description: 'Token has been revoked',
        });
      }
    }

    const missing = requiredScopes.filter((s) => !grantedScopes.includes(s));
    if (missing.length > 0) {
      const description = `Missing required scopes: ${missing.join(', ')}`;
      return deny(403, 'insufficient_scope', insufficientScopeChallenge({
        scopes: requiredScopes,
        description,
        ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
      }), { error: 'insufficient_scope', error_description: description });
    }

    const grant: McpGrant = {
      sub: typeof payload.sub === 'string' ? payload.sub : '',
      iss: typeof payload.iss === 'string' ? payload.iss : '',
      jti: typeof payload.jti === 'string' ? payload.jti : '',
      scopes: grantedScopes,
      ...(typeof payload['agt'] === 'string' ? { agentDid: payload['agt'] } : {}),
      ...(typeof payload['dev'] === 'string' ? { developerId: payload['dev'] } : {}),
      ...(typeof payload['grnt'] === 'string' ? { grantId: payload['grnt'] } : {}),
      ...(typeof payload['delegationDepth'] === 'number' ? { delegationDepth: payload['delegationDepth'] } : {}),
      exp: payload.exp as number,
      iat: payload.iat as number,
      raw: payload,
    };

    if (tools) {
      const messages = jsonRpcMessages(request.method, request.bodyParsed ? request.body : undefined);
      if (messages === undefined) {
        return deny(400, 'body_not_parsed', undefined, {
          error: 'invalid_request',
          reason: 'body_not_parsed',
          error_description: 'With tool enforcement, the request body must be parsed JSON-RPC 2.0 (an object or a non-empty array of messages)',
        });
      }
      const calls = toolCalls(messages);
      if (calls === 'malformed') {
        return deny(400, 'invalid_tool_call', undefined, {
          error: 'invalid_request',
          error_description: 'tools/call requires params with a tool name',
        });
      }
      // A tool needs a decision when its manifest declares requires_decision or
      // the grant's urn:grantex:decision:v1 entry lists it; four eyes comes
      // from both. A decision entry that cannot be read refuses the call.
      const authorizationDetails = payload['authorization_details'];
      const requirementOf = (name: string): ToolRequirement | undefined | 'malformed' => {
        const declared = tools.requirementFor(name);
        if (declared === undefined) return undefined;
        try {
          return withGrantDecisionReference(declared, authorizationDetails);
        } catch (err) {
          if (err instanceof DecisionReferenceError) return 'malformed';
          throw err;
        }
      };
      const decisionCalls = calls.filter((call) => {
        if (typeof call.name !== 'string') return false;
        const requirement = requirementOf(call.name);
        return requirement === 'malformed' || requirement?.requiresDecision === true;
      });
      if (decisionCalls.length > 1) {
        const description = 'A batch may contain at most one call that needs a decision grant';
        return deny(403, 'decision_invalid', undefined, {
          error: 'insufficient_authorization',
          reason: 'decision_invalid',
          sub_reason: 'multiple_decisions_in_batch',
          error_description: description,
        });
      }
      for (const call of calls) {
        if (typeof call.name !== 'string' || call.name.length === 0) {
          return deny(400, 'invalid_tool_call', undefined, {
            error: 'invalid_request',
            error_description: 'tools/call requires params.name',
          });
        }
        const requirement = requirementOf(call.name);
        if (requirement === 'malformed') {
          const description = 'The grant\'s decision references in authorization_details cannot be read';
          return deny(403, 'decision_invalid', undefined, {
            error: 'insufficient_authorization',
            reason: 'decision_invalid',
            sub_reason: 'malformed_authorization_details',
            tool: call.name,
            error_description: description,
          }, tools.requirementFor(call.name));
        }
        if (!requirement) {
          const description = `Tool "${call.name}" is not declared on this server, so no grant can cover it`;
          return deny(403, 'manifest_unknown_tool', insufficientScopeChallenge({
            scopes: [],
            description,
            ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
          }), { error: 'insufficient_scope', reason: 'manifest_unknown_tool', tool: call.name, error_description: description });
        }
        // Scopes are checked against the declared requirement object, which the policy recognises.
        if (!tools.isSatisfied(tools.requirementFor(call.name)!, grantedScopes)) {
          const description = `Tool "${call.name}" is not granted: it needs ${requirement.requiredScopes.join(' ')}`;
          return deny(403, 'tool_not_granted', insufficientScopeChallenge({
            scopes: requirement.requiredScopes,
            description,
            ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
          }), {
            error: 'insufficient_scope',
            reason: 'tool_not_granted',
            tool: call.name,
            required_scopes: requirement.requiredScopes,
            error_description: description,
          }, requirement);
        }
        if (requirement.requiresDecision) {
          let outcome: DecisionOutcome;
          try {
            outcome = options.decisions
              ? await options.decisions.verify({ grant, requirement, arguments: call.arguments, header: request.header })
              : { status: 'absent' };
          } catch {
            outcome = { status: 'invalid', subReason: 'verification_failed' };
          }
          if (outcome.status !== 'valid') {
            const subReason = outcome.status === 'invalid' ? outcome.subReason : undefined;
            const invalid = subReason !== undefined;
            const description = invalid
              ? `The decision grant for "${call.name}" is not valid (${subReason})`
              : `Tool "${call.name}" requires a decision grant approved by a person`;
            return deny(403, invalid ? 'decision_invalid' : 'decision_required', decisionRequiredChallenge({
              tool: requirement.tool,
              ...(requirement.connector !== undefined ? { connector: requirement.connector } : {}),
              description,
              ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
              ...(options.decisionUri !== undefined ? { decisionUri: options.decisionUri } : {}),
            }), {
              error: 'insufficient_authorization',
              reason: invalid ? 'decision_invalid' : 'decision_required',
              ...(invalid ? { sub_reason: subReason } : {}),
              tool: call.name,
              error_description: description,
            }, requirement);
          }
        }
      }
    }

    return { ok: true, grant };
  };
}

/**
 * Removes tools the grant does not cover from a `tools/list` result. A
 * convenience for listing only: refusal happens in the guard regardless.
 */
export function filterToolsForGrant<T extends { name: string }>(
  listed: readonly T[],
  grantedScopes: readonly string[],
  policy: ToolPolicy,
): T[] {
  return listed.filter((tool) => {
    const requirement = policy.requirementFor(tool.name);
    return requirement !== undefined && policy.isSatisfied(requirement, grantedScopes);
  });
}
