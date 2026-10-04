import type { Page } from 'playwright';
import type { WebVitals } from '../types/index.js';

/**
 * Extracts Core Web Vitals and Navigation timing metrics from a Playwright page.
 */
export async function collectWebVitals(page: Page): Promise<WebVitals> {
  try {
    const vitals = await page.evaluate(() => {
      const result: {
        ttfb?: number;
        fcp?: number;
        lcp?: number;
        cls?: number;
        domContentLoaded?: number;
      } = {};

      // 1. Navigation Timing (TTFB, DOMContentLoaded)
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (navEntries && navEntries.length > 0) {
        const nav = navEntries[0];
        if (nav.responseStart > 0) {
          result.ttfb = Math.round(nav.responseStart - nav.requestStart);
        }
        if (nav.domContentLoadedEventEnd > 0) {
          result.domContentLoaded = Math.round(nav.domContentLoadedEventEnd - nav.startTime);
        }
      }

      // 2. First Contentful Paint (FCP)
      const paintEntries = performance.getEntriesByType('paint');
      for (const entry of paintEntries) {
        if (entry.name === 'first-contentful-paint') {
          result.fcp = Math.round(entry.startTime);
          break;
        }
      }

      // 3. Largest Contentful Paint (LCP) from PerformanceObserver buffer if available
      try {
        const lcpEntries = (performance as any).getEntriesByType ? (performance as any).getEntriesByType('largest-contentful-paint') : [];
        if (lcpEntries && lcpEntries.length > 0) {
          const lastLcp = lcpEntries[lcpEntries.length - 1];
          result.lcp = Math.round(lastLcp.startTime);
        }
      } catch {
        // Safe ignore
      }

      return result;
    });

    return vitals;
  } catch {
    // If page is closing or navigated away, return empty vitals
    return {};
  }
}
