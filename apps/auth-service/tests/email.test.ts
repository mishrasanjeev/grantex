import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real implementation
vi.unmock('../src/lib/email.js');

// Hoist mock config and fetch
const { mockConfig, mockFetch } = vi.hoisted(() => {
  const mockConfig = {
    emailApiKey: null as string | null,
    emailFrom: 'Grantex <noreply@grantex.dev>',
  };
  const mockFetch = vi.fn();
  return { mockConfig, mockFetch };
});

vi.mock('../src/config.js', () => ({ config: mockConfig }));
vi.stubGlobal('fetch', mockFetch);

import { sendEmail, verificationEmailHtml } from '../src/lib/email.js';

beforeEach(() => {
  mockConfig.emailApiKey = null;
  mockConfig.emailFrom = 'Grantex <noreply@grantex.dev>';
  mockFetch.mockReset();
});

describe('sendEmail', () => {
  it('throws when RESEND_API_KEY not configured', async () => {
    mockConfig.emailApiKey = null;

    await expect(
      sendEmail({ to: 'user@example.com', subject: 'Test', html: '<p>Hi</p>' }),
    ).rejects.toThrow('Email not configured: RESEND_API_KEY is required');
  });

  it('calls fetch with correct params', async () => {
    mockConfig.emailApiKey = 'test-resend-key';
    mockFetch.mockResolvedValueOnce({ ok: true });

    await sendEmail({
      to: 'user@example.com',
      subject: 'Welcome',
      html: '<p>Hello</p>',
    });

    expect(mockFetch).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-resend-key',
      },
      body: JSON.stringify({
        from: 'Grantex <noreply@grantex.dev>',
        to: 'user@example.com',
        subject: 'Welcome',
        html: '<p>Hello</p>',
      }),
    });
  });

  it('throws when response not ok', async () => {
    mockConfig.emailApiKey = 'test-resend-key';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: vi.fn().mockResolvedValue('Invalid email address'),
    });

    await expect(
      sendEmail({ to: 'bad@', subject: 'Test', html: '<p>Hi</p>' }),
    ).rejects.toThrow('Email send failed (422): Invalid email address');
  });
});

describe('verificationEmailHtml', () => {
  it('generates correct URL and HTML structure', () => {
    const html = verificationEmailHtml('tok_abc123', 'https://grantex.dev');

    expect(html).toContain('https://grantex.dev/v1/signup/verify/tok_abc123');
    expect(html).toContain('Verify your email');
    expect(html).toContain('Verify Email');
    expect(html).toContain('This link expires in 24 hours');
  });

  it('includes the verify URL in both button and plaintext', () => {
    const html = verificationEmailHtml('tok_xyz', 'https://auth.example.com');
    const url = 'https://auth.example.com/v1/signup/verify/tok_xyz';

    // URL appears in href and in the "Or copy this link" text
    const occurrences = html.split(url).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
