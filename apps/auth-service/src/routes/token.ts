import { errorCodes, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { getSql, type TxSql, queries } from '../db/client.js';
import { newGrantId, newTokenId, newRefreshTokenId } from '../lib/ids.js';
import { signGrantToken, parseExpiresIn } from '../lib/crypto.js';
import { parseActorClaim } from '../lib/grant-token-claims.js';
import {
  isKnownPurpose,
  narrowToolsAuthorizationDetails,
  isRegionOnlyToolsAuthorizationDetails,
  purposeOfToolsAuthorizationDetails,
} from '../lib/purpose.js';
import { checkActiveGrantToken } from '../lib/active-grant-token.js';
import { emitEvent } from '../lib/events.js';
import { tokenExchangeTotal, tokenExchangeDuration } from '../lib/metrics.js';
import { withSpan } from '../lib/tracing.js';
import { GRANTEX_AGENT_ID, GRANTEX_GRANT_ID, GRANTEX_PRINCIPAL_ID, GRANTEX_SCOPES, GRANTEX_DEVELOPER_ID } from '../lib/traceAttributes.js';
import { isValidPkceVerifier, verifyPkceChallenge } from '../lib/pkce.js';
import { incrementUsage } from '../lib/usage.js';
import { issueAgentGrantVC } from '../lib/vc.js';
import { config } from '../config.js';
import {
  grantWebAuthnEvidence,
  parseWebAuthnEvidence,
  verifyPortableWebAuthnEvidence,
  type WebAuthnAssertionEvidence,
} from '../lib/webauthn-evidence.js';
import { issueSDJWT } from '../lib/sd-jwt.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import {
  IssuanceFrozenError,
  assertIssuanceOpen,
  issuanceFreezeEnforced,
  issuanceRefusal,
  issueForCommittedGrant,
} from '../lib/revocation/issuance-freeze.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DpopError, verifyDpopProof, type VerifiedDpopProof } from '../lib/dpop.js';
import {
  BoundIssuerStatusStale,
  PassportBindingError,
  refreshBoundIssuerStatus,
  type IssuanceRecheck,
  bindingFromGrantRow,
  commerceAuthorizationDetail,
  constraintsOfStoredBinding,
  insertGrantBinding,
  parseStoredBinding,
  recheckBindingAtIssuance,
  type GrantPassportBinding,
} from '../lib/registry/passport-binding.js';
import {
  clearExpiredRefreshReplayState,
  clearRefreshReplayState,
  openRefreshReplayToken,
  sealRefreshReplayToken,
} from '../lib/refresh-replay.js';
import {
  ACCESS_TOKEN_TYPE,
  ChildGrantError,
  TOKEN_EXCHANGE_GRANT_TYPE,
  attenuateConstraints,
  childGrantExpiry,
  constraintMembers,
  parseStoredConstraints,
  parseTokenExchangeRequest,
  requireProofOfBoundKey,
  type CommerceConstraints,
  type TokenExchangeRequest,
} from '../lib/registry/child-grant.js';

interface TokenBody {
  code: string;
  agentId: string;
  codeVerifier?: string;
  redirectUri?: string;
  credentialFormat?: 'jwt' | 'vc-jwt' | 'sd-jwt' | 'both' | 'agent-passport';
}

interface RefreshBody {
  refreshToken: string;
  agentId: string;
}

interface RouteError {
  statusCode: number;
  message: string;
  code: string;
}

const REFRESH_TOKEN_REPLAY_WINDOW_SECONDS = 300;
const REFRESH_TOKEN_ALREADY_USED = 'Refresh token already used';

function refreshReplayRequestHash(
  developerId: string,
  agentId: string,
  refreshToken: string,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`grantex-refresh-replay:v2\0${developerId}\0${agentId}\0${refreshToken}\0${idempotencyKey}`)
    .digest('hex');
}

function replayHashMatches(stored: unknown, candidate: string | null): boolean {
  if (typeof stored !== 'string' || stored.length !== 64 || candidate === null || candidate.length !== 64) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
}

function routeError(statusCode: number, message: string, code = 'BAD_REQUEST'): never {
  throw { statusCode, message, code } satisfies RouteError;
}

/**
 * A bound grant's token is issued only while the registry still stands behind
 * its passport (spec/passport-binding.md §5). A refusal is the route's, with
 * the Appendix C code; anything else propagates.
 */
async function recheckBinding(
  sql: ReturnType<typeof getSql>,
  tx: TxSql,
  binding: GrantPassportBinding,
  agentId: string,
  options: IssuanceRecheck,
): Promise<{ notAfter: Date }> {
  try {
    return await recheckBindingAtIssuance(sql, tx, binding, agentId, options);
  } catch (err) {
    if (err instanceof PassportBindingError) routeError(err.statusCode, err.message, err.code);
    throw err;
  }
}

/**
 * Run a token-issuing transaction. When it finds a bound grant whose recorded
 * issuer status is past its freshness, the issuer's list is read outside the
 * transaction (no network while it holds its locks) and the transaction runs
 * once more, this time refusing a status that is still stale. The first run
 * rolled back and wrote nothing, so running it again is safe. A list that
 * cannot be read is the route's refusal (status_stale): never a pass.
 */
async function issueWithFreshIssuerStatus(
  sql: ReturnType<typeof getSql>,
  now: Date,
  run: (rereadAllowed: boolean) => Promise<unknown>,
): Promise<void> {
  try {
    await run(true);
    return;
  } catch (err) {
    if (!(err instanceof BoundIssuerStatusStale)) throw err;
    try {
      await refreshBoundIssuerStatus(sql, err.registryAttestationId, now);
    } catch (refusal) {
      if (refusal instanceof PassportBindingError) routeError(refusal.statusCode, refusal.message, refusal.code);
      throw refusal;
    }
  }
  await run(false);
}

/**
 * issueWithFreshIssuerStatus for the child grant exchange, whose refusals
 * are RFC 6749 §5.2 error responses: a refusal of the issuer's list read
 * again propagates as the PassportBindingError it is.
 */
async function runWithFreshIssuerStatus(
  sql: ReturnType<typeof getSql>,
  now: Date,
  run: (rereadAllowed: boolean) => Promise<unknown>,
): Promise<void> {
  try {
    await run(true);
    return;
  } catch (err) {
    if (!(err instanceof BoundIssuerStatusStale)) throw err;
    await refreshBoundIssuerStatus(sql, err.registryAttestationId, now);
  }
  await run(false);
}

