import type { FastifyInstance } from 'fastify';
import { getSql, type TxSql } from '../db/client.js';
import { newGrantId, newTokenId, newRefreshTokenId } from '../lib/ids.js';
import { signGrantToken, parseExpiresIn } from '../lib/crypto.js';
import { delegatedActorClaim } from '../lib/grant-token-claims.js';
import { narrowToolsAuthorizationDetails, purposeOfToolsAuthorizationDetails } from '../lib/purpose.js';
import { emitEvent } from '../lib/events.js';
import { issueAgentGrantVC } from '../lib/vc.js';
import { checkActiveGrantToken } from '../lib/active-grant-token.js';
import {
  IssuanceFrozenError,
  assertIssuanceOpen,
  issuanceFreezeEnforced,
  issuanceRefusal,
  issueForCommittedGrant,
} from '../lib/revocation/issuance-freeze.js';
import { config } from '../config.js';
import {
  grantWebAuthnEvidence,
  parseWebAuthnEvidence,
  verifyPortableWebAuthnEvidence,
  type WebAuthnAssertionEvidence,
} from '../lib/webauthn-evidence.js';

interface DelegateBody {
  parentGrantToken: string;
  subAgentId: string;
  scopes: string[];
  expiresIn?: string;
  credentialFormat?: 'jwt' | 'vc-jwt' | 'both';
}

