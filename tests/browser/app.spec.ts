import { test, expect, request as makeRequest } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:5173';
let admin: { email: string; password: string; secret: string };
test.beforeAll(async () => {
  admin = JSON.parse(await readFile('.local/admin.json', 'utf8'));
  const client = await makeRequest.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const login = await client.post('/api/auth/login', {
    data: { email: admin.email, password: admin.password },
  });
  expect(login.ok()).toBeTruthy();
  if ((await login.json()).user.must_change_password) {
    const password = crypto.randomUUID();
    const rotated = await client.post('/api/auth/change-password', {
      data: { currentPassword: admin.password, password },
    });
    expect(rotated.ok()).toBeTruthy();
    admin.password = password;
    await writeFile('.local/admin.json', JSON.stringify(admin, null, 2));
  }
  await client.dispose();
});
async function signIn(
  page: import('@playwright/test').Page,
  email = admin.email,
  password = admin.password,
) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('file manager: folder organization, upload, simulated scan, download, admin audit and deletion', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  const folder = `Browser QA ${Date.now()}`;
  await page.getByRole('button', { name: 'New folder', exact: true }).last().click();
  await page.getByLabel('Folder name').fill(folder);
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await page.getByRole('button', { name: folder, exact: true }).last().click();
  await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible();
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles([
      {
        name: 'virus-example.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Scanner simulation acceptance fixture'),
      },
      {
        name: 'project-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Project notes for the file manager acceptance test.'),
      },
    ]);
  const infected = page.getByRole('row').filter({ hasText: 'virus-example.txt' });
  await expect(infected.getByText('Infected', { exact: true })).toBeVisible();
  await expect(infected.getByRole('button', { name: 'Download virus-example.txt' })).toBeDisabled();
  const notes = page.getByRole('row').filter({ hasText: 'project-notes.txt' });
  await expect(notes.getByText(/Done|Infected/)).toBeVisible();
  if (await notes.getByText('Done', { exact: true }).count()) {
    const downloadEvent = page.waitForEvent('download');
    await notes.getByRole('button', { name: 'Download project-notes.txt' }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('project-notes.txt');
    const path = await download.path();
    expect(await readFile(path!, 'utf8')).toContain('acceptance test');
  }
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/file_manager.png', fullPage: true });
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Processing activity' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Inspect virus-example.txt', exact: true })
    .first()
    .click();
  await expect(page.getByText('Attempt 1', { exact: true })).toBeVisible();
  await expect(page.locator('.attempt')).toContainText('virus in name');
  await page.screenshot({ path: 'artifacts/scan_audit.png', fullPage: true });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('link', { name: 'My files', exact: true }).click();
  await page.getByRole('button', { name: `Rename ${folder}`, exact: true }).click();
  await page.getByLabel('Folder name').fill(`${folder} renamed`);
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(
    page.getByRole('button', { name: `${folder} renamed`, exact: true }).last(),
  ).toBeVisible();
  await page.getByRole('button', { name: `Delete folder ${folder} renamed`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: `${folder} renamed`, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('administrator creates a user and first-login password rotation protects personal files', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const email = `browser-${Date.now()}@test.invalid`,
    initial = crypto.randomUUID(),
    password = crypto.randomUUID();
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Initial password').fill(initial);
  await page.getByRole('button', { name: 'Create user', exact: true }).last().click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/user_management.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, email, initial);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.getByLabel('Current password', { exact: true }).fill(initial);
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/mobile_file_manager.png', fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});
test('multipart retry preserves progress and uploads survive route changes', async ({ page }) => {
  await signIn(page);
  const name = `multipart-${Date.now()}.bin`;
  let failedOnce = false;
  await page.route('**/__local/r2?**', async (route) => {
    const request = route.request();
    if (!failedOnce && request.method() === 'PUT') {
      failedOnce = true;
      await route.abort('connectionreset');
    } else await route.continue();
  });
  const displayed: number[] = [];
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(21 * 1024 * 1024, 7),
    });
  await expect(page.getByLabel('Upload manager')).toBeVisible();
  await expect(page.locator('.upload-overall')).toHaveCount(0);
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Processing activity' })).toBeVisible();
  while (await page.getByText('Uploading your files', { exact: true }).count()) {
    const value = await page.getByLabel('Upload manager').evaluate((panel) => {
      const bar = panel.querySelector('progress');
      return bar ? (bar.value / bar.max) * 100 : 100;
    });
    displayed.push(value);
    await page.waitForTimeout(100);
  }
  expect(failedOnce).toBe(true);
  expect(displayed.every((v, i) => i === 0 || v >= displayed[i - 1])).toBe(true);
  await page.getByRole('link', { name: 'My files', exact: true }).click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: name })
      .getByText(/Done|Infected/),
  ).toBeVisible({ timeout: 60_000 });
});
