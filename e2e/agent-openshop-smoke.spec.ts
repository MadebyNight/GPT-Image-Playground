import { expect, test, type Page } from '@playwright/test'
import {
  LEGACY_AGENT_ASSISTANT_TEXT,
  LEGACY_AGENT_PROMPT,
  LEGACY_AGENT_REQUEST_BODY_FIXTURE,
  createLegacyAgentSseFixture,
} from '../src/test/fixtures/legacyAgentResponses'

const SOURCE_TASK_ID = 'e2e-source-task'
const SOURCE_IMAGE_ID = 'e2e-source-image'

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    const isInlineResource = requestUrl.protocol === 'data:' || requestUrl.protocol === 'blob:'
    const isLocalHttp = (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:')
      && (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost')
    if (isInlineResource || isLocalHttp) {
      await route.continue()
      return
    }
    await route.fulfill({ status: 204, body: '' })
  })
})

async function gotoGallery(page: Page, url = '/') {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
  expect(response?.ok()).toBe(true)
  await expect(page.getByRole('tablist', { name: '工作区模式' })).toBeVisible()
}

async function seedOpenShopHistory(page: Page) {
  await gotoGallery(page)
  return page.evaluate(async ({ sourceTaskId, sourceImageId }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 3
    canvas.height = 2
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#ffff00']
    colors.forEach((color, index) => {
      context.fillStyle = color
      context.fillRect(index % 3, Math.floor(index / 3), 1, 1)
    })
    const sourceDataUrl = canvas.toDataURL('image/png')
    const request = indexedDB.open('gpt-image-playground', 2)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('tasks')) database.createObjectStore('tasks', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('images')) database.createObjectStore('images', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('thumbnails')) database.createObjectStore('thumbnails', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = db.transaction(['tasks', 'images'], 'readwrite')
    transaction.objectStore('images').put({
      id: sourceImageId,
      dataUrl: sourceDataUrl,
      createdAt: 1,
      source: 'generated',
      width: 3,
      height: 2,
    })
    transaction.objectStore('tasks').put({
      id: sourceTaskId,
      prompt: 'OpenShop Chromium 基线',
      params: {
        size: 'auto',
        quality: 'auto',
        output_format: 'png',
        output_compression: null,
        moderation: 'auto',
        n: 1,
      },
      apiProvider: 'openai',
      inputImageIds: [],
      outputImages: [sourceImageId],
      status: 'done',
      error: null,
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
      origin: 'gallery',
    })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
    return sourceDataUrl
  }, { sourceTaskId: SOURCE_TASK_ID, sourceImageId: SOURCE_IMAGE_ID })
}

test('Chat Agent 使用固定 SSE fixture 完成 Chromium 最小流程', async ({ page }) => {
  let requestBody: unknown = null
  await page.route('**/mock/v1/responses', async (route) => {
    requestBody = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: createLegacyAgentSseFixture(),
    })
  })

  const query = new URLSearchParams({
    apiUrl: 'http://127.0.0.1:4173/mock/v1',
    apiKey: 'e2e-key',
    apiMode: 'responses',
    model: 'gpt-5.5',
  })
  await gotoGallery(page, `/?${query.toString()}`)
  await page.getByRole('tab', { name: 'Agent' }).click()
  await page.locator('[contenteditable][data-placeholder^="描述你想生成的图片"]').fill(LEGACY_AGENT_PROMPT)
  await page.getByTitle('生成 (Ctrl+Enter)').click()

  const latestResponse = page.getByRole('region', { name: '当前 Agent 工作区' }).locator('[data-agent-latest-response]')
  await expect(latestResponse).toContainText(LEGACY_AGENT_ASSISTANT_TEXT)
  await expect(latestResponse.getByAltText('本轮生成结果预览')).toBeVisible()
  expect(requestBody).toEqual(LEGACY_AGENT_REQUEST_BODY_FIXTURE)
})

