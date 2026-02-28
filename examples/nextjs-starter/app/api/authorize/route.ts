import { NextResponse } from 'next/server';
import { Grantex } from '@grantex/sdk';
import { cookies } from 'next/headers';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? '';
const APP_URL = process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000';

export async function POST() {
  if (!API_KEY) {
    return NextResponse.json({ error: 'GRANTEX_API_KEY not configured' }, { status: 500 });
  }

  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  try {
    // Register a fresh agent for this demo session
    const agent = await grantex.agents.register({
      name: 'nextjs-demo-agent',
      description: 'Temporary agent created by the Next.js starter demo',
      scopes: ['calendar:read', 'email:send'],
    });

    // Generate a random state for CSRF protection
    const state = crypto.randomUUID();

    // Create the authorization request with redirect back to our callback
    const authRequest = await grantex.authorize({
      agentId: agent.id,
      userId: 'demo-user',
      scopes: ['calendar:read', 'email:send'],
      redirectUri: `${APP_URL}/callback`,
    });

    // Store agentId and state in cookies for the callback to use
    const cookieStore = await cookies();
    cookieStore.set('grantex_agent_id', agent.id, { path: '/', maxAge: 600, httpOnly: false, sameSite: 'lax' });
    cookieStore.set('grantex_state', state, { path: '/', maxAge: 600, httpOnly: false, sameSite: 'lax' });

    // Append state to the consent URL
    const consentUrl = new URL(authRequest.consentUrl);
    consentUrl.searchParams.set('state', state);

    return NextResponse.json({
      consentUrl: consentUrl.toString(),
      agentId: agent.id,
      authRequestId: authRequest.authRequestId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
