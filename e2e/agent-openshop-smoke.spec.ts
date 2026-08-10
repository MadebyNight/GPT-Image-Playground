import { expect, test, type Page } from '@playwright/test'
import {
  LEGACY_AGENT_ASSISTANT_TEXT,
  LEGACY_AGENT_PROMPT,
  LEGACY_AGENT_REQUEST_BODY_FIXTURE,
  createLegacyAgentSseFixture,
} from '../src/test/fixtures/legacyAgentResponses'

const SOURCE_TASK_ID = 'e2e-source-task'
const SOURCE_IMAGE_ID = 'e2e-source-image'
const AG_PSD_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/ag-psd@22.0.2/dist/bundle.js'
const JSPDF_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js'
const AG_PSD_FIXTURE_URL = 'http://127.0.0.1:4173/openshop/runtime-fixture/ag-psd.js'
const JSPDF_FIXTURE_URL = 'http://127.0.0.1:4173/openshop/runtime-fixture/jspdf.js'
const AG_PSD_FIXTURE_BODY = 'globalThis.__openShopPsdMockLoads=(globalThis.__openShopPsdMockLoads||0)+1;globalThis.agPsd={readPsd(){},writePsd(){}};'
const JSPDF_FIXTURE_BODY = 'globalThis.__openShopPdfMockLoads=(globalThis.__openShopPdfMockLoads||0)+1;globalThis.jspdf={jsPDF:function jsPDF(){}};'
const AG_PSD_FIXTURE_INTEGRITY = 'sha384-3BKWre/l+OYXTMC9FFzBZwnJe2x5f54QYYjx/wE0gK8qFfb/MZKJUbi5/jcy5/ub'
const JSPDF_FIXTURE_INTEGRITY = 'sha384-Nz2WYWCgWk9ZkssCY29dWTj3DKZb/ZUJhbI2W0mEdo8n7Ly7iDwhs5WPItb++MWo'

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

