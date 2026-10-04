import { defineConfig } from '../../src/index.js';

export default defineConfig({
  targetVUs: 10,
  duration: '1m',
  spawnDelayMs: 200,
  thinkTimeMs: 150,
  browser: {
    headless: true,
    isolation: 'context',
  },
  users: './examples/small-load/users.csv',
  scenarios: './examples/small-load/portal.perf.ts',
  reporting: {
    outputDir: './perf-results',
  },
});
