import { execSync } from 'node:child_process';
import { expect, test, type Browser } from '@playwright/test';

// Restarts the API container mid-session. Opt-in because it needs the docker
// stack:  E2E_DOCKER_RESTART=1 E2E_BASE_URL=http://localhost:8080 npx playwright test restart
test.skip(!process.env.E2E_DOCKER_RESTART, 'set E2E_DOCKER_RESTART=1 to run against the docker stack');

const phone = () => `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
async function signup(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const number = phone();
  await page.goto('/register');
  await page.getByLabel('Phone number').fill(number);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByRole('button', { name: 'Fill' }).click();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('link', { name: 'Chats' })).toBeVisible();
  return { page, number };
}

test('clients survive an API server restart', async ({ browser }) => {
  const a = await signup(browser, 'Restart A');
  const b = await signup(browser, 'Restart B');
  await a.page.getByRole('button', { name: 'New chat' }).click();
  await a.page.getByPlaceholder('+14155550123').fill(b.number);
  await a.page.getByRole('button', { name: 'Message', exact: true }).click();
  const box = a.page.getByLabel('Message', { exact: true });
  await box.fill('before restart');
  await box.press('Enter');
  await expect(b.page.locator('.list-item', { hasText: 'Restart A' })).toContainText('before restart');

  execSync('docker compose restart server', { cwd: '..', stdio: 'inherit' });
  // Messages typed while the server is down wait in the outbox...
  await box.fill('during restart');
  await box.press('Enter');
  // ...and both clients reconnect by themselves (backoff) and converge.
  await expect(a.page.locator('.conn-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect(b.page.locator('.conn-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect(b.page.locator('.list-item', { hasText: 'Restart A' })).toContainText('during restart', { timeout: 30_000 });
  await expect(a.page.locator('.bubble', { hasText: 'during restart' }).locator('svg title')).toHaveText(/Delivered|Read/);
});
