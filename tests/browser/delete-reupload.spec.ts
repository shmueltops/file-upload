import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('an infected file can be deleted and uploaded again immediately under the same name', async ({
  page,
}) => {
  const admin = JSON.parse(await readFile('.local/admin.json', 'utf8')) as {
    email: string;
    password: string;
  };
  await page.goto('/');
  await page.getByLabel('Email address').fill(admin.email);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  const folder = `Immediate reuse ${Date.now()}`;
  await page.getByRole('button', { name: 'New folder', exact: true }).last().click();
  await page.getByLabel('Folder name').fill(folder);
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await page.getByRole('button', { name: folder, exact: true }).last().click();
  const filename = 'virus-replacement.txt';
  const upload = async () => {
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: filename,
        mimeType: 'text/plain',
        buffer: Buffer.from('Deletion and name reuse fixture'),
      });
    await expect(
      page.getByRole('row').filter({ hasText: filename }).getByText('Infected', { exact: true }),
    ).toBeVisible();
    const response = await page.request.get(`/api/files?folderPath=${encodeURIComponent(folder)}`);
    const id = (await response.json()).files[0].id as string;
    const audit = await page.request.get(`/api/admin/jobs/${id}/attempts`);
    const attempts = (await audit.json()).attempts;
    expect(attempts).toHaveLength(1);
    return id;
  };
  const original = await upload();
  await page.getByRole('button', { name: `Delete file ${filename}`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: filename })).toHaveCount(0);
  const replacement = await upload();
  expect(replacement).not.toBe(original);
  expect((await page.request.get(`/api/files/${original}`)).status()).toBe(404);
  await expect(
    page.getByText('A file with this name already exists', { exact: false }),
  ).toHaveCount(0);
});
