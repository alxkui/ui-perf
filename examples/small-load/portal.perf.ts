import { defineScenario } from '../../src/index.js';

export default defineScenario({
  name: 'Enterprise Portal User Transaction Flow',
  // Setup runs ONCE per virtual user (User logs in and lands on the dashboard)
  async setup({ page, user, step }) {
    await step('01_Load_Login_Page', async () => {
      await page.goto('http://localhost:3888/login');
      await page.waitForSelector('#login-form');
    });

    await step('02_Authenticate_User', async () => {
      await page.fill('#username', user.username);
      await page.fill('#password', user.password);
      await page.click('#login-btn');
      await page.waitForSelector('#welcome');
    });
  },

  // Run is repeated continuously for the entire test duration (hammering transactions)
  async run({ page, user, step, iteration }) {
    await step('03_Process_Transaction', async () => {
      // 1. Click the order button
      await page.click('#checkout-btn:not(:disabled)');

      // 2. Wait for the confirmation banner corresponding to this order iteration
      await page.waitForSelector(`#order-confirmation[data-order-seq="${iteration}"]`);
    });
  },
});
