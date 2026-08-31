import { expect, test } from '@playwright/test';

/**
 * Wave 27 / C124: operator MCP health panel.
 *
 * The shared e2e API stays passwordless on loopback, so this spec fakes auth-enabled
 * MCP health responses at the HTTP boundary and proves the Agents card runs test
 * connection and shows the last-tested timestamp. Server aggregation and diagnostics
 * are covered in unit tests against a real auth-enforced app.
 */
test('operator opens MCP health panel, runs test connection, and sees a result', async ({
  page,
}) => {
  const testedAt = '2026-08-28T16:00:00.000Z';

  await page.route('**/api/auth/mcp-agents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, credentials: [] }),
    });
  });
  await page.route('**/api/mcp/health/test', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        workspaceChecksumUnchanged: true,
        lastUsedAt: testedAt,
        credential: null,
        status: {
          ok: true,
          transport: 'operator',
          authenticated: true,
          protocolVersion: '2024-11-05',
          agentLabel: null,
          grantedScopes: ['coordination:read', 'coordination:write'],
          storeId: 'store-fixture-e2e',
          baseUrl: 'https://hcc.example.com',
          serverVersion: '5.6.10',
          capabilityVersion: 'mcp-test',
          serverClock: testedAt,
          checks: {
            toolsList: { ok: true, toolCount: 17 },
            resourcesList: { ok: true, resourceCount: 2 },
            resourceRead: { ok: true, uri: 'hcc://workspace/context', byteLength: 100 },
          },
          testedAt,
        },
      }),
    });
  });
  await page.route('**/api/mcp/health', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        state: 'never_connected',
        stateReason: null,
        generatedAt: testedAt,
        agents: [],
        errorSummary: [],
        staleHandoffs: [],
        recentCompletions: [],
        auditEventCount: 0,
      }),
    });
  });

  try {
    await page.goto('/agents');
    const healthCard = page.locator('.mcp-health-card');
    await expect(healthCard.getByRole('heading', { name: 'Connection health' })).toBeVisible();
    await expect(healthCard.getByText('No agent has connected yet')).toBeVisible();

    const testResponsePromise = page.waitForResponse((response) =>
      response.url().includes('/api/mcp/health/test'),
    );
    await healthCard.getByRole('button', { name: 'Check server health' }).click();
    const testResponse = await testResponsePromise;
    expect(testResponse.ok()).toBe(true);
    const payload = (await testResponse.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);

    await expect(page.locator('.mcp-health-test-result')).toBeVisible();
    await expect(page.locator('.mcp-health-test-result')).toContainText('Server health passed');
    await expect(page.locator('.mcp-health-test-result')).toContainText(
      'Store ID: store-fixture-e2e',
    );
    await expect(page.locator('.mcp-health-test-result')).toContainText(
      'Base URL: https://hcc.example.com',
    );
    await expect(page.locator('.mcp-health-test-result')).toContainText('Last tested:');
  } finally {
    await page.unroute('**/api/auth/mcp-agents');
    await page.unroute('**/api/mcp/health');
    await page.unroute('**/api/mcp/health/test');
  }
});
