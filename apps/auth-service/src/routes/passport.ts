import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { getSql } from '../db/client.js';
import { newVerifiableCredentialId } from '../lib/ids.js';
import { getKeyPair, getEdKeyPair, parseExpiresIn } from '../lib/crypto.js';
import { getOrCreateStatusList } from '../lib/vc.js';
import { emitEvent } from '../lib/events.js';
import { config } from '../config.js';
import { ulid } from 'ulid';

const MPP_PASSPORT_MAX_EXPIRY_HOURS = parseInt(
  process.env['MPP_PASSPORT_MAX_EXPIRY_HOURS'] ?? '720',
  10,
);

const VALID_MPP_CATEGORIES = [
  'inference', 'compute', 'data', 'storage',
  'search', 'media', 'delivery', 'browser', 'general',
];

const MPP_CATEGORY_TO_SCOPE: Record<string, string> = {
  'inference': 'payments:mpp:inference',
  'compute': 'payments:mpp:compute',
  'data': 'payments:mpp:data',
  'storage': 'payments:mpp:storage',
  'search': 'payments:mpp:search',
  'media': 'payments:mpp:media',
  'delivery': 'payments:mpp:delivery',
  'browser': 'payments:mpp:browser',
  'general': 'payments:mpp:general',
};

interface IssuePassportBody {
  agentId: string;
  grantId: string;
  allowedMPPCategories: string[];
  maxTransactionAmount: { amount: number; currency: string };
  paymentRails?: string[];
  expiresIn?: string;
  parentPassportId?: string;
}

