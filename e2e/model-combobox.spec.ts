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
  await expect(page.getByText('获取上游模型失败，已显示预设模型列表。')).toBeVisible()
  await expect(page.getByRole('option', { name: 'gpt-image-2' })).toBeVisible()
  await page.getByRole('option', { name: 'gpt-5.5' }).click()
  await expect(modelInput).toHaveValue('gpt-5.5')

  await page.getByRole('button', { name: '显示可用模型' }).click()
  await expect(page.getByRole('option', { name: 'gpt-image-2' })).toBeVisible()
  await modelInput.fill('custom-image-model')
  await expect(modelInput).toHaveValue('custom-image-model')
  await modelInput.press('Escape')
  await expect(page.getByRole('listbox', { name: '可用模型' })).toHaveCount(0)
  await expect(modelInput).toBeVisible()
})

for (const serverManaged of [true, false]) {
  test(`${serverManaged ? 'server-managed' : 'personal profile'} model list classifies image capability and follows the selected protocol`, async ({ page }) => {
    await page.route('**/runtime-config.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          serverApi: serverManaged ? {
            enabled: true,
            provider: 'openai',
            model: 'gpt-image-2',
            apiMode: 'images',
            modelOptions: ['gpt-image-2', 'gpt-5.5'],
            apiModeOptions: ['images', 'responses'],
            allowCustomModel: false,
            codexCli: false,
            responseFormatB64Json: false,
            timeoutSeconds: 60,
            proxyPath: '/api-proxy',
          } : { enabled: false },
          modelProtocols: { 'gemini-3.1-flash-image': 'images' },
        }),
      })
    })
    await page.route('**/v1/models', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [
          { id: 'gpt-image-2.5-sunburst' }, { id: 'gpt-5.6-luna' },
          { id: 'gemini-3.1-flash-image' }, { id: 'imagen-4.0' },
          { id: 'claude-sonnet-5-5' }, { id: 'glm-5.3' }, { id: 'kimi-k3' },
          { id: 'deepseek-v4.1-flash' }, { id: 'gemini-3.1-flash' },
        ] }),
      })
    })

    await page.goto('/')
    await page.getByRole('button', { name: '设置' }).click()
    await page.getByRole('button', { name: 'API 配置' }).click()
    const modelInput = page.getByRole('combobox', { name: '模型 ID' })
    await modelInput.click()

    for (const model of ['claude-sonnet-5-5', 'glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash', 'gemini-3.1-flash']) {
      await expect(page.getByRole('option', { name: `${model} 无图像生成能力` })).toBeDisabled()
    }
    await expect(page.getByRole('option', { name: 'imagen-4.0 协议未知，无法选择' })).toBeDisabled()
    await expect(page.getByRole('option', { name: 'gemini-3.1-flash-image images' })).toBeEnabled()
    await expect(page.getByRole('option', { name: 'gpt-image-2.5-sunburst images' })).toBeEnabled()
    await page.getByRole('option', { name: 'gpt-5.6-luna responses' }).click()
    await expect(modelInput).toHaveValue('gpt-5.6-luna')
    await expect(page.getByText('Responses API (/v1/responses)', { exact: true }).first()).toBeVisible()

    await modelInput.click()
    await page.getByRole('option', { name: 'gemini-3.1-flash-image images' }).click()
    await expect(modelInput).toHaveValue('gemini-3.1-flash-image')
    await expect(page.getByText('Images API (/v1/images)', { exact: true }).first()).toBeVisible()
  })
}

test('invalid protocol mapping falls back to presets without enabling unsupported models', async ({ page }) => {
  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        serverApi: { enabled: false },
        modelProtocols: { 'gpt-image-2': 'chat' },
      }),
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: 'API 配置' }).click()
  await page.getByRole('combobox', { name: '模型 ID' }).click()

  await expect(page.getByText('获取上游模型失败，已显示预设模型列表。')).toBeVisible()
  await expect(page.getByRole('option', { name: 'gpt-image-2 images' })).toBeEnabled()
  await expect(page.getByRole('option', { name: 'gpt-5.5 responses' })).toBeEnabled()
})
