import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const names = [
  'notes.txt',
  'README.md',
  'photo.png',
  'clip.webm',
  'guide.pdf',
  'archive.zip',
  'large.txt',
];
const markdown =
  '# Project guide\n\nA **private** workspace.\n\n- Upload files\n- Keep folders\n\n| Item | Ready |\n| --- | --- |\n| Preview | Yes |\n\n```ts\nconst ready = true;\n```\n\n<script>window.previewUnsafe = true</script>\n[Unsafe](javascript:alert(1))\n![External](https://external.invalid/tracker.png)';

function pdfFixture() {
  const stream = 'BT /F1 24 Tf 55 730 Td (File Vault PDF preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(result.length);
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = result.length;
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return result;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'preview-user',
          email: 'preview@test.invalid',
          role: 'user',
          must_change_password: false,
        },
      },
    }),
  );
  await page.route('**/api/folders', (route) => route.fulfill({ json: { folders: [] } }));
  await page.route('**/api/files?*', (route) =>
    route.fulfill({
      json: {
        files: names.map((filename, index) => ({
          id: String(index),
          filename,
          status: 'done',
          actual_size: index === 6 ? 3 * 1024 * 1024 : 512,
          expected_size: 512,
          updated_at: Date.now(),
        })),
        nextCursor: null,
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
});

test('previews plain text and formatted Markdown safely, with download and size fallback', async ({
  page,
}) => {
  await page.route('**/api/files/0/content?preview=1', (route) =>
    route.fulfill({
      contentType: 'text/plain',
      body: '<strong>Keep this as plain text</strong>\nSecond line',
    }),
  );
  await page.getByRole('button', { name: 'Preview notes.txt', exact: true }).click();
  await expect(page.locator('.text-preview')).toHaveText(
    '<strong>Keep this as plain text</strong>\nSecond line',
  );
  await expect(page.locator('.text-preview strong')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute(
    'href',
    '/api/files/0/content',
  );
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.route('**/api/files/1/content?preview=1', (route) =>
    route.fulfill({ contentType: 'text/plain', body: markdown }),
  );
  await page.getByRole('button', { name: 'Preview README.md', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'README.md' });
  await expect(preview.getByRole('heading', { name: 'Project guide' })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('private');
  await expect(preview.getByRole('table')).toBeVisible();
  await expect(preview.locator('pre code')).toHaveText('const ready = true;\n');
  await expect(preview.locator('script, img')).toHaveCount(0);
  await expect(preview.getByRole('link', { name: 'Unsafe' })).not.toHaveAttribute(
    'href',
    /javascript:/,
  );
  await page.screenshot({ path: 'artifacts/markdown-preview.png' });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('button', { name: 'Preview archive.zip', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Download archive.zip', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Preview large.txt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('too large');
});

test('shows images, playable video, and the browser PDF viewer', async ({ page }) => {
  await page.route('**/api/files/2/content?preview=1', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.getByRole('button', { name: 'Preview photo.png', exact: true }).click();
  await expect(page.getByRole('img', { name: 'photo.png' })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.preview-image').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const videoBytes = await readFile(new URL('./fixtures/preview.webm', import.meta.url));
  await page.route('**/api/files/3/content?preview=1', (route) =>
    route.fulfill({ contentType: 'video/webm', body: Buffer.from(videoBytes) }),
  );
  await page.getByRole('button', { name: 'Preview clip.webm', exact: true }).click();
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(1);
  await expect(page.locator('video')).toHaveAttribute('controls', '');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.route('**/api/files/4/content?preview=1', (route) =>
    route.fulfill({
      contentType: 'application/pdf',
      headers: {
        'Content-Disposition': 'inline',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'none'; object-src 'self'; frame-ancestors 'self'",
      },
      body: pdfFixture(),
    }),
  );
  await page.getByRole('button', { name: 'Preview guide.pdf', exact: true }).click();
  await expect(page.getByTitle('Preview of guide.pdf')).toBeVisible();
  await expect(page.locator('.preview-pdf').locator('..')).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() => page.frames().some((frame) => frame.url().startsWith('chrome-extension://')))
    .toBe(true);
  const viewer = page.frames().find((frame) => frame.url().startsWith('chrome-extension://'))!;
  await expect(viewer.locator('viewer-toolbar')).toBeVisible();
  await page.screenshot({ path: 'artifacts/pdf-preview.png' });
});
