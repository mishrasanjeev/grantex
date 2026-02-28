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

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Exchange authorization code for grant token
    const tokenRes = await fetch(`${BASE_URL}/v1/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code, agentId }),
    });
    const token = await tokenRes.json() as {
      grantToken?: string; grantId?: string; scopes?: string[];
      expiresAt?: string; message?: string;
    };
    if (!tokenRes.ok) {
      return NextResponse.json({ error: token.message ?? 'Token exchange failed' }, { status: tokenRes.status });
    }

    // Fetch agent details to get the DID for audit logging
    const agentRes = await fetch(`${BASE_URL}/v1/agents/${agentId}`, { headers });
    const agent = await agentRes.json() as { did?: string };

    // Log an audit entry (best-effort — don't fail the demo if this errors)
    let auditEntryId: string | null = null;
    try {
      const auditRes = await fetch(`${BASE_URL}/v1/audit/log`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agentId,
          agentDid: agent.did,
          grantId: token.grantId,
          principalId: 'demo-user',
          action: 'demo.token_exchanged',
          status: 'success',
          metadata: { source: 'nextjs-starter' },
        }),
      });
      const auditData = await auditRes.json() as { entryId?: string };
      auditEntryId = auditData.entryId ?? null;
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
