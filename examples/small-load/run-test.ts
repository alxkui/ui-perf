import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { startMockServer } from './mock-server.js';
import { PodRunner, ReportAggregator } from '../../src/index.js';
import config from './ui-perf.config.js';
import scenario from './portal.perf.js';
import pc from 'picocolors';

async function main() {
  console.log(pc.bold(pc.magenta('=== UI-PERF SMALL LOAD END-TO-END VALIDATION ===\n')));

  // Clean previous results
  const resultsDir = path.resolve(process.cwd(), './perf-results');
  if (fs.existsSync(resultsDir)) {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }

  // 1. Start Mock Server
  console.log('1. Starting mock target web server on port 3888...');
  const server = await startMockServer(3888);
  console.log(pc.green('✔ Mock server listening at http://localhost:3888\n'));

  try {
    // 2. Simulate Pod 0 execution (shard 0/2)
    console.log(pc.bold('>>> Running Pod Shard 0 (Pod 1 of 2)...'));
    const runnerPod0 = new PodRunner(config, scenario, '0/2');
    const summaryPod0 = await runnerPod0.run();

    console.log('\n------------------------------------------------------------\n');

    // 3. Simulate Pod 1 execution (shard 1/2)
    console.log(pc.bold('>>> Running Pod Shard 1 (Pod 2 of 2)...'));
    const runnerPod1 = new PodRunner(config, scenario, '1/2');
    const summaryPod1 = await runnerPod1.run();

    console.log('\n------------------------------------------------------------\n');

    // 4. Run Multi-Pod Aggregator
    console.log(pc.bold('>>> Aggregating Multi-Pod Results...'));
    const aggregator = new ReportAggregator('./perf-results');
    const report = aggregator.aggregate();

    console.log(pc.bold(pc.green('\n🎉 Multi-Pod Load Test Aggregation Completed!')));
    console.log(`• Total Fleets Pods:     ${report.participatingPods.length} / ${report.totalPods}`);
    console.log(`• Participating Pods:    ${report.participatingPods.join(', ')}`);
    console.log(`• Total Iterations:      ${report.totalIterations}`);
    console.log(`• Overall Success Rate:  ${report.overallSuccessRate}%`);
    console.log(`• Fleet Throughput:      ${report.overallRPS} iter/s`);
    console.log(`• HTML Dashboard:        ${path.resolve('./perf-results/report.html')}`);

    // Verification assertions
    if (report.totalIterations === 0) {
      throw new Error('Test failed: Expected iterations > 0');
    }
    if (report.participatingPods.length !== 2) {
      throw new Error(`Test failed: Expected 2 pods, got ${report.participatingPods.length}`);
    }
    if (!fs.existsSync('./perf-results/report.html')) {
      throw new Error('Test failed: report.html was not generated');
    }

    console.log(pc.bold(pc.green('\n✔ ALL VALIDATION CHECKS PASSED SUCCESSFULLY!\n')));
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(pc.red(`\nTest failed with error: ${err.message}`));
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
