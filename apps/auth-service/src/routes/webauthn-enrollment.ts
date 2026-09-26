import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { emitEvent } from '../lib/events.js';
import { newWebAuthnChallengeId, newWebAuthnCredentialId, newWebAuthnEnrollmentTicketId } from '../lib/ids.js';
import { generateRegOptions, verifyRegResponse } from '../lib/webauthn.js';
import { PASSKEY_ENROLLMENT_CSP, PASSKEY_ENROLLMENT_HTML } from './passkey-enrollment-page.js';

const TICKET_LIFETIME_MS = 10 * 60 * 1000;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const TICKET_PATTERN = /^(wet_[0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{43})$/;

function ticketParts(value: unknown): { id: string; hash: string } | null {
  if (typeof value !== 'string') return null;
  const match = TICKET_PATTERN.exec(value);
  if (!match) return null;
  return { id: match[1]!, hash: createHash('sha256').update(match[2]!).digest('hex') };
}

function unavailable(reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  return reply.status(404).send({ code: 'NOT_FOUND', message: 'Passkey enrollment is not enabled' });
}

export async function webauthnEnrollmentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { principalId?: string; authRequestId?: string } }>(
    '/v1/webauthn/enrollment-sessions',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.passkeyEnrollmentEnabled) return unavailable(reply);
      const { principalId, authRequestId } = request.body ?? {};
      if (typeof principalId !== 'string' || principalId.trim() !== principalId
          || principalId.length < 1 || principalId.length > 256) {
        return reply.status(400).send({ code: 'BAD_REQUEST', message: 'principalId must contain 1 to 256 characters' });
      }
      if (authRequestId !== undefined
          && (typeof authRequestId !== 'string' || !/^areq_[0-9A-HJKMNP-TV-Z]{26}$/.test(authRequestId))) {
        return reply.status(400).send({ code: 'BAD_REQUEST', message: 'Invalid authRequestId' });
      }

      const sql = getSql();
      const developerId = request.developer.id;
      if (authRequestId) {
        const matchingRequest = await sql`
          SELECT id FROM auth_requests
          WHERE id = ${authRequestId} AND developer_id = ${developerId}
            AND status = 'pending' AND expires_at > NOW()
            AND (principal_id = ${principalId} OR principal_id = '')
        `;
        if (!matchingRequest[0]) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Pending authorization request not found' });
        }
      }

      const id = newWebAuthnEnrollmentTicketId();
      const secret = randomBytes(32).toString('base64url');
      const hash = createHash('sha256').update(secret).digest('hex');
      const expiresAt = new Date(Date.now() + TICKET_LIFETIME_MS);
      await sql`
        INSERT INTO webauthn_challenges
          (id, challenge, principal_id, developer_id, ceremony_type, auth_request_id, expires_at)
        VALUES (${id}, ${hash}, ${principalId}, ${developerId}, 'enrollment_ticket',
          ${authRequestId ?? null}, ${expiresAt})
      `;
      const enrollmentUrl = new URL('/passkey-enroll', config.fidoOrigin);
      enrollmentUrl.hash = new URLSearchParams({ ticket: `${id}.${secret}` }).toString();
      return reply.header('Cache-Control', 'no-store').status(201).send({
        enrollmentUrl: enrollmentUrl.toString(),
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  app.get('/passkey-enroll', { config: { skipAuth: true } }, async (_request, reply) => {
    if (!config.passkeyEnrollmentEnabled) return unavailable(reply);
    return reply
      .header('Content-Security-Policy', PASSKEY_ENROLLMENT_CSP)
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .type('text/html')
      .send(PASSKEY_ENROLLMENT_HTML);
  });

  async function lookupTicket(value: unknown) {
    const parts = ticketParts(value);
    if (!parts) return null;
    const sql = getSql();
    const rows = await sql`
      SELECT id, principal_id, developer_id, auth_request_id, expires_at
      FROM webauthn_challenges
      WHERE id = ${parts.id} AND challenge = ${parts.hash}
        AND ceremony_type = 'enrollment_ticket'
        AND consumed = FALSE AND expires_at > NOW()
    `;
    return rows[0] ?? null;
  }

  app.post<{ Body: { ticket?: string } }>(
    '/v1/webauthn/enroll/options',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.passkeyEnrollmentEnabled) return unavailable(reply);
      const ticket = await lookupTicket(request.body?.ticket);
      if (!ticket) return reply.status(400).send({ code: 'INVALID_TICKET', message: 'Enrollment link is invalid or expired' });
      const sql = getSql();
      const principalId = ticket['principal_id'] as string;
      const developerId = ticket['developer_id'] as string;
      const credentials = await sql`
        SELECT credential_id, public_key, counter, transports FROM webauthn_credentials
        WHERE principal_id = ${principalId} AND developer_id = ${developerId}
      `;
      const developer = await sql`SELECT name FROM developers WHERE id = ${developerId}`;
      const options = await generateRegOptions(principalId, (developer[0]?.['name'] as string) ?? 'Grantex',
        credentials.map((row) => ({
          credentialId: row['credential_id'] as string,
          publicKey: row['public_key'] as string,
          counter: Number(row['counter']),
          transports: (row['transports'] as string[]) ?? [],
        })), true);
      const challengeId = newWebAuthnChallengeId();
      const expiresAt = new Date(Math.min(Date.now() + CHALLENGE_LIFETIME_MS,
        new Date(ticket['expires_at'] as string).getTime()));
      await sql`
        INSERT INTO webauthn_challenges
          (id, challenge, principal_id, developer_id, ceremony_type, enrollment_ticket_id, expires_at)
        VALUES (${challengeId}, ${options.challenge}, ${principalId}, ${developerId},
          'registration_enrollment', ${ticket['id'] as string}, ${expiresAt})
      `;
      return reply.header('Cache-Control', 'no-store').send({ challengeId, publicKey: options });
    },
  );

  app.post<{ Body: { ticket?: string; challengeId?: string; response?: RegistrationResponseJSON } }>(
    '/v1/webauthn/enroll/verify',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.passkeyEnrollmentEnabled) return unavailable(reply);
      const ticket = await lookupTicket(request.body?.ticket);
      const { challengeId, response } = request.body ?? {};
      if (!ticket || typeof challengeId !== 'string' || !response) {
        return reply.status(400).send({ code: 'INVALID_TICKET', message: 'Enrollment link or challenge is invalid or expired' });
      }
      const sql = getSql();
      const principalId = ticket['principal_id'] as string;
      const developerId = ticket['developer_id'] as string;
      const challenge = await sql`
        UPDATE webauthn_challenges SET consumed = TRUE
        WHERE id = ${challengeId} AND enrollment_ticket_id = ${ticket['id'] as string}
          AND principal_id = ${principalId} AND developer_id = ${developerId}
          AND ceremony_type = 'registration_enrollment'
          AND consumed = FALSE AND expires_at > NOW()
        RETURNING challenge
      `;
      if (!challenge[0]) return reply.status(400).send({ code: 'INVALID_CHALLENGE', message: 'Challenge is invalid or expired' });
      let result;
      try {
        result = await verifyRegResponse(response, challenge[0]['challenge'] as string, true);
      } catch {
        return reply.status(400).send({ code: 'INVALID_CREDENTIAL', message: 'Passkey verification failed' });
      }
      if (!result.verified || !result.registrationInfo) {
        return reply.status(400).send({ code: 'INVALID_CREDENTIAL', message: 'Passkey verification failed' });
      }
      const credentialId = newWebAuthnCredentialId();
      const { credential, credentialBackedUp, aaguid } = result.registrationInfo;
      const inserted = await sql`
        WITH claimed AS (
          UPDATE webauthn_challenges SET consumed = TRUE
          WHERE id = ${ticket['id'] as string}
            AND ceremony_type = 'enrollment_ticket'
            AND consumed = FALSE AND expires_at > NOW()
          RETURNING principal_id, developer_id
        )
        INSERT INTO webauthn_credentials
          (id, principal_id, developer_id, credential_id, public_key, counter, transports, aaguid, backed_up)
        SELECT ${credentialId}, claimed.principal_id, claimed.developer_id,
          ${credential.id}, ${isoBase64URL.fromBuffer(credential.publicKey)},
          ${credential.counter}, ${(credential.transports ?? []) as string[]},
          ${aaguid ?? null}, ${credentialBackedUp}
        FROM claimed
        RETURNING id
      `;
      if (!inserted[0]) return reply.status(409).send({ code: 'TICKET_USED', message: 'Enrollment link was already used' });
      emitEvent(developerId, 'fido.registered', { principalId, credentialId }).catch(() => {});
      return reply.header('Cache-Control', 'no-store').status(201).send({
        id: credentialId,
        ...(ticket['auth_request_id']
          ? { returnTo: `/consent?req=${encodeURIComponent(ticket['auth_request_id'] as string)}` }
          : {}),
      });
    },
  );
}