export async function passportRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/passport/issue — Issue AgentPassportCredential
  app.post<{ Body: IssuePassportBody }>(
    '/v1/passport/issue',
    async (request, reply) => {
      const {
        agentId,
        grantId,
        allowedMPPCategories,
        maxTransactionAmount,
      } = request.body;
      const paymentRails = request.body.paymentRails ?? ['tempo'];
      const expiresIn = request.body.expiresIn ?? '24h';
      const parentPassportId = request.body.parentPassportId;
      const developerId = request.developer.id;

      if (!agentId || !grantId || !allowedMPPCategories || !maxTransactionAmount) {
        return reply.status(400).send({
          message: 'agentId, grantId, allowedMPPCategories, and maxTransactionAmount are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      // Validate categories
      const invalidCategories = allowedMPPCategories.filter(
        (c) => !VALID_MPP_CATEGORIES.includes(c),
      );
      if (invalidCategories.length > 0) {
        return reply.status(400).send({
          message: `Invalid MPP categories: ${invalidCategories.join(', ')}`,
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      // Validate expiry
      let expirySeconds: number;
      try {
        expirySeconds = parseExpiresIn(expiresIn);
      } catch {
        return reply.status(422).send({
          message: `Invalid expiresIn format: ${expiresIn}`,
          code: 'INVALID_EXPIRY',
          requestId: request.id,
        });
      }
      const expiryHours = expirySeconds / 3600;
      if (expiryHours > MPP_PASSPORT_MAX_EXPIRY_HOURS) {
        return reply.status(422).send({
          message: `expiresIn exceeds maximum of ${MPP_PASSPORT_MAX_EXPIRY_HOURS} hours`,
          code: 'INVALID_EXPIRY',
          requestId: request.id,
        });
      }

      const sql = getSql();

      // Validate agent belongs to developer
      const agentRows = await sql`
        SELECT id, did FROM agents
        WHERE id = ${agentId} AND developer_id = ${developerId}
      `;
      const agent = agentRows[0];
      if (!agent) {
        return reply.status(400).send({
          message: 'Agent not found or not owned by developer',
          code: 'INVALID_AGENT',
          requestId: request.id,
        });
      }

      // Validate grant is active
      const grantRows = await sql`
        SELECT id, scopes, principal_id, status, expires_at, delegation_depth
        FROM grants
        WHERE id = ${grantId}
          AND agent_id = ${agentId}
          AND developer_id = ${developerId}
      `;
      const grant = grantRows[0];
      if (!grant) {
        return reply.status(400).send({
          message: 'Grant not found or not owned by agent',
          code: 'INVALID_GRANT',
          requestId: request.id,
        });
      }
      if (grant['status'] === 'revoked') {
        return reply.status(400).send({
          message: 'Grant has been revoked',
          code: 'INVALID_GRANT',
          requestId: request.id,
        });
      }

      // Validate categories map to grant scopes
      const grantScopes = grant['scopes'] as string[];
      const requiredScopes = allowedMPPCategories.map(
        (c) => MPP_CATEGORY_TO_SCOPE[c]!,
      );
      const missingScopes = requiredScopes.filter((s) => !grantScopes.includes(s));
      if (missingScopes.length > 0) {
        return reply.status(400).send({
          message: `Grant does not include required MPP scopes: ${missingScopes.join(', ')}`,
          code: 'SCOPE_INSUFFICIENT',
          requestId: request.id,
        });
      }

      // Validate budget if applicable
      const budgetRows = await sql<{ remaining_budget: string }[]>`
        SELECT remaining_budget FROM budget_allocations
        WHERE grant_id = ${grantId} AND remaining_budget > 0
        LIMIT 1
      `;
      if (budgetRows[0]) {
        const remaining = parseFloat(budgetRows[0].remaining_budget);
        if (maxTransactionAmount.amount > remaining) {
          return reply.status(400).send({
            message: `maxTransactionAmount (${maxTransactionAmount.amount}) exceeds remaining budget (${remaining})`,
            code: 'AMOUNT_EXCEEDS_BUDGET',
            requestId: request.id,
          });
        }
      }

      // Build the credential
      const passportUlid = ulid();
      const passportId = `urn:grantex:passport:${passportUlid}`;
      const agentDid = agent['did'] as string;
      const principalId = grant['principal_id'] as string;
      const delegationDepth = Number(grant['delegation_depth'] ?? 0);
      const domain = config.didWebDomain;
      const issuerDid = `did:web:${domain}`;

      const now = new Date();
      const expiresAt = new Date(now.getTime() + expirySeconds * 1000);

      // Allocate StatusList2021 index
      const statusList = await getOrCreateStatusList(developerId);
      const statusListIdx = statusList.nextIndex;
      await sql`
        UPDATE vc_status_lists SET next_index = next_index + 1, updated_at = NOW()
        WHERE id = ${statusList.id}
      `;

      const credentialStatus = {
        id: `${config.jwtIssuer}/v1/credentials/status/${statusList.id}#${statusListIdx}`,
        type: 'StatusList2021Entry',
        statusPurpose: 'revocation',
        statusListIndex: String(statusListIdx),
        statusListCredential: `${config.jwtIssuer}/v1/credentials/status/${statusList.id}`,
      };

      const credentialSubject: Record<string, unknown> = {
        id: agentDid,
        type: 'AIAgent',
        humanPrincipal: `did:grantex:${principalId}`,
        organizationDID: `did:web:${domain}`,
        grantId,
        allowedMPPCategories,
        maxTransactionAmount,
        paymentRails,
        delegationDepth,
        ...(parentPassportId !== undefined ? { parentPassportId } : {}),
      };

      const vcPayload = {
        vc: {
          '@context': [
            'https://www.w3.org/ns/credentials/v2',
            'https://grantex.dev/contexts/mpp/v1',
          ],
          type: ['VerifiableCredential', 'AgentPassportCredential'],
          credentialSubject,
          credentialStatus,
        },
      };

      // Sign with RS256 (primary key), use Ed25519 if available for proof
      const { privateKey, kid } = getKeyPair();
      const vcJwt = await new SignJWT(vcPayload)
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
        .setIssuer(issuerDid)
        .setSubject(agentDid)
        .setJti(passportId)
        .setIssuedAt(Math.floor(now.getTime() / 1000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(privateKey);

      // Build the full credential JSON
      const edKeyPair = getEdKeyPair();
      const proofVerificationMethod = edKeyPair
        ? `${issuerDid}#${edKeyPair.kid}`
        : `${issuerDid}#${kid}`;

      const credential = {
        '@context': [
          'https://www.w3.org/ns/credentials/v2',
          'https://grantex.dev/contexts/mpp/v1',
        ],
        type: ['VerifiableCredential', 'AgentPassportCredential'],
        id: passportId,
        issuer: issuerDid,
        validFrom: now.toISOString(),
        validUntil: expiresAt.toISOString(),
        credentialSubject,
        credentialStatus,
        proof: {
          type: 'Ed25519Signature2020',
          created: now.toISOString(),
          verificationMethod: proofVerificationMethod,
          proofPurpose: 'assertionMethod',
          proofValue: vcJwt,
        },
      };

      const encodedCredential = Buffer.from(
        JSON.stringify(credential),
      ).toString('base64url');

      // Store in database
      await sql`
        INSERT INTO mpp_passports (
          id, developer_id, agent_id, grant_id, principal_id, agent_did,
          organization_did, allowed_categories, max_amount, max_currency,
          payment_rails, delegation_depth, parent_passport_id,
          credential_jwt, encoded_credential, status, status_list_idx, expires_at
        )
        VALUES (
          ${passportId}, ${developerId}, ${agentId}, ${grantId}, ${principalId},
          ${agentDid}, ${`did:web:${domain}`}, ${allowedMPPCategories},
          ${maxTransactionAmount.amount}, ${maxTransactionAmount.currency || 'USDC'},
          ${paymentRails}, ${delegationDepth}, ${parentPassportId ?? null},
          ${vcJwt}, ${encodedCredential}, 'active', ${statusListIdx}, ${expiresAt}
        )
      `;

      // Also store in verifiable_credentials table for unified VC management
      await sql`
        INSERT INTO verifiable_credentials (
          id, grant_id, developer_id, principal_id, agent_did,
          credential_type, format, credential_jwt, status,
          status_list_idx, expires_at
        )
        VALUES (
          ${passportId}, ${grantId}, ${developerId}, ${principalId}, ${agentDid},
          'AgentPassportCredential', 'agent-passport', ${vcJwt}, 'active',
          ${statusListIdx}, ${expiresAt}
        )
      `;

      // Audit
      emitEvent(developerId, 'passport.issued', {
        passportId,
        agentId,
        grantId,
        categories: allowedMPPCategories,
      }).catch(() => {});

      return reply.status(201).send({
        passportId,
        credential,
        encodedCredential,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  // GET /v1/passports — List passports
  app.get(
    '/v1/passports',
    async (request, reply) => {
      const developerId = request.developer.id;
      const sql = getSql();
      const query = request.query as Record<string, string | undefined>;

      const agentId = query.agentId;
      const grantId = query.grantId;
      const status = query.status;

      const rows = await sql`
        SELECT p.id, p.agent_id, p.grant_id, p.encoded_credential, p.status, p.expires_at, p.created_at
        FROM mpp_passports p
        JOIN agents a ON a.id = p.agent_id
        WHERE a.developer_id = ${developerId}
        ${agentId ? sql`AND p.agent_id = ${agentId}` : sql``}
        ${grantId ? sql`AND p.grant_id = ${grantId}` : sql``}
        ${status ? sql`AND p.status = ${status}` : sql``}
        ORDER BY p.created_at DESC
      `;

      const passports = rows.map((p) => {
        let effectiveStatus = p['status'] as string;
        if (effectiveStatus === 'active' && new Date(p['expires_at'] as string) < new Date()) {
          effectiveStatus = 'expired';
        }
        return {
          passportId: p['id'] as string,
          agentId: p['agent_id'] as string,
          grantId: p['grant_id'] as string,
          status: effectiveStatus,
          expiresAt: (p['expires_at'] as Date).toISOString(),
          createdAt: (p['created_at'] as Date).toISOString(),
        };
      });

      return reply.send(passports);
    },
  );

  // GET /v1/passport/:id — Retrieve a passport
  app.get<{ Params: { id: string } }>(
    '/v1/passport/:id',
    async (request, reply) => {
      const { id } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, credential_jwt, encoded_credential, status, expires_at, revoked_at
        FROM mpp_passports
        WHERE id = ${id} AND developer_id = ${developerId}
      `;

      const passport = rows[0];
      if (!passport) {
        return reply.status(404).send({
          message: 'Passport not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      // Determine effective status
      let status = passport['status'] as string;
      if (status === 'active' && new Date(passport['expires_at'] as string) < new Date()) {
        status = 'expired';
      }

      // Parse the stored credential JSON from encoded
      const credentialJson = JSON.parse(
        Buffer.from(passport['encoded_credential'] as string, 'base64url').toString('utf-8'),
      );

      return reply.send({
        ...credentialJson,
        status,
      });
    },
  );

  // POST /v1/passport/:id/revoke — Revoke a passport
  app.post<{ Params: { id: string } }>(
    '/v1/passport/:id/revoke',
    async (request, reply) => {
      const { id } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, status, status_list_idx FROM mpp_passports
        WHERE id = ${id} AND developer_id = ${developerId}
      `;

      const passport = rows[0];
      if (!passport) {
        return reply.status(404).send({
          message: 'Passport not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      if (passport['status'] === 'revoked') {
        return reply.send({ revoked: true, revokedAt: new Date().toISOString() });
      }

      const revokedAt = new Date();

      // Mark as revoked in mpp_passports
      await sql`
        UPDATE mpp_passports SET status = 'revoked', revoked_at = ${revokedAt}
        WHERE id = ${id}
      `;

      // Mark as revoked in verifiable_credentials
      await sql`
        UPDATE verifiable_credentials SET status = 'revoked', revoked_at = ${revokedAt}
        WHERE id = ${id}
      `;

      // Flip StatusList2021 bit
      const statusListIdx = Number(passport['status_list_idx']);
      const listRows = await sql`
        SELECT id, encoded_list FROM vc_status_lists
        WHERE developer_id = ${developerId} AND purpose = 'revocation'
        LIMIT 1
      `;
      if (listRows[0]) {
        const { gzipSync, gunzipSync } = await import('node:zlib');
        const listId = listRows[0]['id'] as string;
        const compressed = Buffer.from(listRows[0]['encoded_list'] as string, 'base64url');
        const bitstring = Buffer.from(gunzipSync(compressed));

        // Set the bit
        const byteIndex = Math.floor(statusListIdx / 8);
        const bitIndex = 7 - (statusListIdx % 8);
        bitstring[byteIndex]! |= 1 << bitIndex;

        const encoded = gzipSync(bitstring).toString('base64url');
        await sql`
          UPDATE vc_status_lists SET encoded_list = ${encoded}, updated_at = NOW()
          WHERE id = ${listId}
        `;
      }

      // Audit
      emitEvent(developerId, 'passport.revoked', { passportId: id }).catch(() => {});

      return reply.send({
        revoked: true,
        revokedAt: revokedAt.toISOString(),
      });
    },
  );
}
