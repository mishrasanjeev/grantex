export interface RunConfig {
  baseUrl: string;
  apiKey: string;
  suite?: string;
  include?: string[];
  format: 'text' | 'json';
  bail: boolean;
  /** Also validate ES256/EdDSA signing keys in a mixed JWKS; defaults off. */
  allowAdditionalSigningKeys?: boolean;
  /** Internal service token for the OACP routes; the API key is used when absent. */
  internalToken?: string;
  /** Pinned OACP issuer identifier (the auth service's JWT_ISSUER). Default: baseUrl. */
  oacpIssuer?: string;
  /** Commerce tenant the OACP suite issues under. Default: cten_CONFORMANCE. */
  oacpTenantId?: string;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
  rawText: string;
  durationMs: number;
}

export type TestStatus = 'pass' | 'fail' | 'skip';

export interface TestResult {
  name: string;
  status: TestStatus;
  durationMs: number;
  specRef: string;
  error?: string;
}

export interface SuiteResult {
  name: string;
  description: string;
  optional: boolean;
  tests: TestResult[];
  durationMs: number;
}

export interface ConformanceReport {
  suites: SuiteResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
}

export interface SharedAgent {
  agentId: string;
  agentDid: string;
  name: string;
}

export interface SuiteContext {
  baseUrl: string;
  apiKey: string;
  http: import('./http-client.js').ConformanceHttpClient;
  flow: import('./flow.js').AuthFlowHelper;
  cleanup: import('./cleanup.js').CleanupTracker;
  /** Pre-created agent shared across suites to avoid plan limits */
  sharedAgent: SharedAgent;
  allowAdditionalSigningKeys?: boolean;
  internalToken?: string;
  oacpIssuer?: string;
  oacpTenantId?: string;
}

export interface SuiteDefinition {
  name: string;
  description: string;
  optional: boolean;
  run: (ctx: SuiteContext) => Promise<TestResult[]>;
}