test('Chat Agent 失败终态出现后立即刷新仍保留 partial 与错误', async ({ page }) => {
  await page.route('**/mock/v1/responses', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: [
        'data: {"type":"response.output_text.delta","delta":"刷新后仍应保留的 partial"}\n\n',
        'data: {"type":"response.failed","response":{"error":{"message":"E2E 模型执行失败"}}}\n\n',
      ].join(''),
    })
  })

  const query = new URLSearchParams({
    apiUrl: 'http://127.0.0.1:4173/mock/v1',
    apiKey: 'e2e-key',
    apiMode: 'responses',
    model: 'gpt-5.5',
  })
  await gotoGallery(page, `/?${query.toString()}`)
  await page.getByRole('tab', { name: 'Agent' }).click()
  await page.locator('[contenteditable][data-placeholder^="描述你想生成的图片"]').fill('测试失败后立即刷新')
  await page.getByTitle('生成 (Ctrl+Enter)').click()

  let latestResponse = page.getByRole('region', { name: '当前 Agent 工作区' }).locator('[data-agent-latest-response]')
  await expect(latestResponse).toContainText('刷新后仍应保留的 partial')
  await expect(latestResponse).toContainText('E2E 模型执行失败')
  await expect(latestResponse).toContainText('执行失败')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('tablist', { name: '工作区模式' })).toBeVisible()
  await page.getByRole('tab', { name: 'Agent' }).click()
  latestResponse = page.getByRole('region', { name: '当前 Agent 工作区' }).locator('[data-agent-latest-response]')
  await expect(latestResponse).toContainText('刷新后仍应保留的 partial')
  await expect(latestResponse).toContainText('E2E 模型执行失败')
  await expect(latestResponse).toContainText('执行失败')
})

test('双能力部署可切换 Chat 与 Tool，并隔离完整输入草稿', async ({ page }) => {
  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        serverApi: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-5.5',
          apiMode: 'responses',
          modelOptions: ['gpt-5.5'],
          apiModeOptions: ['responses'],
          allowCustomModel: true,
          codexCli: false,
          responseFormatB64Json: false,
          timeoutSeconds: 60,
          proxyPath: '/api-proxy',
        },
        restrictedAgent: {
          enabled: true,
          basePath: '/agent-api/v1',
          agentOnly: false,
        },
      }),
    })
  })

  await gotoGallery(page)
  await page.getByRole('tab', { name: 'Agent' }).click()
  const editor = page.locator('[contenteditable][data-placeholder^="描述你想生成的图片"]')
  await expect(page.getByRole('tablist', { name: 'Agent 模式' })).toBeVisible()
  await editor.fill('Chat 独立草稿')

  await page.getByRole('tab', { name: 'Tool' }).click()
  await expect(editor).toHaveText('')
  await editor.fill('Tool 独立草稿')

  await page.getByRole('tab', { name: 'Chat' }).click()
  await expect(editor).toHaveText('Chat 独立草稿')
  await page.getByRole('tab', { name: 'Tool' }).click()
  await expect(editor).toHaveText('Tool 独立草稿')
})

test('Tool-only agentOnly 刷新后从 Tool 草稿生成执行计划', async ({ page }) => {
  const prompt = 'tool-scope-after-refresh'
  let planRequestBody = ''
  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        serverApi: { enabled: false },
        restrictedAgent: {
          enabled: true,
          basePath: '/agent-api/v1',
          agentOnly: true,
        },
      }),
    })
  })
  await page.route('**/agent-api/v1/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { enabled: true, csrfToken: 'e2e-csrf' } }),
    })
  })
  await page.route('**/agent-api/v1/plans', async (route) => {
    planRequestBody = route.request().postData() ?? ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'e2e-plan',
          version: 1,
          status: 'awaiting_confirmation',
          expiresAt: '2099-01-01T00:00:00.000Z',
          originalRequest: prompt,
          summary: 'Tool scope E2E plan',
          steps: [{ title: '生成图片', operation: 'generate' }],
          generation: {
            exactPrompt: prompt,
            action: 'generate',
            size: '1024x1024',
            quality: 'auto',
            outputFormat: 'png',
            outputCompression: null,
            imageCount: 1,
          },
          inputs: [],
          assumptions: [],
          warnings: [],
          policyVersion: 'restricted-image-v1',
        },
      }),
    })
  })

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
  expect(response?.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: 'Tool Agent 工作区' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: '工作区模式' })).toHaveCount(0)
  const editor = page.locator('[contenteditable][data-placeholder^="描述你想生成的图片"]')
  await editor.fill(prompt)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Tool Agent 工作区' })).toBeVisible()
  await expect(editor).toHaveText(prompt)
  await page.getByTitle('生成执行计划 (Ctrl+Enter)').click()

  await expect(page.getByRole('heading', { name: 'Tool scope E2E plan' })).toBeVisible()
  expect(planRequestBody).toContain(prompt)
})

