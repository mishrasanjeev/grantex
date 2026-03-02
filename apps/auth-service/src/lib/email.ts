/**
 * Email sending via Resend API.
 */

import { config } from '../config.js';

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  if (!config.emailApiKey) {
    throw new Error('Email not configured: RESEND_API_KEY is required');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.emailApiKey}`,
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: params.to,
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Email send failed (${response.status}): ${body}`);
  }
}

export function verificationEmailHtml(token: string, baseUrl: string): string {
  const verifyUrl = `${baseUrl}/v1/signup/verify/${token}`;
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Verify your email</h2>
      <p>Click the button below to verify your Grantex developer account.</p>
      <a href="${verifyUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
        Verify Email
      </a>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
        Or copy this link: ${verifyUrl}
      </p>
      <p style="color: #9ca3af; font-size: 12px;">This link expires in 24 hours.</p>
    </div>
  `;
}