function isRouteError(err: unknown): err is RouteError {
  return typeof err === 'object'
    && err !== null
    && 'statusCode' in err
    && 'message' in err
    && 'code' in err;
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  let replaySweep: ReturnType<typeof setInterval> | undefined;
  if (process.env['NODE_ENV'] !== 'test') {
    app.addHook('onReady', async () => {
      await clearExpiredRefreshReplayState(queries(getSql()));
      replaySweep = setInterval(() => {
        clearExpiredRefreshReplayState(queries(getSql())).catch((error: unknown) => {
          app.log.error({ err: error }, 'refresh replay-state sweep failed');
        });
      }, 60_000);
      replaySweep.unref();
    });
    app.addHook('onClose', async () => {
      if (replaySweep) clearInterval(replaySweep);
    });
  }

  // RFC 8693 §2.1 sends a token exchange form-encoded (RFC 6749 Appendix B).
  // A form body is parsed only for POST /v1/token with
  // PASSPORT_BOUND_GRANTS_ENABLED; everywhere else it is refused 415 exactly
  // as when no parser existed, so nothing changes with the flag off.
  app.addContentTypeParser(FORM_CONTENT_TYPE, { parseAs: 'string' }, (request, body, done) => {
    if (!config.passportBoundGrantsEnabled || request.routeOptions.url !== '/v1/token') {
      done(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(request.headers['content-type']));
      return;
    }
    const parsed: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'))) {
      const current = parsed[key];
      if (current === undefined) parsed[key] = value;
      else if (Array.isArray(current)) current.push(value);
      else parsed[key] = [current, value];
    }
    done(null, parsed);
  });

  // POST /v1/token — stricter rate limit: 20/min
  app.post<{ Body: TokenBody }>('/v1/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const endTimer = tokenExchangeDuration.startTimer();
    const body = request.body;
    // A per-merchant child grant (spec/passport-binding.md §8). Off, a token
    // exchange is answered as it always was: a code exchange without a code.
    if (config.passportBoundGrantsEnabled && typeof body === 'object' && body !== null && !Array.isArray(body)
        && (body as unknown as Record<string, unknown>)['grant_type'] === TOKEN_EXCHANGE_GRANT_TYPE) {
      // Counted and timed as the code exchange is: success, or failed for
      // any refusal or error.
      let status: 'success' | 'failed' = 'failed';
      try {
        const sent = await exchangeChildGrant(request, reply, body as unknown as Record<string, unknown>);
        if (reply.statusCode === 200) status = 'success';
        return sent;
      } finally {
        tokenExchangeTotal.inc({ status });
        endTimer();
      }
    }
    // Only a token exchange is taken form-encoded; a code exchange stays JSON.
    if (isFormRequest(request)) throw new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(request.headers['content-type']);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.status(400).send({ message: 'Request body must be a JSON object', code: 'BAD_REQUEST', requestId: request.id });
    }
    const { code, agentId, codeVerifier, redirectUri, credentialFormat } = body;

    if (typeof code !== 'string' || code.length === 0 || code.length > 512
        || typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256) {
      return reply.status(400).send({
        message: 'code and agentId are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (codeVerifier !== undefined && typeof codeVerifier !== 'string') {
      return reply.status(400).send({ message: 'codeVerifier must be a string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (redirectUri !== undefined && (typeof redirectUri !== 'string' || redirectUri.length === 0 || redirectUri.length > 2048)) {
      return reply.status(400).send({ message: 'redirectUri must be a non-empty string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (credentialFormat !== undefined
        && !['jwt', 'vc-jwt', 'sd-jwt', 'both', 'agent-passport'].includes(credentialFormat)) {
      return reply.status(400).send({ message: 'Invalid credentialFormat', code: 'BAD_REQUEST', requestId: request.id });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    let authReq!: Record<string, unknown>;
    let expiresAt!: Date;
    let expTimestamp!: number;
    let jwt!: string;
    let webAuthnEvidence: WebAuthnAssertionEvidence | undefined;
    let verifiableCredential: string | undefined;
    let verifiableCredentialId: string | undefined;
    const grantId = newGrantId();
    const jti = newTokenId();
    const refreshId = newRefreshTokenId();
    // The instant a bound grant's registry records are checked at.
    const issuanceNow = new Date();

    try {
      await issueWithFreshIssuerStatus(sql, issuanceNow, (rereadAllowed) => sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const authRows = await tx`
          SELECT ar.id, ar.agent_id, ar.principal_id, ar.developer_id,
                 ar.scopes, ar.expires_in, ar.expires_at, ar.status,
                 ar.audience, ar.redirect_uri, ar.code_challenge,
                 ar.agent_key_thumbprint, ar.purpose, ar.authorization_details,
                 ar.fido_verified, ar.fido_evidence, ar.passport_binding, d.mode, d.fido_required,
                 a.did AS agent_did
          FROM auth_requests ar
          JOIN agents a ON a.id = ar.agent_id
          JOIN developers d ON d.id = ar.developer_id
          WHERE ar.code = ${code}
            AND ar.agent_id = ${agentId}
            AND ar.developer_id = ${developerId}
            AND ar.protocol = 'grantex-v1'
            AND a.status = 'active'
          FOR UPDATE OF ar, a
        `;

        authReq = authRows[0] ?? routeError(400, 'Invalid code');
        if (authReq['status'] !== 'approved') {
          routeError(400, 'Auth request not approved');
        }
        if (new Date(authReq['expires_at'] as string) < new Date()) {
          routeError(400, 'Auth request expired');
        }
        const requiresPasskey = authReq['mode'] === 'live' || authReq['fido_required'] === true;
        if ((config.portableWebAuthnEvidenceEnabled
              && (requiresPasskey || authReq['fido_verified'] === true))
            || authReq['fido_evidence'] != null) {
          if (authReq['fido_verified'] !== true || authReq['fido_evidence'] == null) {
            routeError(400, 'A new passkey consent is required for portable evidence', 'PASSKEY_EVIDENCE_REQUIRED');
          }
          try {
            webAuthnEvidence = parseWebAuthnEvidence(authReq['fido_evidence']);
          } catch {
            routeError(500, 'Stored passkey evidence is invalid', 'INTERNAL_ERROR');
          }
          if (webAuthnEvidence.authRequestId !== authReq['id']
              || !await verifyPortableWebAuthnEvidence(webAuthnEvidence, {
                rpId: config.fidoRpId,
                origin: config.fidoOrigin,
              })) {
            routeError(500, 'Stored passkey evidence does not match the authorization request', 'INTERNAL_ERROR');
          }
        }

        const registeredRedirectUri = authReq['redirect_uri'];
        if (typeof registeredRedirectUri === 'string' && redirectUri !== registeredRedirectUri) {
          routeError(400, 'redirectUri must exactly match the authorization request', 'REDIRECT_URI_MISMATCH');
        }

        const storedChallenge = authReq['code_challenge'] as string | null;
        if (storedChallenge) {
          if (codeVerifier === undefined) {
            routeError(400, 'codeVerifier is required for PKCE');
          }
          if (!isValidPkceVerifier(codeVerifier)) {
            routeError(400, 'Invalid codeVerifier');
          }
          if (!verifyPkceChallenge(codeVerifier, storedChallenge)) {
            routeError(400, 'Invalid codeVerifier');
          }
        }

        const expiresSeconds = parseExpiresIn(authReq['expires_in'] as string);
        const now = Date.now();
        expiresAt = new Date(now + expiresSeconds * 1000);
        expTimestamp = Math.floor(expiresAt.getTime() / 1000);
        // Refresh tokens cannot outlive the underlying grant.
        let refreshExpiresAt = new Date(Math.min(now + 30 * 86400 * 1000, expiresAt.getTime()));

        // The plan limit must be enforced where the grant is actually created.
        // Serializing issuance per developer closes the check-then-insert race and
        // prevents many already-approved codes from exceeding the subscription.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 3))`;
        const planRows = await tx`
          SELECT
            COALESCE((SELECT plan FROM subscriptions WHERE developer_id = ${developerId} LIMIT 1), 'free') AS plan,
            (SELECT COUNT(*) FROM grants
             WHERE developer_id = ${developerId} AND status = 'active' AND expires_at > NOW()) AS count
        `;
        const planName = (planRows[0]?.['plan'] as string | undefined) ?? 'free';
        const plan = isPlanName(planName) ? planName : 'free';
        const grantCount = Number(planRows[0]?.['count'] ?? 0);
        const grantLimit = PLAN_LIMITS[plan].grants;
        if (!Number.isSafeInteger(grantCount) || grantCount >= grantLimit) {
          routeError(
            402,
            `Plan limit reached: ${plan} plan allows ${grantLimit} active grant(s)`,
            'PLAN_LIMIT_EXCEEDED',
          );
        }

        // An emergency stop's lockout, checked in the transaction that writes
        // the grant: a freeze committed while this waited is seen, and a
        // freeze placed after this commits finds the grant in its sweep. The
        // code is not consumed when it is refused.
        await assertIssuanceOpen(tx, {
          developerId,
          agentIds: [authReq['agent_id'] as string],
          principalIds: [authReq['principal_id'] as string],
        }, { path: 'token', inTransaction: true, log: request.log });

        // The purpose the Principal approved travels unchanged to the grant and
        // its token. A stored purpose without matching tools entries is a
        // corrupt request: refuse to issue rather than drop the constraint.
        const approvedPurpose = authReq['purpose'] ?? null;
        const approvedDetails = authReq['authorization_details'] ?? null;
        if (approvedPurpose !== null) {
          if (!isKnownPurpose(approvedPurpose)
              || !Array.isArray(approvedDetails)
              || approvedDetails.length === 0
              || purposeOfToolsAuthorizationDetails(approvedDetails as Array<Record<string, unknown>>) !== approvedPurpose) {
            routeError(500, 'Authorization request purpose is inconsistent', 'INTERNAL_ERROR');
          }
        } else if (approvedDetails !== null) {
          // Without a purpose the only valid tools entries are the region-only
          // ones issuance writes: one per connector of the approved scopes, each
          // with a well-formed region and no purpose. Anything else is a corrupt
          // row and is refused rather than signed.
          if (!isRegionOnlyToolsAuthorizationDetails(approvedDetails, authReq['scopes'] as string[])) {
            routeError(500, 'Authorization request purpose is inconsistent', 'INTERNAL_ERROR');
          }
        }
        const grantAuthorizationDetails = approvedDetails as Array<Record<string, unknown>> | null;

        // A request authorized with a passport keeps its binding whatever the
        // flag says now: turning the flag off stops new bindings, it never
        // strips one the Principal consented to. The key it binds is the
        // request's agent_key_thumbprint, the token's cnf.jkt.
        let passportBinding: GrantPassportBinding | null = null;
        let commerceConstraints: CommerceConstraints | null = null;
        if (authReq['passport_binding'] !== null && authReq['passport_binding'] !== undefined) {
          try {
            passportBinding = parseStoredBinding(authReq['passport_binding']);
            commerceConstraints = constraintsOfStoredBinding(authReq['passport_binding']);
          } catch {
            routeError(500, 'Authorization request passport binding is invalid', 'INTERNAL_ERROR');
          }
          if (authReq['agent_key_thumbprint'] !== passportBinding.key_thumbprint) {
            routeError(500, 'Authorization request passport binding is inconsistent', 'INTERNAL_ERROR');
          }
          const { notAfter } = await recheckBinding(sql, tx, passportBinding, authReq['agent_id'] as string,
            { now: issuanceNow, rereadAllowed });
          // A bound grant never outlives its passport or its attestation: a
          // longer requested lifetime ends at the earlier of their exp values.
          if (notAfter.getTime() < expiresAt.getTime()) {
            expiresAt = notAfter;
            expTimestamp = Math.floor(expiresAt.getTime() / 1000);
            refreshExpiresAt = new Date(Math.min(refreshExpiresAt.getTime(), expiresAt.getTime()));
          }
        }
        const tokenAuthorizationDetails = passportBinding === null
          ? grantAuthorizationDetails
          : [...(grantAuthorizationDetails ?? []), commerceAuthorizationDetail(passportBinding, commerceConstraints)];

        if (config.agentLifecycleStatesEnabled) {
          // Lock order is the capacity lock (3), then the lifecycle sweep lock
          // (4). This read runs after a sweep that committed while we waited.
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
          const activeAgent = await tx`
            SELECT id FROM agents
            WHERE id = ${authReq['agent_id'] as string}
              AND developer_id = ${developerId}
              AND status = 'active'
          `;
          if (!activeAgent[0]) routeError(400, 'Agent is not active', 'AGENT_INACTIVE');
        }

        await tx`
          INSERT INTO grants (
            id, agent_id, principal_id, developer_id, scopes, expires_at,
            audience, agent_key_thumbprint, purpose, authorization_details,
            fido_verified, fido_credential_id, fido_evidence
          )
          VALUES (
            ${grantId},
            ${authReq['agent_id'] as string},
            ${authReq['principal_id'] as string},
            ${authReq['developer_id'] as string},
            ${authReq['scopes'] as string[]},
            ${expiresAt},
            ${authReq['audience'] as string | null},
            ${authReq['agent_key_thumbprint'] as string | null},
            ${approvedPurpose as string | null},
            ${grantAuthorizationDetails === null ? null : tx.json(grantAuthorizationDetails as never)},
            ${webAuthnEvidence !== undefined},
            ${webAuthnEvidence?.credentialId ?? null},
            ${webAuthnEvidence ? tx.json(webAuthnEvidence as never) : null}
          )
        `;
        if (passportBinding !== null) {
          await insertGrantBinding(tx, {
            grantId,
            developerId: authReq['developer_id'] as string,
            agentId: authReq['agent_id'] as string,
          }, passportBinding, commerceConstraints);
        }

        // No `bdg` claim at issuance. A budget is attached to a grant after the
        // fact via POST /v1/budget/allocate, which requires the grant to already
        // exist and be active — and this grant's id was generated a few lines
        // above, inside this same transaction. Querying budget_allocations for
        // it could therefore never return a row; it was a guaranteed-empty
        // round trip on every token exchange. Refresh picks the budget up once
        // one exists.

        // Signing is part of the transaction boundary. A key/configuration
        // failure must not consume the one-time code or persist unusable rows.
        const audience = authReq['audience'] as string | null | undefined;
        jwt = await withSpan('grantex.token.sign', {
          [GRANTEX_AGENT_ID]: authReq['agent_did'] as string,
          [GRANTEX_GRANT_ID]: grantId,
          [GRANTEX_PRINCIPAL_ID]: authReq['principal_id'] as string,
          [GRANTEX_DEVELOPER_ID]: developerId,
          [GRANTEX_SCOPES]: authReq['scopes'] as string[],
        }, () => signGrantToken({
          sub: authReq['principal_id'] as string,
          agt: authReq['agent_did'] as string,
          dev: authReq['developer_id'] as string,
          clientId: authReq['agent_id'] as string,
          scp: authReq['scopes'] as string[],
          jti,
          grnt: grantId,
          ...(audience ? { aud: audience } : {}),
          ...(typeof authReq['agent_key_thumbprint'] === 'string'
            ? { cnf: { jkt: authReq['agent_key_thumbprint'] } }
            : {}),
          ...(tokenAuthorizationDetails !== null ? { authorizationDetails: tokenAuthorizationDetails } : {}),
          ...(webAuthnEvidence ? { webauthnEvidence: grantWebAuthnEvidence(webAuthnEvidence) } : {}),
          exp: expTimestamp,
        }));

        await tx`
          INSERT INTO grant_tokens (jti, grant_id, expires_at)
          VALUES (${jti}, ${grantId}, ${expiresAt})
        `;

        await tx`
          INSERT INTO refresh_tokens (id, grant_id, expires_at)
          VALUES (${refreshId}, ${grantId}, ${refreshExpiresAt})
        `;

        if ((credentialFormat === 'vc-jwt' || credentialFormat === 'both')
            && (config.portableWebAuthnEvidenceEnabled || webAuthnEvidence)) {
          const vcResult = await issueAgentGrantVC({
            grantId,
            agentDid: authReq['agent_did'] as string,
            principalId: authReq['principal_id'] as string,
            developerId,
            scopes: authReq['scopes'] as string[],
            expiresAt,
            ...(webAuthnEvidence ? { fidoEvidence: webAuthnEvidence } : {}),
          }, tx);
          verifiableCredential = vcResult.vcJwt;
          verifiableCredentialId = vcResult.vcId;
        }

        await tx`
          UPDATE auth_requests
          SET status = 'consumed'
          WHERE id = ${authReq['id'] as string}
        `;
      }));
    } catch (err) {
      const refusal = issuanceRefusal(err);
      if (refusal) return reply.status(refusal.statusCode).send({ ...refusal.body, requestId: request.id });
      if (isRouteError(err)) {
        return reply.status(err.statusCode).send({
          message: err.message,
          code: err.code,
          requestId: request.id,
        });
      }
      throw err;
    }

    if ((credentialFormat === 'vc-jwt' || credentialFormat === 'both')
        && !config.portableWebAuthnEvidenceEnabled && !webAuthnEvidence) {
      if (issuanceFreezeEnforced()) {
        // The grant's transaction has committed and released the lockout's
        // lock, so a lockout could land before this credential is written:
        // it would revoke the grant, sweep its credentials, and never see
        // this one. The credential is written in a transaction of its own
        // that re-reads the grant and the freeze under the same lock.
        try {
          const vcResult = await issueForCommittedGrant(sql, {
            subject: {
              developerId,
              grantId,
              agentIds: [authReq['agent_id'] as string],
              principalIds: [authReq['principal_id'] as string],
            },
            path: 'token',
            log: request.log,
          }, (tx) => issueAgentGrantVC({
            grantId,
            agentDid: authReq['agent_did'] as string,
            principalId: authReq['principal_id'] as string,
            developerId,
            scopes: authReq['scopes'] as string[],
            expiresAt,
          }, tx));
          if (vcResult !== null) {
            verifiableCredential = vcResult.vcJwt;
            verifiableCredentialId = vcResult.vcId;
          }
        } catch (err) {
          // A lockout now covers the grant, and its stop revokes it: refused
          // like every other issuance under a lockout, rather than answered
          // with a token the stop is taking away.
          if (err instanceof IssuanceFrozenError) {
            const refusal = issuanceRefusal(err)!;
            return reply.status(refusal.statusCode).send({ ...refusal.body, requestId: request.id });
          }
          // Anything else, a lockout state that cannot be read included,
          // leaves the credential out, as a failed best-effort issuance
          // always has. Its transaction rolled back, so nothing was written:
          // closed, not open.
        }
      } else {
        try {
          const vcResult = await issueAgentGrantVC({
            grantId,
            agentDid: authReq['agent_did'] as string,
            principalId: authReq['principal_id'] as string,
            developerId,
            scopes: authReq['scopes'] as string[],
            expiresAt,
          });
          verifiableCredential = vcResult.vcJwt;
          verifiableCredentialId = vcResult.vcId;
        } catch {
          // Preserve the pre-rollout best-effort behavior while the flag is off.
        }
      }
    }
    if (verifiableCredentialId) {
      emitEvent(developerId, 'vc.issued', { vcId: verifiableCredentialId, grantId }).catch(() => {});
    }

    // SD-JWT issuance (optional)
    let sdJwtCredential: string | undefined;
    if (credentialFormat === 'sd-jwt') {
      try {
        const sdResult = await issueSDJWT({
          grantId,
          agentDid: authReq['agent_did'] as string,
          principalId: authReq['principal_id'] as string,
          developerId,
          scopes: authReq['scopes'] as string[],
          expiresAt,
        });
        sdJwtCredential = sdResult.sdJwt;
        emitEvent(developerId, 'sd-jwt.issued', { vcId: sdResult.vcId, grantId }).catch(() => {});
      } catch {
        // Best-effort — don't fail the token exchange if SD-JWT issuance fails
      }
    }

    // Agent Passport issuance (optional) — routes to POST /v1/passport/issue internally
    let agentPassportId: string | undefined;
    if (credentialFormat === 'agent-passport') {
      try {
        // Best-effort: passport issuance via the token exchange path
        // Callers should use POST /v1/passport/issue directly for full control
        agentPassportId = `urn:grantex:passport:token-exchange:${grantId}`;
        emitEvent(developerId, 'passport.token-exchange', { grantId }).catch(() => {});
      } catch {
        // Best-effort — don't fail the token exchange if passport issuance fails
      }
    }

    // Emit events (best-effort, non-blocking)
    const eventData = {
      grantId,
      agentId: authReq['agent_id'] as string,
      principalId: authReq['principal_id'] as string,
      scopes: authReq['scopes'] as string[],
      expiresAt: expiresAt.toISOString(),
    };
    emitEvent(developerId, 'grant.created', eventData).catch(() => {});
    emitEvent(developerId, 'token.issued', { tokenId: jti, ...eventData }).catch(() => {});

    tokenExchangeTotal.inc({ status: 'success' });
    endTimer();

    // Usage metering (best-effort)
    incrementUsage(developerId, 'token_exchanges').catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: expiresAt.toISOString(),
      scopes: authReq['scopes'] as string[],
      refreshToken: refreshId,
      grantId,
      ...(verifiableCredential !== undefined ? { verifiableCredential } : {}),
      ...(sdJwtCredential !== undefined ? { sdJwtCredential } : {}),
      ...(agentPassportId !== undefined ? { agentPassportId } : {}),
    });
  });

  // POST /v1/token/refresh — refresh a grant token (single-use rotation)
  app.post<{ Body: RefreshBody }>('/v1/token/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.status(400).send({ message: 'Request body must be a JSON object', code: 'BAD_REQUEST', requestId: request.id });
    }
    const { refreshToken, agentId } = body;

    if (typeof refreshToken !== 'string' || refreshToken.length === 0 || refreshToken.length > 512
        || typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256) {
      return reply.status(400).send({
        message: 'refreshToken and agentId are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;
    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;
    if (idempotencyKey !== undefined && (idempotencyKey.length < 16 || idempotencyKey.length > 256)) {
      return reply.status(400).send({
        message: 'Idempotency-Key must contain 16 to 256 characters',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const replayRequestHash = idempotencyKey
      ? refreshReplayRequestHash(developerId, agentId, refreshToken, idempotencyKey)
      : null;

    let row!: Record<string, unknown>;
    let grantId!: string;
    let scopes!: string[];
    let grantExpiresAt!: Date;
    let jwt!: string;
    let jti = newTokenId();
    let issuedAt = Math.floor(Date.now() / 1000);
    let responseRefreshToken!: string;
    let refreshReplay = false;
    let refreshReplayRejected = false;

    // The instant a bound grant's registry records are checked at.
    const issuanceNow = new Date();

    try {
      await issueWithFreshIssuerStatus(sql, issuanceNow, (rereadAllowed) => sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx`
          SELECT rt.id AS refresh_id, rt.grant_id, rt.is_used,
                 rt.expires_at AS refresh_expires_at, rt.used_at,
                  rt.rotated_to_token_id, rt.replay_expires_at,
                  rt.replay_request_hash, rt.replay_jti, rt.replay_issued_at,
                  rt.replay_grant_token,
                 g.agent_id, g.principal_id, g.developer_id, g.scopes, g.status AS grant_status,
                  g.expires_at AS grant_expires_at, g.audience, g.agent_key_thumbprint,
                  g.authorization_details AS grant_authorization_details,
                  g.fido_evidence,
                 g.parent_grant_id, g.delegation_depth, g.actor_chain,
                 a.did AS agent_did, parent_agent.did AS parent_agent_did,
                  ba.remaining_budget, ba.currency AS budget_currency,
                  gpb.issuer_entity_id AS passport_issuer_entity_id,
                  gpb.attestation_id AS passport_attestation_id,
                  gpb.registry_attestation_id AS passport_registry_attestation_id,
                  gpb.external_credential_id AS passport_external_credential_id,
                  gpb.passport_hash, gpb.key_thumbprint AS passport_key_thumbprint,
                  gpb.acceptance_list_uri AS passport_acceptance_list_uri,
                  gpb.acceptance_list_idx AS passport_acceptance_list_idx,
                  gpb.passport_expires_at,
                  gpb.commerce_constraints AS passport_commerce_constraints
          FROM refresh_tokens rt
          JOIN grants g ON g.id = rt.grant_id
          JOIN agents a ON a.id = g.agent_id
          LEFT JOIN grants parent_grant ON parent_grant.id = g.parent_grant_id
          LEFT JOIN agents parent_agent ON parent_agent.id = parent_grant.agent_id
          LEFT JOIN budget_allocations ba ON ba.grant_id = g.id
          LEFT JOIN grant_passport_bindings gpb ON gpb.grant_id = g.id
          WHERE rt.id = ${refreshToken}
            AND g.developer_id = ${developerId}
            AND g.protocol = 'grantex-v1'
            AND a.status = 'active'
          FOR UPDATE OF rt, g, a
        `;

        row = rows[0] ?? routeError(400, 'Invalid refresh token');
        if (row['agent_id'] !== agentId) {
          routeError(400, 'Agent mismatch');
        }
        if (row['grant_status'] === 'revoked') {
          routeError(400, 'Grant has been revoked');
        }
        if (row['grant_status'] !== 'active') {
          routeError(400, 'Grant is not active');
        }
        if (new Date(row['grant_expires_at'] as string) <= new Date()) {
          routeError(400, 'Grant has expired');
        }
        // An emergency stop's lockout covers this grant if it covers the grant
        // or anything above it, as a stop over that scope would have revoked
        // it. Refused before a token is minted or a replayed one handed back;
        // the refresh token is left unused.
        await assertIssuanceOpen(tx, {
          developerId,
          agentIds: [row['agent_id'] as string],
          principalIds: [row['principal_id'] as string],
          grantIds: [row['grant_id'] as string],
        }, { path: 'token_refresh', inTransaction: true, log: request.log });

        grantId = row['grant_id'] as string;
        scopes = row['scopes'] as string[];
        grantExpiresAt = new Date(row['grant_expires_at'] as string);
        const now = new Date();
        // Refresh tokens cannot outlive the underlying grant.
        const refreshExpiresAt = new Date(Math.min(now.getTime() + 30 * 86400 * 1000, grantExpiresAt.getTime()));

        const remainingBudget = row['remaining_budget'];
        const remainingBudgetText = remainingBudget !== null && remainingBudget !== undefined
          ? String(remainingBudget)
          : undefined;
        const budgetAmount = remainingBudget !== null && remainingBudget !== undefined
          ? Number(remainingBudget)
          : undefined;
        if (budgetAmount !== undefined && !Number.isFinite(budgetAmount)) {
          routeError(500, 'Invalid budget allocation', 'INTERNAL_ERROR');
        }
        const budgetCurrency = typeof row['budget_currency'] === 'string' ? row['budget_currency'] : undefined;
        if (remainingBudgetText !== undefined
            && (!/^(0|[1-9]\d*)(\.\d+)?$/.test(remainingBudgetText)
              || !budgetCurrency
              || !/^[A-Z]{3}$/.test(budgetCurrency))) {
          routeError(500, 'Invalid budget allocation', 'INTERNAL_ERROR');
        }
        const audience = row['audience'] as string | null | undefined;
        const parentGrnt = row['parent_grant_id'] as string | null | undefined;
        const parentAgt = row['parent_agent_did'] as string | null | undefined;
        const delegationDepth = Number(row['delegation_depth'] ?? 0);
        // The stored RFC 8693 actor chain; grants delegated before it was
        // stored fall back to the delegating agent alone.
        let refreshedAct: Record<string, unknown> | undefined;
        try {
          refreshedAct = row['actor_chain'] !== null && row['actor_chain'] !== undefined
            ? parseActorClaim(row['actor_chain']) as Record<string, unknown>
            : (parentAgt ? { sub: parentAgt } : undefined);
        } catch {
          routeError(500, 'Invalid grant actor chain', 'INTERNAL_ERROR');
        }
        if (refreshedAct !== undefined && parentAgt && refreshedAct['sub'] !== parentAgt) {
          routeError(500, 'Invalid grant actor chain', 'INTERNAL_ERROR');
        }
        // Refreshed tokens keep the grant's tools entries (purpose) and add the
        // current budget entry, if any.
        const storedDetails = row['grant_authorization_details'] ?? null;
        if (storedDetails !== null && !Array.isArray(storedDetails)) {
          routeError(500, 'Invalid grant authorization details', 'INTERNAL_ERROR');
        }
        // A bound grant's refreshed token carries its binding again, once the
        // registry's records still stand behind the passport.
        let passportBinding: GrantPassportBinding | null;
        let commerceConstraints: CommerceConstraints | null = null;
        try {
          passportBinding = bindingFromGrantRow(row);
          if (passportBinding !== null) commerceConstraints = parseStoredConstraints(row['passport_commerce_constraints']);
        } catch {
          routeError(500, 'Invalid grant passport binding', 'INTERNAL_ERROR');
        }
        if (passportBinding !== null) {
          if (row['agent_key_thumbprint'] !== passportBinding.key_thumbprint) {
            routeError(500, 'Invalid grant passport binding', 'INTERNAL_ERROR');
          }
          // The grant's expires_at was already limited to the passport and
          // attestation exp at issuance; the recheck refuses once either passed.
          await recheckBinding(sql, tx, passportBinding, row['agent_id'] as string, { now: issuanceNow, rereadAllowed });
        }
        const refreshedDetails: Array<Record<string, unknown>> = [
          ...((storedDetails as Array<Record<string, unknown>> | null) ?? []),
          ...(passportBinding !== null ? [commerceAuthorizationDetail(passportBinding, commerceConstraints)] : []),
          ...(remainingBudgetText !== undefined && budgetCurrency
            ? [{
                type: 'urn:grantex:params:oauth:authorization-details:budget',
                amount: remainingBudgetText,
                currency: budgetCurrency,
              }]
            : []),
        ];

        const signRefreshedGrantToken = () => signGrantToken({
          sub: row['principal_id'] as string,
          agt: row['agent_did'] as string,
          dev: row['developer_id'] as string,
          clientId: row['agent_id'] as string,
          scp: scopes,
          jti,
          grnt: grantId,
          iat: issuedAt,
          ...(audience ? { aud: audience } : {}),
          ...(typeof row['agent_key_thumbprint'] === 'string'
            ? { cnf: { jkt: row['agent_key_thumbprint'] } }
            : {}),
          ...(budgetAmount !== undefined ? { bdg: budgetAmount } : {}),
          ...(refreshedDetails.length > 0 ? { authorizationDetails: refreshedDetails } : {}),
          ...(row['fido_evidence'] != null
            ? { webauthnEvidence: grantWebAuthnEvidence(parseWebAuthnEvidence(row['fido_evidence'])) }
            : {}),
          ...(parentAgt ? { parentAgt } : {}),
          ...(parentGrnt ? { parentGrnt } : {}),
          ...(refreshedAct !== undefined ? { act: refreshedAct } : {}),
          ...(delegationDepth > 0 ? { delegationDepth } : {}),
          exp: Math.floor(grantExpiresAt.getTime() / 1000),
        });

        if (row['is_used']) {
          const replayExpiresAt = row['replay_expires_at'] !== null && row['replay_expires_at'] !== undefined
            ? new Date(row['replay_expires_at'] as string)
            : null;
          const rotatedToTokenId = row['rotated_to_token_id'];
          if (
            typeof rotatedToTokenId !== 'string'
            || rotatedToTokenId.length === 0
            || replayExpiresAt === null
            || Number.isNaN(replayExpiresAt.getTime())
            || replayExpiresAt <= now
          ) {
            await clearRefreshReplayState(tx, row['refresh_id'] as string);
            refreshReplayRejected = true;
            return;
          }
          const replayIssuedAt = Number(row['replay_issued_at']);
          const replayGrantToken = openRefreshReplayToken(row['replay_grant_token']);
          if (!replayHashMatches(row['replay_request_hash'], replayRequestHash)
              || typeof row['replay_jti'] !== 'string'
              || replayGrantToken === null
              || !Number.isSafeInteger(replayIssuedAt)) {
            await clearRefreshReplayState(tx, row['refresh_id'] as string);
            refreshReplayRejected = true;
            return;
          }

          const rotatedRows = await tx`
            SELECT id, grant_id, is_used, expires_at
            FROM refresh_tokens
            WHERE id = ${rotatedToTokenId}
            FOR UPDATE
          `;
          const rotated = rotatedRows[0];
          if (
            !rotated
            || rotated['grant_id'] !== grantId
            || rotated['is_used']
            || new Date(rotated['expires_at'] as string) <= now
          ) {
            await clearRefreshReplayState(tx, row['refresh_id'] as string);
            refreshReplayRejected = true;
            return;
          }

          // The previous response may have been lost after commit. The same
          // idempotency key reproduces the original token identity and returns
          // the already-rotated child without extending any lifetime.
          responseRefreshToken = rotatedToTokenId;
          refreshReplay = true;
          jti = row['replay_jti'];
          issuedAt = replayIssuedAt;
          jwt = replayGrantToken;
          return;
        }

        if (new Date(row['refresh_expires_at'] as string) < now) {
          routeError(400, 'Refresh token expired');
        }

        const newRefreshId = newRefreshTokenId();
        responseRefreshToken = newRefreshId;

        // Sign before rotating the single-use refresh token. A signer failure
        // rolls the transaction back and leaves the caller able to retry.
        jwt = await signRefreshedGrantToken();
        const encryptedReplayToken = sealRefreshReplayToken(jwt);

        await tx`
          INSERT INTO refresh_tokens (id, grant_id, expires_at)
          VALUES (${newRefreshId}, ${grantId}, ${refreshExpiresAt})
        `;

        const updated = await tx`
          UPDATE refresh_tokens
          SET is_used = true,
              used_at = NOW(),
              rotated_to_token_id = ${newRefreshId},
              replay_request_hash = ${replayRequestHash},
              replay_jti = ${jti},
              replay_issued_at = ${issuedAt},
              replay_grant_token = ${encryptedReplayToken},
              replay_expires_at = LEAST(
                NOW() + (${REFRESH_TOKEN_REPLAY_WINDOW_SECONDS} * INTERVAL '1 second'),
                ${refreshExpiresAt}
              )
          WHERE id = ${row['refresh_id'] as string}
            AND is_used = false
          RETURNING id
        `;
        if (!updated[0]) {
          routeError(400, REFRESH_TOKEN_ALREADY_USED);
        }

        await tx`
          INSERT INTO grant_tokens (jti, grant_id, expires_at)
          VALUES (${jti}, ${grantId}, ${grantExpiresAt})
        `;
      }));
      if (refreshReplayRejected) routeError(400, REFRESH_TOKEN_ALREADY_USED);
    } catch (err) {
      const refusal = issuanceRefusal(err);
      if (refusal) return reply.status(refusal.statusCode).send({ ...refusal.body, requestId: request.id });
      if (isRouteError(err)) {
        return reply.status(err.statusCode).send({
          message: err.message,
          code: err.code,
          requestId: request.id,
        });
      }
      throw err;
    }

    // Emit event (best-effort)
    const eventData = {
      grantId,
      agentId: row['agent_id'] as string,
      principalId: row['principal_id'] as string,
      scopes,
      expiresAt: grantExpiresAt.toISOString(),
    };
    emitEvent(developerId, 'token.issued', { tokenId: jti, refreshReplay, ...eventData }).catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: grantExpiresAt.toISOString(),
      scopes,
      refreshToken: responseRefreshToken,
      grantId,
    });
  });
}

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