test('Gallery 中 Chat 失效回退 Tool 时保持 Gallery 草稿与提交路由', async ({ page }) => {
  let galleryRequests = 0
  let galleryRequestUrl = ''
  let galleryRequestBody: unknown = null
  let toolCapabilityRequests = 0
  let toolPlanRequests = 0
  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        serverApi: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-5.5',
          apiMode: 'responses',
          modelOptions: ['gpt-5.5'],
          apiModeOptions: ['images', 'responses'],
          allowCustomModel: true,
          codexCli: false,
          responseFormatB64Json: false,
          timeoutSeconds: 60,
          proxyPath: '/api-proxy',
        },
        restrictedAgent: {
          enabled: true,
          basePath: '/agent-api/v1',
          agentOnly: false,
        },
      }),
    })
  })
  await page.route('**/api-proxy/**', async (route) => {
    galleryRequests += 1
    galleryRequestUrl = route.request().url()
    galleryRequestBody = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }),
    })
  })
  await page.route('**/agent-api/v1/capabilities', async (route) => {
    toolCapabilityRequests += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { enabled: true, csrfToken: 'e2e-csrf' } }),
    })
  })
  await page.route('**/agent-api/v1/plans', async (route) => {
    toolPlanRequests += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'wrong route' }) })
  })

  await gotoGallery(page)
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: 'API 配置' }).click()
  await page.getByText('Images API (/v1/images)', { exact: true }).click()
  await page.locator('[data-option-value="responses"]').click()
  await page.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('tab', { name: 'Agent' }).click()
  await expect(page.getByRole('tablist', { name: 'Agent 模式' })).toBeVisible()
  await page.getByRole('tab', { name: 'Chat' }).click()
  await page.getByRole('tab', { name: '画廊' }).click()
  const editor = page.locator('[contenteditable][data-placeholder^="描述你想生成的图片"]')
  await editor.fill('Gallery 独立草稿')

  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: 'API 配置' }).click()
  await page.getByText('Responses API (/v1/responses)', { exact: true }).click()
  await page.locator('[data-option-value="images"]').click()
  await page.getByRole('button', { name: '关闭' }).click()

  await expect(editor).toHaveText('Gallery 独立草稿')
  await page.getByTitle('生成 (Ctrl+Enter)').click()
  await expect.poll(() => galleryRequests).toBe(1)
  expect(galleryRequestUrl).toContain('/images/generations')
  expect(galleryRequestBody).toMatchObject({ prompt: 'Gallery 独立草稿' })
  expect(toolCapabilityRequests).toBe(0)
  expect(toolPlanRequests).toBe(0)
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open('gpt-image-playground', 2)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tasks = await new Promise<Array<{ prompt?: string; origin?: string }>>((resolve, reject) => {
      const operation = db.transaction('tasks', 'readonly').objectStore('tasks').getAll()
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    db.close()
    const task = tasks.find((candidate) => candidate.prompt === 'Gallery 独立草稿')
    return task?.origin ?? (task ? 'gallery' : null)
  })).toBe('gallery')
  await page.getByRole('tab', { name: 'Agent' }).click()
  await expect(page.getByRole('heading', { name: 'Tool Agent 工作区' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Agent 模式' })).toHaveCount(0)
  await page.getByRole('tab', { name: '画廊' }).click()
  await expect(editor).toHaveText('Gallery 独立草稿')
})

test('localStorage getter 抛出 SecurityError 时 App 仍可启动', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
  })

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
  expect(response?.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: 'GPT Image Playground' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: '工作区模式' })).toBeVisible()
})

