export interface RouteDefinition {
  path: string;
  methods: string[];
  requiredScopes: string[];
  /** Expected grant token audience for this route; overrides `GatewayConfig.audience`. */
  audience?: string;
}

export interface GatewayConfig {
  upstream: string;
  jwksUri: string;
  port: number;
  upstreamHeaders?: Record<string, string>;
  routes: RouteDefinition[];
  grantexApiKey?: string;
  /** Expected grant token audience (RFC 7519 section 4.1.3). */
  audience?: string;
  /**
   * `on` (default) refuses a token whose `aud` does not contain the expected
   * audience, and a token that carries `aud` when no audience is configured.
   * `off` ignores `aud`, as releases before the check did.
   */
  audienceCheck?: 'on' | 'off';
}

export interface MatchResult {
  route: RouteDefinition;
  params: Record<string, string>;
}
