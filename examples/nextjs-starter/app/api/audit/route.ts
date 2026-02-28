import { NextRequest, NextResponse } from 'next/server';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? '';

export async function GET(request: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ error: 'GRANTEX_API_KEY not configured' }, { status: 500 });
  }

  const grantId = request.nextUrl.searchParams.get('grantId');
  if (!grantId) {
    return NextResponse.json({ error: 'grantId is required' }, { status: 400 });
  }

  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  try {
    const result = await grantex.audit.list({ grantId });
    return NextResponse.json({ entries: result.entries });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
