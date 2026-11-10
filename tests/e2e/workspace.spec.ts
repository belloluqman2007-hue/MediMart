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
test('dashboard is honest, responsive, and has all 22 navigation entries', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-nav a')).toHaveCount(22);
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
  await expect(
    page.getByRole('heading', { name: 'Sign in to open this workspace', exact: true }),
  ).toBeVisible();
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
test('an owner can add a product, receive a batch, and audit it in the stock ledger', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/#/inventory/products');
  await page.getByRole('link', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Product name', { exact: true }).fill('Browser Test Paracetamol');
  await page.getByLabel('Generic name').fill('Paracetamol');
  await page.getByLabel('Barcode').fill('BR-E2E-0001');
  await page.getByRole('combobox', { name: /Base unit/ }).selectOption({ label: 'Tablet (tab)' });
  await page.getByLabel('Purchase cost (₦)').fill('50.00');
  await page.getByLabel('Selling price (₦)').fill('100.00');
  await page.getByLabel('Reorder level').fill('5');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Browser Test Paracetamol', exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Receive stock', exact: true }).last().click();
  await page.getByLabel('Quantity received').fill('10');
  await page.getByLabel('Cost per unit (₦)').fill('50.00');
  await page.getByLabel('Batch number').fill('E2E-BATCH-1');
  const expiry = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Expiry date').fill(expiry);
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(page.getByRole('heading', { name: 'Stock received', exact: true })).toBeVisible();
  await expect(page.getByText('now holds')).toContainText('10 tab');

  await page.goto('/#/inventory/movements');
  const movementRow = page.locator('table').getByRole('row').filter({ hasText: 'Browser Test' });
  await expect(movementRow.first()).toContainText('E2E-BATCH-1');
  await expect(movementRow.first()).toContainText('Stock received');

  await page.goto('/#/inventory/batches');
  await expect(page.locator('table').getByText('E2E-BATCH-1').first()).toBeVisible();

  await page.goto('/#/inventory/categories');
  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  await page.getByLabel('Category name').fill('E2E Test Category');
  await page.getByRole('button', { name: 'Create category' }).click();
  await expect(page.getByText('E2E Test Category').first()).toBeVisible();

  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/inventory/products');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
test('a cashier cannot reach inventory records through the UI or the API', async ({ page }) => {
  await signIn(page, staff);
  await page.goto('/#/inventory');
  await expect(
    page.getByRole('heading', { name: 'This space needs a different permission', exact: true }),
  ).toBeVisible();
  expect((await page.request.get('/api/products')).status()).toBe(403);
  expect((await page.request.get('/api/inventory/dashboard')).status()).toBe(403);
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

const postChangeOwner = {
  ...owner,
  password: 'A fresh browser-only owner passphrase',
};

test('cashier can scan a barcode at POS, complete a cash sale with change, view receipts, and hits RBAC boundaries on debts and reports', async ({
  page,
}) => {
  await signIn(page, staff);
  await page.goto('/#/pos');
  await expect(page.getByRole('heading', { name: 'Checkout terminal', exact: true })).toBeVisible();

  // Scan the medicine barcode created in inventory e2e test
  await page.getByLabel('Scan barcode or SKU', { exact: true }).fill('BR-E2E-0001');
  await page.getByRole('button', { name: 'Scan / Add', exact: true }).click();
  await page
    .getByRole('button', { name: 'Increase quantity of Browser Test Paracetamol', exact: true })
    .click();

  // 2 tablets @ ₦100.00 = ₦200.00; tender ₦500.00 cash => ₦300.00 change due
  await page.getByLabel('Cash tendered (₦)', { exact: true }).fill('500.00');
  await expect(page.getByText('Change due to customer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Complete sale/ }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('MM-');
  await expect(dialog).toContainText('300.00');
  await dialog.getByRole('link', { name: 'Open receipt page', exact: true }).click();

  await expect(page.getByText('OFFICIAL SALES RECEIPT')).toBeVisible();
  await page.getByRole('button', { name: 'Ordinary paper (A4)' }).click();
  await expect(page.locator('.receipt-standard')).toBeVisible();

  // Cashier cannot access Debts or Financial Reports
  await page.goto('/#/debts');
  await expect(
    page.getByRole('heading', { name: 'This space needs a different permission', exact: true }),
  ).toBeVisible();
  await page.goto('/#/reports');
  await expect(
    page.getByRole('heading', { name: 'This space needs a different permission', exact: true }),
  ).toBeVisible();
});

test('owner records a part-paid credit sale, settles customer debt, refunds an item, and verifies separated financial reports & WCAG A/AA', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page, postChangeOwner);

  // Register customer and run part-payment credit sale on POS
  await page.goto('/#/pos');
  await page.getByRole('button', { name: 'New customer', exact: true }).click();
  const custModal = page.getByRole('dialog', { name: 'Register customer' });
  await custModal.getByLabel('Customer full name', { exact: true }).fill('Bolanle Adeyemi');
  await custModal.getByLabel('Customer phone', { exact: true }).fill('08023456789');
  await custModal.getByLabel('Credit limit (₦)', { exact: true }).fill('5000.00');
  await custModal.getByRole('button', { name: 'Save & select customer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Customer Bolanle Adeyemi registered');

  await page.getByLabel('Scan barcode or SKU', { exact: true }).fill('BR-E2E-0001');
  await page.getByRole('button', { name: 'Scan / Add', exact: true }).click();
  await page
    .getByRole('button', { name: 'Increase quantity of Browser Test Paracetamol', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Increase quantity of Browser Test Paracetamol', exact: true })
    .click();

  // 3 tablets = ₦300.00; pay ₦100.00 cash => ₦200.00 credit balance
  await page.getByLabel('Cash tendered (₦)', { exact: true }).fill('100.00');
  await expect(page.getByText('Outstanding credit balance', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Complete sale/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Next customer', exact: true })
    .click();

  // Settle the ₦200.00 debt on /#/debts
  await page.goto('/#/debts');
  await expect(page.locator('table').getByText('Bolanle Adeyemi').first()).toBeVisible();
  await page.getByRole('button', { name: 'Settle', exact: true }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save repayment', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('repayment against');

  // Refund 1 tablet from Sales History -> Sale Detail
  await page.goto('/#/pos/sales');
  await page.locator('table tbody tr').first().locator('a.row-link').first().click();
  await page.getByRole('button', { name: 'Process refund', exact: true }).click();
  const refundDialog = page.getByRole('dialog');
  await refundDialog
    .getByLabel('Refund quantity for Browser Test Paracetamol', { exact: true })
    .fill('1');
  await refundDialog
    .getByLabel('Refund reason', { exact: true })
    .fill('Customer returned 1 unopened tablet');
  await refundDialog.getByRole('button', { name: 'Record refund', exact: true }).click();
  await expect(page.getByText('Partially refunded').first()).toBeVisible();

  // Verify separated financial pillars on /#/reports
  await page.goto('/#/reports');
  await expect(page.getByText('1 · Sales Revenue')).toBeVisible();
  await expect(page.getByText('2 · Money Actually Received')).toBeVisible();
  await expect(page.getByText('3 · Outstanding Credit & Debts')).toBeVisible();
  await expect(page.getByText('4 · Cost of Goods Sold (COGS)')).toBeVisible();
  await expect(page.getByText('5 · Gross Profit')).toBeVisible();
  await expect(page.getByText('6 · Operating Expenses')).toBeVisible();

  // Automated WCAG A/AA check across Phase 3 workspaces
  for (const route of ['/#/pos', '/#/pos/sales', '/#/customers', '/#/debts', '/#/reports']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      axe.violations.map(({ id, nodes }) => ({
        route,
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })),
    ).toEqual([]);
  }
});

test('owner opens the Phase 5 purchasing and finance workspaces without runtime errors', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await signIn(page, postChangeOwner);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const routes = [
    ['/#/purchases', 'Purchase orders'],
    ['/#/expenses', 'Operating expenses'],
    ['/#/cash-register', 'Cash register'],
    ['/#/reports/financial', 'Financial reports'],
  ] as const;
  for (const [route, heading] of routes) {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  expect(errors).toEqual([]);
});

test('Phase 4 synthetic patient journey, prescribing and FEFO dispensing', async ({ page }) => {
  test.setTimeout(90_000);
  const bootstrap = await (await page.request.get('/api/auth/bootstrap-status')).json();
  if (bootstrap.required) {
    const registration = await page.request.post('/api/auth/register-owner', {
      data: {
        ...owner,
        password: 'A fresh browser-only owner passphrase',
        bootstrapToken: 'e2e-only-not-a-real-credential-00000000000000',
      },
    });
    expect(registration.status()).toBe(201);
    const registered = await registration.json();
    await page.request.post('/api/auth/logout', {
      headers: { 'X-CSRF-Token': registered.csrfToken },
      data: {},
    });
  }
  await signIn(page, { ...owner, password: 'A fresh browser-only owner passphrase' });
  const session = await (await page.request.get('/api/auth/session')).json();
  const post = (url: string, data: object) =>
    page.request.post(url, { headers: { 'X-CSRF-Token': session.csrfToken }, data });
  const clinical = {
    fullName: 'Synthetic Clinical Professional',
    email: 'clinical@synthetic.test',
    password: 'Synthetic clinical passphrase 2026!',
  };
  const created = await post('/api/staff', {
    ...clinical,
    roles: ['healthcare_professional', 'pharmacist'],
  });
  expect(created.status()).toBe(201);
  const units = await (await page.request.get('/api/units')).json();
  const unit =
    units.units?.find((u: { code: string }) => u.code === 'tablet') ??
    units.find?.((u: { code: string }) => u.code === 'tablet');
  expect(unit).toBeTruthy();
  const product = await post('/api/products', {
    name: 'Synthetic Clinical Medicine',
    sku: 'SYNTH-E2E-MED',
    productType: 'medicine',
    purchaseCostKobo: 100,
    sellingPriceKobo: 200,
    reorderLevel: 0,
    baseUnitId: unit.id,
    isExpiryTracked: true,
    status: 'active',
    units: [],
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).id;
  expect(
    (
      await post('/api/stock/receive', {
        operationId: crypto.randomUUID(),
        productId,
        unitId: unit.id,
        quantity: 20,
        unitCostKobo: 100,
        batchNumber: 'SYNTH-BATCH',
        expiryDate: '2030-12-31',
        reason: 'Synthetic browser test',
      })
    ).status(),
  ).toBe(201);
  await post('/api/auth/logout', {});
  await page.reload();
  await signIn(page, clinical);
  await page.goto('/#/patients/new');
  await page.getByLabel('Full name', { exact: true }).fill('Synthetic Patient Browser');
  await page.getByLabel('Date of birth', { exact: true }).fill('1990-01-01');
  await page.getByLabel('Phone number', { exact: true }).fill('0005550123');
  await page
    .getByLabel('Known allergies (record unknown or none known explicitly)')
    .fill('Synthetic allergy — review required');
  await page.screenshot({ path: 'docs/screenshots/phase4-registration.png', fullPage: true });
  await page.getByRole('button', { name: 'Save patient', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic Patient Browser', exact: true }),
  ).toBeVisible();
  const patientId = page.url().split('/patients/')[1]!;
  await page.getByText('Record vital signs', { exact: true }).click();
  await page.getByLabel('Weight (kg)', { exact: true }).fill('80');
  await page.getByLabel('Height (cm)', { exact: true }).fill('200');
  await page.getByRole('button', { name: 'Save vital signs', exact: true }).click();
  await expect(
    page.getByText('BMI: 20 kg/m² (interpret for age and clinical context)', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/phase4-profile.png', fullPage: true });
  await page.getByRole('link', { name: 'New consultation', exact: true }).click();
  await page
    .getByLabel('Presenting complaints', { exact: true })
    .fill('Synthetic complaint for workflow testing');
  await page
    .getByLabel('Assessment / documented clinical impression', { exact: true })
    .fill('Synthetic professional documentation — not a diagnosis');
  await page.getByLabel('Treatment plan', { exact: true }).fill('Synthetic plan for test only');
  await page.screenshot({ path: 'docs/screenshots/phase4-consultation.png', fullPage: true });
  await page.getByRole('button', { name: 'Save consultation', exact: true }).click();
  await expect(
    page.getByText('Synthetic complaint for workflow testing', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Create prescription for this consultation', exact: true })
    .click();
  await page
    .getByLabel('Search medicine catalogue', { exact: true })
    .fill('Synthetic Clinical Medicine');
  await page.getByRole('combobox', { name: 'Add medicine', exact: true }).selectOption(productId);
  for (const [label, value] of Object.entries({
    Strength: '10mg',
    Dosage: 'One tablet',
    'Route of administration': 'Oral',
    Frequency: 'Daily',
    Duration: '10 days',
    Instructions: 'Synthetic test only',
  }))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Quantity prescribed (base units)', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Save prescription draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prescription', exact: true })).toBeVisible();
  await page
    .getByLabel('I have reviewed current allergies, conditions and medicine warnings')
    .check();
  await page.getByRole('button', { name: 'Authorize prescription', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Complete dispensing', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/phase4-prescription.png', fullPage: true });
  await page
    .getByLabel('Synthetic Clinical Medicine — quantity to dispense (base units)', { exact: true })
    .fill('4');
  await page.getByRole('button', { name: 'Confirm dispensing', exact: true }).click();
  await expect(
    page.getByText('Quantity prescribed: 10 base units · Dispensed: 4 · Remaining: 6', {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/phase4-dispensing.png', fullPage: true });
  const prescriptionUrl = page.url();
  await page.getByRole('link', { name: 'Dispense and pay through POS', exact: true }).click();
  await page
    .getByRole('button', { name: 'Load remaining prescription into cart', exact: true })
    .click();
  await page
    .getByLabel('I reviewed the current prescription, allergies and medicine warnings', {
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: /Complete sale/ }).click();
  await expect(page.getByRole('dialog')).toContainText('MM-');
  await page.goto(prescriptionUrl);
  await expect(
    page.getByText('Quantity prescribed: 10 base units · Dispensed: 10 · Remaining: 0', {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(`/#/patients/${patientId}`);
  await expect(page.getByText('Patient timeline · Latest first', { exact: true })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
});

test('sync diagnostics do not claim that connected means synchronized', async ({ page }) => {
  const bootstrap = await (await page.request.get('/api/auth/bootstrap-status')).json();
  if (bootstrap.required) {
    const registration = await page.request.post('/api/auth/register-owner', {
      data: { ...postChangeOwner, bootstrapToken: 'e2e-only-not-a-real-credential-00000000000000' },
    });
    expect(registration.status()).toBe(201);
    const registered = await registration.json();
    await page.request.post('/api/auth/logout', {
      headers: { 'X-CSRF-Token': registered.csrfToken },
      data: {},
    });
  }
  await signIn(page, postChangeOwner);
  await page.goto('/#/backup-sync');
  await expect(
    page.getByRole('heading', { name: 'Synchronization is not available' }),
  ).toBeVisible();
  await expect(
    page.getByText('Reachability is not confirmation that data has synchronized.'),
  ).toBeVisible();
  await expect(
    page.getByText('Central database · Counts only; no transaction details are shown.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh diagnostics' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync Now' })).toHaveCount(0);
  if (process.env.MEDIMART_CAPTURE_SYNC === '1') {
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('button', { name: 'Dismiss notification' })
      .click()
      .catch(() => {});
    await page.waitForTimeout(1000); // Allow the responsive navigation transition to finish.
    await page.screenshot({
      path: 'docs/screenshots/phase6/sync-diagnostics-browser.png',
      fullPage: true,
    });
  }
});