export async function delegateRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/grants/delegate
  app.post<{ Body: DelegateBody }>('/v1/grants/delegate', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<DelegateBody>;
    const { parentGrantToken, subAgentId, scopes, expiresIn = '1h' } = body;

    if (typeof parentGrantToken !== 'string' || parentGrantToken.length === 0
        || typeof subAgentId !== 'string' || subAgentId.length === 0
        || !Array.isArray(scopes) || scopes.length === 0) {
      return reply.status(400).send({
        message: 'parentGrantToken, subAgentId, and scopes are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (typeof expiresIn !== 'string') {
      return reply.status(400).send({
        message: 'expiresIn must be a string like "1h", "30m", or "1d"',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (scopes.length > 100 || scopes.some((scope) => typeof scope !== 'string' || scope.length === 0 || scope.length > 256)) {
      return reply.status(400).send({
        message: 'scopes must contain 1 to 100 non-empty strings of at most 256 characters',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (body.credentialFormat !== undefined && !['jwt', 'vc-jwt', 'both'].includes(body.credentialFormat)) {
      return reply.status(400).send({
        message: 'credentialFormat must be jwt, vc-jwt, or both',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const parentCheck = await checkActiveGrantToken(parentGrantToken, {
      expectedDeveloperId: request.developer.id,
    });

    if (!parentCheck.ok) {
      if (parentCheck.reason === 'invalid') {
        return reply.status(400).send({ message: 'Invalid parentGrantToken', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (parentCheck.reason === 'invalid_claims') {
        return reply.status(400).send({ message: 'Invalid parentGrantToken claims', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (parentCheck.reason === 'wrong_developer') {
        return reply.status(403).send({ message: 'Parent grant belongs to a different developer', code: 'FORBIDDEN', requestId: request.id });
      }
      if (parentCheck.reason === 'not_found') {
        return reply.status(400).send({ message: 'Invalid parentGrantToken claims', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (parentCheck.reason === 'revoked') {
        return reply.status(400).send({ message: 'Parent grant has been revoked', code: 'BAD_REQUEST', requestId: request.id });
      }
      return reply.status(400).send({ message: 'Parent grant has expired', code: 'BAD_REQUEST', requestId: request.id });
    }

    const parentClaims = parentCheck.claims;
    if (!parentClaims.jti || !parentClaims.grnt || !parentClaims.scp || !parentClaims.exp) {
      return reply.status(400).send({ message: 'Invalid parentGrantToken claims', code: 'BAD_REQUEST', requestId: request.id });
    }

    // PRD §8.6: a sub-agent of a passport-bound grant must bind its own
    // passport, with the parent's binding carried in act.passport. Until that
    // exists, a passport-bound grant, or a per-merchant child of one, is not
    // delegated: an unbound delegated grant would escape the binding
    // (spec/passport-binding.md §8.6). Read only with the flag on, so nothing
    // changes with it off.
    if (config.passportBoundGrantsEnabled) {
      const bound = await getSql()`
        SELECT 1 FROM grant_passport_bindings
        WHERE grant_id = ${parentClaims.grnt} AND developer_id = ${request.developer.id}
      `;
      if (bound.length > 0) {
        return reply.status(403).send({
          message: 'A passport-bound grant cannot be delegated yet: a sub-agent must bind its own Agent Passport',
          code: 'PASSPORT_BOUND_DELEGATION_UNSUPPORTED',
          requestId: request.id,
        });
      }
    }

    const parentGrnt = parentClaims.grnt;
    const parentAgt = parentClaims.agt;
    const parentScp = parentClaims.scp;
    const parentExp = parentClaims.exp;
    const parentDepth = parentClaims.delegationDepth ?? 0;

    // SPEC §9: the delegation chain has to terminate. Without this the depth was
    // computed and signed but never compared against anything, so an agent could
    // keep delegating to fresh sub-agents indefinitely.
    if (parentDepth + 1 > config.maxDelegationDepth) {
      return reply.status(403).send({
        message: `Delegation depth limit reached: chains may not exceed ${config.maxDelegationDepth} hop(s)`,
        code: 'DELEGATION_DEPTH_EXCEEDED',
        requestId: request.id,
      });
    }

    // Validate scopes ⊆ parent scopes
    const invalidScopes = scopes.filter((s) => !parentScp.includes(s));
    if (invalidScopes.length > 0) {
      return reply.status(400).send({
        message: `Requested scopes exceed parent grant scopes: ${invalidScopes.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;
    let inheritedEvidence: WebAuthnAssertionEvidence | undefined;
    if (parentClaims.webauthnEvidence) {
      const rows = await sql`
        SELECT fido_evidence FROM grants
        WHERE id = ${parentGrnt} AND developer_id = ${developerId}
      `;
      try {
        inheritedEvidence = parseWebAuthnEvidence(rows[0]?.['fido_evidence']);
        if (inheritedEvidence.digest !== parentClaims.webauthnEvidence.digest
            || !await verifyPortableWebAuthnEvidence(inheritedEvidence, {
              rpId: config.fidoRpId, origin: config.fidoOrigin,
            })) {
          throw new Error('Parent passkey evidence does not match its signed reference');
        }
      } catch {
        return reply.status(400).send({
          message: 'Parent grant has invalid passkey evidence', code: 'BAD_REQUEST', requestId: request.id,
        });
      }
    }

    // Look up sub-agent
    const agentRows = await sql`
      SELECT id, did, scopes, key_thumbprint
      FROM agents
      WHERE id = ${subAgentId} AND developer_id = ${developerId} AND status = 'active'
    `;
    const subAgent = agentRows[0];
    if (!subAgent) {
      return reply.status(404).send({ message: 'Sub-agent not found', code: 'NOT_FOUND', requestId: request.id });
    }
    const registeredSubAgentScopes = Array.isArray(subAgent['scopes']) ? subAgent['scopes'] as string[] : [];
    const unregisteredScopes = scopes.filter((scope) => !registeredSubAgentScopes.includes(scope));
    if (registeredSubAgentScopes.length > 0 && unregisteredScopes.length > 0) {
      return reply.status(400).send({
        message: `Requested scopes exceed sub-agent registration: ${unregisteredScopes.join(', ')}`,
        code: 'INVALID_SCOPE',
        requestId: request.id,
      });
    }

    // Compute expiry: min(parent exp, now + expiresIn)
    let expiresSeconds: number;
    try {
      expiresSeconds = parseExpiresIn(expiresIn);
    } catch {
      return reply.status(400).send({
        message: 'Invalid expiresIn format. Use e.g. "1h", "30m", or "1d".',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (config.maxGrantLifetimeSeconds !== null && expiresSeconds > config.maxGrantLifetimeSeconds) {
      return reply.status(400).send({
        message: `expiresIn exceeds the maximum grant lifetime of ${config.maxGrantLifetimeSeconds} seconds`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const now = Date.now();
    const requestedExpiry = now + expiresSeconds * 1000;
    const parentExpiry = parentExp * 1000;
    const expiresAt = new Date(Math.min(requestedExpiry, parentExpiry));
    const expTimestamp = Math.floor(expiresAt.getTime() / 1000);

    // A delegated grant inherits the parent's purpose: it keeps the parent's
    // tools entries for the connectors it is delegated, and never gains one.
    let childDetails: Array<Record<string, unknown>>;
    let childPurpose: string | undefined;
    try {
      const parentDetails = narrowToolsAuthorizationDetails(parentClaims.authorizationDetails, parentScp);
      childPurpose = purposeOfToolsAuthorizationDetails(parentDetails);
      childDetails = narrowToolsAuthorizationDetails(parentClaims.authorizationDetails, scopes);
    } catch {
      return reply.status(400).send({ message: 'Invalid parentGrantToken claims', code: 'BAD_REQUEST', requestId: request.id });
    }

    // RFC 8693 actor chain: the delegating agent, then the actors that
    // delegated to it. Stored on the grant so a refreshed token keeps it.
    let actorChain: Record<string, unknown>;
    try {
      actorChain = delegatedActorClaim(parentAgt, parentClaims.act) as Record<string, unknown>;
    } catch {
      return reply.status(400).send({ message: 'Invalid parentGrantToken claims', code: 'BAD_REQUEST', requestId: request.id });
    }

    const grantId = newGrantId();
    const jti = newTokenId();
    const refreshId = newRefreshTokenId();
    const delegationDepth = parentDepth + 1;

    const refreshExpiresAt = new Date(Math.min(now + 30 * 86400 * 1000, expiresAt.getTime()));

    // Sign before committing any database state, then persist all related rows
    // in one transaction so a failed insert cannot leave a partial grant.
    const jwt = await signGrantToken({
      sub: parentClaims['sub'] as string,
      agt: subAgent['did'] as string,
      dev: developerId,
      clientId: subAgentId,
      scp: scopes,
      jti,
      grnt: grantId,
      ...(typeof parentClaims.aud === 'string' ? { aud: parentClaims.aud } : {}),
      ...(typeof subAgent['key_thumbprint'] === 'string'
        ? { cnf: { jkt: subAgent['key_thumbprint'] as string } }
        : {}),
      act: actorChain,
      ...(childDetails.length > 0 ? { authorizationDetails: childDetails } : {}),
      ...(inheritedEvidence ? { webauthnEvidence: grantWebAuthnEvidence(inheritedEvidence) } : {}),
      exp: expTimestamp,
      ...(parentAgt !== undefined ? { parentAgt } : {}),
      parentGrnt,
      delegationDepth,
    });
    let parentStillActive = false;
    let verifiableCredential: string | undefined;
    let verifiableCredentialId: string | undefined;
    // A refusal from the lockout check rolls the transaction back and is
    // answered below; anything else propagates as it always did.
    let refused = null as ReturnType<typeof issuanceRefusal>;
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
      // Serialize against cascade revocation. If revocation wins the lock,
      // this query re-checks the updated row and no child is created. If
      // delegation wins, the revoker waits and its recursive CTE sees this
      // newly inserted child.
      const lockedParent = await tx`
        SELECT id
        FROM grants
        WHERE id = ${parentGrnt}
          AND developer_id = ${developerId}
          AND protocol = 'grantex-v1'
          AND status = 'active'
          AND expires_at > NOW()
        FOR UPDATE
      `;
      if (!lockedParent[0]) return;
      parentStillActive = true;

      // An emergency stop's lockout. The child is a new grant for the
      // sub-agent, made under the parent's authority, so a freeze on either
      // agent, the principal, or the parent grant or anything above it refuses
      // it. After the parent's lock, like the insert it guards.
      await assertIssuanceOpen(tx, {
        developerId,
        agentIds: [subAgentId],
        principalIds: [parentClaims.sub],
        grantIds: [parentGrnt],
      }, { path: 'delegate', inTransaction: true, log: request.log });

      await tx`
        INSERT INTO grants (
          id, agent_id, principal_id, developer_id, scopes, expires_at,
          audience, parent_grant_id, delegation_depth, agent_key_thumbprint,
          actor_chain, purpose, authorization_details,
          fido_verified, fido_credential_id, fido_evidence
        )
        VALUES (
          ${grantId},
          ${subAgentId},
          ${parentClaims.sub},
          ${developerId},
          ${scopes},
          ${expiresAt},
          ${typeof parentClaims.aud === 'string' ? parentClaims.aud : null},
          ${parentGrnt},
          ${delegationDepth},
          ${subAgent['key_thumbprint'] as string | null},
          ${tx.json(actorChain as never)},
          ${childPurpose ?? null},
          ${childDetails.length > 0 ? tx.json(childDetails as never) : null},
          ${inheritedEvidence !== undefined},
          ${inheritedEvidence?.credentialId ?? null},
          ${inheritedEvidence ? tx.json(inheritedEvidence as never) : null}
        )
      `;
      await tx`
        INSERT INTO grant_tokens (jti, grant_id, expires_at)
        VALUES (${jti}, ${grantId}, ${expiresAt})
      `;
      await tx`
        INSERT INTO refresh_tokens (id, grant_id, expires_at)
        VALUES (${refreshId}, ${grantId}, ${refreshExpiresAt})
      `;
      if ((body.credentialFormat === 'vc-jwt' || body.credentialFormat === 'both')
          && (config.portableWebAuthnEvidenceEnabled || inheritedEvidence)) {
        const vcResult = await issueAgentGrantVC({
          grantId,
          agentDid: subAgent['did'] as string,
          principalId: parentClaims.sub,
          developerId,
          scopes,
          expiresAt,
          delegationDepth,
          ...(inheritedEvidence ? { fidoEvidence: inheritedEvidence } : {}),
        }, tx);
        verifiableCredential = vcResult.vcJwt;
        verifiableCredentialId = vcResult.vcId;
      }
    }).catch((err: unknown) => {
      refused = issuanceRefusal(err);
      if (refused === null) throw err;
    });
    if (refused !== null) {
      return reply.status(refused.statusCode).send({ ...refused.body, requestId: request.id });
    }
    if (!parentStillActive) {
      return reply.status(400).send({
        message: 'Parent grant is no longer active',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    if ((body.credentialFormat === 'vc-jwt' || body.credentialFormat === 'both')
        && !config.portableWebAuthnEvidenceEnabled && !inheritedEvidence) {
      if (issuanceFreezeEnforced()) {
        // The delegation's transaction has committed and released the
        // lockout's lock, so a lockout could land before this credential is
        // written: it would revoke the child, sweep its credentials, and
        // never see this one. The credential is written in a transaction of
        // its own that re-reads the child grant and the freeze under the same
        // lock; the child's lineage brings in the parent and everything above.
        try {
          const vcResult = await issueForCommittedGrant(sql, {
            subject: {
              developerId,
              grantId,
              agentIds: [subAgentId],
              principalIds: [parentClaims.sub],
            },
            path: 'delegate',
            log: request.log,
          }, (tx) => issueAgentGrantVC({
            grantId,
            agentDid: subAgent['did'] as string,
            principalId: parentClaims.sub,
            developerId,
            scopes,
            expiresAt,
            delegationDepth,
          }, tx));
          if (vcResult !== null) {
            verifiableCredential = vcResult.vcJwt;
            verifiableCredentialId = vcResult.vcId;
          }
        } catch (err) {
          // A lockout now covers the child, and its stop revokes it: refused
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
            agentDid: subAgent['did'] as string,
            principalId: parentClaims.sub,
            developerId,
            scopes,
            expiresAt,
            delegationDepth,
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

    // Emit events (best-effort, non-blocking)
    emitEvent(developerId, 'grant.created', {
      grantId,
      agentId: subAgentId,
      principalId: parentClaims.sub,
      scopes,
      expiresAt: expiresAt.toISOString(),
      delegationDepth,
      parentGrantId: parentGrnt,
    }).catch(() => {});
    emitEvent(developerId, 'token.issued', {
      tokenId: jti,
      grantId,
      agentId: subAgentId,
      principalId: parentClaims.sub,
      scopes,
      expiresAt: expiresAt.toISOString(),
    }).catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: expiresAt.toISOString(),
      scopes,
      grantId,
      refreshToken: refreshId,
      ...(verifiableCredential !== undefined ? { verifiableCredential } : {}),
    });
  });
}