function isFormRequest(request: FastifyRequest): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && type.toLowerCase().startsWith(FORM_CONTENT_TYPE);
}

/** A failure of the child grant exchange that is the server's, not the request's. */
class ChildGrantInternalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildGrantInternalError';
  }
}

function sendChildGrantRefusal(reply: FastifyReply, requestId: string, refusal: {
  statusCode: number; error: string; code: string; reason: string; message: string;
}) {
  return reply.status(refusal.statusCode).send({
    error: refusal.error,
    error_description: refusal.message,
    code: refusal.code,
    reason: refusal.reason,
    message: refusal.message,
    requestId,
  });
}

/**
 * The DPoP proof (RFC 9449 §4) of a token exchange: one header, signed,
 * for POST at this endpoint, fresh, and not seen before (its jti is recorded
 * in the replay store, §11.1). The key is compared with the subject token's
 * cnf.jkt by the caller. Throws ChildGrantError (invalid_dpop_proof).
 */
async function verifyExchangeProof(request: FastifyRequest): Promise<VerifiedDpopProof> {
  const header = request.headers['dpop'];
  try {
    return await verifyDpopProof(typeof header === 'string' ? header : undefined, {
      method: 'POST',
      targetUri: `${config.publicBaseUrl.replace(/\/$/, '')}/v1/token`,
    });
  } catch (err) {
    if (err instanceof DpopError) throw new ChildGrantError('invalid_dpop_proof', err.reason, err.message);
    throw err;
  }
}

