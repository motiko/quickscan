import { test, expect } from '@playwright/test';
import { resetDatabase } from './helpers';

test.describe('Document naming', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await resetDatabase(page);
  });

  test('detects a custom OpenAI-compatible endpoint and picks its model', async ({ page }) => {
    let requestBody: { model: string; messages: { content: string }[] } | null = null;
    let authHeader: string | undefined;
    await page.route('https://llm.example.test/v1/models', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ object: 'list', data: [{ id: 'test/model', object: 'model' }, { id: 'other/model', object: 'model' }] }),
      });
    });
    await page.route('https://llm.example.test/v1/chat/completions', async (route) => {
      requestBody = route.request().postDataJSON();
      authHeader = await route.request().headerValue('authorization') ?? undefined;
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '"Rechnung ACME September 2026"' } }] }),
      });
    });

    await page.goto('/settings');
    await page.getByText('Use Cloud LLM').click();
    await page.getByRole('radio', { name: 'Custom endpoint' }).click();
    // Without the /v1 suffix, which detection adds
    await page.getByLabel('Endpoint URL', { exact: true }).fill('https://llm.example.test');
    await page.getByLabel('API key', { exact: true }).fill('sk-e2e');
    await page.getByLabel('API key', { exact: true }).blur();
    await expect(page.getByText('OpenAI Chat Completions API · 2 models')).toBeVisible();
    await expect(page.getByLabel('Endpoint URL', { exact: true })).toHaveValue('https://llm.example.test/v1');
    await expect(page.getByLabel('Model', { exact: true })).toHaveValue('test/model');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status')).toContainText('Works with test/model! Sample title: “Rechnung ACME September 2026”');
    expect(requestBody!.model).toBe('test/model');
    expect(authHeader).toBe('Bearer sk-e2e');
  });

  test('uses Anthropic with an API key', async ({ page }) => {
    let requestBody: { model: string; system: string; messages: { content: string }[] } | null = null;
    let apiKey: string | null = null;
    let listKey: string | null = null;
    const corsPreflight = {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
      },
    };
    // No model is set, so the app picks the newest one from the account's model list
    await page.route('https://api.anthropic.com/v1/models', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill(corsPreflight);
        return;
      }
      listKey = await route.request().headerValue('x-api-key');
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { type: 'model', id: 'claude-opus-5-5' },
            { type: 'model', id: 'claude-sonnet-4-5' },
          ],
          has_more: false,
        }),
      });
    });
    await page.route('https://api.anthropic.com/v1/messages', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill(corsPreflight);
        return;
      }
      requestBody = route.request().postDataJSON();
      apiKey = await route.request().headerValue('x-api-key');
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Rechnung – ACME – 2026-09-14' }] }),
      });
    });

    await page.goto('/settings');
    await page.getByText('Use Cloud LLM').click();
    await page.getByRole('radio', { name: 'Anthropic' }).click();
    await expect(page.getByRole('radio', { name: 'Anthropic' })).toBeChecked();
    await page.getByLabel('API key', { exact: true }).fill('sk-ant-e2e');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status')).toContainText('Works with claude-opus-5-5! Sample title: “Rechnung – ACME – 2026-09-14”');
    expect(listKey).toBe('sk-ant-e2e');
    expect(apiKey).toBe('sk-ant-e2e');
    expect(requestBody!.model).toBe('claude-opus-5-5');
  });
});
