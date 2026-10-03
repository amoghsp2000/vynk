import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const phone = () => `+1555${Math.floor(1e6 + Math.random() * 8e6)}`;
async function signup(name) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 760 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const number = phone();
  await page.goto('http://localhost:5173/register');
  await page.getByLabel('Phone number').fill(number);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByRole('button', { name: 'Fill' }).click();
  await page.screenshot({ path: 'screenshots/otp.png' });
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('link', { name: 'Chats' }).waitFor();
  return { page, number };
}
const a = await signup('Maya Chen'), c = await signup('Jon Park');
await a.page.getByRole('button', { name: 'New chat' }).click();
await a.page.getByPlaceholder('+14155550123').fill(c.number);
await a.page.getByRole('button', { name: 'Save contact & message' }).click();
for (const t of ['Hey Jon! Are we still on for lunch tomorrow? 🍕', 'I can book the place near the office']) {
  await a.page.getByLabel('Message', { exact: true }).fill(t); await a.page.keyboard.press('Enter');
}
await c.page.locator('.list-item', { hasText: 'Maya' }).click();
await c.page.getByLabel('Message', { exact: true }).fill('Yes! 12:30 works 👍'); await c.page.keyboard.press('Enter');
await c.page.getByLabel('Message', { exact: true }).pressSequentially('see you th', { delay: 20 });
await a.page.waitForTimeout(800);
await a.page.screenshot({ path: 'screenshots/chat.png' });
await a.page.getByRole('button', { name: 'Voice call' }).click();
await c.page.getByRole('button', { name: 'Accept' }).waitFor();
await c.page.screenshot({ path: 'screenshots/incoming.png' });
await c.page.getByRole('button', { name: 'Accept' }).click();
await a.page.waitForTimeout(3000);
await a.page.screenshot({ path: 'screenshots/active-call.png' });
await b.close();
