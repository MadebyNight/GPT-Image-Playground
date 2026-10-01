import { expect, test } from '@playwright/test'

test('preset models are available before typing and custom model IDs remain editable', async ({ page }) => {
  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        serverApi: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-image-2',
          apiMode: 'images',
          modelOptions: ['gpt-image-2', 'gpt-5.5'],
          apiModeOptions: ['images', 'responses'],
          allowCustomModel: true,
          codexCli: false,
          responseFormatB64Json: false,
          timeoutSeconds: 60,
          proxyPath: '/api-proxy',
        },
      }),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: 'API 配置' }).click()

  const modelInput = page.getByRole('combobox', { name: '模型 ID' })
  await expect(modelInput).toHaveValue('gpt-image-2')
  await modelInput.click()
  await expect(page.getByRole('option', { name: 'gpt-image-2' })).toBeVisible()
  await page.getByRole('option', { name: 'gpt-5.5' }).click()
  await expect(modelInput).toHaveValue('gpt-5.5')

  await page.getByRole('button', { name: '显示预设模型' }).click()
  await expect(page.getByRole('option', { name: 'gpt-image-2' })).toBeVisible()
  await modelInput.fill('custom-image-model')
  await expect(modelInput).toHaveValue('custom-image-model')
  await modelInput.press('Escape')
  await expect(page.getByRole('listbox', { name: '预设模型' })).toHaveCount(0)
  await expect(modelInput).toBeVisible()
})
