#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { PodRunner } from '../core/runner.js';
import { ReportAggregator } from '../aggregation/aggregator.js';
import type { UiPerfConfig, ScenarioDefinition } from '../types/index.js';

const program = new Command();

program
  .name('ui-perf')
  .description('High-scale distributed UI performance testing tool powered by Playwright')
  .version('0.1.0');

// RUN COMMAND
program
  .command('run')
  .description('Execute UI performance test on current pod/worker')
  .option('-c, --config <path>', 'Path to ui-perf configuration file')
  .option('-s, --shard <shard>', 'Shard index and total (e.g. 0/4 or 1/4)')
  .option('-u, --vus <number>', 'Override target total virtual users', (val) => parseInt(val, 10))
  .option('-d, --duration <dur>', 'Override test duration (e.g. 30s, 5m)')
  .option('--delay <ms>', 'Override spawn delay in ms', (val) => parseInt(val, 10))
  .option('--headless <boolean>', 'Run browsers headless', (val) => val !== 'false')
  .option('--aggregate', 'Automatically run aggregator after pod completion', false)
  .action(async (opts) => {
    try {
      // Find config file
      let configPath = opts.config;
      if (!configPath) {
        const candidates = [
          'ui-perf.config.ts',
          'ui-perf.config.js',
          'ui-perf.config.mjs',
          'ui-perf.config.cjs',
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(path.resolve(process.cwd(), candidate))) {
            configPath = candidate;
            break;
          }
        }
      }

      if (!configPath || !fs.existsSync(path.resolve(process.cwd(), configPath))) {
        console.error(pc.red(`Error: Config file not found. Specify with -c <path> or run "ui-perf init".`));
        process.exit(1);
      }

      const absoluteConfigPath = path.resolve(process.cwd(), configPath);
      let loadedModule: any;

      // Handle ts/esm dynamic import
      try {
        loadedModule = await import(`file://${absoluteConfigPath}`);
      } catch (err: any) {
        // In case tsx isn't registered, dynamically try jiti / ts-node / import
        console.error(pc.red(`Failed to load config from ${absoluteConfigPath}: ${err.message}`));
        process.exit(1);
      }

      const rawConfig: UiPerfConfig = loadedModule.default || loadedModule;

      // Apply CLI overrides
      if (opts.vus) rawConfig.targetVUs = opts.vus;
      if (opts.duration) rawConfig.duration = opts.duration;
      if (opts.delay !== undefined) rawConfig.spawnDelayMs = opts.delay;
      if (opts.headless !== undefined) {
        if (!rawConfig.browser) rawConfig.browser = {};
        rawConfig.browser.headless = opts.headless;
      }

      // Load scenario
      let scenario: ScenarioDefinition;
      if (typeof rawConfig.scenarios === 'string') {
        const scenarioPath = path.resolve(process.cwd(), rawConfig.scenarios);
        const scenarioMod = await import(`file://${scenarioPath}`);
        scenario = scenarioMod.default || scenarioMod;
      } else if (Array.isArray(rawConfig.scenarios)) {
        scenario = rawConfig.scenarios[0];
      } else {
        scenario = rawConfig.scenarios;
      }

      if (!scenario || typeof scenario.run !== 'function') {
        console.error(pc.red('Error: Invalid scenario. Must define a "run" function.'));
        process.exit(1);
      }

      const runner = new PodRunner(rawConfig, scenario, opts.shard);
      const summary = await runner.run();

      // If aggregate flag is passed or single pod test
      if (opts.aggregate || summary.totalPods === 1) {
        const outDir = rawConfig.reporting?.outputDir || './perf-results';
        const aggregator = new ReportAggregator(outDir);
        aggregator.aggregate();
        console.log(pc.bold(pc.green(`✔ Aggregated interactive report generated at: ${path.join(outDir, 'report.html')}`)));
      }

      if (summary.failedIterations > 0 && summary.passedIterations === 0) {
        process.exitCode = 1;
      }
    } catch (err: any) {
      console.error(pc.red(`Fatal Execution Error: ${err.message}`));
      if (err.stack) console.error(pc.dim(err.stack));
      process.exit(1);
    }
  });

// AGGREGATE COMMAND
program
  .command('aggregate')
  .description('Aggregate multiple pod summary files into a consolidated JSON and HTML report')
  .option('-d, --dir <path>', 'Directory containing summary-pod-*.json files', './perf-results')
  .action((opts) => {
    try {
      console.log(pc.bold(pc.cyan(`\n📊 [ui-perf] Aggregating multi-pod results from: ${opts.dir}`)));
      const aggregator = new ReportAggregator(opts.dir);
      const report = aggregator.aggregate();

      console.log(pc.green(`✔ Aggregated ${report.participatingPods.length} pods successfully!`));
      console.log(`• Total Fleet Iterations: ${pc.bold(report.totalIterations.toLocaleString())}`);
      console.log(`• Overall Success Rate:  ${pc.bold(`${report.overallSuccessRate}%`)}`);
      console.log(`• Total Fleet RPS:       ${pc.bold(`${report.overallRPS} iter/s`)}`);
      console.log(`• Consolidated JSON:     ${pc.cyan(path.join(opts.dir, 'summary-aggregate.json'))}`);
      console.log(`• Interactive HTML:      ${pc.bold(pc.cyan(path.join(opts.dir, 'report.html')))}\n`);
    } catch (err: any) {
      console.error(pc.red(`Aggregation Error: ${err.message}`));
      process.exit(1);
    }
  });

// INIT COMMAND
program
  .command('init')
  .description('Scaffold starter configuration and scenario files')
  .action(() => {
    const configTemplate = `import { defineConfig } from 'ui-perf';

export default defineConfig({
  targetVUs: 10,
  duration: '30s',
  spawnDelayMs: 200,
  browser: {
    headless: true,
    isolation: 'context', // 'context' is optimal for high scale; 'browser' gives isolated processes
  },
  users: './users.csv',
  scenarios: './scenarios/sample.perf.ts',
  reporting: {
    outputDir: './perf-results',
  },
});
`;

    const scenarioTemplate = `import { defineScenario } from 'ui-perf';

export default defineScenario({
  name: 'Sample Web Navigation & Interaction',
  async run({ page, user, step }) {
    await step('01_Home_Page', async () => {
      await page.goto('https://example.com');
      await page.waitForSelector('h1');
    });

    await step('02_Read_More', async () => {
      const link = page.locator('a');
      if (await link.count() > 0) {
        await link.first().click();
      }
    });
  },
});
`;

    const usersTemplate = `username,password
testuser1@example.com,secret123
testuser2@example.com,secret123
testuser3@example.com,secret123
testuser4@example.com,secret123
testuser5@example.com,secret123
`;

    fs.mkdirSync(path.resolve(process.cwd(), 'scenarios'), { recursive: true });
    fs.writeFileSync(path.resolve(process.cwd(), 'ui-perf.config.ts'), configTemplate, 'utf-8');
    fs.writeFileSync(path.resolve(process.cwd(), 'scenarios/sample.perf.ts'), scenarioTemplate, 'utf-8');
    fs.writeFileSync(path.resolve(process.cwd(), 'users.csv'), usersTemplate, 'utf-8');

    console.log(pc.bold(pc.green('✔ Initialized ui-perf project with:')));
    console.log(`  • ui-perf.config.ts`);
    console.log(`  • scenarios/sample.perf.ts`);
    console.log(`  • users.csv`);
    console.log(`\nRun your test with: ${pc.cyan('npx ui-perf run')}`);
  });

program.parse(process.argv);
