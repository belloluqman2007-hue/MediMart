import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const owner = {
  fullName: 'Browser Test Owner',
  email: 'browser-owner@example.test',
  password: 'A unique browser-test passphrase',
};
const staff = {
  fullName: 'Browser Test Cashier',
  email: 'browser-cashier@example.test',
  password: 'A unique cashier-test passphrase',
};
async function signIn(page: Page, account = owner) {
  await page.goto('/#/login');
  await page.getByLabel('Email address', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in to MediMart' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
test('controlled first-owner setup works from the UI', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('Full name', { exact: true }).fill(owner.fullName);
  await page.getByLabel('Email address', { exact: true }).fill(owner.email);
  await page.getByLabel('Password', { exact: true }).fill(owner.password);
  await page.getByLabel('Server setup token').fill('e2e-only-not-a-real-credential-00000000000000');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByText('Your account is ready', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Your account is ready', { exact: true })).toBeVisible();
});
test('dashboard is honest, responsive, and has all 20 navigation entries', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-nav a')).toHaveCount(20);
  await expect(page.getByText('Not available yet', { exact: true })).toHaveCount(4);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});
test('module search, placeholders, and keyboard dialog controls work', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search modules' }).fill('prescriptions');
  await page.getByRole('dialog').getByRole('button', { name: 'Prescriptions Healthcare' }).click();
  await expect(page.getByRole('heading', { name: 'Prescriptions', exact: true })).toBeVisible();
  await expect(page.getByText('No demo transactions', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
test('mobile navigation opens, traps focus, and closes after selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Inventory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});
test('invalid credentials show a safe inline error, then a valid login succeeds', async ({
  page,
}) => {
  await page.goto('/#/login');
  await page.getByLabel('Email address', { exact: true }).fill(owner.email);
  await page.getByLabel('Password', { exact: true }).fill('wrong password');
  await page.getByRole('button', { name: 'Sign in to MediMart' }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to sign in');
  await page.getByLabel('Password', { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'Sign in to MediMart' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
});
test('settings persist and an owner can create a limited staff account', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/settings');
  await page.getByLabel('Business name', { exact: true }).fill('MediMart browser test');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Business name saved');
  await page.reload();
  await expect(page.getByLabel('Business name', { exact: true })).toHaveValue(
    'MediMart browser test',
  );
  await page.getByRole('tab', { name: 'Staff access', exact: true }).click();
  await page.getByLabel('Full name', { exact: true }).fill(staff.fullName);
  await page.getByLabel('Email address', { exact: true }).fill(staff.email);
  await page.getByLabel('Role', { exact: true }).selectOption('cashier');
  await page.getByLabel('Initial password', { exact: true }).fill(staff.password);
  await page.getByRole('button', { name: 'Create staff account' }).click();
  await expect(page.getByRole('status')).toContainText('Individual staff account created');
});
test('a cashier sees an explicit permission boundary, not protected module content', async ({
  page,
}) => {
  await signIn(page, staff);
  await page.goto('/#/patients');
  await expect(
    page.getByRole('heading', { name: 'This space needs a different permission' }),
  ).toBeVisible();
  const response = await page.request.get('/api/audit-logs');
  expect(response.status()).toBe(403);
  await page.goto('/#/settings?tab=team');
  await expect(page.getByText('This setting needs additional access')).toBeVisible();
});
test('an owner can verify and revoke an Android installation from settings', async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID();
  const secret = 'a'.repeat(64);
  const registration = await request.post('/api/devices/register', {
    data: { id, secret, name: 'Browser-tested phone', platform: 'android' },
  });
  expect(registration.status()).toBe(201);
  const { pairingCode } = (await registration.json()) as { pairingCode: string };
  await signIn(page);
  await page.goto('/#/settings?tab=devices');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByLabel('Eight-digit pairing code').fill(pairingCode);
  await page.getByRole('button', { name: 'Approve device', exact: true }).click();
  await expect(page.getByText('approved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
  await expect(page.getByText('revoked', { exact: true })).toBeVisible();
});
test('public shell reopens offline without caching API responses or granting a session', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByText('Central server offline', { exact: true })).toBeVisible();
  const privateEntries = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
    return requests
      .flat()
      .map((entry) => entry.url)
      .filter((url) => new URL(url).pathname.startsWith('/api/'));
  });
  expect(privateEntries).toEqual([]);
  await page.goto('/#/settings');
  await expect(page.getByText('Make this workspace yours', { exact: true })).toBeVisible();
});
for (const [name, path] of [
  ['dashboard', '/'],
  ['login', '/#/login'],
  ['settings', '/#/settings'],
] as const) {
  test(`${name} has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })),
    ).toEqual([]);
  });
}
test('individual password changes sign out the owner and accept the new credential', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/#/settings');
  await page.getByText('Change your password', { exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(owner.password);
  const newPassword = 'A fresh browser-only owner passphrase';
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Change password & sign out', exact: true }).click();
  await expect(page.getByText('Make this workspace yours', { exact: true })).toBeVisible();
  await signIn(page, { ...owner, password: newPassword });
  await expect(page.getByText('Your account is ready', { exact: true })).toBeVisible();
});
test('skip navigation and settings tabs work with a keyboard without changing the wrong route', async ({
  page,
}) => {
  await page.goto('/');
  const before = page.url();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(page.url()).toBe(before);
  await expect(page.locator('#main-content')).toBeFocused();
  await page.goto('/#/settings');
  await page.getByRole('tab', { name: 'General', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Connection & storage', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Central server', exact: true })).toBeVisible();
});
