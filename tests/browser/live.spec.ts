import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('deployed multipart upload with real R2 part reconciliation', async ({ page }) => {
  test.skip(process.env.RUN_LIVE_BROWSER !== '1', 'Explicit opt-in for deployed integration data.');
  const credentials = JSON.parse(await readFile('.local/live-verification.json', 'utf8')) as {
    origin: string;
    email: string;
    password: string;
  };
  await page.goto(credentials.origin);
  await page.getByLabel('Email address').fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  const name = `live-multipart-${Date.now()}.bin`;
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(21 * 1024 * 1024, 7),
    });
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row.getByText(/Done|Infected/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: `Retry ${name}`, exact: true })).toHaveCount(0);
});
test('deployed browser upload, processing and authorized download', async ({ page }) => {
  test.skip(process.env.RUN_LIVE_BROWSER !== '1', 'Explicit opt-in for deployed integration data.');
  const credentials = JSON.parse(await readFile('.local/live-verification.json', 'utf8')) as {
    origin: string;
    email: string;
    password: string;
  };
  await page.goto(credentials.origin);
  await page.getByLabel('Email address').fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  const name = `live-browser-${Date.now()}.txt`,
    contents = 'Browser-to-R2-to-Queues end-to-end verification.';
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(contents) });
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row.getByText(/Done|Infected/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: `Retry ${name}`, exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/deployed_file_manager.png', fullPage: true });
  if (await row.getByText('Done', { exact: true }).count()) {
    const event = page.waitForEvent('download');
    await row.getByRole('button', { name: `Download ${name}`, exact: true }).click();
    const file = await event;
    expect(await readFile((await file.path())!, 'utf8')).toBe(contents);
  }
});
