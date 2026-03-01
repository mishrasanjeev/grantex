import { NextRequest, NextResponse } from 'next/server';
import { Grantex } from '@grantex/sdk';

const ALLOWED_HOSTS = [
  'https://grantex-auth-dd4mtrt2gq-uc.a.run.app',
  'http://localhost:3001',
];

function getBaseUrl(): string {
  const url = process.env['GRANTEX_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
  if (!ALLOWED_HOSTS.includes(url)) {
    throw new Error(`GRANTEX_URL must be one of: ${ALLOWED_HOSTS.join(', ')}`);
  }
  return url;
}

const API_KEY = process.env['GRANTEX_API_KEY'] ?? '';

export async function POST(request: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ error: 'GRANTEX_API_KEY not configured' }, { status: 500 });
  }

  let baseUrl: string;
  try {
    baseUrl = getBaseUrl();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid GRANTEX_URL';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const gx = new Grantex({ apiKey: API_KEY, baseUrl });

  const body = await request.json() as { code?: string; agentId?: string };
  const { code, agentId } = body;

  if (!code || !agentId) {
    return NextResponse.json({ error: 'code and agentId are required' }, { status: 400 });
  }

  try {
    // Exchange authorization code for grant token
    const token = await gx.tokens.exchange({ code, agentId });

    // Log an audit entry (best-effort — don't fail the demo if this errors)
    let auditEntryId: string | null = null;
    try {
      const auditEntry = await gx.audit.log({
        agentId,
        grantId: token.grantId,
        action: 'demo.token_exchanged',
        status: 'success',
        metadata: { source: 'nextjs-starter' },
      });
      auditEntryId = auditEntry.entryId ?? null;
    } catch {
      // Audit logging is non-critical for the demo
    }

    return NextResponse.json({
      grantToken: token.grantToken,
      grantId: token.grantId,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      ...(auditEntryId ? { auditEntryId } : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
