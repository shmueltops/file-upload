import { test, expect } from '@playwright/test';

const user = {
  id: 'logout-user',
  email: 'logout@test.invalid',
  role: 'user',
  must_change_password: false,
};
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user } }));
  await page.route('**/api/folders', (route) => route.fulfill({ json: { folders: [] } }));
  await page.route('**/api/files?*', (route) =>
    route.fulfill({ json: { files: [], nextCursor: null } }),
  );
});

test('signs out immediately despite a failed logout request and stays signed out after refresh', async ({
  page,
}) => {
  let finishLogout!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishLogout = resolve;
  });
  await page.route('**/api/auth/logout', async (route) => {
    await pending;
    await route.fulfill({ status: 500, json: { error: 'Simulated server failure.' } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'My files' })).toHaveCount(0);
  finishLogout();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.route('**/api/auth/login', (route) => route.fulfill({ json: { user } }));
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('test-password-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/logout-recovery.png' });
});

test('automatically signs out when an authenticated API request reports an expired session', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  await page.route('**/api/files?*', (route) =>
    route.fulfill({ status: 401, json: { error: 'Sign in to continue.', code: 'unauthorized' } }),
  );
  await page.getByRole('button', { name: 'Refresh files' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});

test('a wrong current password does not sign out a valid password-change session', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { user: { ...user, must_change_password: true } } }),
  );
  await page.route('**/api/auth/change-password', (route) =>
    route.fulfill({ status: 401, json: { error: 'Current password is incorrect.' } }),
  );
  await page.goto('/');
  await page.getByLabel('Current password').fill('wrong-password');
  await page.getByLabel('New password', { exact: true }).fill('new-test-password-only');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Current password is incorrect.');
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
});
