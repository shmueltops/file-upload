import { test, expect } from '@playwright/test';

test('loading indicators animate during work and respect reduced motion', async ({ page }) => {
  let openWorkspace!: () => void;
  const workspace = new Promise<void>((resolve) => {
    openWorkspace = resolve;
  });
  let showFiles!: () => void;
  const filesReady = new Promise<void>((resolve) => {
    showFiles = resolve;
  });
  let done = false;
  await page.route('**/api/auth/me', async (route) => {
    await workspace;
    await route.fulfill({
      json: {
        user: {
          id: 'loading-demo',
          email: 'demo@test.invalid',
          role: 'user',
          must_change_password: false,
        },
      },
    });
  });
  await page.route('**/api/folders', (route) => route.fulfill({ json: { folders: [] } }));
  await page.route('**/api/files?*', async (route) => {
    await filesReady;
    await route.fulfill({
      json: {
        files: [
          {
            id: 'demo-file',
            filename: 'Project notes.pdf',
            expected_size: 1024,
            status: done ? 'done' : 'scanning',
            updated_at: Date.now(),
          },
        ],
        nextCursor: null,
      },
    });
  });
  await page.goto('/');
  const opening = page.getByRole('status').filter({ hasText: 'Opening your workspace' });
  await expect(opening.locator('.loading-spinner')).toBeVisible();
  await expect(opening.locator('.loading-spinner')).toHaveCSS('animation-name', 'loading-turn');
  openWorkspace();
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading your files' }).locator('.loading-spinner'),
  ).toBeVisible();
  showFiles();
  const badge = page.locator('.status-scanning');
  await expect(badge).toHaveText('Scanning');
  await expect(badge.locator('.loading-spinner')).toHaveCSS('animation-name', 'loading-turn');
  await page.screenshot({ path: 'artifacts/loading-status.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(badge.locator('.loading-spinner')).toHaveCSS('animation-name', 'none');
  done = true;
  await expect(page.locator('.status-done')).toBeVisible();
  await expect(page.locator('.status-done .loading-spinner')).toHaveCount(0);
});
