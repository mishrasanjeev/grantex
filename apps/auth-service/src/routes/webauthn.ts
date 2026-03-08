import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newWebAuthnCredentialId, newWebAuthnChallengeId } from '../lib/ids.js';
import { generateRegOptions, verifyRegResponse, generateAuthOptions, verifyAuthResponse } from '../lib/webauthn.js';
import { emitEvent } from '../lib/events.js';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/types';

export async function webauthnRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/webauthn/register/options — generate registration options (protected)
  app.post<{ Body: { principalId: string } }>(
    '/v1/webauthn/register/options',
    async (request, reply) => {
      const { principalId } = request.body;
      if (!principalId) {
        return reply.status(400).send({ message: 'principalId is required', code: 'BAD_REQUEST', requestId: request.id });
      }

      const sql = getSql();
      const developerId = request.developer.id;
      const rpName = request.developer.name || 'Grantex';

      // Fetch existing credentials for exclusion
      const existingRows = await sql`
        SELECT credential_id, public_key, counter, transports
        FROM webauthn_credentials
        WHERE principal_id = ${principalId} AND developer_id = ${developerId}
      `;

      const existing = existingRows.map((r) => ({
        credentialId: r['credential_id'] as string,
        publicKey: r['public_key'] as string,
        counter: Number(r['counter']),
        transports: (r['transports'] as string[]) ?? [],
      }));

      const options = await generateRegOptions(principalId, rpName, existing);

      // Store challenge
      const challengeId = newWebAuthnChallengeId();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
      await sql`
        INSERT INTO webauthn_challenges (id, challenge, principal_id, developer_id, ceremony_type, expires_at)
        VALUES (${challengeId}, ${options.challenge}, ${principalId}, ${developerId}, 'registration', ${expiresAt})
      `;

      return reply.send({ challengeId, publicKey: options });
    },
  );

  // POST /v1/webauthn/register/verify — verify registration response (protected)
  app.post<{ Body: { challengeId: string; response: RegistrationResponseJSON; deviceName?: string } }>(
    '/v1/webauthn/register/verify',
    async (request, reply) => {
      const { challengeId, response, deviceName } = request.body;
      if (!challengeId || !response) {
        return reply.status(400).send({ message: 'challengeId and response are required', code: 'BAD_REQUEST', requestId: request.id });
      }

      const sql = getSql();
      const developerId = request.developer.id;

      // Look up and consume challenge
      const challengeRows = await sql`
        SELECT challenge, principal_id FROM webauthn_challenges
        WHERE id = ${challengeId} AND developer_id = ${developerId}
          AND ceremony_type = 'registration' AND consumed = FALSE AND expires_at > NOW()
      `;
      const challengeRow = challengeRows[0];
      if (!challengeRow) {
        return reply.status(400).send({ message: 'Invalid or expired challenge', code: 'BAD_REQUEST', requestId: request.id });
      }

      await sql`UPDATE webauthn_challenges SET consumed = TRUE WHERE id = ${challengeId}`;

      const verification = await verifyRegResponse(response, challengeRow['challenge'] as string);
      if (!verification.verified || !verification.registrationInfo) {
        return reply.status(400).send({ message: 'Registration verification failed', code: 'BAD_REQUEST', requestId: request.id });
      }

      const { credential, credentialBackedUp } = verification.registrationInfo;
      const credId = newWebAuthnCredentialId();

      await sql`
        INSERT INTO webauthn_credentials (id, principal_id, developer_id, credential_id, public_key, counter, transports, aaguid, backed_up, device_name)
        VALUES (
          ${credId},
          ${challengeRow['principal_id'] as string},
          ${developerId},
          ${credential.id},
          ${isoBase64URL.fromBuffer(credential.publicKey)},
          ${credential.counter},
          ${(credential.transports ?? []) as string[]},
          ${verification.registrationInfo.aaguid ?? null},
          ${credentialBackedUp},
          ${deviceName ?? null}
        )
      `;

      emitEvent(developerId, 'fido.registered', {
        principalId: challengeRow['principal_id'] as string,
        credentialId: credId,
      }).catch(() => {});

      return reply.status(201).send({
        id: credId,
        principalId: challengeRow['principal_id'] as string,
        deviceName: deviceName ?? null,
        backedUp: credentialBackedUp,
        transports: credential.transports ?? [],
        createdAt: new Date().toISOString(),
      });
    },
  );

  // GET /v1/webauthn/credentials — list credentials for a principal (protected)
  app.get<{ Querystring: { principalId: string } }>(
    '/v1/webauthn/credentials',
    async (request, reply) => {
      const principalId = request.query.principalId;
      if (!principalId) {
        return reply.status(400).send({ message: 'principalId query param is required', code: 'BAD_REQUEST', requestId: request.id });
      }

      const sql = getSql();
      const rows = await sql`
        SELECT id, principal_id, device_name, backed_up, transports, created_at, last_used_at
        FROM webauthn_credentials
        WHERE principal_id = ${principalId} AND developer_id = ${request.developer.id}
        ORDER BY created_at DESC
      `;

      return reply.send({
        credentials: rows.map((r) => ({
          id: r['id'],
          principalId: r['principal_id'],
          deviceName: r['device_name'] ?? null,
          backedUp: r['backed_up'],
          transports: r['transports'] ?? [],
          createdAt: r['created_at'],
          lastUsedAt: r['last_used_at'] ?? null,
        })),
      });
    },
  );

  // DELETE /v1/webauthn/credentials/:id — remove a credential (protected)
  app.delete<{ Params: { id: string } }>(
    '/v1/webauthn/credentials/:id',
    async (request, reply) => {
      const sql = getSql();
      const rows = await sql`
        DELETE FROM webauthn_credentials
        WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
        RETURNING id
      `;
      if (!rows[0]) {
        return reply.status(404).send({ message: 'Credential not found', code: 'NOT_FOUND', requestId: request.id });
      }
      return reply.status(204).send();
    },
  );

  // POST /v1/webauthn/assert/options — generate assertion options (PUBLIC, used from consent page)
  app.post<{ Body: { authRequestId: string } }>(
    '/v1/webauthn/assert/options',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { authRequestId } = request.body;
      if (!authRequestId) {
        return reply.status(400).send({ message: 'authRequestId is required', code: 'BAD_REQUEST', requestId: request.id });
      }

      const sql = getSql();

      // Look up auth request to get principal and developer
      const arRows = await sql`
        SELECT ar.principal_id, ar.developer_id, d.fido_required
        FROM auth_requests ar
        JOIN developers d ON d.id = ar.developer_id
        WHERE ar.id = ${authRequestId} AND ar.status = 'pending' AND ar.expires_at > NOW()
      `;
      const ar = arRows[0];
      if (!ar) {
        return reply.status(404).send({ message: 'Auth request not found or expired', code: 'NOT_FOUND', requestId: request.id });
      }

      if (!ar['fido_required']) {
        return reply.status(400).send({ message: 'FIDO not required for this developer', code: 'BAD_REQUEST', requestId: request.id });
      }

      const principalId = ar['principal_id'] as string;
      const developerId = ar['developer_id'] as string;

      // Fetch credentials
      const credRows = await sql`
        SELECT credential_id, public_key, counter, transports
        FROM webauthn_credentials
        WHERE principal_id = ${principalId} AND developer_id = ${developerId}
      `;

      if (credRows.length === 0) {
        return reply.status(400).send({ message: 'No FIDO credentials registered for this principal', code: 'BAD_REQUEST', requestId: request.id });
      }

      const credentials = credRows.map((r) => ({
        credentialId: r['credential_id'] as string,
        publicKey: r['public_key'] as string,
        counter: Number(r['counter']),
        transports: (r['transports'] as string[]) ?? [],
      }));

      const options = await generateAuthOptions(credentials);

      // Store challenge
      const challengeId = newWebAuthnChallengeId();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await sql`
        INSERT INTO webauthn_challenges (id, challenge, principal_id, developer_id, ceremony_type, auth_request_id, expires_at)
        VALUES (${challengeId}, ${options.challenge}, ${principalId}, ${developerId}, 'assertion', ${authRequestId}, ${expiresAt})
      `;

      return reply.send({ challengeId, publicKey: options });
    },
  );

  // POST /v1/webauthn/assert/verify — verify assertion (PUBLIC, used from consent page)
  app.post<{ Body: { challengeId: string; response: AuthenticationResponseJSON } }>(
    '/v1/webauthn/assert/verify',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { challengeId, response } = request.body;
      if (!challengeId || !response) {
        return reply.status(400).send({ message: 'challengeId and response are required', code: 'BAD_REQUEST', requestId: request.id });
      }

      const sql = getSql();

      // Look up challenge
      const challengeRows = await sql`
        SELECT challenge, principal_id, developer_id, auth_request_id FROM webauthn_challenges
        WHERE id = ${challengeId} AND ceremony_type = 'assertion' AND consumed = FALSE AND expires_at > NOW()
      `;
      const challengeRow = challengeRows[0];
      if (!challengeRow) {
        return reply.status(400).send({ message: 'Invalid or expired challenge', code: 'BAD_REQUEST', requestId: request.id });
      }

      await sql`UPDATE webauthn_challenges SET consumed = TRUE WHERE id = ${challengeId}`;

      // Find the credential being used
      const credentialId = response.id;
      const credRows = await sql`
        SELECT id, credential_id, public_key, counter, transports
        FROM webauthn_credentials
        WHERE credential_id = ${credentialId}
          AND principal_id = ${challengeRow['principal_id'] as string}
          AND developer_id = ${challengeRow['developer_id'] as string}
      `;
      const credRow = credRows[0];
      if (!credRow) {
        return reply.status(400).send({ message: 'Credential not found', code: 'BAD_REQUEST', requestId: request.id });
      }

      const storedCred = {
        credentialId: credRow['credential_id'] as string,
        publicKey: credRow['public_key'] as string,
        counter: Number(credRow['counter']),
        transports: (credRow['transports'] as string[]) ?? [],
      };

      const verification = await verifyAuthResponse(response, challengeRow['challenge'] as string, storedCred);
      if (!verification.verified) {
        return reply.status(400).send({ message: 'Assertion verification failed', code: 'BAD_REQUEST', requestId: request.id });
      }

      // Update counter and last_used_at
      await sql`
        UPDATE webauthn_credentials
        SET counter = ${verification.authenticationInfo.newCounter}, last_used_at = NOW()
        WHERE id = ${credRow['id'] as string}
      `;

      // Mark auth request as FIDO verified
      const authRequestId = challengeRow['auth_request_id'] as string;
      if (authRequestId) {
        await sql`
          UPDATE auth_requests SET fido_verified = TRUE WHERE id = ${authRequestId}
        `;
      }

      emitEvent(challengeRow['developer_id'] as string, 'fido.assertion', {
        principalId: challengeRow['principal_id'] as string,
        authRequestId,
      }).catch(() => {});

      return reply.send({ verified: true });
    },
  );
}
