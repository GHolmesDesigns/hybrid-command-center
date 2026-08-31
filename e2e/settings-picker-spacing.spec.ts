import { test, expect } from '@playwright/test';

test('the Drive Picker button keeps space before the following control', async ({ page }) => {
  await page.route('**/api/settings/drive', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        pickerConfigured: true,
        connected: true,
        rootFolderId: null,
        rootFolderUrl: null,
        picker: {
          clientId: 'e2e-client',
          apiKey: 'e2e-key',
          appId: 'e2e-app',
          scope: 'https://www.googleapis.com/auth/drive.file',
        },
      }),
    }),
  );

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 800, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/settings');

    const picker = page.getByRole('button', { name: 'Choose root folder with Google Picker' });
    const disconnect = page.getByRole('button', { name: 'Disconnect Google Drive' });
    await expect(picker).toBeVisible();
    await expect(disconnect).toBeVisible();

    const spacing = await picker.evaluate((element) => {
      const next = element.nextElementSibling;
      if (!next) throw new Error('Expected a control after the Drive Picker button.');
      const button = element.getBoundingClientRect();
      const following = next.getBoundingClientRect();
      return {
        marginBottom: getComputedStyle(element).marginBottom,
        gap: following.top - button.bottom,
      };
    });
    expect(spacing.marginBottom).toBe('18px');
    expect(spacing.gap).toBeGreaterThanOrEqual(18);
  }
});