function subjectRefused(reason: string, message: string): never {
  throw new ChildGrantError('invalid_request', reason, message);
}

/**
 * POST /v1/token with grant_type urn:ietf:params:oauth:grant-type:token-exchange
 * (RFC 8693 §2.1), PASSPORT_BOUND_GRANTS_ENABLED on: a per-merchant child of
 * a passport-bound grant (spec/passport-binding.md §8).
 *
 * The client is the developer the API key authenticates (RFC 8693 §2.1
 * leaves client authentication to the deployment); the subject token must be
 * one of its grants' tokens, and the request must carry a DPoP proof (RFC
 * 9449) signed with the key the subject token is bound to. The child is a
 * token of the parent grant, with a fresh jti, recorded in grant_tokens
 * against the parent grant (so revoking the grant revokes it, and a budget
 * debit made with its grant id lands on the parent's allocation) and in
 * grant_child_tokens (so revoking the subject token revokes it too). Every refusal is an RFC 6749 §5.2 error response
 * with the PRD Appendix C code where one applies; every check fails closed.
 */
async function exchangeChildGrant(request: FastifyRequest, reply: FastifyReply, body: Record<string, unknown>) {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  const developerId = request.developer.id;
  const sql = getSql();
  // The instant the parent's binding is checked at, and the child's clock.
  const issuanceNow = new Date();
  const nowSeconds = Math.floor(issuanceNow.getTime() / 1000);

  let exchange: TokenExchangeRequest;
  let jwt!: string;
  let exp!: number;
  let scopes!: string[];
  let grantId!: string;
  const childJti = newTokenId();
  try {
    exchange = parseTokenExchangeRequest(body);
    // Proof of possession of the bound key, before the subject is read: the
    // developer's credential and a copied parent token do not suffice.
    const proof = await verifyExchangeProof(request);

    // Signature, claims, the developer, and the token's and grant's
    // revocation state (Redis and the database); any doubt is a refusal.
    const checked = await checkActiveGrantToken(exchange.subjectToken, {
      expectedDeveloperId: developerId,
      expectedProtocol: 'grantex-v1',
    });
    if (!checked.ok) {
      // Another developer's token reads as an invalid one: the answer does
      // not say whose it is.
      const reason = checked.reason === 'revoked' || checked.reason === 'expired' ? checked.reason : 'invalid';
      subjectRefused(`subject_token_${reason}`, `The subject token is ${reason === 'invalid' ? 'not a grant token of this developer' : reason}`);
    }
    const claims = checked.claims;
    // A bound subject carries cnf.jkt; one that does not is refused below as
    // not passport-bound, and the proof is compared with the binding there.
    if (claims.cnf?.jkt !== undefined) requireProofOfBoundKey(proof.thumbprint, claims.cnf.jkt);
    if (claims.parentJti !== undefined) {
      subjectRefused('subject_is_child', 'A child grant is not exchanged again: exchange the parent grant token');
    }

    await runWithFreshIssuerStatus(sql, issuanceNow, (rereadAllowed) => sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      // FOR SHARE: a revocation of the grant or of the subject token that
      // comes second waits for this exchange to commit. The grant's status is
      // read by every check of the child; the token revocation revokes the
      // children in a second statement, with a snapshot taken after the wait,
      // so it sees this child (routes/tokens.ts). A revocation that came
      // first has committed by the time this lock is granted, and this reads
      // it. Parallel exchanges do not block one another.
      const rows = await tx`
        SELECT g.id, g.agent_id, g.principal_id, g.scopes, g.status, g.expires_at,
               g.agent_key_thumbprint, g.authorization_details,
               gt.is_revoked AS subject_revoked, gt.expires_at AS subject_expires_at,
               a.did AS agent_did, a.status AS agent_status,
               EXISTS (SELECT 1 FROM grant_child_tokens c WHERE c.jti = gt.jti) AS subject_is_child,
               gpb.issuer_entity_id AS passport_issuer_entity_id,
               gpb.attestation_id AS passport_attestation_id,
               gpb.registry_attestation_id AS passport_registry_attestation_id,
               gpb.external_credential_id AS passport_external_credential_id,
               gpb.passport_hash, gpb.key_thumbprint AS passport_key_thumbprint,
               gpb.acceptance_list_uri AS passport_acceptance_list_uri,
               gpb.acceptance_list_idx AS passport_acceptance_list_idx,
               gpb.passport_expires_at,
               gpb.commerce_constraints AS passport_commerce_constraints
        FROM grant_tokens gt
        JOIN grants g ON g.id = gt.grant_id
        JOIN agents a ON a.id = g.agent_id
        LEFT JOIN grant_passport_bindings gpb ON gpb.grant_id = g.id
        WHERE gt.jti = ${claims.jti}
          AND g.developer_id = ${developerId}
          AND g.protocol = 'grantex-v1'
        FOR SHARE OF gt, g
      `;
      const row = rows[0];
      if (!row || row['id'] !== claims.grnt) subjectRefused('subject_token_invalid', 'The subject token is not a grant token of this developer');
      if (row['subject_revoked'] === true || row['status'] !== 'active') {
        subjectRefused('subject_token_revoked', 'The subject token or its grant has been revoked');
      }
      if (new Date(row['expires_at'] as string).getTime() <= issuanceNow.getTime()
          || new Date(row['subject_expires_at'] as string).getTime() <= issuanceNow.getTime()) {
        subjectRefused('subject_token_expired', 'The subject token or its grant has expired');
      }
      if (row['agent_status'] !== 'active') subjectRefused('agent_inactive', 'The agent of the subject token is not active');
      if (row['subject_is_child'] === true) {
        subjectRefused('subject_is_child', 'A child grant is not exchanged again: exchange the parent grant token');
      }

      let binding: GrantPassportBinding | null;
      let parentConstraints: CommerceConstraints | null = null;
      try {
        binding = bindingFromGrantRow(row);
        if (binding !== null) parentConstraints = parseStoredConstraints(row['passport_commerce_constraints']);
      } catch {
        // A binding the registry did not write: refuse to issue rather than
        // issue unbound or unconstrained.
        throw new ChildGrantInternalError('Invalid grant passport binding');
      }
      // Child grants exist only for passport-bound parents (PRD §8.5).
      if (binding === null) {
        subjectRefused('not_passport_bound', 'Only a passport-bound grant is exchanged for a per-merchant child grant');
      }
      // Key equality (spec/agent-passport-1.0.md §7): the child keeps the
      // parent's cnf.jkt, which is the passport's key.
      if (row['agent_key_thumbprint'] !== binding.key_thumbprint || claims.cnf?.jkt !== binding.key_thumbprint) {
        throw new ChildGrantInternalError('Invalid grant passport binding');
      }
      // RFC 9449: the request is signed by the passport's key.
      requireProofOfBoundKey(proof.thumbprint, binding.key_thumbprint);

      // An emergency stop's lockout over the grant, its agent or principal.
      await assertIssuanceOpen(tx, {
        developerId,
        agentIds: [row['agent_id'] as string],
        principalIds: [row['principal_id'] as string],
        grantIds: [row['id'] as string],
      }, { path: 'token_exchange', inTransaction: true, log: request.log });

      // The same recheck as the code exchange and the refresh (§5): the
      // issuer, the attestation, both status sources, the passport's and the
      // attestation's exp, and the key. Refusals propagate with their code.
      const { notAfter } = await recheckBindingAtIssuance(sql, tx, binding, row['agent_id'] as string,
        { now: issuanceNow, rereadAllowed });

      // Decision 3 and attenuation (child-grant.ts).
      const childConstraints = attenuateConstraints(parentConstraints, exchange.merchant, exchange.authorizationDetails);

      const grantScopes = row['scopes'] as string[];
      scopes = exchange.scopes ?? claims.scp;
      if (scopes.some((scope) => !claims.scp.includes(scope) || !grantScopes.includes(scope))) {
        throw new ChildGrantError('invalid_scope', 'wider_scope', 'The requested scope exceeds the parent grant\'s');
      }

      exp = childGrantExpiry({
        now: nowSeconds,
        subjectExp: claims.exp,
        grantExpiresAt: Math.floor(new Date(row['expires_at'] as string).getTime() / 1000),
        notAfter: Math.floor(notAfter.getTime() / 1000),
      });
      if (exp <= nowSeconds) subjectRefused('subject_token_expired', 'The subject token or its grant has expired');

      let toolsDetails: Array<Record<string, unknown>>;
      try {
        toolsDetails = narrowToolsAuthorizationDetails(row['authorization_details'] ?? null, scopes);
      } catch {
        throw new ChildGrantInternalError('Invalid grant authorization details');
      }

      grantId = row['id'] as string;
      const expiresAt = new Date(exp * 1000);
      // Signed before anything is written: a signer failure rolls back.
      jwt = await signGrantToken({
        sub: row['principal_id'] as string,
        agt: row['agent_did'] as string,
        dev: developerId,
        clientId: row['agent_id'] as string,
        scp: scopes,
        jti: childJti,
        grnt: grantId,
        iat: nowSeconds,
        aud: exchange.merchant,
        cnf: { jkt: binding.key_thumbprint },
        // RFC 8693 §4.1: the same agent acts with the same key, so no actor is
        // added; the parent's actor chain, when it has one, is kept as it is.
        ...(claims.act !== undefined ? { act: claims.act } : {}),
        authorizationDetails: [...toolsDetails, commerceAuthorizationDetail(binding, childConstraints)],
        parentJti: claims.jti,
        exp,
      });
      await tx`
        INSERT INTO grant_tokens (jti, grant_id, expires_at)
        VALUES (${childJti}, ${grantId}, ${expiresAt})
      `;
      await tx`
        INSERT INTO grant_child_tokens (jti, grant_id, developer_id, parent_jti, merchant_origin, constraints, expires_at)
        VALUES (${childJti}, ${grantId}, ${developerId}, ${claims.jti}, ${exchange.merchant},
                ${tx.json(constraintMembers(childConstraints) as never)}, ${expiresAt})
      `;
    }));
  } catch (err) {
    if (err instanceof ChildGrantError) return sendChildGrantRefusal(reply, request.id, err);
    if (err instanceof PassportBindingError) {
      // RFC 8693 §2.2.2: a subject token unacceptable by policy is
      // invalid_request, answered as RFC 6749 §5.2 specifies, 400; the
      // Appendix C code says why. status_stale is not a refusal of the
      // request but the registry unable to answer now, and keeps its 503 so
      // that a client retries rather than gives up.
      return sendChildGrantRefusal(reply, request.id, {
        statusCode: err.code === 'status_stale' ? err.statusCode : 400, error: 'invalid_request', code: err.code, reason: err.reason, message: err.message,
      });
    }
    const refusal = issuanceRefusal(err);
    if (refusal) return reply.status(refusal.statusCode).send({ ...refusal.body, requestId: request.id });
    if (err instanceof ChildGrantInternalError) {
      return reply.status(500).send({ message: err.message, code: 'INTERNAL_ERROR', requestId: request.id });
    }
    throw err;
  }

  emitEvent(developerId, 'token.issued', {
    tokenId: childJti,
    grantId,
    merchant: exchange.merchant,
    scopes,
    expiresAt: new Date(exp * 1000).toISOString(),
  }).catch(() => {});
  incrementUsage(developerId, 'token_exchanges').catch(() => {});

  // RFC 8693 §2.2.1. The child is sender-constrained by cnf.jkt (RFC 9449
  // §6.1), hence DPoP; it is short-lived and gets no refresh token.
  return reply.status(200).send({
    access_token: jwt,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: 'DPoP',
    expires_in: exp - nowSeconds,
    scope: scopes.join(' '),
  });
}
