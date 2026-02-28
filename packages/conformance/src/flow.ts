import type { ConformanceHttpClient } from './http-client.js';
import type { CleanupTracker } from './cleanup.js';

export interface FlowResult {
  agentId: string;
  agentDid: string;
  authRequestId: string;
  code: string;
  grantToken: string;
  refreshToken: string;
  grantId: string;
  scopes: string[];
  expiresAt: string;
  principalId: string;
}

interface AuthorizeResponse {
  authRequestId: string;
  consentUrl: string;
  expiresAt: string;
  code?: string;
  sandbox?: boolean;
  policyEnforced?: boolean;
}

interface ConsentApproveResponse {
  code: string;
}

interface TokenResponse {
  grantToken: string;
  expiresAt: string;
  scopes: string[];
  refreshToken: string;
  grantId: string;
}

interface AgentResponse {
  agentId: string;
  did: string;
  name: string;
  scopes: string[];
}

export interface FlowOptions {
  agentName?: string;
  scopes?: string[];
  principalId?: string;
}

export class AuthFlowHelper {
  constructor(
    private readonly http: ConformanceHttpClient,
    private readonly cleanup: CleanupTracker,
  ) {}

  async executeFullFlow(options?: FlowOptions): Promise<FlowResult> {
    const agentName = options?.agentName ?? `conformance-agent-${Date.now()}`;
    const scopes = options?.scopes ?? ['read', 'write'];
    const principalId = options?.principalId ?? `principal-${Date.now()}`;

    // 1. Create agent
    const agentRes = await this.http.post<AgentResponse>('/v1/agents', {
      name: agentName,
      scopes,
    });
    if (agentRes.status !== 201) {
      throw new Error(`Failed to create agent: ${agentRes.status} ${agentRes.rawText}`);
    }
    const { agentId, did: agentDid } = agentRes.body;
    this.cleanup.trackAgent(agentId);

    // 2. Authorize
    const authRes = await this.http.post<AuthorizeResponse>('/v1/authorize', {
      agentId,
      principalId,
      scopes,
    });
    if (authRes.status !== 201) {
      throw new Error(`Failed to authorize: ${authRes.status} ${authRes.rawText}`);
    }
    const { authRequestId } = authRes.body;

    // 3. Get code — sandbox auto-provides it, otherwise approve consent
    let code: string;
    if (authRes.body.code) {
      code = authRes.body.code;
    } else {
      const consentRes = await this.http.requestPublic<ConsentApproveResponse>(
        'POST',
        `/v1/consent/${authRequestId}/approve`,
      );
      if (consentRes.status !== 200) {
        throw new Error(`Failed to approve consent: ${consentRes.status} ${consentRes.rawText}`);
      }
      code = consentRes.body.code;
    }

    // 4. Exchange code for token
    const tokenRes = await this.http.post<TokenResponse>('/v1/token', {
      code,
      agentId,
    });
    if (tokenRes.status !== 201) {
      throw new Error(`Failed to exchange token: ${tokenRes.status} ${tokenRes.rawText}`);
    }
    this.cleanup.trackGrant(tokenRes.body.grantId);

    return {
      agentId,
      agentDid,
      authRequestId,
      code,
      grantToken: tokenRes.body.grantToken,
      refreshToken: tokenRes.body.refreshToken,
      grantId: tokenRes.body.grantId,
      scopes: tokenRes.body.scopes,
      expiresAt: tokenRes.body.expiresAt,
      principalId,
    };
  }
}
