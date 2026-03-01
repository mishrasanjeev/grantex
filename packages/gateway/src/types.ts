export interface RouteDefinition {
  path: string;
  methods: string[];
  requiredScopes: string[];
}

export interface GatewayConfig {
  upstream: string;
  jwksUri: string;
  port: number;
  upstreamHeaders?: Record<string, string>;
  routes: RouteDefinition[];
  grantexApiKey?: string;
}

export interface MatchResult {
  route: RouteDefinition;
  params: Record<string, string>;
}
