import { test, expect } from '@playwright/test';
import { open, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
test('full 3 GB browser multipart transfer and processing', async ({ page }) => {
  test.skip(
    process.env.RUN_LARGE_FILE_TEST !== '1',
    'Opt in to the 3 GB disk/network test with RUN_LARGE_FILE_TEST=1.',
  );
  test.setTimeout(900_000);
  const admin = JSON.parse(await readFile('.local/admin.json', 'utf8')) as {
    email: string;
    password: string;
  };
  await mkdir('.local/fixtures', { recursive: true });
  const name = `maximum-size-${Date.now()}.bin`,
    path = resolve('.local/fixtures', name),
    handle = await open(path, 'w');
  await handle.truncate(3_000_000_000);
  await handle.close();
  await page.goto('/');
  await page.getByLabel('Email address').fill(admin.email);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  await page.locator('input[type=file]').first().setInputFiles(path);
  await expect(page.getByLabel('Upload manager')).toBeVisible();
  let previous = 0,
    report = 0;
  for (let i = 0; i < 8000; i++) {
    const panel = page.getByLabel('Upload manager');
    const percent = await panel.evaluate((element) => {
      const bar = element.querySelector('progress');
      return bar ? (bar.value / bar.max) * 100 : 100;
    });
    expect(percent).toBeGreaterThanOrEqual(previous);
    previous = percent;
    if (percent >= report + 10) {
      report = Math.floor(percent);
      console.log(`3 GB transfer: ${report}%`);
    }
    if (await panel.getByText('Upload summary', { exact: true }).count()) break;
    await page.waitForTimeout(100);
  }
  await expect(page.getByRole('button', { name: `Retry ${name}`, exact: true })).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row.getByText('3.00 GB', { exact: true })).toBeVisible();
  await expect(row.getByText(/Done|Infected/)).toBeVisible({ timeout: 300_000 });
  await page.screenshot({ path: 'artifacts/maximum_file_size.png', fullPage: true });
  if (await row.getByText('Done', { exact: true }).count()) {
    const result = await page.request.get('/api/files?folderPath=');
    const record = (await result.json()).files.find(
      (f: { filename: string }) => f.filename === name,
    );
    const response = await page.request.get(`/api/files/${record.id}/content`, {
      headers: { Range: 'bytes=2999999984-2999999999' },
    });
    expect(response.status()).toBe(206);
    expect((await response.body()).length).toBe(16);
    console.log('3 GB clean promotion and final-byte range download passed.');
  } else console.log('3 GB upload passed; the simulated scanner selected its infected outcome.');
});
