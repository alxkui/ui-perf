# ui-perf ⚡

**ui-perf** is a distributed, high-scale UI performance and load testing framework powered by [Playwright](https://playwright.dev).

Unlike traditional API-only performance tools (k6, Locust, JMeter), **ui-perf** executes real headless browser sessions to accurately measure client-side rendering bottlenecks, complex Single-Page Apps (SPAs), legacy web portals without APIs, DOM latency, and Core Web Vitals under load (1 to 500+ concurrent browsers).

---

## 🚀 Key Features

1. **Distributed Workload Sharding (Kubernetes & Argo Workflows)**
   - Scales effortlessly to 500+ concurrent browsers across multiple worker pods.
   - Automatically detects pod index from `JOB_COMPLETION_INDEX` (Kubernetes Indexed Jobs) or `POD_INDEX` / `ARGO_SHARD_INDEX`.
   - CLI shard override: `--shard 0/20` or `--shard 1/20`.

2. **Zero-Collision User Partitioning**
   - Provide a list of test accounts via CSV or JSON.
   - Pods deterministically partition credentials into disjoint subsets so no two virtual users across different pods ever collide or share sessions.

3. **Staggered Browser Spawning (Ramp-Up Delay)**
   - Configurable `spawnDelayMs` prevents CPU cold-start spikes and throttling when booting browser instances.

4. **Configurable Test Duration & Pacing**
   - Run tests for any duration (e.g. `30s`, `15m`, `1h`) with optional VU think-time/pacing.

5. **Multi-Pod Metric Aggregation & HTML Report**
   - Pods write local NDJSON traces and summary files.
   - Built-in aggregator calculates true global percentiles (**min, max, avg, p50, p90, p95, p99**), fleet throughput (RPS), Web Vitals (LCP, FCP, TTFB, CLS), and generates a standalone interactive HTML dashboard.

6. **Native Developer Experience**
   - Install via `npm install ui-perf playwright`.
   - Write standard, intuitive Playwright scripts wrapped in named `step()` timers.

---

## 📦 Quick Start

### 1. Installation

```bash
npm install ui-perf playwright
npx playwright install chromium
```

### 2. Initialize Starter Files

```bash
npx ui-perf init
```

This creates:
- `ui-perf.config.ts`: Main performance test configuration.
- `scenarios/sample.perf.ts`: Declarative Playwright scenario.
- `users.csv`: List of user credentials for partitioned assignment.

---

## 🛠️ Defining a Scenario (Login Once & Hammer UI Actions)

When testing an application through the UI, you typically want users to **log in once**, and then **repeatedly hammer transactions (e.g. placing orders, clicking buttons) for the full test duration** (e.g. 10 minutes) without the overhead of logging in repeatedly.

`ui-perf` provides lifecycle hooks directly in `defineScenario`:
- **`setup({ page, user, step })`**: Runs **once** when the Virtual User browser starts up (e.g. authenticate, navigate to dashboard).
- **`run({ page, user, step, iteration })`**: Repeated **continuously in a loop** for the specified duration (`10m`, `30s`, etc.) on the open, logged-in page.
- **`teardown({ page, user, step })`**: Optional cleanup hook executed once when duration ends (e.g. logout).

```typescript
// scenarios/orders.perf.ts
import { defineScenario } from 'ui-perf';

export default defineScenario({
  name: 'Enterprise Portal Order Hammering Flow',

  // 1. Setup runs ONCE per virtual user
  async setup({ page, user, step }) {
    await step('01_Load_Login_Page', async () => {
      await page.goto('https://app.company.internal/login');
      await page.waitForSelector('#login-form');
    });

    await step('02_Authenticate_User', async () => {
      await page.fill('#username', user.username);
      await page.fill('#password', user.password);
      await page.click('#login-submit');
      await page.waitForSelector('#order-dashboard');
    });
  },

  // 2. Run is repeated continuously in a loop for the entire test duration (e.g. 10 minutes)
  async run({ page, user, step, iteration }) {
    await step('03_Place_Order', async () => {
      await page.click('#create-order-btn');
      await page.waitForSelector('.confirmation-badge');
    });
  },

  // 3. Teardown runs ONCE when the duration expires
  async teardown({ page, user, step }) {
    await step('04_Logout', async () => {
      await page.click('#logout-btn');
    });
  },
});
```

---

## ⚙️ Configuration (`ui-perf.config.ts`)

```typescript
import { defineConfig } from 'ui-perf';

export default defineConfig({
  // Total virtual users across all pods
  targetVUs: 500,

  // Test duration
  duration: '10m',

  // Delay in milliseconds between spawning each browser on the pod
  spawnDelayMs: 250,

  // Delay between iterations for each VU (think time)
  thinkTimeMs: 500,

  browser: {
    // 'context' creates 1 lightweight browser process with isolated BrowserContexts (recommended for high scale)
    // 'browser' launches a separate browser process per VU
    isolation: 'context',
    headless: true,
    type: 'chromium',
  },

  // Path to CSV or JSON credentials file
  users: './users.csv',

  // Path to scenario file or scenario object
  scenarios: './scenarios/checkout.perf.ts',

  reporting: {
    outputDir: './perf-results',
    saveScreenshotsOnFailure: true,
  },
});
```

---

## 🏃 Running Tests

### Small Local Test (Single Worker)
```bash
# Run 4 virtual users for 10 seconds and generate report
npx ui-perf run --vus 4 --duration 10s --aggregate
```

### Multi-Pod Cluster (Kubernetes / Argo / Manual)

On Worker Pod 0:
```bash
npx ui-perf run --shard 0/20
```

On Worker Pod 1:
```bash
npx ui-perf run --shard 1/20
```

Once all pods finish, generate the unified multi-pod HTML report:
```bash
npx ui-perf aggregate --dir ./perf-results
```

The resulting interactive dashboard will be located at `./perf-results/report.html`.

---

## ☸️ Distributed Deployment Templates

Ready-to-use manifests are provided in the [`templates/`](./templates/) folder:
- **`templates/kubernetes-indexed-job.yaml`**: Kubernetes Indexed Job manifest configured for 20 pods running 500 users.
- **`templates/argo-workflow.yaml`**: Argo Workflows parallel DAG workflow with automatic multi-pod aggregation step.
- **`templates/Dockerfile`**: Optimized container image pre-configured with Playwright Chromium.

---

## 🧪 Small Load Validation Test

To run the self-contained mock application validation test:

```bash
npm run build
npx tsx examples/small-load/run-test.ts
```

This boots an internal mock portal, executes 2 simulated pods (`shard 0/2` and `shard 1/2`), and aggregates the results into an interactive HTML dashboard.

---

## 📄 License
MIT