test('OpenShop 宿主拒绝错误消息来源并持久化像素等价的新历史', async ({ page }) => {
  const sourceDataUrl = await seedOpenShopHistory(page)
  await page.route('**/openshop/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><script>
        let configuredId = null;
        let sourceBlob = null;
        window.addEventListener('message', (event) => {
          const data = event.data;
          if (event.source !== parent || event.origin !== location.origin || !data || data.version !== 1) return;
          if (data.type === 'openshop:hello') {
            parent.postMessage({ version: 1, type: 'openshop:ready', id: data.id }, location.origin);
          } else if (data.type === 'openshop:configure') {
            configuredId = data.id;
            sourceBlob = data.document && data.document.blob;
          } else if (data.type === 'openshop:export') {
            parent.postMessage({
              version: 1,
              type: 'openshop:exported',
              id: data.id,
              format: 'png',
              filename: 'e2e-export.png',
              blob: sourceBlob,
            }, location.origin);
          }
        });
        window.__getConfiguredId = () => configuredId;
        window.__completeConfiguration = () => parent.postMessage({
          version: 1,
          type: 'openshop:configured',
          id: configuredId,
        }, location.origin);
      </script>`,
    })
  })

  const response = await page.goto(`/?e2e=openshop#/openshop/${SOURCE_IMAGE_ID}?task=${SOURCE_TASK_ID}`, {
    waitUntil: 'domcontentloaded',
  })
  expect(response?.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: '高级编辑' })).toBeVisible()
  const editorFrame = page.frameLocator('[data-openshop-frame]')
  await expect(editorFrame.locator('html')).toBeVisible()
  const frame = page.frames().find((candidate) => candidate.url().endsWith('/openshop/'))
  if (!frame) throw new Error('OpenShop iframe was not created')

  await expect.poll(() => frame.evaluate(() => (window as typeof window & { __getConfiguredId?: () => string | null }).__getConfiguredId?.() ?? null)).not.toBeNull()
  const configuredId = await frame.evaluate(() => (window as typeof window & { __getConfiguredId: () => string }).__getConfiguredId())
  const saveButton = page.getByRole('button', { name: '保存到历史' })

  await page.evaluate((id) => {
    window.postMessage({ version: 1, type: 'openshop:configured', id }, location.origin)
  }, configuredId)
  await expect(saveButton).toBeDisabled()

  await frame.evaluate(() => (window as typeof window & { __completeConfiguration: () => void }).__completeConfiguration())
  await expect(saveButton).toBeEnabled()
  await saveButton.click()
  await expect(page.getByText('已保存为新的编辑历史记录')).toBeVisible()

  const persisted = await page.evaluate(async ({ sourceTaskId, sourceImageId }) => {
    const request = indexedDB.open('gpt-image-playground', 2)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = <T>(store: string, key?: IDBValidKey) => new Promise<T>((resolve, reject) => {
      const objectStore = db.transaction(store, 'readonly').objectStore(store)
      const operation = key == null ? objectStore.getAll() : objectStore.get(key)
      operation.onsuccess = () => resolve(operation.result as T)
      operation.onerror = () => reject(operation.error)
    })
    const tasks = await read<Array<Record<string, unknown>>>('tasks')
    const sourceTask = tasks.find((task) => task.id === sourceTaskId)
    const openShopTask = tasks.find((task) => task.origin === 'openshop')
    if (!openShopTask) throw new Error('OpenShop task was not persisted')
    const outputImageId = (openShopTask.outputImages as string[])[0]
    const outputImage = await read<{ dataUrl: string; source: string }>('images', outputImageId)
    db.close()
    return { sourceTask, openShopTask, outputImage, sourceImageId }
  }, { sourceTaskId: SOURCE_TASK_ID, sourceImageId: SOURCE_IMAGE_ID })

  expect(persisted.sourceTask?.outputImages).toEqual([SOURCE_IMAGE_ID])
  expect(persisted.openShopTask).toMatchObject({
    origin: 'openshop',
    sourceTaskId: SOURCE_TASK_ID,
    inputImageIds: [SOURCE_IMAGE_ID],
    status: 'done',
  })
  expect(persisted.outputImage.source).toBe('openshop')

  const pixels = await page.evaluate(async ({ source, output }) => {
    const decode = (dataUrl: string) => new Promise<{ width: number; height: number; rgba: number[] }>((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (!context) return reject(new Error('Canvas unavailable'))
        context.drawImage(image, 0, 0)
        resolve({
          width: canvas.width,
          height: canvas.height,
          rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
        })
      }
      image.onerror = () => reject(new Error('Image decode failed'))
      image.src = dataUrl
    })
    return { source: await decode(source), output: await decode(output) }
  }, { source: sourceDataUrl, output: persisted.outputImage.dataUrl })

  expect(pixels.output).toEqual(pixels.source)
})
