import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { sendEmail, verificationEmailHtml } from '../lib/email.js';
import { config } from '../config.js';

export async function verifyEmailRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/signup/verify — send verification email
  app.post<{ Body: { email: string } }>('/v1/signup/verify', async (request, reply) => {
    const { email } = request.body;
    const developerId = request.developer.id;

    if (!email) {
      return reply.status(400).send({
        message: 'email is required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000); // 24 hours

    const id = `emv_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    await sql`
      INSERT INTO email_verifications (id, developer_id, token, email, expires_at)
      VALUES (${id}, ${developerId}, ${token}, ${email}, ${expiresAt})
    `;

    // Send email (best-effort)
    try {
      await sendEmail({
        to: email,
        subject: 'Verify your Grantex email',
        html: verificationEmailHtml(token, config.jwtIssuer),
      });
    } catch {
      // Email send failure is non-fatal
    }

    return reply.status(201).send({
      message: 'Verification email sent',
      expiresAt: expiresAt.toISOString(),
    });
  });

  // GET /v1/signup/verify/:token — verify email token
  app.get<{ Params: { token: string } }>('/v1/signup/verify/:token', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    const { token } = request.params;
    const sql = getSql();

    const rows = await sql`
      SELECT id, developer_id, email, expires_at, verified_at
      FROM email_verifications
      WHERE token = ${token}
    `;

    const row = rows[0];
    if (!row) {
      return reply.status(404).send({
        message: 'Invalid verification token',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }

    if (row['verified_at']) {
      return reply.status(200).send({ message: 'Email already verified' });
    }

    if (new Date(row['expires_at'] as string) < new Date()) {
      return reply.status(400).send({
        message: 'Verification token expired',
        code: 'TOKEN_EXPIRED',
        requestId: request.id,
      });
    }

    // Mark verified
    await sql`
      UPDATE email_verifications SET verified_at = NOW() WHERE id = ${row['id'] as string}
    `;
    await sql`
      UPDATE developers SET email_verified = TRUE WHERE id = ${row['developer_id'] as string}
    `;

    return reply.send({ message: 'Email verified successfully' });
  });
}
