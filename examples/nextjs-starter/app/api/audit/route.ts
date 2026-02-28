import { NextRequest, NextResponse } from 'next/server';

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

  try {
    const res = await fetch(`${BASE_URL}/v1/audit/entries?grantId=${encodeURIComponent(grantId)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const data = await res.json() as { entries?: unknown[] };
    return NextResponse.json({ entries: data.entries ?? [] });
  } catch {
    return NextResponse.json({ entries: [] });
  }
}
