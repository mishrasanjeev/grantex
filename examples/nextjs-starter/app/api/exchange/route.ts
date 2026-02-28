import { NextRequest, NextResponse } from 'next/server';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? '';

export async function POST(request: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ error: 'GRANTEX_API_KEY not configured' }, { status: 500 });
  }

  const body = await request.json() as { code?: string; agentId?: string };
  const { code, agentId } = body;

  if (!code || !agentId) {
    return NextResponse.json({ error: 'code and agentId are required' }, { status: 400 });
  }

  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  try {
    // Exchange authorization code for grant token
    const token = await grantex.tokens.exchange({ code, agentId });

    // Log an audit entry for the demo
    const auditEntry = await grantex.audit.log({
      agentId,
      grantId: token.grantId,
      action: 'demo.token_exchanged',
      status: 'success',
      metadata: { source: 'nextjs-starter' },
    });

    return NextResponse.json({
      grantToken: token.grantToken,
      grantId: token.grantId,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      auditEntryId: auditEntry.entryId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
