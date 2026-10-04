import type { Browser, BrowserContext, Page, LaunchOptions } from 'playwright';

export interface UserCredential {
  username: string;
  password: string;
  [key: string]: any;
}

export type StepFunction = (name: string, fn: () => Promise<void>) => Promise<void>;

export interface ScenarioContext {
  page: Page;
  browser: Browser;
  context: BrowserContext;
  user: UserCredential;
  vuId: number;
  podIndex: number;
  step: StepFunction;
  iteration: number;
}

export interface ScenarioDefinition {
  name: string;
  /**
   * Optional setup hook executed once per Virtual User upon browser startup.
   * Ideal for authenticating/logging in and navigating to the target screen once.
   */
  setup?: (ctx: ScenarioContext) => Promise<void>;

  /**
   * Main load scenario repeated in a loop for the entire test duration.
   * When setup is provided or sessionReuse is true, the user remains logged in on the same page.
   */
  run: (ctx: ScenarioContext) => Promise<void>;

  /**
   * Optional teardown hook executed once per Virtual User when the test duration ends.
   */
  teardown?: (ctx: ScenarioContext) => Promise<void>;

  /**
   * Global hooks executed once per pod/worker.
   */
  beforeAll?: () => Promise<void>;
  afterAll?: () => Promise<void>;
}

export interface StepMetric {
  name: string;
  durationMs: number;
  status: 'passed' | 'failed';
  error?: string;
  timestamp: number;
}

export interface WebVitals {
  ttfb?: number;
  fcp?: number;
  lcp?: number;
  cls?: number;
  domContentLoaded?: number;
}

export interface IterationResult {
  vuId: number;
  podIndex: number;
  iteration: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: 'passed' | 'failed';
  steps: StepMetric[];
  vitals?: WebVitals;
  error?: string;
}

export interface MetricAggregate {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface StepAggregate extends MetricAggregate {
  name: string;
  passedCount: number;
  failedCount: number;
  errorRate: number;
}

export interface ErrorEntry {
  message: string;
  count: number;
  step?: string;
  lastOccurrence: number;
}

export interface PodSummary {
  runId: string;
  podIndex: number;
  totalPods: number;
  assignedVUs: number;
  targetTotalVUs: number;
  startTime: number;
  endTime: number;
  durationSeconds: number;
  totalIterations: number;
  passedIterations: number;
  failedIterations: number;
  steps: Record<string, StepAggregate>;
  vitals: Record<string, MetricAggregate>;
  errors: ErrorEntry[];
  hostInfo?: {
    hostname: string;
    platform: string;
    cpus: number;
  };
}

export interface AggregatedReport {
  runId: string;
  totalPods: number;
  participatingPods: number[];
  targetTotalVUs: number;
  startTime: number;
  endTime: number;
  durationSeconds: number;
  totalIterations: number;
  passedIterations: number;
  failedIterations: number;
  overallSuccessRate: number;
  overallRPS: number;
  steps: Record<string, StepAggregate>;
  vitals: Record<string, MetricAggregate>;
  errors: ErrorEntry[];
  podSummaries: PodSummary[];
}

export interface ShardingConfig {
  totalPods?: number;
  podIndex?: number;
}

export interface BrowserConfig {
  type?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  isolation?: 'browser' | 'context';
  launchOptions?: LaunchOptions;
  viewport?: { width: number; height: number };
}

export interface ReportingConfig {
  outputDir?: string;
  runId?: string;
  generateHtml?: boolean;
  saveScreenshotsOnFailure?: boolean;
}

export interface UiPerfConfig {
  targetVUs: number;
  duration: string | number; // e.g. "30s", "10m", or seconds (30)
  spawnDelayMs?: number;    // delay between launching browsers on this pod
  thinkTimeMs?: number;     // delay/pacing between iterations for each VU
  sessionReuse?: boolean;   // if true or setup is defined, keeps page open and stays logged in for the duration
  sharding?: ShardingConfig;
  browser?: BrowserConfig;
  users?: UserCredential[] | string; // inline array or file path to JSON/CSV
  scenarios: ScenarioDefinition | ScenarioDefinition[] | string;
  reporting?: ReportingConfig;
}
