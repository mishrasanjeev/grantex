export interface RouteDefinition {
  path: string;
  methods: string[];
  requiredScopes: string[];
  /** Expected grant token audience for this route; overrides `GatewayConfig.audience`. */
  audience?: string;
  /** Data region for this route; overrides `GatewayConfig.dataRegion`. */
  dataRegion?: string;
}

export interface GatewayConfig {
  /** Programmatic opt-in issuer authority callback. Requires a route/global audience. Not JSON-serializable. */
  currentAuthority?: (token: string) => Promise<import('@grantex/sdk').VerifiedGrant>;
  /** Enable authenticated /v1/grants/verify calls from YAML/CLI configuration. Defaults false. */
  currentAuthorityCheck?: boolean;
  grantexBaseUrl?: string;
  expectedPrincipalId?: string;
  expectedAgentDid?: string;
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
  /**
   * The data region this gateway's upstream processes data in (for example `in`).
   * With `dataRegionCheck: 'on'`, a grant whose tools entries name another region is
   * refused (`REGION_MISMATCH`), and one that names a region when no region is
   * configured is refused outright (`REGION_UNCONFIGURED`).
   */
  dataRegion?: string;
  /** `off` (the default in this release) ignores a grant's `data_region`; `on` checks it. */
  dataRegionCheck?: 'on' | 'off';
}

export interface MatchResult {
  route: RouteDefinition;
  params: Record<string, string>;
}
