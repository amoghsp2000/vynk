import { expect, test, type Browser } from '@playwright/test';

const phone = () => `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

async function signup(browser: Browser, name: string) {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('parley.debug', '1'));
  // Relay-only ICE: no direct path allowed, audio must traverse coturn.
  await context.addInitScript(() => {
    localStorage.setItem('parley.forceRelay', '1');
    localStorage.setItem('parley.debug', '1');
  });
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
  await expect(page.locator('.conn-banner')).toHaveCount(0);
  return { page, context, number };
}

test('voice call works through the TURN relay (NAT/firewall fallback)', async ({ browser }) => {
  const a = await signup(browser, 'Relay Caller');
  const b = await signup(browser, 'Relay Callee');
  await a.page.getByRole('button', { name: 'New chat' }).click();
  await a.page.getByPlaceholder('+14155550123').fill(b.number);
  await a.page.getByRole('button', { name: 'Message', exact: true }).click();
  await a.page.getByRole('button', { name: 'Voice call' }).click();
  await b.page.getByRole('button', { name: 'Accept' }).click();
  await expect(a.page.locator('.call-overlay .state')).toHaveText(/^\d\d:\d\d$/, { timeout: 30_000 });
  await a.page.waitForTimeout(2000);
  const stats = await a.page.evaluate(() => (window as any).__parleyCall.stats());
  console.log('relay call stats', stats);
  expect(stats.candidateType).toBe('relay');
  expect(stats.inboundBytes).toBeGreaterThan(1000);
  expect(stats.outboundBytes).toBeGreaterThan(1000);
  await a.page.getByRole('button', { name: 'End call' }).click();
  await expect(b.page.locator('.call-overlay .state')).toHaveText('Call ended');
  await a.context.close();
  await b.context.close();
});
