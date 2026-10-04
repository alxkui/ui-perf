import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import pc from 'picocolors';
import type {
  UiPerfConfig,
  ScenarioDefinition,
  ScenarioContext,
  StepMetric,
  IterationResult,
  PodSummary,
  UserCredential,
} from '../types/index.js';
import { calculateShardPlan, loadCredentials, resolveSharding } from './sharding.js';
import { MetricsCollector } from '../metrics/collector.js';
import { collectWebVitals } from '../metrics/vitals.js';

export function parseDurationToMs(dur: string | number): number {
  if (typeof dur === 'number') {
    return dur * 1000;
  }
  const match = dur.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration format: "${dur}". Expected formats like "30s", "5m", "1h", or a number in seconds.`);
  }

  const val = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();

  switch (unit) {
    case 's':
      return val * 1000;
    case 'm':
      return val * 60 * 1000;
    case 'h':
      return val * 60 * 60 * 1000;
    default:
      return val * 1000;
  }
}

export class PodRunner {
  private config: UiPerfConfig;
  private scenario: ScenarioDefinition;
  private isInterrupted: boolean = false;
  private cliShard?: string;

  constructor(config: UiPerfConfig, scenario: ScenarioDefinition, cliShard?: string) {
    this.config = config;
    this.scenario = scenario;
    this.cliShard = cliShard;
  }

  public async run(): Promise<PodSummary> {
    const runId = this.config.reporting?.runId || `run-${Date.now()}`;
    const outputDir = path.resolve(process.cwd(), this.config.reporting?.outputDir || './perf-results');
    fs.mkdirSync(outputDir, { recursive: true });

    // 1. Sharding & Credentials calculation
    const { podIndex, totalPods } = resolveSharding(this.config.sharding, this.cliShard);
    const allUsers = loadCredentials(this.config.users);
    const shardPlan = calculateShardPlan(this.config.targetVUs, podIndex, totalPods, allUsers);

    const durationMs = parseDurationToMs(this.config.duration);
    const spawnDelayMs = this.config.spawnDelayMs ?? 150;
    const thinkTimeMs = this.config.thinkTimeMs ?? 0;
    const isolation = this.config.browser?.isolation ?? 'context';
    const browserTypeChoice = this.config.browser?.type ?? 'chromium';
    const headless = this.config.browser?.headless ?? true;

    console.log(pc.bold(pc.cyan('\n🚀 [ui-perf] Starting Distributed UI Performance Run')));
    console.log(pc.dim('------------------------------------------------------------'));
    console.log(`• Run ID:           ${pc.yellow(runId)}`);
    console.log(`• Pod Shard:        ${pc.green(`Pod ${podIndex + 1} of ${totalPods}`)} (Index: ${podIndex})`);
    console.log(`• Virtual Users:    ${pc.green(`${shardPlan.assignedVUs} VUs on this pod`)} (${this.config.targetVUs} total across fleet)`);
    console.log(`• Test Duration:    ${pc.cyan(`${Math.round(durationMs / 1000)}s`)}`);
    console.log(`• Spawn Delay:      ${pc.dim(`${spawnDelayMs}ms per VU`)}`);
    console.log(`• Browser Mode:     ${pc.magenta(`${browserTypeChoice} (${isolation} isolation, headless: ${headless})`)}`);
    console.log(`• Scenario:         ${pc.bold(this.scenario.name)}`);
    if (shardPlan.credentials.length > 0) {
      console.log(`• User Accounts:    ${pc.green(`${shardPlan.credentials.length} unique credentials partitioned for this pod`)}`);
    } else {
      console.log(`• User Accounts:    ${pc.dim('None provided (synthetic user sessions generated)')}`);
    }
    console.log(pc.dim('------------------------------------------------------------\n'));

    const collector = new MetricsCollector({
      runId,
      podIndex,
      totalPods,
      assignedVUs: shardPlan.assignedVUs,
      targetTotalVUs: this.config.targetVUs,
    });
    collector.start();

    // Signal handlers for graceful teardown
    const handleSig = () => {
      if (!this.isInterrupted) {
        console.log(pc.yellow('\n\nReceived termination signal. Finishing in-flight iterations and generating pod summary...'));
        this.isInterrupted = true;
      }
    };
    process.on('SIGINT', handleSig);
    process.on('SIGTERM', handleSig);

    // Call scenario beforeAll hook if defined
    if (this.scenario.beforeAll) {
      console.log(pc.dim('Running beforeAll hook...'));
      await this.scenario.beforeAll();
    }

    const browserLauncher = browserTypeChoice === 'firefox' ? firefox : browserTypeChoice === 'webkit' ? webkit : chromium;
    const launchArgs = [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    // Shared browser if in 'context' mode
    let sharedBrowser: Browser | null = null;
    if (isolation === 'context') {
      sharedBrowser = await browserLauncher.launch({
        headless,
        args: launchArgs,
        ...this.config.browser?.launchOptions,
      });
    }

    const testEndTime = Date.now() + durationMs;
    let activeVUs = 0;
    const vuPromises: Promise<void>[] = [];

    // Live logging ticker
    const ticker = setInterval(() => {
      const summary = collector.getSummary();
      const elapsedSec = Math.max(1, Math.round((Date.now() - summary.startTime) / 1000));
      const remainingSec = Math.max(0, Math.round((testEndTime - Date.now()) / 1000));
      const currentRps = (summary.totalIterations / elapsedSec).toFixed(1);

      process.stdout.write(
        `\r[Pod ${podIndex}] Elapsed: ${elapsedSec}s | Left: ${remainingSec}s | Active VUs: ${activeVUs}/${shardPlan.assignedVUs} | Iterations: ${summary.totalIterations} (✓ ${pc.green(summary.passedIterations)} / ✗ ${pc.red(summary.failedIterations)}) | Speed: ${currentRps} iter/s  `
      );
    }, 1000);

    // Spawn VUs with configured spawn delay
    for (let i = 0; i < shardPlan.assignedVUs; i++) {
      if (this.isInterrupted) break;

      const vuIndex = i;
      const globalVuId = shardPlan.vuStartIndex + vuIndex;

      // Assign disjoint user credential
      const user: UserCredential =
        shardPlan.credentials.length > 0
          ? shardPlan.credentials[vuIndex % shardPlan.credentials.length]
          : { username: `user-pod${podIndex}-vu${globalVuId}`, password: 'password123' };

      const vuPromise = (async () => {
        activeVUs++;
        let localBrowser: Browser | null = null;
        let persistentContext: BrowserContext | null = null;
        let persistentPage: Page | null = null;

        const shouldReuseSession = Boolean(this.scenario.setup || this.config.sessionReuse);

        const createStepWrapper = (stepMetrics: StepMetric[], pageGetter: () => Page | null, iterNum: number) => {
          return async (stepName: string, stepFn: () => Promise<void>) => {
            const stepStart = Date.now();
            try {
              await stepFn();
              stepMetrics.push({
                name: stepName,
                durationMs: Date.now() - stepStart,
                status: 'passed',
                timestamp: stepStart,
              });
            } catch (err: any) {
              const errMsg = err?.message || String(err);
              stepMetrics.push({
                name: stepName,
                durationMs: Date.now() - stepStart,
                status: 'failed',
                error: errMsg,
                timestamp: stepStart,
              });

              if (this.config.reporting?.saveScreenshotsOnFailure) {
                const curPage = pageGetter();
                if (curPage) {
                  try {
                    const shotPath = path.join(
                      outputDir,
                      `error-pod${podIndex}-vu${globalVuId}-iter${iterNum}-${Date.now()}.png`
                    );
                    await curPage.screenshot({ path: shotPath, fullPage: true });
                  } catch {
                    // Ignore screenshot failure during teardown
                  }
                }
              }

              throw err;
            }
          };
        };

        try {
          if (isolation === 'browser') {
            localBrowser = await browserLauncher.launch({
              headless,
              args: launchArgs,
              ...this.config.browser?.launchOptions,
            });
          }

          if (shouldReuseSession) {
            // Persistent session mode (Login once, repeat actions continuously for duration)
            const contextOptions = {
              viewport: this.config.browser?.viewport || { width: 1280, height: 720 },
            };
            persistentContext = isolation === 'browser'
              ? await localBrowser!.newContext(contextOptions)
              : await sharedBrowser!.newContext(contextOptions);

            persistentPage = await persistentContext.newPage();

            // Run VU Setup Hook (e.g. Login once)
            if (this.scenario.setup) {
              const setupStartTime = Date.now();
              const setupMetrics: StepMetric[] = [];
              const setupStep = createStepWrapper(setupMetrics, () => persistentPage, 0);

              const setupCtx: ScenarioContext = {
                page: persistentPage,
                browser: (isolation === 'context' ? sharedBrowser! : localBrowser!),
                context: persistentContext,
                user,
                vuId: globalVuId,
                podIndex,
                step: setupStep,
                iteration: 0,
              };

              let setupStatus: 'passed' | 'failed' = 'passed';
              let setupError: string | undefined;

              try {
                await this.scenario.setup(setupCtx);
              } catch (err: any) {
                setupStatus = 'failed';
                setupError = err?.message || String(err);
                console.error(pc.red(`[VU ${globalVuId}] Setup failed: ${setupError}`));
              }

              // Record setup step metrics
              collector.recordIteration({
                vuId: globalVuId,
                podIndex,
                iteration: 0,
                startTime: setupStartTime,
                endTime: Date.now(),
                durationMs: Date.now() - setupStartTime,
                status: setupStatus,
                steps: setupMetrics,
                error: setupError,
              });

              if (setupStatus === 'failed') {
                return; // Abort this VU if setup/login failed
              }
            }

            let iteration = 0;
            while (Date.now() < testEndTime && !this.isInterrupted) {
              iteration++;
              const iterStartTime = Date.now();
              const stepMetrics: StepMetric[] = [];
              let iterError: string | undefined;

              const step = createStepWrapper(stepMetrics, () => persistentPage, iteration);

              const ctx: ScenarioContext = {
                page: persistentPage,
                browser: (isolation === 'context' ? sharedBrowser! : localBrowser!),
                context: persistentContext,
                user,
                vuId: globalVuId,
                podIndex,
                step,
                iteration,
              };

              let vitals = {};
              let status: 'passed' | 'failed' = 'passed';

              try {
                await this.scenario.run(ctx);
                vitals = await collectWebVitals(persistentPage);
              } catch (err: any) {
                status = 'failed';
                iterError = err?.message || String(err);

                // If page closed or crashed, recover for subsequent iterations
                if (persistentPage.isClosed()) {
                  try {
                    persistentPage = await persistentContext.newPage();
                    if (this.scenario.setup) {
                      await this.scenario.setup({ ...ctx, page: persistentPage });
                    }
                  } catch {
                    // Ignore recovery failure
                  }
                }
              }

              const iterResult: IterationResult = {
                vuId: globalVuId,
                podIndex,
                iteration,
                startTime: iterStartTime,
                endTime: Date.now(),
                durationMs: Date.now() - iterStartTime,
                status,
                steps: stepMetrics,
                vitals,
                error: iterError,
              };

              collector.recordIteration(iterResult);

              if (thinkTimeMs > 0 && Date.now() < testEndTime && !this.isInterrupted) {
                await new Promise((r) => setTimeout(r, thinkTimeMs));
              }
            }

            // Run VU Teardown Hook
            if (this.scenario.teardown && persistentPage && !persistentPage.isClosed()) {
              const teardownMetrics: StepMetric[] = [];
              const teardownStep = createStepWrapper(teardownMetrics, () => persistentPage, iteration);
              const teardownCtx: ScenarioContext = {
                page: persistentPage,
                browser: (isolation === 'context' ? sharedBrowser! : localBrowser!),
                context: persistentContext,
                user,
                vuId: globalVuId,
                podIndex,
                step: teardownStep,
                iteration,
              };
              await this.scenario.teardown(teardownCtx).catch(() => {});
            }

            try {
              if (persistentPage && !persistentPage.isClosed()) await persistentPage.close();
              if (persistentContext) await persistentContext.close();
            } catch {
              // Safe ignore
            }
          } else {
            // Fresh context/page per iteration mode
            let iteration = 0;

            while (Date.now() < testEndTime && !this.isInterrupted) {
              iteration++;
              const iterStartTime = Date.now();
              const stepMetrics: StepMetric[] = [];
              let iterError: string | undefined;

              let context = localBrowser ? await localBrowser.newContext() : await sharedBrowser!.newContext({
                viewport: this.config.browser?.viewport || { width: 1280, height: 720 },
              });

              const page = await context.newPage();
              const step = createStepWrapper(stepMetrics, () => page, iteration);

              const ctx: ScenarioContext = {
                page,
                browser: (isolation === 'context' ? sharedBrowser! : localBrowser!),
                context,
                user,
                vuId: globalVuId,
                podIndex,
                step,
                iteration,
              };

              let vitals = {};
              let status: 'passed' | 'failed' = 'passed';

              try {
                await this.scenario.run(ctx);
                vitals = await collectWebVitals(page);
              } catch (err: any) {
                status = 'failed';
                iterError = err?.message || String(err);
              } finally {
                try {
                  await page.close();
                  await context.close();
                } catch {
                  // Ignore close errors
                }
              }

              const iterResult: IterationResult = {
                vuId: globalVuId,
                podIndex,
                iteration,
                startTime: iterStartTime,
                endTime: Date.now(),
                durationMs: Date.now() - iterStartTime,
                status,
                steps: stepMetrics,
                vitals,
                error: iterError,
              };

              collector.recordIteration(iterResult);

              if (thinkTimeMs > 0 && Date.now() < testEndTime && !this.isInterrupted) {
                await new Promise((r) => setTimeout(r, thinkTimeMs));
              }
            }
          }
        } finally {
          if (localBrowser) {
            await localBrowser.close().catch(() => {});
          }
          activeVUs--;
        }
      })();

      vuPromises.push(vuPromise);

      if (spawnDelayMs > 0 && i < shardPlan.assignedVUs - 1) {
        await new Promise((r) => setTimeout(r, spawnDelayMs));
      }
    }

    // Wait for all active VUs to complete
    await Promise.all(vuPromises);
    clearInterval(ticker);

    if (sharedBrowser) {
      await sharedBrowser.close().catch(() => {});
    }

    if (this.scenario.afterAll) {
      console.log(pc.dim('\nRunning afterAll hook...'));
      await this.scenario.afterAll().catch(() => {});
    }

    process.removeListener('SIGINT', handleSig);
    process.removeListener('SIGTERM', handleSig);

    const summary = collector.finish();

    // Save summary JSON
    const summaryFilePath = path.join(outputDir, `summary-pod-${podIndex}.json`);
    fs.writeFileSync(summaryFilePath, JSON.stringify(summary, null, 2), 'utf-8');

    // Save detailed results NDJSON
    const ndjsonFilePath = path.join(outputDir, `results-pod-${podIndex}.ndjson`);
    const ndjsonContent = collector.getIterationResults().map((res) => JSON.stringify(res)).join('\n') + '\n';
    fs.writeFileSync(ndjsonFilePath, ndjsonContent, 'utf-8');

    console.log('\n\n' + pc.bold(pc.green(`✔ Pod ${podIndex} Execution Finished Successfully`)));
    console.log(`• Pod Summary Saved:  ${pc.cyan(summaryFilePath)}`);
    console.log(`• Total Iterations:    ${summary.totalIterations} (Passed: ${summary.passedIterations}, Failed: ${summary.failedIterations})`);

    // Print step table
    if (Object.keys(summary.steps).length > 0) {
      console.log('\n' + pc.bold('Step Latency Summary (ms):'));
      console.table(
        Object.values(summary.steps).map((s) => ({
          Step: s.name,
          Count: s.count,
          'Pass %': `${(100 - s.errorRate).toFixed(1)}%`,
          Min: s.min,
          p50: s.p50,
          p90: s.p90,
          p95: s.p95,
          p99: s.p99,
          Max: s.max,
        }))
      );
    }

    return summary;
  }
}
