import fs from 'node:fs';
import path from 'node:path';
import type {
  AggregatedReport,
  PodSummary,
  StepAggregate,
  MetricAggregate,
  ErrorEntry,
} from '../types/index.js';
import { computeMetricAggregate } from '../metrics/collector.js';

export class ReportAggregator {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = path.resolve(process.cwd(), outputDir);
  }

  public aggregate(): AggregatedReport {
    if (!fs.existsSync(this.outputDir)) {
      throw new Error(`Output directory does not exist: ${this.outputDir}`);
    }

    const files = fs.readdirSync(this.outputDir);
    const summaryFiles = files.filter(
      (f) => f.startsWith('summary-pod-') && f.endsWith('.json')
    );

    if (summaryFiles.length === 0) {
      throw new Error(`No pod summary files (summary-pod-*.json) found in ${this.outputDir}`);
    }

    const podSummaries: PodSummary[] = summaryFiles.map((file) => {
      const fullPath = path.join(this.outputDir, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      return JSON.parse(content) as PodSummary;
    });

    // Check for NDJSON files to do exact global percentile calculation
    const ndjsonFiles = files.filter(
      (f) => f.startsWith('results-pod-') && f.endsWith('.ndjson')
    );

    const stepRawDurations: Map<string, { durations: number[]; passed: number; failed: number }> = new Map();
    const vitalsRawValues: Map<string, number[]> = new Map();

    if (ndjsonFiles.length > 0) {
      for (const ndjsonFile of ndjsonFiles) {
        const fullPath = path.join(this.outputDir, ndjsonFile);
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const item = JSON.parse(line);
            if (item.steps && Array.isArray(item.steps)) {
              for (const step of item.steps) {
                let entry = stepRawDurations.get(step.name);
                if (!entry) {
                  entry = { durations: [], passed: 0, failed: 0 };
                  stepRawDurations.set(step.name, entry);
                }
                entry.durations.push(step.durationMs);
                if (step.status === 'passed') entry.passed++;
                else entry.failed++;
              }
            }

            if (item.vitals && typeof item.vitals === 'object') {
              for (const [vName, vVal] of Object.entries(item.vitals)) {
                if (typeof vVal === 'number' && !Number.isNaN(vVal)) {
                  let vList = vitalsRawValues.get(vName);
                  if (!vList) {
                    vList = [];
                    vitalsRawValues.set(vName, vList);
                  }
                  vList.push(vVal);
                }
              }
            }
          } catch {
            // Ignore parse errors on truncated lines
          }
        }
      }
    }

    // Overall aggregate computation
    const runId = podSummaries[0]?.runId || `run-${Date.now()}`;
    const totalPods = Math.max(...podSummaries.map((p) => p.totalPods), podSummaries.length);
    const participatingPods = podSummaries.map((p) => p.podIndex).sort((a, b) => a - b);
    const targetTotalVUs = podSummaries[0]?.targetTotalVUs || podSummaries.reduce((acc, p) => acc + p.assignedVUs, 0);

    const startTime = Math.min(...podSummaries.map((p) => p.startTime));
    const endTime = Math.max(...podSummaries.map((p) => p.endTime));
    const durationSeconds = Math.max(1, Math.round((endTime - startTime) / 1000));

    const totalIterations = podSummaries.reduce((acc, p) => acc + p.totalIterations, 0);
    const passedIterations = podSummaries.reduce((acc, p) => acc + p.passedIterations, 0);
    const failedIterations = podSummaries.reduce((acc, p) => acc + p.failedIterations, 0);
    const overallSuccessRate =
      totalIterations > 0 ? Number(((passedIterations / totalIterations) * 100).toFixed(2)) : 100;
    const overallRPS = Number((totalIterations / durationSeconds).toFixed(2));

    // Aggregate Steps
    const steps: Record<string, StepAggregate> = {};
    if (stepRawDurations.size > 0) {
      for (const [name, data] of stepRawDurations.entries()) {
        const metricAgg = computeMetricAggregate(data.durations);
        const totalCount = data.passed + data.failed;
        const errorRate = totalCount > 0 ? Number(((data.failed / totalCount) * 100).toFixed(2)) : 0;
        steps[name] = {
          name,
          passedCount: data.passed,
          failedCount: data.failed,
          errorRate,
          ...metricAgg,
        };
      }
    } else {
      // Fallback from pod summary averages
      const stepNames = new Set<string>();
      podSummaries.forEach((p) => Object.keys(p.steps).forEach((s) => stepNames.add(s)));

      for (const name of stepNames) {
        let totalCount = 0;
        let totalPassed = 0;
        let totalFailed = 0;
        let min = Infinity;
        let max = 0;
        let sumP50 = 0;
        let sumP90 = 0;
        let sumP95 = 0;
        let sumP99 = 0;
        let countPods = 0;

        for (const pod of podSummaries) {
          const s = pod.steps[name];
          if (s) {
            totalCount += s.count;
            totalPassed += s.passedCount;
            totalFailed += s.failedCount;
            min = Math.min(min, s.min);
            max = Math.max(max, s.max);
            sumP50 += s.p50;
            sumP90 += s.p90;
            sumP95 += s.p95;
            sumP99 += s.p99;
            countPods++;
          }
        }

        const errorRate = totalCount > 0 ? Number(((totalFailed / totalCount) * 100).toFixed(2)) : 0;
        steps[name] = {
          name,
          count: totalCount,
          passedCount: totalPassed,
          failedCount: totalFailed,
          errorRate,
          min: min === Infinity ? 0 : min,
          max,
          avg: countPods > 0 ? Math.round(sumP50 / countPods) : 0,
          p50: countPods > 0 ? Math.round(sumP50 / countPods) : 0,
          p90: countPods > 0 ? Math.round(sumP90 / countPods) : 0,
          p95: countPods > 0 ? Math.round(sumP95 / countPods) : 0,
          p99: countPods > 0 ? Math.round(sumP99 / countPods) : 0,
        };
      }
    }

    // Aggregate Vitals
    const vitals: Record<string, MetricAggregate> = {};
    if (vitalsRawValues.size > 0) {
      for (const [name, values] of vitalsRawValues.entries()) {
        vitals[name] = computeMetricAggregate(values);
      }
    } else {
      const vitalsNames = new Set<string>();
      podSummaries.forEach((p) => Object.keys(p.vitals).forEach((v) => vitalsNames.add(v)));
      for (const name of vitalsNames) {
        let totalCount = 0;
        let min = Infinity;
        let max = 0;
        let sumP50 = 0;
        let count = 0;
        for (const pod of podSummaries) {
          const v = pod.vitals[name];
          if (v) {
            totalCount += v.count;
            min = Math.min(min, v.min);
            max = Math.max(max, v.max);
            sumP50 += v.p50;
            count++;
          }
        }
        vitals[name] = {
          count: totalCount,
          min: min === Infinity ? 0 : min,
          max,
          avg: count > 0 ? Math.round(sumP50 / count) : 0,
          p50: count > 0 ? Math.round(sumP50 / count) : 0,
          p90: count > 0 ? Math.round(sumP50 / count) : 0,
          p95: count > 0 ? Math.round(sumP50 / count) : 0,
          p99: count > 0 ? Math.round(sumP50 / count) : 0,
        };
      }
    }

    // Aggregate Errors
    const errorsMap: Map<string, { count: number; step?: string; lastOccurrence: number }> = new Map();
    for (const pod of podSummaries) {
      for (const err of pod.errors) {
        const existing = errorsMap.get(err.message);
        if (existing) {
          existing.count += err.count;
          existing.lastOccurrence = Math.max(existing.lastOccurrence, err.lastOccurrence);
        } else {
          errorsMap.set(err.message, { ...err });
        }
      }
    }
    const errors: ErrorEntry[] = Array.from(errorsMap.entries()).map(([message, d]) => ({
      message,
      count: d.count,
      step: d.step,
      lastOccurrence: d.lastOccurrence,
    }));

    const report: AggregatedReport = {
      runId,
      totalPods,
      participatingPods,
      targetTotalVUs,
      startTime,
      endTime,
      durationSeconds,
      totalIterations,
      passedIterations,
      failedIterations,
      overallSuccessRate,
      overallRPS,
      steps,
      vitals,
      errors,
      podSummaries,
    };

    // Save JSON aggregate
    const jsonPath = path.join(this.outputDir, 'summary-aggregate.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

    // Generate HTML report
    const htmlPath = path.join(this.outputDir, 'report.html');
    fs.writeFileSync(htmlPath, this.generateHtmlReport(report), 'utf-8');

    return report;
  }

  private generateHtmlReport(report: AggregatedReport): string {
    const jsonStr = JSON.stringify(report);
    const stepsList = Object.values(report.steps);
    const vitalsList = Object.entries(report.vitals).map(([name, stat]) => ({ name, ...stat }));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ui-perf Aggregated Report - ${report.runId}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(22, 27, 46, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.25);
      --accent-green: #10b981;
      --accent-red: #ef4444;
      --accent-yellow: #f59e0b;
      --accent-purple: #8b5cf6;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at 50% 0%, #17223b 0%, var(--bg) 65%);
      color: var(--text);
      min-height: 100vh;
      padding: 32px 24px;
      line-height: 1.5;
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 32px;
    }

    .logo-badge {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .badge-icon {
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 22px;
      color: #fff;
      box-shadow: 0 0 20px var(--accent-glow);
    }

    h1 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
    }

    .sub-meta {
      font-size: 13px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }

    .grid-kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }

    .kpi-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 20px;
      position: relative;
      overflow: hidden;
    }

    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
    }

    .kpi-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .kpi-val {
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -1px;
    }

    .kpi-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .section-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 32px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 14px;
    }

    th {
      color: var(--text-muted);
      font-weight: 600;
      padding: 12px 14px;
      border-bottom: 1px solid var(--card-border);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    td {
      padding: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .step-name {
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-weight: 600;
      color: #fff;
    }

    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
    }

    .badge-success { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .badge-danger  { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .badge-info    { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }

    .chart-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 12px;
    }

    .bar-row {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .bar-label {
      width: 180px;
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bar-track {
      flex: 1;
      height: 24px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      overflow: hidden;
      display: flex;
    }

    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #0284c7, #38bdf8);
      border-radius: 6px;
      transition: width 0.5s ease-out;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 8px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 700;
      color: #fff;
    }

    .bar-val {
      width: 80px;
      text-align: right;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      color: var(--text-muted);
    }

    .error-item {
      padding: 12px 16px;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 8px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }

    .error-msg {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #fca5a5;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-badge">
        <div class="badge-icon">⚡</div>
        <div>
          <h1>ui-perf Aggregated Dashboard</h1>
          <div class="sub-meta">Run ID: <strong>${report.runId}</strong> • Multi-Pod Cluster Report</div>
        </div>
      </div>
      <div>
        <span class="badge badge-info">${report.participatingPods.length} / ${report.totalPods} Pods Active</span>
      </div>
    </header>

    <!-- Key Metrics Grid -->
    <div class="grid-kpis">
      <div class="kpi-card">
        <div class="kpi-label">Target Virtual Users</div>
        <div class="kpi-val" style="color: var(--accent);">${report.targetTotalVUs}</div>
        <div class="kpi-sub">${report.participatingPods.length} Pods Participating</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">Total Iterations</div>
        <div class="kpi-val">${report.totalIterations.toLocaleString()}</div>
        <div class="kpi-sub">${report.durationSeconds}s Total Duration</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">Fleet Throughput</div>
        <div class="kpi-val" style="color: var(--accent-purple);">${report.overallRPS} <span style="font-size: 16px; font-weight: 500;">iter/s</span></div>
        <div class="kpi-sub">Aggregated across all pods</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">Success Rate</div>
        <div class="kpi-val" style="color: ${report.overallSuccessRate >= 95 ? 'var(--accent-green)' : report.overallSuccessRate >= 80 ? 'var(--accent-yellow)' : 'var(--accent-red)'};">
          ${report.overallSuccessRate}%
        </div>
        <div class="kpi-sub">${report.passedIterations} pass / ${report.failedIterations} fail</div>
      </div>
    </div>

    <!-- Step Latency Percentiles -->
    <div class="card">
      <div class="section-title">📊 Step Response Times (ms) across Fleet</div>
      <table>
        <thead>
          <tr>
            <th>Step Name</th>
            <th>Count</th>
            <th>Success Rate</th>
            <th>Min</th>
            <th>p50 (Med)</th>
            <th>p90</th>
            <th>p95</th>
            <th>p99</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody>
          ${stepsList
            .map(
              (s) => `<tr>
            <td class="step-name">${s.name}</td>
            <td>${s.count.toLocaleString()}</td>
            <td>
              <span class="badge ${s.errorRate === 0 ? 'badge-success' : s.errorRate < 5 ? 'badge-warning' : 'badge-danger'}">
                ${(100 - s.errorRate).toFixed(1)}%
              </span>
            </td>
            <td>${s.min}ms</td>
            <td><strong>${s.p50}ms</strong></td>
            <td>${s.p90}ms</td>
            <td>${s.p95}ms</td>
            <td><strong style="color: var(--accent-yellow);">${s.p99}ms</strong></td>
            <td>${s.max}ms</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <!-- Latency Distribution Chart -->
    <div class="card">
      <div class="section-title">⚡ Step Latency Comparison (p95)</div>
      <div class="chart-container">
        ${(() => {
          const maxP95 = Math.max(...stepsList.map((s) => s.p95), 100);
          return stepsList
            .map((s) => {
              const pct = Math.max(8, Math.min(100, Math.round((s.p95 / maxP95) * 100)));
              return `<div class="bar-row">
                <div class="bar-label" title="${s.name}">${s.name}</div>
                <div class="bar-track">
                  <div class="bar-fill" style="width: ${pct}%;">p95: ${s.p95}ms</div>
                </div>
                <div class="bar-val">${s.p95} ms</div>
              </div>`;
            })
            .join('');
        })()}
      </div>
    </div>

    <!-- Core Web Vitals -->
    ${
      vitalsList.length > 0
        ? `
    <div class="card">
      <div class="section-title">🌐 Browser Core Web Vitals (Aggregated)</div>
      <table>
        <thead>
          <tr>
            <th>Vital Metric</th>
            <th>Samples</th>
            <th>Avg</th>
            <th>p50</th>
            <th>p90</th>
            <th>p95</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody>
          ${vitalsList
            .map(
              (v) => `<tr>
            <td class="step-name">${v.name.toUpperCase()}</td>
            <td>${v.count}</td>
            <td>${v.avg}ms</td>
            <td><strong>${v.p50}ms</strong></td>
            <td>${v.p90}ms</td>
            <td>${v.p95}ms</td>
            <td>${v.max}ms</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`
        : ''
    }

    <!-- Pod Fleet Breakdown -->
    <div class="card">
      <div class="section-title">📦 Distributed Pod Fleet Status</div>
      <table>
        <thead>
          <tr>
            <th>Pod</th>
            <th>Host / Node</th>
            <th>VUs Assigned</th>
            <th>Iterations</th>
            <th>Success %</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${report.podSummaries
            .map((p) => {
              const passPct = p.totalIterations > 0 ? ((p.passedIterations / p.totalIterations) * 100).toFixed(1) : '100.0';
              return `<tr>
              <td><span class="badge badge-info">Pod ${p.podIndex}</span></td>
              <td>${p.hostInfo?.hostname || 'k8s-worker'} (${p.hostInfo?.cpus || 4} CPUs)</td>
              <td><strong>${p.assignedVUs} VUs</strong></td>
              <td>${p.totalIterations} (✓${p.passedIterations} / ✗${p.failedIterations})</td>
              <td><span class="badge ${Number(passPct) >= 95 ? 'badge-success' : 'badge-warning'}">${passPct}%</span></td>
              <td>${p.durationSeconds}s</td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>

    <!-- Error Log Breakdown -->
    ${
      report.errors.length > 0
        ? `
    <div class="card">
      <div class="section-title" style="color: var(--accent-red);">⚠️ Error Log Breakdown (${report.errors.reduce((a, b) => a + b.count, 0)} Total)</div>
      ${report.errors
        .map(
          (err) => `
        <div class="error-item">
          <div>
            ${err.step ? `<span class="badge badge-warning" style="margin-bottom: 6px;">Step: ${err.step}</span><br>` : ''}
            <div class="error-msg">${err.message}</div>
          </div>
          <div>
            <span class="badge badge-danger">${err.count} occurrences</span>
          </div>
        </div>
      `
        )
        .join('')}
    </div>`
        : ''
    }
  </div>
</body>
</html>`;
  }
}
