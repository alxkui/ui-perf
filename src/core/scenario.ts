import type { ScenarioDefinition, UiPerfConfig } from '../types/index.js';

/**
 * Define a UI Performance Scenario with typed context.
 *
 * @example
 * ```ts
 * export default defineScenario({
 *   name: 'User Checkout Flow',
 *   async run({ page, user, step }) {
 *     await step('Home Page', async () => {
 *       await page.goto('/');
 *     });
 *   }
 * });
 * ```
 */
export function defineScenario(scenario: ScenarioDefinition): ScenarioDefinition {
  return scenario;
}

/**
 * Define UI Performance configuration.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   targetVUs: 50,
 *   duration: '1m',
 *   spawnDelayMs: 200,
 *   scenarios: './scenarios/checkout.ts',
 * });
 * ```
 */
export function defineConfig(config: UiPerfConfig): UiPerfConfig {
  return config;
}
