import os from 'node:os';
import type {
  IterationResult,
  PodSummary,
  StepAggregate,
  MetricAggregate,
  ErrorEntry,
  StepMetric,
  WebVitals,
} from '../types/index.js';

export function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return Math.round(sortedValues[0]);

  const index = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  const interpolated = sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  return Math.round(interpolated);
}

export function computeMetricAggregate(values: number[]): MetricAggregate {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avg = Math.round(sum / sorted.length);

  return {
    count: sorted.length,
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    avg,
    p50: calculatePercentile(sorted, 50),
    p90: calculatePercentile(sorted, 90),
    p95: calculatePercentile(sorted, 95),
    p99: calculatePercentile(sorted, 99),
  };
}

export class MetricsCollector {
  private runId: string;
  private podIndex: number;
  private totalPods: number;
  private assignedVUs: number;
  private targetTotalVUs: number;
  private startTime: number = 0;
  private endTime: number = 0;

  private iterations: IterationResult[] = [];
  private stepDurations: Map<string, { durations: number[]; passed: number; failed: number }> = new Map();
  private errorsMap: Map<string, { count: number; step?: string; lastOccurrence: number }> = new Map();
  private vitalsMap: Map<keyof WebVitals, number[]> = new Map();

  constructor(options: {
    runId: string;
    podIndex: number;
    totalPods: number;
    assignedVUs: number;
    targetTotalVUs: number;
  }) {
    this.runId = options.runId;
    this.podIndex = options.podIndex;
    this.totalPods = options.totalPods;
    this.assignedVUs = options.assignedVUs;
    this.targetTotalVUs = options.targetTotalVUs;
  }

  public start(): void {
    this.startTime = Date.now();
  }

  public recordIteration(result: IterationResult): void {
    this.iterations.push(result);

    // Record steps
    for (const step of result.steps) {
      let entry = this.stepDurations.get(step.name);
      if (!entry) {
        entry = { durations: [], passed: 0, failed: 0 };
        this.stepDurations.set(step.name, entry);
      }

      entry.durations.push(step.durationMs);
      if (step.status === 'passed') {
        entry.passed += 1;
      } else {
        entry.failed += 1;
        this.recordError(step.error || 'Step failed without message', step.name);
      }
    }

    // Record Web Vitals
    if (result.vitals) {
      for (const [key, val] of Object.entries(result.vitals) as [keyof WebVitals, number | undefined][]) {
        if (typeof val === 'number' && !Number.isNaN(val)) {
          let list = this.vitalsMap.get(key);
          if (!list) {
            list = [];
            this.vitalsMap.set(key, list);
          }
          list.push(val);
        }
      }
    }

    if (result.status === 'failed' && result.error) {
      this.recordError(result.error);
    }
  }

  public recordError(message: string, step?: string): void {
    const key = `${step ? `[${step}] ` : ''}${message}`;
    const existing = this.errorsMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastOccurrence = Date.now();
    } else {
      this.errorsMap.set(key, {
        count: 1,
        step,
        lastOccurrence: Date.now(),
      });
    }
  }

  public getSummary(): PodSummary {
    const endTime = this.endTime || Date.now();
    const durationSeconds = Math.max(1, Math.round((endTime - this.startTime) / 1000));

    const totalIterations = this.iterations.length;
    const passedIterations = this.iterations.filter((it) => it.status === 'passed').length;
    const failedIterations = totalIterations - passedIterations;

    // Step Aggregates
    const steps: Record<string, StepAggregate> = {};
    for (const [name, data] of this.stepDurations.entries()) {
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

    // Vitals Aggregates
    const vitals: Record<string, MetricAggregate> = {};
    for (const [key, values] of this.vitalsMap.entries()) {
      vitals[key] = computeMetricAggregate(values);
    }

    // Errors
    const errors: ErrorEntry[] = Array.from(this.errorsMap.entries()).map(([message, err]) => ({
      message,
      count: err.count,
      step: err.step,
      lastOccurrence: err.lastOccurrence,
    }));

    return {
      runId: this.runId,
      podIndex: this.podIndex,
      totalPods: this.totalPods,
      assignedVUs: this.assignedVUs,
      targetTotalVUs: this.targetTotalVUs,
      startTime: this.startTime,
      endTime,
      durationSeconds,
      totalIterations,
      passedIterations,
      failedIterations,
      steps,
      vitals,
      errors,
      hostInfo: {
        hostname: os.hostname(),
        platform: os.platform(),
        cpus: os.cpus().length,
      },
    };
  }

  public finish(): PodSummary {
    this.endTime = Date.now();
    return this.getSummary();
  }

  public getIterationResults(): IterationResult[] {
    return this.iterations;
  }
}
