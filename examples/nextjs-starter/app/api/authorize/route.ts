import { NextResponse } from 'next/server';
import { Grantex } from '@grantex/sdk';
import { cookies } from 'next/headers';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? '';
const APP_URL = process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000';

// The API returns `agentId` but the SDK types use `id` — use the raw shape
interface AgentRaw {
  agentId: string;
  did: string;
  name: string;
  scopes: string[];
}

async function getOrCreateAgent(grantex: Grantex): Promise<AgentRaw> {
  // Reuse an existing demo agent to avoid hitting the free-plan agent limit
  const { agents } = await grantex.agents.list() as unknown as { agents: AgentRaw[] };
  const existing = agents.find((a) => a.name === 'nextjs-demo-agent');
  if (existing) return existing;

  const created = await grantex.agents.register({
    name: 'nextjs-demo-agent',
    description: 'Temporary agent created by the Next.js starter demo',
    scopes: ['calendar:read', 'email:send'],
  }) as unknown as AgentRaw;
  return created;
}

export async function POST() {
  if (!API_KEY) {
    return NextResponse.json({ error: 'GRANTEX_API_KEY not configured' }, { status: 500 });
  }

  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  try {
    const agent = await getOrCreateAgent(grantex);
    const agentId = agent.agentId;

    // Generate a random state for CSRF protection
    const state = crypto.randomUUID();

    // Call the authorize endpoint directly so we can include `state` in the
    // request body. The SDK's authorize() doesn't expose the `state` param,
    // but the auth service stores it and returns it in the consent redirect.
    const authRes = await fetch(`${BASE_URL}/v1/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId,
        principalId: 'demo-user',
        scopes: ['calendar:read', 'email:send'],
        redirectUri: `${APP_URL}/callback`,
        state,
      }),
    });
    const authRequest = await authRes.json() as { authRequestId: string; consentUrl: string };
    if (!authRes.ok) {
      const msg = (authRequest as unknown as { message?: string }).message ?? 'Authorize failed';
      return NextResponse.json({ error: msg }, { status: authRes.status });
    }

    // Store agentId and state in cookies for the callback to use
    const cookieStore = await cookies();
    cookieStore.set('grantex_agent_id', agentId, { path: '/', maxAge: 600, httpOnly: false, sameSite: 'lax' });
    cookieStore.set('grantex_state', state, { path: '/', maxAge: 600, httpOnly: false, sameSite: 'lax' });

    // The auth service returns consentUrl using its JWT_ISSUER (grantex.dev),
    // but the consent UI is served by the auth service itself. Replace the
    // origin with the actual auth service base URL.
    const rawConsentUrl = new URL(authRequest.consentUrl);
    const consentUrl = new URL(`${BASE_URL}${rawConsentUrl.pathname}${rawConsentUrl.search}`);
    consentUrl.searchParams.set('state', state);

    return NextResponse.json({
      consentUrl: consentUrl.toString(),
      agentId,
      authRequestId: authRequest.authRequestId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