async function installOpenShopToolFixture(page: Page) {
  await page.route('**/openshop/index.html', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><canvas id="canvas"></canvas><script>
        let sessionId = null;
        let phase = 'idle';
        let canvas = document.getElementById('canvas');
        const reply = (request, message) => parent.postMessage({
          version: 1,
          id: request.id,
          requestId: request.id,
          sessionId: request.sessionId,
          ...message,
        }, location.origin);
        const isPlain = (value) => Boolean(value)
          && typeof value === 'object'
          && !Array.isArray(value)
          && [Object.prototype, null].includes(Object.getPrototypeOf(value));
        const exact = (value, required) => isPlain(value)
          && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
          && Object.keys(value).every((key) => required.includes(key));
        const commandValid = (command) => {
          if (!exact(command, ['schemaVersion', 'id', 'target', 'args'])
            || command.schemaVersion !== 1
            || command.target !== 'document'
            || !isPlain(command.args)) return false;
          if (command.id === 'canvas.crop') return exact(command.args, ['x', 'y', 'width', 'height'])
            && [command.args.x, command.args.y, command.args.width, command.args.height].every(Number.isSafeInteger);
          if (command.id === 'canvas.rotate') return exact(command.args, ['degrees'])
            && typeof command.args.degrees === 'number'
            && [90, -90, 180, -180].includes(command.args.degrees);
          if (command.id === 'canvas.flip') return exact(command.args, ['axis'])
            && (command.args.axis === 'h' || command.args.axis === 'v');
          return command.id === 'canvas.flatten' && exact(command.args, []);
        };
        const requestValid = (request) => {
          const base = ['version', 'type', 'id', 'requestId', 'sessionId'];
          if (!isPlain(request) || request.version !== 1 || !request.id
            || request.requestId !== request.id || !request.sessionId) return false;
          if (request.type === 'openshop:tool:hello') return exact(request, base);
          if (request.type === 'openshop:tool:configure') return exact(request, [...base, 'document'])
            && exact(request.document, ['blob', 'name'])
            && request.document.blob instanceof Blob
            && typeof request.document.name === 'string'
            && request.document.name.length > 0;
          if (request.type === 'openshop:tool:execute') return exact(request, [...base, 'commands'])
            && Array.isArray(request.commands)
            && request.commands.length >= 1
            && request.commands.length <= 5
            && request.commands.every(commandValid);
          return request.type === 'openshop:tool:export'
            && exact(request, [...base, 'format'])
            && request.format === 'png';
        };
        const descriptor = () => ({
          canvas: { width: canvas.width, height: canvas.height },
          primaryImage: { present: canvas.width > 0 && canvas.height > 0 },
        });
        const fail = (request, code, message, commandIndex) => reply(request, {
          type: 'openshop:tool:error',
          code,
          message,
          retryable: false,
          ...(Number.isInteger(commandIndex) ? { commandIndex } : {}),
        });
        const replaceCanvas = (next) => {
          canvas.replaceWith(next);
          canvas = next;
        };
        const crop = (args) => {
          if (![args.x, args.y, args.width, args.height].every(Number.isSafeInteger)
            || args.x < 0 || args.y < 0 || args.width < 1 || args.height < 1
            || args.x + args.width > canvas.width || args.y + args.height > canvas.height) {
            throw new Error('crop outside canvas');
          }
          const next = document.createElement('canvas');
          next.width = args.width;
          next.height = args.height;
          next.getContext('2d').drawImage(canvas, args.x, args.y, args.width, args.height, 0, 0, args.width, args.height);
          replaceCanvas(next);
        };
        const rotate = (degrees) => {
          const quarter = Math.abs(degrees) === 90;
          const next = document.createElement('canvas');
          next.width = quarter ? canvas.height : canvas.width;
          next.height = quarter ? canvas.width : canvas.height;
          const context = next.getContext('2d');
          context.translate(next.width / 2, next.height / 2);
          context.rotate(degrees * Math.PI / 180);
          context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
          replaceCanvas(next);
        };
        const flip = (axis) => {
          const next = document.createElement('canvas');
          next.width = canvas.width;
          next.height = canvas.height;
          const context = next.getContext('2d');
          if (axis === 'h') { context.translate(next.width, 0); context.scale(-1, 1); }
          else { context.translate(0, next.height); context.scale(1, -1); }
          context.drawImage(canvas, 0, 0);
          replaceCanvas(next);
        };
        window.addEventListener('message', async (event) => {
          const request = event.data;
          if (event.source !== parent || event.origin !== location.origin || request?.version !== 1) return;
          if (!requestValid(request)) return fail(request, 'INVALID_REQUEST', 'invalid request schema');
          if (request.type === 'openshop:tool:hello') {
            sessionId = request.sessionId;
            phase = 'ready';
            reply(request, {
              type: 'openshop:tool:ready',
              capabilities: {
                commands: ['canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten'],
                maxCommands: 5,
                inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
                outputFormats: ['png'],
              },
            });
            return;
          }
          if (request.sessionId !== sessionId) return fail(request, 'SESSION_EXPIRED', 'wrong session');
          if (request.type === 'openshop:tool:configure') {
            if (phase !== 'ready') return fail(request, 'INVALID_REQUEST', 'configure out of sequence');
            const magic = new Uint8Array(await request.document.blob.slice(0, 12).arrayBuffer());
            const mime = request.document.blob.type.toLowerCase();
            const magicMatches = mime === 'image/png'
              ? magic.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => magic[index] === byte)
              : mime === 'image/jpeg'
                ? magic.length >= 3 && magic[0] === 255 && magic[1] === 216 && magic[2] === 255
                : mime === 'image/webp'
                  && magic.length >= 12
                  && String.fromCharCode(...magic.subarray(0, 4)) === 'RIFF'
                  && String.fromCharCode(...magic.subarray(8, 12)) === 'WEBP';
            if (!magicMatches) return fail(request, 'IMPORT_FAILED', 'mime magic mismatch');
            const bitmap = await createImageBitmap(request.document.blob);
            const next = document.createElement('canvas');
            next.width = bitmap.width;
            next.height = bitmap.height;
            next.getContext('2d').drawImage(bitmap, 0, 0);
            bitmap.close();
            replaceCanvas(next);
            phase = 'configured';
            reply(request, { type: 'openshop:tool:configured', document: descriptor() });
            return;
          }
          if (request.type === 'openshop:tool:execute') {
            if (phase !== 'configured') return fail(request, 'INVALID_REQUEST', 'execute out of sequence');
            await new Promise((resolve) => setTimeout(resolve, 120));
            try {
              request.commands.forEach((command, commandIndex) => {
                try {
                  if (command.id === 'canvas.crop') crop(command.args);
                  else if (command.id === 'canvas.rotate') rotate(command.args.degrees);
                  else if (command.id === 'canvas.flip') flip(command.args.axis);
                  else if (command.id !== 'canvas.flatten') throw new Error('unsupported command');
                } catch (error) {
                  error.commandIndex = commandIndex;
                  throw error;
                }
              });
            } catch (error) {
              return fail(request, 'VALIDATION_FAILED', error.message, error.commandIndex);
            }
            phase = 'executed';
            reply(request, {
              type: 'openshop:tool:executed',
              appliedCommands: request.commands.length,
              changed: true,
              document: descriptor(),
            });
            return;
          }
          if (request.type === 'openshop:tool:export') {
            if (phase !== 'executed') return fail(request, 'INVALID_REQUEST', 'export out of sequence');
            const blob = await new Promise((resolve, reject) => canvas.toBlob(
              (value) => value ? resolve(value) : reject(new Error('png export failed')),
              'image/png',
            ));
            phase = 'exported';
            reply(request, {
              type: 'openshop:tool:exported',
              format: 'png',
              filename: 'tool-output.png',
              blob,
              document: descriptor(),
            });
          }
        });
      </script>`,
    })
  })
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

test('真实 public OpenShop 在全新离线 Chromium 中连续执行并原子保存', async ({ browser }) => {
  const context = await browser.newContext()
  const realPage = await context.newPage()
  const externalRequests: string[] = []
  await realPage.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    const isInlineResource = requestUrl.protocol === 'data:' || requestUrl.protocol === 'blob:'
    const isLocalHttp = (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:')
      && (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost')
    if (isInlineResource || isLocalHttp) {
      await route.continue()
      return
    }
    externalRequests.push(requestUrl.href)
    await route.abort('blockedbyclient')
  })

  try {
    const devtools = await context.newCDPSession(realPage)
    await devtools.send('Network.enable')
    await devtools.send('Network.clearBrowserCache')
    await devtools.send('Storage.clearDataForOrigin', {
      origin: 'http://127.0.0.1:4173',
      storageTypes: 'all',
    })

    const sourceDataUrl = await seedOpenShopHistory(realPage)
    const sourceSnapshot = await realPage.evaluate(async ({ sourceTaskId, sourceImageId }) => {
      const request = indexedDB.open('gpt-image-playground', 2)
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const read = <T>(store: string, key: IDBValidKey) => new Promise<T>((resolve, reject) => {
        const operation = db.transaction(store, 'readonly').objectStore(store).get(key)
        operation.onsuccess = () => resolve(operation.result)
        operation.onerror = () => reject(operation.error)
      })
      const result = {
        task: await read<Record<string, unknown>>('tasks', sourceTaskId),
        image: await read<Record<string, unknown>>('images', sourceImageId),
      }
      db.close()
      return result
    }, { sourceTaskId: SOURCE_TASK_ID, sourceImageId: SOURCE_IMAGE_ID })

    const startRealRun = async (commands: Array<Record<string, unknown>>) => realPage.evaluate(async ({
      sourceTaskId,
      sourceImageId,
      toolCommands,
    }) => {
      const loadModule = new Function('path', 'return import(path)') as (path: string) => Promise<Record<string, unknown>>
      const [{ openShopToolRunner }, { useStore }] = await Promise.all([
        loadModule('/src/lib/openShopToolRunner.ts'),
        loadModule('/src/store.ts'),
      ]) as [
        { openShopToolRunner: (options: Record<string, unknown>) => Promise<Record<string, unknown>> },
        { useStore: { setState: (state: Record<string, unknown>) => void } },
      ]
      const request = indexedDB.open('gpt-image-playground', 2)
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const sourceTask = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const operation = db.transaction('tasks', 'readonly').objectStore('tasks').get(sourceTaskId)
        operation.onsuccess = () => resolve(operation.result)
        operation.onerror = () => reject(operation.error)
      })
      db.close()
      useStore.setState({ tasks: [sourceTask] })
      ;(window as typeof window & { __realOpenShopToolRun?: Promise<Record<string, unknown>> }).__realOpenShopToolRun = (async () => {
        const startedAt = performance.now()
        const result = await openShopToolRunner({
          sourceTaskId,
          inputAssetId: sourceImageId,
          commands: toolCommands,
          outputFormat: 'png',
        })
        return { ...result, coldStartMs: performance.now() - startedAt }
      })()
    }, { sourceTaskId: SOURCE_TASK_ID, sourceImageId: SOURCE_IMAGE_ID, toolCommands: commands })

    await startRealRun([
      { schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 1, y: 0, width: 2, height: 2 } },
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } },
      { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'h' } },
      { schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: {} },
    ])
    const realToolFrame = realPage.locator('[data-openshop-tool-frame]')
    await expect(realToolFrame).toHaveCount(1)
    await expect(realToolFrame).toHaveCSS('width', '1280px')
    await expect(realToolFrame).toHaveCSS('height', '900px')
    await expect(realToolFrame).toHaveAttribute('src', /\/openshop\/index\.html$/)
    const firstResult = await realPage.evaluate(async () => {
      const result = await (window as typeof window & {
        __realOpenShopToolRun: Promise<{
          task: { id: string }
          document: { canvas: { width: number; height: number } }
          coldStartMs: number
        }>
      }).__realOpenShopToolRun
      return {
        taskId: result.task.id,
        width: result.document.canvas.width,
        height: result.document.canvas.height,
        coldStartMs: result.coldStartMs,
      }
    })
    expect(firstResult).toMatchObject({ width: 2, height: 2 })
    expect(firstResult.coldStartMs).toBeGreaterThan(0)
    expect(firstResult.coldStartMs).toBeLessThan(60_000)
    await expect(realToolFrame).toHaveCount(0)

    await startRealRun([
      { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'v' } },
    ])
    await expect(realToolFrame).toHaveCount(1)
    const secondResult = await realPage.evaluate(async () => {
      const result = await (window as typeof window & {
        __realOpenShopToolRun: Promise<{ task: { id: string }; coldStartMs: number }>
      }).__realOpenShopToolRun
      return { taskId: result.task.id, elapsedMs: result.coldStartMs }
    })
    expect(secondResult.taskId).not.toBe(firstResult.taskId)
    await expect(realToolFrame).toHaveCount(0)

    const persisted = await realPage.evaluate(async ({ sourceTaskId, sourceImageId, firstTaskId, secondTaskId }) => {
      const request = indexedDB.open('gpt-image-playground', 2)
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const read = <T>(store: string, key: IDBValidKey) => new Promise<T>((resolve, reject) => {
        const operation = db.transaction(store, 'readonly').objectStore(store).get(key)
        operation.onsuccess = () => resolve(operation.result)
        operation.onerror = () => reject(operation.error)
      })
      const sourceTask = await read<Record<string, unknown>>('tasks', sourceTaskId)
      const sourceImage = await read<Record<string, unknown>>('images', sourceImageId)
      const firstTask = await read<Record<string, unknown>>('tasks', firstTaskId)
      const secondTask = await read<Record<string, unknown>>('tasks', secondTaskId)
      const firstImageId = (firstTask.outputImages as string[])[0]
      const secondImageId = (secondTask.outputImages as string[])[0]
      const firstImage = await read<{ dataUrl: string; source: string }>('images', firstImageId)
      const secondImage = await read<{ dataUrl: string; source: string }>('images', secondImageId)
      const firstThumbnail = await read<Record<string, unknown>>('thumbnails', firstImageId)
      const secondThumbnail = await read<Record<string, unknown>>('thumbnails', secondImageId)
      db.close()
      return { sourceTask, sourceImage, firstTask, secondTask, firstImage, secondImage, firstThumbnail, secondThumbnail }
    }, {
      sourceTaskId: SOURCE_TASK_ID,
      sourceImageId: SOURCE_IMAGE_ID,
      firstTaskId: firstResult.taskId,
      secondTaskId: secondResult.taskId,
    })

    expect(persisted.sourceTask).toEqual(sourceSnapshot.task)
    expect(persisted.sourceImage).toEqual(sourceSnapshot.image)
    expect(persisted.sourceImage.dataUrl).toBe(sourceDataUrl)
    expect(persisted.firstTask).toMatchObject({
      origin: 'openshop',
      sourceTaskId: SOURCE_TASK_ID,
      inputImageIds: [SOURCE_IMAGE_ID],
      status: 'done',
    })
    expect(persisted.secondTask).toMatchObject({
      origin: 'openshop',
      sourceTaskId: SOURCE_TASK_ID,
      inputImageIds: [SOURCE_IMAGE_ID],
      status: 'done',
    })
    expect(persisted.firstImage.source).toBe('openshop')
    expect(persisted.secondImage.source).toBe('openshop')
    expect(persisted.firstThumbnail).toMatchObject({ thumbnailVersion: 2 })
    expect(persisted.secondThumbnail).toMatchObject({ thumbnailVersion: 2 })

    const outputPixels = await realPage.evaluate(async (dataUrl) => {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('output decode failed'))
        image.src = dataUrl
      })
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      context.drawImage(image, 0, 0)
      return {
        width: canvas.width,
        height: canvas.height,
        rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
      }
    }, persisted.firstImage.dataUrl)
    expect(outputPixels).toEqual({
      width: 2,
      height: 2,
      rgba: [
        0, 255, 0, 255,
        0, 0, 0, 255,
        0, 0, 255, 255,
        255, 255, 0, 255,
      ],
    })
    expect(externalRequests.some((url) => /fabric@7\.4\.0|ag-psd@22\.0\.2|jspdf@4\.2\.1/.test(url))).toBe(false)
    console.log(`[OpenShop real cold start] ${firstResult.coldStartMs.toFixed(1)} ms; second run ${secondResult.elapsedMs.toFixed(1)} ms`)
  } finally {
    await context.close()
  }
})

test('OpenShop 启动不请求 PSD/PDF，按需并发加载时每个已验证组件只请求一次', async ({ page }) => {
  const runtimeRequests: string[] = []
  page.on('request', (request) => {
    if ([AG_PSD_RUNTIME_URL, JSPDF_RUNTIME_URL, AG_PSD_FIXTURE_URL, JSPDF_FIXTURE_URL].includes(request.url())) {
      runtimeRequests.push(request.url())
    }
  })
  await page.route(AG_PSD_FIXTURE_URL, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: AG_PSD_FIXTURE_BODY })
  })
  await page.route(JSPDF_FIXTURE_URL, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: JSPDF_FIXTURE_BODY })
  })

  const response = await page.goto('/openshop/index.html', { waitUntil: 'domcontentloaded' })
  expect(response?.ok()).toBe(true)
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.osBoot)).toBe('ready')
  expect(runtimeRequests).toEqual([])

  const loaded = await page.evaluate(async ({ psdUrl, psdIntegrity, pdfUrl, pdfIntegrity }) => {
    const runtimeWindow = window as typeof window & {
      __openShopPsdMockLoads?: number
      __openShopPdfMockLoads?: number
      agPsd?: { readPsd?: unknown; writePsd?: unknown }
      jspdf?: { jsPDF?: unknown }
    }
    const openShop = Function('return OS')() as {
      _runtimeAssets: Record<string, { url: string; integrity: string; type: string }>
      _loadVerifiedRuntimeScript: (name: string, isReady: () => boolean) => Promise<boolean>
    }
    openShop._runtimeAssets = Object.freeze({
      ...openShop._runtimeAssets,
      psdDecoder: Object.freeze({ url: psdUrl, integrity: psdIntegrity, type: 'application/javascript' }),
      pdfExporter: Object.freeze({ url: pdfUrl, integrity: pdfIntegrity, type: 'application/javascript' }),
    })
    const before = { agPsd: Boolean(runtimeWindow.agPsd), jspdf: Boolean(runtimeWindow.jspdf) }
    const loadPsd = () => openShop._loadVerifiedRuntimeScript('psdDecoder', () => Boolean(runtimeWindow.agPsd?.writePsd))
    const loadPdf = () => openShop._loadVerifiedRuntimeScript('pdfExporter', () => Boolean(runtimeWindow.jspdf?.jsPDF))
    await Promise.all([loadPsd(), loadPsd(), loadPdf(), loadPdf()])
    await Promise.all([loadPsd(), loadPdf()])
    return {
      before,
      hasReadPsd: typeof runtimeWindow.agPsd?.readPsd === 'function',
      hasWritePsd: typeof runtimeWindow.agPsd?.writePsd === 'function',
      hasJsPdf: typeof runtimeWindow.jspdf?.jsPDF === 'function',
      psdExecutions: runtimeWindow.__openShopPsdMockLoads,
      pdfExecutions: runtimeWindow.__openShopPdfMockLoads,
    }
  }, {
    psdUrl: AG_PSD_FIXTURE_URL,
    psdIntegrity: AG_PSD_FIXTURE_INTEGRITY,
    pdfUrl: JSPDF_FIXTURE_URL,
    pdfIntegrity: JSPDF_FIXTURE_INTEGRITY,
  })

  expect(loaded).toEqual({
    before: { agPsd: false, jspdf: false },
    hasReadPsd: true,
    hasWritePsd: true,
    hasJsPdf: true,
    psdExecutions: 1,
    pdfExecutions: 1,
  })
  expect(runtimeRequests.filter((value) => value === AG_PSD_FIXTURE_URL)).toHaveLength(1)
  expect(runtimeRequests.filter((value) => value === JSPDF_FIXTURE_URL)).toHaveLength(1)
  expect(runtimeRequests).not.toContain(AG_PSD_RUNTIME_URL)
  expect(runtimeRequests).not.toContain(JSPDF_RUNTIME_URL)
})

test('OpenShop 离线首次导出 PSD/PDF 失败时保留可用画布并给出中文联网提示', async ({ page }) => {
  await page.route(AG_PSD_RUNTIME_URL, async (route) => route.abort('blockedbyclient'))
  await page.route(JSPDF_RUNTIME_URL, async (route) => route.abort('blockedbyclient'))

  const response = await page.goto('/openshop/index.html', { waitUntil: 'domcontentloaded' })
  expect(response?.ok()).toBe(true)
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.osBoot)).toBe('ready')

  const result = await page.evaluate(async () => {
    const openShop = Function('return OS')() as {
      canvas?: { getObjects?: () => unknown[]; lowerCanvasEl?: HTMLCanvasElement }
      toast: (message: unknown, type?: string) => unknown
      exportPDF: () => Promise<boolean>
      exportPSD: () => Promise<boolean>
    }
    const toasts: string[] = []
    const originalToast = openShop.toast.bind(openShop)
    openShop.toast = (message, type) => {
      toasts.push(String(message))
      return originalToast(message, type)
    }
    const [pdf, psd] = await Promise.all([openShop.exportPDF(), openShop.exportPSD()])
    return {
      pdf,
      psd,
      toasts,
      boot: document.documentElement.dataset.osBoot,
      canvasUsable: Boolean(openShop.canvas?.getObjects && openShop.canvas.lowerCanvasEl?.isConnected),
    }
  })

  expect(result.pdf).toBe(false)
  expect(result.psd).toBe(false)
  expect(result.toasts.filter((message) => message.includes('该功能需联网加载已验证组件'))).toHaveLength(2)
  expect(result.boot).toBe('ready')
  expect(result.canvasUsable).toBe(true)
})

test('OpenShop Tool Runner 在真实 Chromium/IndexedDB 中连续执行组合命令、验证像素并清理 iframe', async ({ page }) => {
  await installOpenShopToolFixture(page)
  await seedOpenShopHistory(page)

  const startRun = async (commands: Array<Record<string, unknown>>) => page.evaluate(async ({ sourceTaskId, sourceImageId, toolCommands }) => {
    const loadModule = new Function('path', 'return import(path)') as (path: string) => Promise<Record<string, unknown>>
    const [{ openShopToolRunner }, { useStore }] = await Promise.all([
      loadModule('/src/lib/openShopToolRunner.ts'),
      loadModule('/src/store.ts'),
    ]) as [
      { openShopToolRunner: (options: Record<string, unknown>) => Promise<unknown> },
      { useStore: { setState: (state: Record<string, unknown>) => void } },
    ]
    const request = indexedDB.open('gpt-image-playground', 2)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const sourceTask = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const operation = db.transaction('tasks', 'readonly').objectStore('tasks').get(sourceTaskId)
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    db.close()
    useStore.setState({ tasks: [sourceTask] })
    ;(window as typeof window & { __openShopToolRun?: Promise<unknown> }).__openShopToolRun = openShopToolRunner({
      sourceTaskId,
      inputAssetId: sourceImageId,
      commands: toolCommands,
      outputFormat: 'png',
    })
  }, { sourceTaskId: SOURCE_TASK_ID, sourceImageId: SOURCE_IMAGE_ID, toolCommands: commands })

  await startRun([
    { schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 1, y: 0, width: 2, height: 2 } },
    { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } },
    { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'h' } },
    { schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: {} },
  ])
  const toolFrame = page.locator('[data-openshop-tool-frame]')
  await expect(toolFrame).toHaveCount(1)
  await expect(toolFrame).toHaveCSS('width', '1280px')
  await expect(toolFrame).toHaveCSS('height', '900px')
  const firstResult = await page.evaluate(async () => {
    const result = await (window as typeof window & { __openShopToolRun: Promise<{ task: { id: string }; document: { canvas: { width: number; height: number } } }> }).__openShopToolRun
    return { taskId: result.task.id, width: result.document.canvas.width, height: result.document.canvas.height }
  })
  expect(firstResult).toMatchObject({ width: 2, height: 2 })
  await expect(toolFrame).toHaveCount(0)

  await startRun([
    { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'v' } },
  ])
  await expect(toolFrame).toHaveCount(1)
  const secondResult = await page.evaluate(async () => {
    const result = await (window as typeof window & { __openShopToolRun: Promise<{ task: { id: string } }> }).__openShopToolRun
    return { taskId: result.task.id }
  })
  expect(secondResult.taskId).not.toBe(firstResult.taskId)
  await expect(toolFrame).toHaveCount(0)

  const persisted = await page.evaluate(async ({ sourceTaskId, firstTaskId, secondTaskId }) => {
    const request = indexedDB.open('gpt-image-playground', 2)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = <T>(store: string, key: IDBValidKey) => new Promise<T>((resolve, reject) => {
      const operation = db.transaction(store, 'readonly').objectStore(store).get(key)
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    const sourceTask = await read<Record<string, unknown>>('tasks', sourceTaskId)
    const firstTask = await read<Record<string, unknown>>('tasks', firstTaskId)
    const secondTask = await read<Record<string, unknown>>('tasks', secondTaskId)
    const firstImage = await read<{ dataUrl: string; source: string }>('images', (firstTask.outputImages as string[])[0])
    db.close()
    return { sourceTask, firstTask, secondTask, firstImage }
  }, { sourceTaskId: SOURCE_TASK_ID, firstTaskId: firstResult.taskId, secondTaskId: secondResult.taskId })

  expect(persisted.sourceTask.outputImages).toEqual([SOURCE_IMAGE_ID])
  expect(persisted.firstTask).toMatchObject({
    origin: 'openshop',
    sourceTaskId: SOURCE_TASK_ID,
    inputImageIds: [SOURCE_IMAGE_ID],
    status: 'done',
  })
  expect(persisted.secondTask).toMatchObject({ origin: 'openshop', sourceTaskId: SOURCE_TASK_ID, status: 'done' })
  expect(persisted.firstImage.source).toBe('openshop')

  const outputPixels = await page.evaluate(async (dataUrl) => {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('output decode failed'))
      image.src = dataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(image, 0, 0)
    const rgba = Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
    return { width: canvas.width, height: canvas.height, rgba }
  }, persisted.firstImage.dataUrl)
  expect(outputPixels).toEqual({
    width: 2,
    height: 2,
    rgba: [
      0, 255, 0, 255,
      0, 0, 0, 255,
      0, 0, 255, 255,
      255, 255, 0, 255,
    ],
  })
})

test('OpenShop Tool command 失败不创建 Task，并销毁一次性 iframe', async ({ page }) => {
  await installOpenShopToolFixture(page)
  await seedOpenShopHistory(page)

  const failure = await page.evaluate(async ({ sourceTaskId, sourceImageId }) => {
    const loadModule = new Function('path', 'return import(path)') as (path: string) => Promise<Record<string, unknown>>
    const [{ openShopToolRunner }, { useStore }] = await Promise.all([
      loadModule('/src/lib/openShopToolRunner.ts'),
      loadModule('/src/store.ts'),
    ]) as [
      { openShopToolRunner: (options: Record<string, unknown>) => Promise<unknown> },
      { useStore: { setState: (state: Record<string, unknown>) => void } },
    ]
    const sourceTask = {
      id: sourceTaskId,
      prompt: 'OpenShop Chromium 基线',
      params: { size: 'auto', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto', n: 1 },
      inputImageIds: [],
      outputImages: [sourceImageId],
      status: 'done',
      error: null,
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
      origin: 'gallery',
    }
    useStore.setState({ tasks: [sourceTask] })
    try {
      await openShopToolRunner({
        sourceTaskId,
        inputAssetId: sourceImageId,
        commands: [{ schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 2, y: 0, width: 2, height: 2 } }],
        outputFormat: 'png',
      })
      return null
    } catch (error) {
      return { code: (error as { code?: string }).code, commandIndex: (error as { commandIndex?: number }).commandIndex }
    }
  }, { sourceTaskId: SOURCE_TASK_ID, sourceImageId: SOURCE_IMAGE_ID })
  expect(failure).toEqual({ code: 'VALIDATION_FAILED', commandIndex: 0 })
  await expect(page.locator('[data-openshop-tool-frame]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open('gpt-image-playground', 2)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tasks = await new Promise<Array<{ origin?: string }>>((resolve, reject) => {
      const operation = db.transaction('tasks', 'readonly').objectStore('tasks').getAll()
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    db.close()
    return tasks.filter((task) => task.origin === 'openshop').length
  })).toBe(0)
})
