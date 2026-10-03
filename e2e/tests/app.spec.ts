import { expect, test, type Browser, type Page } from '@playwright/test';

const phone = () => `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

async function signup(browser: Browser, name: string) {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('parley.debug', '1'));
  const page = await context.newPage();
  const number = phone();
  await page.goto('/register');
  await page.getByLabel('Phone number').fill(number);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  // Dev mock OTP provider exposes the code; the page offers to fill it.
  await page.getByRole('button', { name: 'Fill' }).click();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('link', { name: 'Chats' })).toBeVisible();
  await expect(page.locator('.conn-banner')).toHaveCount(0); // realtime connected
  return { page, context, number, name };
}

async function openChatByPhone(page: Page, number: string) {
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByPlaceholder('+14155550123').fill(number);
  await page.getByRole('button', { name: 'Save contact & message' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByLabel('Message', { exact: true }).press('Enter');
}

test('chat, receipts, typing, presence, offline sync, voice call, status', async ({ browser }) => {
  const alice = await signup(browser, 'Alice E2E');
  const bob = await signup(browser, 'Bob E2E');

  // --- 1:1 chat ---
  await openChatByPhone(alice.page, bob.number);
  await send(alice.page, 'Hello Bob 👋');
  const aliceBubble = alice.page.locator('.bubble', { hasText: 'Hello Bob 👋' });
  await expect(aliceBubble).toBeVisible();

  // Bob gets it live in his chat list with an unread badge.
  const bobRow = bob.page.locator('.list-item', { hasText: 'Alice E2E' });
  await expect(bobRow).toContainText('Hello Bob 👋');
  await expect(bobRow.locator('.badge')).toHaveText('1');
  // Bob's client acked delivery -> Alice sees double ticks.
  await expect(aliceBubble.locator('svg title')).toHaveText('Delivered');

  // Bob opens the chat -> READ.
  await bobRow.click();
  await expect(bob.page.locator('.bubble', { hasText: 'Hello Bob 👋' })).toBeVisible();
  await expect(aliceBubble.locator('svg title')).toHaveText('Read');

  // Presence + typing.
  await expect(alice.page.locator('.chat-header .sub')).toHaveText('online');
  await bob.page.getByLabel('Message', { exact: true }).pressSequentially('typing something', { delay: 30 });
  await expect(alice.page.locator('.chat-header .sub')).toHaveText('typing…');
  await bob.page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(alice.page.locator('.bubble', { hasText: 'typing something' })).toBeVisible();

  // Reply.
  await bob.page.locator('.bubble', { hasText: 'Hello Bob 👋' }).hover();
  await bob.page.locator('.bubble', { hasText: 'Hello Bob 👋' }).getByLabel('Reply').click();
  await send(bob.page, 'replying!');
  await expect(alice.page.locator('.bubble', { hasText: 'replying!' }).locator('.quote')).toContainText('Hello Bob');

  // --- offline recipient + reconnection ---
  await bob.context.setOffline(true);
  await expect(bob.page.locator('.conn-banner')).toBeVisible({ timeout: 30_000 });
  await send(alice.page, 'sent while you were offline');
  // Bob's own send while offline waits in the outbox (clock icon).
  await send(bob.page, 'queued offline');
  await expect(bob.page.locator('.bubble', { hasText: 'queued offline' }).locator('svg title')).toHaveText('Sending');
  await bob.context.setOffline(false);
  await expect(bob.page.locator('.conn-banner')).toHaveCount(0, { timeout: 30_000 });
  await expect(bob.page.locator('.bubble', { hasText: 'sent while you were offline' })).toBeVisible();
  await expect(alice.page.locator('.bubble', { hasText: 'queued offline' })).toBeVisible();
  await expect(bob.page.locator('.bubble', { hasText: 'queued offline' })).toHaveCount(1); // no duplicate

  // Page refresh keeps history (server is the source of truth).
  await bob.page.reload();
  await expect(bob.page.locator('.bubble', { hasText: 'sent while you were offline' })).toBeVisible();

  // --- voice call over WebRTC ---
  await alice.page.getByRole('button', { name: 'Voice call' }).click();
  await expect(bob.page.getByRole('dialog', { name: 'Call' })).toContainText('Incoming voice call');
  await bob.page.getByRole('button', { name: 'Accept' }).click();
  // Both sides show a running timer once ICE connects.
  try {
    await expect(alice.page.locator('.call-overlay .state')).toHaveText(/^\d\d:\d\d$/, { timeout: 30_000 });
  } catch (err) {
    console.log('A diag', JSON.stringify(await alice.page.evaluate(() => (window as any).__parleyCall.diag())));
    console.log('B diag', JSON.stringify(await bob.page.evaluate(() => (window as any).__parleyCall.diag())));
    throw err;
  }
  await expect(bob.page.locator('.call-overlay .state')).toHaveText(/^\d\d:\d\d$/, { timeout: 30_000 });
  // Real audio packets flow in both directions.
  await alice.page.waitForTimeout(2000);
  const aStats = await alice.page.evaluate(() => (window as any).__parleyCall.stats());
  const bStats = await bob.page.evaluate(() => (window as any).__parleyCall.stats());
  console.log('alice call stats', aStats, 'bob call stats', bStats);
  expect(aStats.inboundBytes).toBeGreaterThan(1000);
  expect(aStats.outboundBytes).toBeGreaterThan(1000);
  expect(bStats.inboundBytes).toBeGreaterThan(1000);
  // Mute toggles.
  await alice.page.getByRole('button', { name: 'Mute' }).click();
  await expect(alice.page.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await alice.page.getByRole('button', { name: 'End call' }).click();
  await expect(bob.page.locator('.call-overlay .state')).toHaveText('Call ended');
  await expect(bob.page.getByRole('dialog', { name: 'Call' })).toHaveCount(0, { timeout: 10_000 });

  // Rejected call.
  await alice.page.getByRole('button', { name: 'Voice call' }).click();
  await bob.page.getByRole('button', { name: 'Decline' }).click();
  await expect(alice.page.locator('.call-overlay .state')).toHaveText('Call declined');

  // Call history.
  await bob.page.getByRole('link', { name: 'Calls' }).click();
  await expect(bob.page.locator('.list-item', { hasText: 'Alice E2E' }).first()).toBeVisible();

  // --- status ---
  // Bob saved nobody; Alice saved Bob. Default status privacy is "my contacts",
  // so Alice's status is visible to Bob.
  await alice.page.goto('/status/new');
  await alice.page.getByPlaceholder('Type a status').fill('Hello from my status');
  await alice.page.getByRole('button', { name: 'Post status' }).click();
  await expect(alice.page.getByText('My status')).toBeVisible();

  await bob.page.getByRole('link', { name: 'Status' }).click();
  await expect(bob.page).toHaveURL(/\/status$/);
  await expect(bob.page.locator('.section-label', { hasText: 'Recent updates' })).toBeVisible();
  await bob.page.locator('.list-item', { hasText: 'Alice E2E' }).click();
  await expect(bob.page.locator('.status-text')).toHaveText('Hello from my status');
  await bob.page.getByPlaceholder('Reply…').fill('Nice status');
  await bob.page.getByPlaceholder('Reply…').press('Enter');
  await bob.page.getByRole('button', { name: 'Close' }).click();

  await alice.page.locator('.list-item', { hasText: 'My status' }).click();
  await expect(alice.page.getByRole('button', { name: /1 views/ })).toBeVisible();
  await alice.page.getByRole('button', { name: /1 views/ }).click();
  await expect(alice.page.locator('.viewers-sheet')).toContainText('Bob E2E');

  await alice.context.close();
  await bob.context.close();
});
