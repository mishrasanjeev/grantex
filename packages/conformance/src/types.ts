export interface RunConfig {
  baseUrl: string;
  apiKey: string;
  suite?: string;
  include?: string[];
  format: 'text' | 'json';
  bail: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
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

export interface SuiteContext {
  baseUrl: string;
  apiKey: string;
  http: import('./http-client.js').ConformanceHttpClient;
  flow: import('./flow.js').AuthFlowHelper;
  cleanup: import('./cleanup.js').CleanupTracker;
}

export interface SuiteDefinition {
  name: string;
  description: string;
  optional: boolean;
  run: (ctx: SuiteContext) => Promise<TestResult[]>;
}
