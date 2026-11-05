import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('folder picker preserves a nested tree inside the current destination', async ({ page }) => {
  const admin = JSON.parse(await readFile('.local/admin.json', 'utf8')) as {
    email: string;
    password: string;
  };
  const marker = `Folder acceptance ${Date.now()}`;
  const website = resolve('.local/fixtures', marker, 'Website');
  await mkdir(resolve(website, 'assets/images'), { recursive: true });
  await mkdir(resolve(website, 'styles'), { recursive: true });
  await writeFile(resolve(website, 'index.html'), '<p>Folder upload fixture</p>');
  await writeFile(resolve(website, 'assets/images/banner.txt'), 'Nested folder fixture');
  await writeFile(resolve(website, 'styles/main.css'), 'body { color: blue; }');
  await page.goto('/');
  await page.getByLabel('Email address').fill(admin.email);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  await page.getByRole('button', { name: 'New folder', exact: true }).last().click();
  await page.getByLabel('Folder name').fill(marker);
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await page.getByRole('button', { name: marker, exact: true }).last().click();
  await page.locator('input[type=file]').nth(1).setInputFiles(website);
  await expect(page.getByText('Upload summary', { exact: true })).toBeVisible();
  const response = await page.request.get('/api/folders');
  const paths = (await response.json()).folders.map((f: { path: string }) => f.path);
  expect(paths).toContain(`${marker}/Website/assets/images`);
  expect(paths).toContain(`${marker}/Website/styles`);
  const files = await page.request.get('/api/files');
  const names = (await files.json()).files.map((f: { filename: string }) => f.filename);
  expect(names).toEqual(expect.arrayContaining(['index.html', 'banner.txt', 'main.css']));
  await page.getByRole('button', { name: 'Website', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Website', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'assets', exact: true }).last().click();
  await page.getByRole('button', { name: 'images', exact: true }).last().click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'banner.txt' })
      .getByText(/Done|Infected/),
  ).toBeVisible();
});
